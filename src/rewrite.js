import { predictRewriteFocus } from './ml.js';

const DEFAULT_HINTS = ['명확함', '자연스러움', '정리됨'];
const PHONETIC_REPLACEMENTS = [
  [/\buh\b/gi, ''],
  [/\bum\b/gi, ''],
  [/\blike\b/gi, ''],
  [/\byou know\b/gi, ''],
  [/\bactually\b/gi, ''],
  [/\bbasically\b/gi, ''],
  [/\bkind of\b/gi, 'kind of'],
  [/\bsort of\b/gi, 'sort of'],
  [/\bgonna\b/gi, 'going to'],
  [/\bwanna\b/gi, 'want to'],
  [/\bgotta\b/gi, 'have to'],
  [/\bcould of\b/gi, 'could have'],
  [/\bshould of\b/gi, 'should have'],
  [/\bwould of\b/gi, 'would have'],
  [/\bim\b/gi, "I'm"],
  [/\bdont\b/gi, "don't"],
  [/\bcant\b/gi, "can't"],
  [/\bwont\b/gi, "won't"],
  [/\bisnt\b/gi, "isn't"],
  [/\barent\b/gi, "aren't"],
  [/\b어\b/g, ''],
  [/\b음\b/g, ''],
  [/\b그\b/g, ''],
  [/\b저\b/g, ''],
  [/\b그러니까\b/g, ''],
  [/\b뭐지\b/g, ''],
  [/\b뭐였더라\b/g, '']
];

export function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function deriveContextProfile(text = '') {
  const source = normalizeWhitespace(text).toLowerCase();
  const hints = inferContextHints(source);
  const mlFocus = predictRewriteFocus(source);

  let channel = /(email|mail|이메일)/i.test(source)
    ? 'email'
    : /(chat|slack|메신저|dm|discord)/i.test(source)
      ? 'chat'
      : /(report|보고|summary|요약)/i.test(source)
        ? 'report'
        : /(presentation|발표|talk|설명)/i.test(source)
          ? 'presentation'
          : 'general';

  let tone = /(sorry|apology|미안|사과)/i.test(source)
    ? 'apologetic'
    : /(urgent|급함|긴급|asap|빨리|지금|빠른)/i.test(source)
      ? 'urgent'
      : /(formal|공식|정중|존댓말|polite)/i.test(source)
        ? 'formal'
        : /(summary|요약|report|보고)/i.test(source)
          ? 'concise'
          : 'neutral';

  let intent = /(ask|question|why|how|what|궁금|문의)/i.test(source)
    ? 'question'
    : /(sorry|apology|미안|사과)/i.test(source)
      ? 'apology'
      : /(update|report|보고|status|상황|결과)/i.test(source)
        ? 'update'
        : /(next step|action|해야|할 일|to do|todo|지금 처리)/i.test(source)
          ? 'action'
          : 'general';

  let urgency = /(urgent|급함|긴급|asap|빨리|지금|빠른)/i.test(source) ? 'high' : 'normal';

  switch (mlFocus.label) {
    case 'question':
      intent = 'question';
      if (tone === 'neutral') tone = 'casual';
      break;
    case 'action':
      intent = 'action';
      urgency = 'high';
      if (channel === 'general') channel = 'chat';
      break;
    case 'summary':
      channel = 'report';
      tone = 'concise';
      if (intent === 'general') intent = 'update';
      break;
    case 'apology':
      tone = 'apologetic';
      intent = 'apology';
      break;
    case 'polite':
      if (tone === 'neutral') tone = 'formal';
      break;
    default:
      break;
  }

  return { channel, tone, intent, urgency, hints, mlFocus };
}

export function inferContextHints(text) {
  const source = normalizeWhitespace(text).toLowerCase();
  const hints = [];

  if (!source) return DEFAULT_HINTS;
  if (/(email|mail|이메일)/i.test(source)) hints.push('공손함', '문서형');
  if (/(chat|slack|메신저|dm|discord)/i.test(source)) hints.push('짧음', '직접적');
  if (/(client|고객|customer|환자|member)/i.test(source)) hints.push('배려', '친절');
  if (/(summary|요약|report|보고)/i.test(source)) hints.push('간결함', '정리됨');
  if (/(apology|sorry|미안|사과)/i.test(source)) hints.push('사과', '부드러움');
  if (/(presentation|발표|talk|설명)/i.test(source)) hints.push('분명함', '자신감');
  if (/(urgent|급함|긴급|asap|빨리|지금|빠른)/i.test(source)) hints.push('긴급', '실행');

  return hints.length ? [...new Set(hints)] : DEFAULT_HINTS;
}

