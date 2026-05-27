const DEFAULT_CONTEXT_HINTS = ['명확함', '친절함', '간결함'];

const TRANSFORMERS = [
  {
    id: 'possibility-1',
    label: '가능성 1',
    build: ({ text, profile }) => {
      const core = simplifyText(text);
      const note = summaryNote(profile, '가장 직접적인 해석');
      return note ? `${core} — ${note}` : core;
    }
  },
  {
    id: 'possibility-2',
    label: '가능성 2',
    build: ({ text, profile }) => {
      const core = adaptToContext(text, profile);
      const note = summaryNote(profile, '문맥을 반영한 보정');
      return note ? `${core} (${note})` : core;
    }
  },
  {
    id: 'possibility-3',
    label: '가능성 3',
    build: ({ text, profile }) => {
      const core = makeActionable(text, profile);
      const note = summaryNote(profile, '실행 중심 요약');
      return note ? `${core}\n\n${note}` : core;
    }
  }
];

export function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function inferContextHints(context) {
  const source = normalizeWhitespace(context).toLowerCase();
  const hints = [];

  if (!source) return DEFAULT_CONTEXT_HINTS;
  if (/(email|mail|이메일)/i.test(source)) hints.push('professional', 'polished');
  if (/(chat|slack|메신저|dm|discord)/i.test(source)) hints.push('casual', 'direct');
  if (/(client|고객|customer|환자|member)/i.test(source)) hints.push('courteous', 'helpful');
  if (/(summary|요약|report|보고)/i.test(source)) hints.push('concise', 'structured');
  if (/(apology|sorry|미안|사과)/i.test(source)) hints.push('humble', 'warm');
  if (/(presentation|발표|talk|설명)/i.test(source)) hints.push('confident', 'clear');
  if (/(korean|한국어|존댓말|polite)/i.test(source)) hints.push('polite');
  if (/(urgent|급함|긴급|asap|빨리|지금|빠른)/i.test(source)) hints.push('urgent', 'actionable');

  return hints.length ? [...new Set(hints)] : DEFAULT_CONTEXT_HINTS;
}

export function deriveContextProfile(context, transcript = '') {
  const combined = normalizeWhitespace(`${context} ${transcript}`).toLowerCase();
  const hints = inferContextHints(context);

  const channel = /(email|mail|이메일)/i.test(combined)
    ? 'email'
    : /(chat|slack|메신저|dm|discord)/i.test(combined)
      ? 'chat'
      : /(report|보고|summary|요약)/i.test(combined)
        ? 'report'
        : /(presentation|발표|talk|설명)/i.test(combined)
          ? 'presentation'
          : 'general';

  const audience = /(customer|고객|client|환자|member)/i.test(combined)
    ? 'customer'
    : /(team|팀|동료|cohort|group)/i.test(combined)
      ? 'team'
      : /(boss|manager|lead|상사)/i.test(combined)
        ? 'manager'
        : 'general';

  const tone = /(urgent|급함|긴급|asap|빨리|지금)/i.test(combined)
    ? 'urgent'
    : /(sorry|apology|미안|사과)/i.test(combined)
      ? 'apologetic'
      : /(formal|공식|정중|존댓말|polite)/i.test(combined)
        ? 'formal'
        : /(chat|slack|메신저|dm|discord)/i.test(combined)
          ? 'casual'
          : /(summary|요약|report|보고)/i.test(combined)
            ? 'concise'
            : 'neutral';

  const intent = /(ask|question|why|how|what|궁금|문의)/i.test(combined)
    ? 'question'
    : /(sorry|apology|미안|사과)/i.test(combined)
      ? 'apology'
      : /(update|report|보고|status|상황)/i.test(combined)
        ? 'update'
        : /(next step|action|해야|할 일|to do|todo)/i.test(combined)
          ? 'action'
          : 'general';

  const urgency = /(urgent|급함|긴급|asap|빨리|지금|빠른)/i.test(combined) ? 'high' : 'normal';

  return { channel, audience, tone, intent, urgency, hints };
}

