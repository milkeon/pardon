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

const TRANSCRIPT_STOPWORDS = new Set([
  '그리고', '그런데', '그래서', '다만', '하지만', '또', '즉', '결국', '왜냐하면', '시간상', '아무튼', '아까처럼',
  '그', '이', '저', '것', '거', '수', '등', '좀', '약간', '그냥', '조금', '대충', '진짜', '사실', '정말', '아주',
  '아마', '거의', '이미', '이제', '다시', '처음', '현재', '상황', '내용', '부분', '문장', '말', '것들', '여기', '저기'
]);

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
  const rawText = String(text ?? '');
  const cleanedText = normalizeWhitespace(rawText);
  if (!cleanedText) {
    return [
      {
        id: 'possibility-1',
        label: '제안 1 · 원문 보정',
        text: '녹음을 정지하면 원문 보정, 자연스러운 문장, 정리된 문장이 표시됩니다.'
      },
      {
        id: 'possibility-2',
        label: '제안 2 · 자연스러운 문장',
        text: '녹음을 정지하면 원문 보정, 자연스러운 문장, 정리된 문장이 표시됩니다.'
      },
      {
        id: 'possibility-3',
        label: '제안 3 · 정리된 문장',
        text: '녹음을 정지하면 원문 보정, 자연스러운 문장, 정리된 문장이 표시됩니다.'
      }
    ];
  }

  const profile = deriveContextProfile(rawText);
  const phonetic = buildPhoneticVariant(rawText);
  const balanced = buildBalancedVariant(rawText, profile);
  const organized = buildOrganizedVariant(rawText, profile);

  return [
    {
      id: 'possibility-1',
      label: '제안 1 · 원문 보정',
      text: phonetic
    },
    {
      id: 'possibility-2',
      label: '제안 2 · 자연스러운 문장',
      text: balanced
    },
    {
      id: 'possibility-3',
      label: '제안 3 · 정리된 문장',
      text: organized
    }
  ];
}

function buildPhoneticVariant(text) {
  const clauses = splitTranscriptClauses(text);
  const sourceClauses = clauses.length ? clauses : [normalizeWhitespace(text)];
  const lines = sourceClauses
    .filter(Boolean)
    .map((line) => applyPhoneticFixes(line));

  const joined = lines.join(' ')
    .replace(/\s+([,.!?;:])/g, '$1');

  return ensureSentenceEnding(normalizeWhitespace(joined));
}

function buildContextVariant(text, profile) {
  const structure = analyzeTranscriptStructure(text, profile);
  const clauses = splitTranscriptClauses(text);
  const sourceClauses = clauses.length ? clauses : [normalizeWhitespace(text)];
  const cleanedClauses = dedupeClauses(
    sourceClauses
      .map((clause) => applyTranscriptCorrections(cleanSpokenKorean(applyPhoneticFixes(clause))))
      .filter(Boolean)
  );

  if (!cleanedClauses.length) {
    return buildPhoneticVariant(text);
  }

  if (cleanedClauses.length === 1) {
    return ensureSentenceEnding(normalizeWhitespace(cleanedClauses[0]));
  }

  const selectedClauses = cleanedClauses.length > 4
    ? selectVariantClauses(cleanedClauses, profile, structure, 4)
    : cleanedClauses;

  return ensureSentenceEnding(normalizeWhitespace(selectedClauses.join(' ')));
}

function buildCombinedVariant(text, profile, phonetic, contextual) {
  const structure = analyzeTranscriptStructure(text, profile);
  const clauses = splitTranscriptClauses(text);
  const sourceClauses = clauses.length ? clauses : [contextual || phonetic || normalizeWhitespace(text)];
  const cleanedClauses = dedupeClauses(
    sourceClauses
      .map((clause) => applyContextCorrections(applyTranscriptCorrections(cleanSpokenKorean(applyPhoneticFixes(clause)))))
      .filter(Boolean)
  );

  if (!cleanedClauses.length) {
    return contextual || phonetic || ensureSentenceEnding(normalizeWhitespace(text));
  }

  if (cleanedClauses.length === 1) {
    return ensureSentenceEnding(normalizeWhitespace(cleanedClauses[0]));
  }

  const selectedClauses = cleanedClauses.length > 4
    ? selectVariantClauses(cleanedClauses, profile, structure, 4)
    : cleanedClauses;

  const merged = normalizeWhitespace(selectedClauses.join(' '));
  if (!merged) return contextual || phonetic || ensureSentenceEnding(normalizeWhitespace(text));
  return ensureSentenceEnding(merged);
}

function buildBalancedVariant(text, profile) {
  const lower = normalizeWhitespace(text).toLowerCase();
  switch (profile.mlFocus?.label) {
    case 'action':
      if (/(send|보내).*(update|업데이트).*(team|팀)/i.test(lower) || /(update|업데이트).*(team|팀)/i.test(lower)) {
        return '팀에 업데이트를 보내야 합니다.';
      }
      return buildActionVariant(text);
    case 'question':
      return buildQuestionVariant(text);
    case 'apology':
      return buildApologyVariant(text);
    case 'summary':
      return buildUpdateVariant(text);
    case 'polite':
      return buildPoliteVariant(text);
    default:
      return looksLikeConversation(text) ? buildDialogueVariant(text, profile) : buildPoliteVariant(text);
  }
}