export function buildRewriteVariants(text) {
  const cleanedText = normalizeWhitespace(text);
  if (!cleanedText) {
    return [
      {
        id: 'possibility-1',
        label: '가능성 1 · 음성 보정본',
        text: '녹음을 정지하면 음성 보정본, 맥락 보정본, 종합본이 표시됩니다.'
      },
      {
        id: 'possibility-2',
        label: '가능성 2 · 맥락 보정본',
        text: '녹음을 정지하면 음성 보정본, 맥락 보정본, 종합본이 표시됩니다.'
      },
      {
        id: 'possibility-3',
        label: '가능성 3 · 종합본',
        text: '녹음을 정지하면 음성 보정본, 맥락 보정본, 종합본이 표시됩니다.'
      }
    ];
  }

  const profile = deriveContextProfile(cleanedText);
  const phonetic = buildPhoneticVariant(cleanedText);
  const contextual = buildContextVariant(cleanedText, profile);
  const combined = buildCombinedVariant(cleanedText, profile, phonetic, contextual);

  return [
    {
      id: 'possibility-1',
      label: '가능성 1 · 음성 보정본',
      text: phonetic
    },
    {
      id: 'possibility-2',
      label: '가능성 2 · 맥락 보정본',
      text: contextual
    },
    {
      id: 'possibility-3',
      label: '가능성 3 · 종합본',
      text: combined
    }
  ];
}

function buildPhoneticVariant(text) {
  const lines = normalizeWhitespace(text)
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
    .map((line) => applyPhoneticFixes(line));

  const joined = lines.join(' ').replace(/\s+([,.!?;:])/g, '$1');
  return ensureSentenceEnding(normalizeWhitespace(joined));
}

function buildContextVariant(text, profile) {
  const base = buildPhoneticVariant(text);

  if (profile.intent === 'question') {
    return buildQuestionVariant(base);
  }

  if (profile.intent === 'apology') {
    return buildApologyVariant(base);
  }

  if (profile.intent === 'update' || profile.channel === 'report') {
    return buildUpdateVariant(base);
  }

  if (profile.intent === 'action') {
    return buildActionVariant(base);
  }

  if (profile.tone === 'formal' || profile.tone === 'apologetic') {
    return buildPoliteVariant(base);
  }

  if (profile.mlFocus.label === 'summary') {
    return buildUpdateVariant(base);
  }

  return applyContextCorrections(base);
}

function buildCombinedVariant(text, profile, phonetic, contextual) {
  if (profile.intent === 'action') {
    return buildCombinedActionVariant(phonetic);
  }

  if (profile.intent === 'question') {
    return buildQuestionVariant(phonetic);
  }

  if (profile.intent === 'apology') {
    return buildApologyVariant(phonetic);
  }

  if (contextual !== phonetic) return contextual;
  return ensureSentenceEnding(normalizeWhitespace(text));
}

function applyPhoneticFixes(text) {
  let result = normalizeWhitespace(text);

  for (const [pattern, replacement] of PHONETIC_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }

  result = result
    .replace(/\s+/g, ' ')
    .replace(/\b(\w+)(?:\s+\1\b)+/gi, '$1')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();

  return ensureSentenceEnding(result);
}