export function buildRemotePrompt({ transcript, context = '' }) {
  const profile = deriveContextProfile(context, transcript);

  return {
    model: 'gpt-4o-mini',
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          '너는 음성 인식 결과를 바탕으로 사용자가 실제로 의도했을 가능성이 높은 3가지 해석안을 만드는 편집 도우미다. 반드시 문맥 프로필을 반영하고, 세 후보는 서로 의미가 겹치지 않게 구분하라. 출력은 JSON 객체만 허용하며 키는 possibility1, possibility2, possibility3만 사용한다. 각 값은 자연스러운 한국어 또는 원문 언어로 작성하되, 설명 문구나 메타 설명은 넣지 마라. 세 후보의 역할은 다음과 같다: 가능성 1 = 가장 직접적인 해석, 가능성 2 = 문맥 보정 해석, 가능성 3 = 실행/요약 중심 해석.'
      },
      {
        role: 'user',
        content: JSON.stringify({ transcript, context, profile })
      }
    ]
  };
}

export function buildRewriteVariants(text, context = '') {
  const cleanedText = normalizeWhitespace(text);
  const profile = deriveContextProfile(context, cleanedText);

  if (!cleanedText) {
    return TRANSFORMERS.map((variant) => ({
      id: variant.id,
      label: variant.label,
      text: '텍스트가 들어오면 세 가지 가능성이 표시됩니다.'
    }));
  }

  return TRANSFORMERS.map((variant) => ({
    id: variant.id,
    label: variant.label,
    text: finalizeVariantText(variant.build({ text: cleanedText, profile }))
  }));
}

function simplifyText(text) {
  const withoutFillers = normalizeWhitespace(text)
    .replace(/\b(um+|uh+|like|you know|actually|basically)\b/gi, '')
    .replace(/\s+,/g, ',')
    .replace(/\s+([?.!,;:])/g, '$1');

  return withoutFillers || normalizeWhitespace(text);
}

function adaptToContext(text, profile) {
  const base = simplifyText(text);

  if (profile.tone === 'formal' || profile.audience === 'customer') {
    return softenText(base);
  }

  if (profile.channel === 'chat' || profile.urgency === 'high') {
    return tightenText(base);
  }

  if (profile.intent === 'question') {
    return ensureQuestionTone(base);
  }

  if (profile.intent === 'update' || profile.channel === 'report') {
    return structureAsUpdate(base);
  }

  return base;
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

function tightenText(text) {
  const result = simplifyText(text)
    .replace(/\b(I think|maybe|perhaps|probably)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]$/, '');

  return result || simplifyText(text);
}

function ensureQuestionTone(text) {
  const base = simplifyText(text);
  return /\?$/.test(base) ? base : `${base}?`;
}

function structureAsUpdate(text) {
  const base = simplifyText(text);
  const sentences = base.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length > 1) {
    return `업데이트:\n- ${sentences.join('\n- ')}`;
  }
  return `업데이트: ${base}`;
}

function makeActionable(text, profile) {
  const base = simplifyText(text)
    .replace(/^(please\s+)?/i, '')
    .replace(/\bwe should\b/gi, 'let’s')
    .replace(/\b(i need to|need to)\b/gi, 'next step:')
    .replace(/\b(can you|could you)\b/gi, 'please');

  if (profile.urgency === 'high') {
    return `우선순위 높음: ${base}`;
  }

  const sentences = base.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length > 1) {
    return `실행 계획:\n- ${sentences.join('\n- ')}`;
  }
  return `실행 계획: ${base}`;
}

function summaryNote(profile, fallback) {
  const parts = [];
  if (profile.channel !== 'general') parts.push(profile.channel);
  if (profile.audience !== 'general') parts.push(profile.audience);
  if (profile.tone !== 'neutral') parts.push(profile.tone);
  if (profile.intent !== 'general') parts.push(profile.intent);
  if (profile.urgency === 'high') parts.push('긴급');

  const note = parts.length ? parts.join(' · ') : fallback;
  return `맥락: ${note}`;
}

function finalizeVariantText(value) {
  return String(value ?? '')
    .split(/\n+/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean)
    .join('\n')
    .trim();
}