function buildOrganizedVariant(text, profile) {
  const lower = normalizeWhitespace(text).toLowerCase();
  switch (profile.mlFocus?.label) {
    case 'action':
      if (/(send|보내).*(update|업데이트).*(team|팀)/i.test(lower) || /(update|업데이트).*(team|팀)/i.test(lower)) {
        return '팀에 업데이트를 보내고 진행 상황까지 공유해야 합니다.';
      }
      return buildCombinedActionVariant(text);
    case 'question':
      return buildQuestionVariant(text);
    case 'apology':
      return buildApologyVariant(text);
    case 'summary':
      return buildSummaryVariant(text, profile);
    case 'polite':
      return buildPoliteVariant(text);
    default:
      return buildSummaryVariant(text, profile);
  }
}

function buildDialogueVariant(text, profile = deriveContextProfile(text), structure = analyzeTranscriptStructure(text, profile)) {
  const base = normalizeWhitespace(text);
  const cleaned = applyTranscriptCorrections(cleanSpokenKorean(base));
  const fragments = extractSalientFragments(cleaned, profile, structure, 2);

  if (!fragments.length) {
    return ensureSentenceEnding(normalizeWhitespace(cleaned));
  }

  const opener = chooseVariantOpener(profile, structure, 'dialogue');
  const joined = stitchClauses(fragments, 'dialogue');
  return ensureSentenceEnding(normalizeWhitespace(`${opener} ${joined}`));
}