function applyContextCorrections(text) {
  return normalizeWhitespace(text)
    .replace(/\bplease\b/gi, '')
    .replace(/\bcan you\b/gi, 'could you')
    .replace(/\bcould you\b/gi, 'could you')
    .replace(/\bneed to\b/gi, '해야 합니다')
    .replace(/\bI need to\b/gi, '제가 해야 합니다')
    .replace(/\blet's\b/gi, '함께')
    .replace(/\bupdate\b/gi, '업데이트')
    .replace(/\bfollow up\b/gi, '후속 확인')
    .replace(/\bsend\b/gi, '보내')
    .replace(/\breview\b/gi, '검토')
    .replace(/\bcheck\b/gi, '확인')
    .replace(/\breply\b/gi, '답장')
    .replace(/\bhelp\b/gi, '도움')
    .replace(/\bfix\b/gi, '수정')
    .replace(/\bissue\b/gi, '문제')
    .replace(/\bteam\b/gi, '팀')
    .replace(/\bclient\b/gi, '고객')
    .replace(/\bcustomer\b/gi, '고객')
    .replace(/\bstatus\b/gi, '상태')
    .replace(/\bsummary\b/gi, '요약')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

function buildQuestionVariant(text) {
  return ensureQuestionTone(applyContextCorrections(text));
}

function buildApologyVariant(text) {
  return softenText(applyContextCorrections(text));
}

function buildUpdateVariant(text) {
  return structureAsUpdate(applyContextCorrections(text));
}

function buildActionVariant(text) {
  const base = normalizeWhitespace(text);
  const lower = base.toLowerCase();

  if (/(send|보내).*(update|업데이트).*(team|팀)/i.test(lower) || /(update|업데이트).*(team|팀)/i.test(lower)) {
    return '팀에 업데이트를 보내야 합니다.';
  }

  if (/(follow up|후속).*(team|팀|client|고객)/i.test(lower)) {
    return '팀과 후속 확인을 진행해야 합니다.';
  }

  if (/(need to|해야|할 일|action)/i.test(lower)) {
    return `실행 계획: ${normalizeWhitespace(base)}`;
  }

  return makeActionable(applyContextCorrections(text));
}

function buildCombinedActionVariant(text) {
  const base = normalizeWhitespace(text);
  const lower = base.toLowerCase();

  if (/(send|보내).*(update|업데이트).*(team|팀)/i.test(lower) || /(update|업데이트).*(team|팀)/i.test(lower)) {
    return '팀에 업데이트를 보내고 진행 상황까지 공유해야 합니다.';
  }

  if (/(follow up|후속).*(team|팀|client|고객)/i.test(lower)) {
    return '팀과 후속 확인을 진행하고 결과를 공유해야 합니다.';
  }

  const action = buildActionVariant(text);
  return action.startsWith('실행 계획:') ? action : `실행 계획: ${action}`;
}

function softenText(text) {
  return normalizeWhitespace(text)
    .replace(/^i\s+need\s+to\b/i, "I'd appreciate it if we could")
    .replace(/^i\s+want\s+to\b/i, "I'd like to")
    .replace(/^i\s+can't\b/i, 'I may not be able to')
    .replace(/^i\s+cannot\b/i, 'I may not be able to')
    .replace(/\b(can't|cannot)\b/gi, 'may not be able to')
    .replace(/\bwant to\b/gi, 'would like to')
    .replace(/\bneed to\b/gi, 'would appreciate it if we could')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

function makeActionable(text) {
  const result = normalizeWhitespace(text)
    .replace(/^please\s+/i, '')
    .replace(/\bwe should\b/gi, 'let’s')
    .replace(/\bshould\b/gi, '해야 합니다')
    .replace(/\bmust\b/gi, '반드시')
    .replace(/\bcan you\b/gi, 'please')
    .replace(/\bcould you\b/gi, 'please')
    .replace(/\bfollow up\b/gi, '후속 확인')
    .replace(/\bupdate\b/gi, '업데이트')
    .replace(/\bsend\b/gi, '보내')
    .replace(/\breview\b/gi, '검토')
    .replace(/\bcheck\b/gi, '확인')
    .replace(/\breply\b/gi, '답장')
    .replace(/\bfix\b/gi, '수정')
    .replace(/\bissue\b/gi, '문제')
    .replace(/\bteam\b/gi, '팀')
    .replace(/\bclient\b/gi, '고객')
    .replace(/\bcustomer\b/gi, '고객')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();

  const sentences = result.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length > 1) {
    return `실행 계획:\n- ${sentences.join('\n- ')}`;
  }
  return `실행 계획: ${result}`;
}

function structureAsUpdate(text) {
  const base = normalizeWhitespace(text);
  const sentences = base.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length > 1) {
    return `업데이트:\n- ${sentences.join('\n- ')}`;
  }
  return `업데이트: ${base}`;
}

function ensureQuestionTone(text) {
  const base = normalizeWhitespace(text);
  return /\?$/.test(base) ? base : `${base}?`;
}

function ensureSentenceEnding(text) {
  const base = normalizeWhitespace(text);
  if (!base) return base;
  if (/[.!?]$/.test(base)) return base;
  return `${base}.`;
}
