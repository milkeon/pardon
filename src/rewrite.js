const DEFAULT_CONTEXT_HINTS = [
  '명확함',
  '친절함',
  '간결함'
];

const TRANSFORMERS = [
  {
    id: 'clean',
    label: '깔끔하게',
    build: ({ text, context, hints }) => {
      const intent = contextSummary(context, hints);
      const core = simplifyText(text);
      return intent ? `${core} — ${intent}` : core;
    }
  },
  {
    id: 'polite',
    label: '공손하게',
    build: ({ text, context, hints }) => {
      const core = softenText(text);
      const intent = contextSummary(context, hints);
      return intent ? `${core} (${intent})` : core;
    }
  },
  {
    id: 'action',
    label: '실행 중심',
    build: ({ text, context, hints }) => {
      const core = makeActionable(text);
      const intent = contextSummary(context, hints);
      return intent ? `${core}\n\n${intent}` : core;
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

  if (/(email|mail|이메일)/i.test(source)) hints.push('professional', 'polished');
  if (/(chat|slack|메신저|dm|discord)/i.test(source)) hints.push('casual', 'direct');
  if (/(client|고객|customer|환자|member)/i.test(source)) hints.push('courteous', 'helpful');
  if (/(summary|요약|report|보고)/i.test(source)) hints.push('concise', 'structured');
  if (/(apology|sorry|미안|사과)/i.test(source)) hints.push('humble', 'warm');
  if (/(presentation|발표|talk|설명)/i.test(source)) hints.push('confident', 'clear');
  if (/(korean|한국어|존댓말|polite)/i.test(source)) hints.push('polite');
  if (/(urgent|급함|긴급)/i.test(source)) hints.push('urgent', 'actionable');

  return hints.length ? [...new Set(hints)] : DEFAULT_CONTEXT_HINTS;
}

export function buildRewriteVariants(text, context = '') {
  const cleanedText = normalizeWhitespace(text);
  const hints = inferContextHints(context);

  if (!cleanedText) {
    return TRANSFORMERS.map((variant) => ({
      id: variant.id,
      label: variant.label,
      text: '텍스트가 들어오면 세 가지 재작성 버전이 표시됩니다.'
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
  const withoutFillers = normalizeWhitespace(text)
    .replace(/\b(um+|uh+|like|you know|actually|basically)\b/gi, '')
    .replace(/\s+,/g, ',')
    .replace(/\s+([?.!,;:])/g, '$1');

  return withoutFillers || normalizeWhitespace(text);
}

function softenText(text) {
  const base = simplifyText(text)
    .replace(/^i\s+need\s+to\b/i, "I'd appreciate it if we could")
    .replace(/^i\s+want\s+to\b/i, "I'd like to")
    .replace(/^i\s+can't\b/i, 'I may not be able to')
    .replace(/^i\s+cannot\b/i, 'I may not be able to')
    .replace(/\b(can't|cannot)\b/gi, 'may not be able to')
    .replace(/\bwant to\b/gi, 'would like to')
    .replace(/\bneed to\b/gi, 'would appreciate it if we could');

  if (/\?$/.test(base)) return base;
  if (/[.!]$/.test(base)) return base;
  return `${base}.`;
}

function makeActionable(text) {
  const base = simplifyText(text)
    .replace(/^(please\s+)?/i, '')
    .replace(/\bwe should\b/gi, 'let’s')
    .replace(/\b(i need to|need to)\b/gi, 'next step:')
    .replace(/\b(can you|could you)\b/gi, 'please');

  const sentences = base.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length > 1) {
    return `실행 계획:\n- ${sentences.join('\n- ')}`;
  }
  return `실행 계획: ${base}`;
}

function contextSummary(context, hints) {
  const cleanContext = normalizeWhitespace(context);
  if (!cleanContext) {
    return `맥락: ${hints.slice(0, 2).join(', ')}`;
  }
  const short = cleanContext.length > 90 ? `${cleanContext.slice(0, 87)}...` : cleanContext;
  return `맥락: ${short}`;
}

function finalizeVariantText(value) {
  return String(value ?? '')
    .split(/\n+/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean)
    .join('\n')
    .trim();
}