function buildPoliteVariant(text) {
  const dialogue = buildDialogueVariant(text, deriveContextProfile(text));
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

function buildSummaryVariant(text, profile = deriveContextProfile(text), structure = analyzeTranscriptStructure(text, profile)) {
  const cleaned = applyTranscriptCorrections(cleanSpokenKorean(text));
  const fragments = extractSalientFragments(cleaned, profile, structure, 3);

  if (!fragments.length) {
    return polishForDelivery(cleaned);
  }

  const opener = chooseVariantOpener(profile, structure, 'summary');
  const joined = stitchClauses(fragments, 'summary');
  return ensureSentenceEnding(normalizeWhitespace(opener ? `${opener}, ${joined}` : joined));
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
    .replace(/상황으로 인지하고/g, '상황을 인지하고')
    .replace(/데이터가 부족해 가지고/g, '데이터가 부족해서')
    .replace(/부족해셔/g, '부족해서')
    .replace(/자연 처리/g, '자연어 처리')
    .replace(/구체적으로 해야 돼/g, '구체적으로 해야 합니다')
    .replace(/구체적으로 해야돼/g, '구체적으로 해야 합니다')
    .replace(/명확하게 해야 돼/g, '명확하게 해야 합니다')
    .replace(/퍼스/g, 'first')
    .replace(/g8/g, 'G8')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

function splitForSpeech(text) {
  return normalizeWhitespace(text)
    .replace(/([.!?])/g, '$1|')
    .split('|')
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function splitTranscriptClauses(text) {
  return normalizeWhitespace(text)
    .replace(/([.!?])/g, '$1|')
    .replace(/\s+(근데|그리고|그래서|다만|하지만|그런데|또|즉|결국|왜냐하면|시간상|아무튼|아까처럼)\s+/g, '|$1 ')
    .split('|')
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function analyzeTranscriptStructure(text, profile) {
  const cleaned = applyTranscriptCorrections(cleanSpokenKorean(text));
  const clauses = splitTranscriptClauses(cleaned);
  const signatures = new Set();
  let repeatedClauses = 0;

  for (const clause of clauses) {
    const signature = buildClauseSignature(clause);
    if (!signature) continue;
    if (signatures.has(signature)) {
      repeatedClauses += 1;
    } else {
      signatures.add(signature);
    }
  }

  const fillerCount = (cleaned.match(/\b(어|음|그|저|그러니까|뭐지|뭐였더라|좀|약간|그냥)\b/g) || []).length;
  const longForm = cleaned.length > 60 || clauses.length > 2;
  const shouldSummarize = longForm && (repeatedClauses > 0 || fillerCount > 0 || profile.mlFocus.label === 'summary' || profile.mlFocus.confidence < 0.6);

  return {
    cleaned,
    clauses,
    longForm,
    repeatedClauses,
    fillerCount,
    shouldSummarize
  };
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

function selectVariantClauses(clauses, profile, structure, maxClauses) {
  const cleanedClauses = dedupeClauses(clauses.map((clause) => applyContextCorrections(cleanSpokenKorean(clause))).filter(Boolean));
  if (cleanedClauses.length <= maxClauses) return cleanedClauses;

  const scored = cleanedClauses.map((clause, index) => ({
    clause,
    index,
    score: scoreClause(clause, profile, structure)
  }));

  const chosen = scored
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, maxClauses)
    .sort((left, right) => left.index - right.index)
    .map((item) => item.clause);

  return chosen.length ? chosen : cleanedClauses.slice(0, maxClauses);
}

function extractSalientFragments(text, profile, structure, maxFragments) {
  const clauses = structure.clauses.length ? structure.clauses : splitTranscriptClauses(text);
  const selectedClauses = selectVariantClauses(clauses, profile, structure, maxFragments);
  if (selectedClauses.length > 1 || !structure.longForm) {
    return selectedClauses;
  }

  const tokens = normalizeWhitespace(text).split(' ').filter(Boolean);
  if (tokens.length <= 6) return selectedClauses.length ? selectedClauses : [tightenSentence(text)];

  const windowSize = Math.max(6, Math.min(12, Math.ceil(tokens.length / 4)));
  const windows = [];

  for (let index = 0; index <= tokens.length - windowSize; index += 1) {
    const slice = tokens.slice(index, index + windowSize);
    const fragment = tightenSentence(slice.join(' '));
    if (!fragment) continue;

    windows.push({
      fragment,
      index,
      score: scoreFragment(fragment, profile, structure)
    });
  }

  const chosen = windows
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .filter((window, index, list) => {
      const overlap = list.slice(0, index).some((other) => Math.abs(other.index - window.index) < windowSize / 2);
      return !overlap;
    })
    .slice(0, maxFragments)
    .sort((left, right) => left.index - right.index)
    .map((window) => window.fragment);

  return chosen.length ? chosen : selectedClauses.length ? selectedClauses : [tightenSentence(text)];
}

function dedupeClauses(clauses) {
  const seen = new Set();
  const result = [];

  for (const clause of clauses) {
    const signature = buildClauseSignature(clause);
    if (!signature || seen.has(signature)) continue;
    seen.add(signature);
    result.push(tightenSentence(clause));
  }

  return result;
}

function buildClauseSignature(clause) {
  return normalizeWhitespace(clause)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((token) => token.length > 1 && !TRANSCRIPT_STOPWORDS.has(token))
    .join(' ');
}

function scoreClause(clause, profile, structure) {
  const lowered = normalizeWhitespace(clause).toLowerCase();
  const tokens = lowered.split(/\s+/).filter(Boolean);
  const contentTokens = tokens.filter((token) => token.length > 1 && !TRANSCRIPT_STOPWORDS.has(token));
  let score = contentTokens.length * 2;

  if (profile.intent === 'summary' && /(정리|요약|핵심|데이터|부족|문맥|상황|원인|결과|흐름)/i.test(lowered)) score += 6;
  if (profile.intent === 'question' && /(왜|어떻게|무엇|궁금|질문|알려)/i.test(lowered)) score += 6;
  if (profile.intent === 'action' && /(해야|필요|진행|보내|확인|수정|공유|처리)/i.test(lowered)) score += 6;
  if (profile.intent === 'apology' && /(죄송|미안|실수|사과|delay|confusion)/i.test(lowered)) score += 6;
  if (profile.tone === 'formal') score += 1;
  if (structure.longForm) score += Math.min(4, Math.floor(clause.length / 24));
  if (structure.fillerCount > 0) score += 1;
  if (/^(근데|그리고|그래서|다만|하지만|그런데)/.test(lowered)) score -= 1;
  if (contentTokens.length <= 2) score -= 2;

  return score;
}

function scoreFragment(fragment, profile, structure) {
  return scoreClause(fragment, profile, structure) + (fragment.length > 80 ? 2 : 0);
}

function chooseVariantOpener(profile, structure, mode) {
  const label = profile.mlFocus.label;
  if (mode === 'summary') {
    if (label === 'question') return '질문하신 내용을 정리하면';
    if (label === 'action') return '실행 관점에서 정리하면';
    if (label === 'apology') return '죄송하지만 정리하면';
    if (label === 'polite') return '말씀드리면';
    if (structure.shouldSummarize) return '';
    return '';
  }

  if (label === 'question') return '즉';
  if (label === 'action') return '해야 할 일은';
  if (label === 'apology') return '죄송하지만';
  if (label === 'summary') return '';
  if (profile.tone === 'formal') return '말씀드리면';
  return '';
}

function stitchClauses(clauses, mode) {
  if (!clauses.length) return '';
  if (clauses.length === 1) return clauses[0];

  return clauses
    .map((clause) => stripLeadingConnector(clause))
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

function stripLeadingConnector(text) {
  return normalizeWhitespace(text).replace(/^(그리고|그런데|그래서|다만|하지만|또|즉|결국)\s+/i, '').trim();
}

function applyTranscriptCorrections(text) {
  return normalizeWhitespace(text)
    .replace(/상황으로 인지하고/g, '상황을 인지하고')
    .replace(/데이터가 부족해 가지고/g, '데이터가 부족해서')
    .replace(/부족해셔/g, '부족해서')
    .replace(/자연 처리/g, '자연어 처리')
    .replace(/구체적으로 해야 돼/g, '구체적으로 해야 합니다')
    .replace(/구체적으로 해야돼/g, '구체적으로 해야 합니다')
    .replace(/명확하게 해야 돼/g, '명확하게 해야 합니다')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
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
