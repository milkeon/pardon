const DEFAULT_CONTEXT_HINTS = [
  '정확한 정보 전달',
  '자연스러운 문맥'
];

const TRANSFORMERS = [
  {
    id: 'p1',
    label: '가능성 1 (가장 유력)',
    build: ({ text }) => {
      // 말더듬 단어 정리 및 가장 직관적인 STT 음성 복원
      return simplifyText(text);
    }
  },
  {
    id: 'p2',
    label: '가능성 2 (유사 발음 교정)',
    build: ({ text, context }) => {
      // 엉뚱한 동음이의어 또는 맞춤법 오류 가능성을 감안한 대안 유사 발음 교정
      return phoneticCorrection(text, context);
    }
  },
  {
    id: 'p3',
    label: '가능성 3 (문맥 의도 보정)',
    build: ({ text, context, hints }) => {
      // 주어진 문맥 힌트를 적극 융합해 화자가 실제 말하려 한 최종 의도로 보완한 해석
      return contextHeuristics(text, context, hints);
    }
  }
];

export function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function inferContextHints(context) {
  const source = normalizeWhitespace(context).toLowerCase();
  const hints = [];

  if (!source) {
    return DEFAULT_CONTEXT_HINTS;
  }

  if (/(email|mail|이메일)/i.test(source)) hints.push('공식 이메일 서식', '정중함');
  if (/(chat|slack|메신저|dm|discord)/i.test(source)) hints.push('메신저 어휘', '간결함');
  if (/(client|고객|customer|환자|member)/i.test(source)) hints.push('고객 소통', '친절함');
  if (/(summary|요약|report|보고)/i.test(source)) hints.push('보고 형식', '명확함');
  if (/(apology|sorry|미안|사과)/i.test(source)) hints.push('사과 전달', '진중함');
  if (/(presentation|발표|talk|설명)/i.test(source)) hints.push('구어체 정돈', '명료함');
  if (/(korean|한국어|존댓말|polite)/i.test(source)) hints.push('존댓말 서식');
  if (/(urgent|급함|긴급)/i.test(source)) hints.push('긴급 행동 전달', '즉각 반응');

  return hints.length ? [...new Set(hints)] : DEFAULT_CONTEXT_HINTS;
}

export function buildRewriteVariants(text, context = '') {
  const cleanedText = text ? text.trim() : '';
  const hints = inferContextHints(context);

  if (!cleanedText) {
    return TRANSFORMERS.map((variant) => ({
      id: variant.id,
      label: variant.label,
      text: '텍스트가 들어오면 세 가지 해석 가능성 대안이 표시됩니다.'
    }));
  }

  return TRANSFORMERS.map((variant) => ({
    id: variant.id,
    label: variant.label,
    text: finalizeVariantText(
      variant.build({ text: cleanedText, context, hints })
    )
  }));
}

function simplifyText(text) {
  // 음성 인식 중 빈번한 아, 음, 어 등 말더듬성 불필요 추임새 제거
  const withoutFillers = String(text ?? '')
    .replace(/\b(아|음|어|그|저|습|읍|actually|basically)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return withoutFillers || String(text ?? '').trim();
}

function phoneticCorrection(text, context) {
  let base = simplifyText(text);
  const lowerContext = String(context ?? '').toLowerCase();
  
  // 상황 문맥 힌트에 맞추어 흔히 일어나는 STT 한국어 오인식 어휘를 교정
  if (lowerContext.includes('고객') || lowerContext.includes('친절') || lowerContext.includes('customer')) {
    base = base
      .replace(/(안녕|방가)/g, '안녕하세요')
      .replace(/(조음|조은)/g, '좋은')
      .replace(/(알개|알게)/g, '알겠습니다');
  }
  if (lowerContext.includes('메일') || lowerContext.includes('보고') || lowerContext.includes('이메일')) {
    base = base
      .replace(/(했슴|했다|했음)/g, '보고드립니다')
      .replace(/(보냄|보냇)/g, '발송해 드립니다')
      .replace(/(체크)/g, '검토 후 공유해 드리겠습니다');
  }
  if (lowerContext.includes('급') || lowerContext.includes('긴급') || lowerContext.includes('빨리')) {
    base = base
      .replace(/(천천히|나중에)/g, '즉시 확인 후')
      .replace(/(부탁)/g, '요청드립니다');
  }
  
  return base;
}

function contextHeuristics(text, context, hints) {
  const core = simplifyText(text);
  const cleanContext = normalizeWhitespace(context);
  if (!cleanContext) {
    return `${core} (추정 목적: ${hints.slice(0, 2).join(', ')} 처리)`;
  }
  const short = cleanContext.length > 90 ? `${cleanContext.slice(0, 87)}...` : cleanContext;
  return `${core} (문맥 적합성: [${short}] 방향 보정)`;
}

function finalizeVariantText(value) {
  return String(value ?? '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}
