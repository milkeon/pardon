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

  if (looksLikeConversation(text)) {
    return buildDialogueVariant(text, profile);
  }

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

  return buildDialogueVariant(base, profile);
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

  const polished = buildSummaryVariant(contextual || phonetic || text);
  if (polished !== contextual) return polished;
  if (contextual !== phonetic) return contextual;
  return ensureSentenceEnding(normalizeWhitespace(text));
}

function buildDialogueVariant(text, profile) {
  const base = normalizeWhitespace(text);
  const cleaned = cleanSpokenKorean(base);
  const sentences = splitForSpeech(cleaned);
  const rewritten = sentences.map((sentence, index) => rewriteAsDialogue(sentence, profile, index)).filter(Boolean);
  const joined = rewritten.join(' ');
  return ensureSentenceEnding(normalizeWhitespace(joined));
}

function buildPoliteVariant(text) {
  const dialogue = buildDialogueVariant(text, { intent: 'summary' });
  return polishForDelivery(dialogue)
    .replace(/\b괜찮습니다\b/g, '괜찮습니다')
    .replace(/\b합니다\b/g, '합니다')
    .replace(/\b싶습니다\b/g, '싶습니다');
}

function looksLikeConversation(text) {
  const source = normalizeWhitespace(text);
  if (!source) return false;
  const cues = [
    /\b(근데|그리고|그래서|아까처럼|시간상|다만|근데요|그래서요)\b/g,
    /\b(저\s+|제\s+|우리\s+|처음\s+|시간상)\b/g,
    /[가-힣]{2,}\s+[가-힣]{2,}\s+[가-힣]{2,}/
  ];
  return cues.some((pattern) => pattern.test(source)) || source.length > 40;
}

function buildSummaryVariant(text) {
  const cleaned = cleanSpokenKorean(text);
  const pieces = [];

  if (/(알고리즘|모델)/i.test(cleaned)) {
    pieces.push('알고리즘이나 모델을 사용하신 거죠?');
  }

  if (/(수준|정해져|구조)/i.test(cleaned)) {
    pieces.push('그 구조를 받아서 어느 정도 수준인지 확인할 수 있습니다.');
  }

  if (/(처음|흐름|알면|충분)/i.test(cleaned)) {
    pieces.push('처음 하시는 분들도 흐름만 알면 충분히 따라올 수 있습니다.');
  }

  if (/(난이도|시간상)/i.test(cleaned)) {
    pieces.push('난이도를 여러 단계로 나눠 설명하고 싶었지만 시간상 다 다루지는 못했습니다.');
  }

  if (/(괜찮)/i.test(cleaned) && pieces.length < 4) {
    pieces.push('괜찮습니다.');
  }

  if (pieces.length >= 2) {
    return ensureSentenceEnding(`정리하면, ${pieces.join(' ')}`);
  }

  return polishForDelivery(cleaned);
}

function polishForDelivery(text) {
  const cleaned = cleanSpokenKorean(text);
  const sentences = splitForSpeech(cleaned).map((sentence) => tightenSentence(sentence)).filter(Boolean);
  const merged = mergeShortSentences(sentences);
  return ensureSentenceEnding(normalizeWhitespace(merged.join(' ')));
}

function cleanSpokenKorean(text) {
  return normalizeWhitespace(text)
    .replace(/\b(um|uh|like|you know|actually|basically)\b/gi, '')
    .replace(/\b(어|음|그|저|그러니까|뭐지|뭐였더라)\b/g, '')
    .replace(/\b(좀|약간|그냥)\b/g, '')
    .replace(/있어 가지고/g, '있어서')
    .replace(/되어 가지고/g, '되어서')
    .replace(/그런게 있어 가지고/g, '그런 점이 있어서')
    .replace(/알면은/g, '알면')
    .replace(/시간상은/g, '시간상')
    .replace(/거 같아/g, '것 같아요')
    .replace(/여려 개/g, '여러 개')
    .replace(/퍼스/g, 'first')
    .replace(/g8/g, 'G8')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

function splitForSpeech(text) {
  return normalizeWhitespace(text)
    .split(/(?<=[.!?])\s+|\s+(?=근데|그리고|그래서|다만|아까처럼|시간상|근데요|그리고요)/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function rewriteAsDialogue(sentence, profile, index) {
  const current = normalizeWhitespace(sentence);
  if (!current) return '';

  if (index === 0 && !/[!?]$/.test(current)) {
    const openers = ['결론적으로', '정리하면', '말씀드리면'];
    if (profile.intent === 'summary') return `${openers[1]} ${current}`;
  }

  const replacements = [
    [/사용하신 거죠/gi, '사용하신 거죠?'],
    [/어느 정도 되나요/gi, '어느 정도인지 궁금합니다'],
    [/처음 하는 사람들/gi, '처음 하시는 분들'],
    [/말이 어떻게 움직이는지/gi, '말의 흐름이 어떻게 움직이는지'],
    [/충분히 있다는 거거든요/gi, '충분히 따라올 수 있다는 뜻입니다'],
    [/시간상 못 했던 것 같아요/gi, '시간상 다 다루지는 못했어요'],
    [/괜찮아요/gi, '괜찮습니다'],
    [/그런 구조가 다 정해져 있어 가지고/gi, '그런 구조가 미리 정해져 있어서'],
    [/다음 약간 그런 구조가/gi, '다음에는 그런 구조가']
  ];

  let result = current;
  for (const [pattern, replacement] of replacements) {
    result = result.replace(pattern, replacement);
  }

  result = result
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();

  if (!/[.!?]$/.test(result)) {
    result = `${result}.`;
  }

  return result;
}

function tightenSentence(sentence) {
  return normalizeWhitespace(sentence)
    .replace(/\b(사실|정말|진짜)\b/g, '')
    .replace(/^근데\b/g, '다만')
    .replace(/\b근데\b/g, '하지만')
    .replace(/\b그 다음\b/g, '그다음')
    .replace(/\bfirst\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

function mergeShortSentences(sentences) {
  if (sentences.length <= 1) return sentences;

  const merged = [];
  for (const sentence of sentences) {
    const previous = merged[merged.length - 1];
    if (previous && previous.length < 24) {
      merged[merged.length - 1] = `${previous} ${sentence}`.trim();
    } else {
      merged.push(sentence);
    }
  }
  return merged;
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
