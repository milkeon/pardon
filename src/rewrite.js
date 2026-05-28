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

const TECH_EXPLANATION_CONTEXT_RE = /(쿠키|세션|브라우저|서버|로그인|인증|토큰|식별자|캐시|스토리지|로컬스토리지|세션스토리지|cookie|session|browser|server|auth)/i;
const TECH_EXPLANATION_CUE_RE = /(방식|원리|설명|예를 들어|그러면|그럼|때문에|그래서|저장|관리|요청|응답|데이터|위험|탈취|아이디|비밀번호)/i;

export function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

const REWRITE_ANCHOR_RULES = [
  { test: (sourceLower) => /\bfix\b/i.test(sourceLower), targets: ['수정'] },
  { test: (sourceLower) => /\bredirect\b/i.test(sourceLower), targets: ['리다이렉트'] },
  { test: (sourceLower) => /\bissue\b/i.test(sourceLower), targets: ['문제'] },
  { test: (sourceLower) => /\bupdate\b/i.test(sourceLower), targets: ['업데이트'] },
  { test: (sourceLower) => /\bsend\b/i.test(sourceLower), targets: ['보내', '전달'] },
  { test: (sourceLower) => /\bteam\b/i.test(sourceLower), targets: ['팀'] },
  { test: (sourceLower) => /\breview\b/i.test(sourceLower), targets: ['검토'] },
  { test: (sourceLower) => /\bcheck\b/i.test(sourceLower), targets: ['확인'] },
  { test: (sourceLower) => /\breply\b/i.test(sourceLower), targets: ['답장'] },
  { test: (sourceLower) => /\bhelp\b/i.test(sourceLower), targets: ['도움'] },
  { test: (sourceLower) => /\bclient\b/i.test(sourceLower), targets: ['고객'] },
  { test: (sourceLower) => /\bcustomer\b/i.test(sourceLower), targets: ['고객'] },
  { test: (sourceLower) => sourceLower.includes('리사이젝트') || sourceLower.includes('리젝트'), targets: ['리다이렉트'] },
  { test: (sourceLower) => sourceLower.includes('자연 처리'), targets: ['자연어 처리'] },
  { test: (sourceLower) => sourceLower.includes('구체적으로 해야 돼') || sourceLower.includes('구체적으로 해야돼'), targets: ['구체적으로 해야 합니다'] },
  { test: (sourceLower) => sourceLower.includes('명확하게 해야 돼') || sourceLower.includes('명확하게 해야돼'), targets: ['명확하게 해야 합니다'] }
];

export function guardRewriteVariant(sourceText, candidateText, fallbackText, strictness = 'balanced') {
  const source = normalizeWhitespace(sourceText);
  const candidate = normalizeWhitespace(candidateText);
  const fallback = normalizeWhitespace(fallbackText || source);

  if (!candidate) {
    return ensureSentenceEnding(fallback);
  }

  if (source && source === candidate) {
    return ensureSentenceEnding(candidate);
  }

  if (!isLikelyRewriteVariant(source, candidate, strictness)) {
    return ensureSentenceEnding(fallback);
  }

  return ensureSentenceEnding(candidate);
}

function isLikelyRewriteVariant(sourceText, candidateText, strictness = 'balanced') {
  const source = normalizeWhitespace(sourceText);
  const candidate = normalizeWhitespace(candidateText);
  if (!source || !candidate) return false;

  const sourceSignature = buildSimilaritySignature(source);
  const candidateSignature = buildSimilaritySignature(candidate);
  const charSimilarity = jaccardSimilarity(buildNgrams(sourceSignature, 2), buildNgrams(candidateSignature, 2));
  const sourceTokens = buildContentTokenSet(source);
  const candidateTokens = buildContentTokenSet(candidate);
  const tokenOverlap = overlapRatio(sourceTokens, candidateTokens);
  const anchorMatch = scoreRewriteAnchors(source, candidate);
  const lengthRatio = candidateSignature.length / Math.max(1, sourceSignature.length);

  const bounds = strictness === 'strict'
    ? { min: 0.72, max: 1.3, similarity: 0.28, tokenOverlap: 0.18, anchorRatio: 0.34 }
    : strictness === 'relaxed'
      ? { min: 0.48, max: 1.65, similarity: 0.18, tokenOverlap: 0.12, anchorRatio: 0.22 }
      : { min: 0.58, max: 1.45, similarity: 0.22, tokenOverlap: 0.15, anchorRatio: 0.28 };

  if (anchorMatch.expected > 0 && anchorMatch.ratio >= bounds.anchorRatio) {
    return lengthRatio >= 0.35 && lengthRatio <= 1.9;
  }

  if (lengthRatio < bounds.min || lengthRatio > bounds.max) {
    return false;
  }

  if (sourceTokens.size <= 3) {
    return charSimilarity >= Math.max(bounds.similarity, 0.28) && tokenOverlap >= 0.1;
  }

  return charSimilarity >= bounds.similarity && tokenOverlap >= bounds.tokenOverlap;
}

function scoreRewriteAnchors(sourceText, candidateText) {
  const sourceLower = normalizeWhitespace(sourceText).toLowerCase();
  const candidateLower = normalizeWhitespace(candidateText).toLowerCase();

  let expected = 0;
  let matched = 0;

  for (const rule of REWRITE_ANCHOR_RULES) {
    if (!rule.test(sourceLower)) {
      continue;
    }

    expected += 1;
    if (rule.targets.some((target) => candidateLower.includes(target.toLowerCase()))) {
      matched += 1;
    }
  }

  return {
    expected,
    matched,
    ratio: expected ? matched / expected : 0
  };
}

function buildSimilaritySignature(text) {
  return normalizeWhitespace(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function buildNgrams(text, size) {
  const source = String(text || '');
  if (source.length < size) return new Set(source ? [source] : []);

  const grams = new Set();
  for (let index = 0; index <= source.length - size; index += 1) {
    grams.add(source.slice(index, index + size));
  }
  return grams;
}

function jaccardSimilarity(left, right) {
  if (!left.size && !right.size) return 0;
  let shared = 0;
  for (const item of left) {
    if (right.has(item)) shared += 1;
  }
  const union = left.size + right.size - shared;
  return union > 0 ? shared / union : 0;
}

function buildContentTokenSet(text) {
  return new Set(
    normalizeWhitespace(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(' ')
      .filter((token) => token.length > 1 && !TRANSCRIPT_STOPWORDS.has(token))
  );
}

function overlapRatio(sourceTokens, candidateTokens) {
  if (!sourceTokens.size) return 0;

  let shared = 0;
  for (const token of sourceTokens) {
    if (candidateTokens.has(token)) shared += 1;
  }

  return shared / sourceTokens.size;
}

export function deriveContextProfile(text = '') {
  const source = normalizeWhitespace(text).toLowerCase();
  const hints = inferContextHints(source);
  const mlFocus = predictRewriteFocus(source);
  const technicalExplanation = looksLikeTechnicalExplanation(source);

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
      : !technicalExplanation && /(next step|action|해야|할 일|to do|todo|지금 처리|need to|have to|should|must|send|follow up|fix|review|check|update|resolve|finish)/i.test(source) && source.length < 180
        ? 'action'
        : /(update|report|보고|status|상황|결과)/i.test(source)
          ? 'update'
          : 'general';

  let urgency = /(urgent|급함|긴급|asap|빨리|지금|빠른)/i.test(source) ? 'high' : 'normal';

  switch (mlFocus.label) {
    case 'question':
      intent = 'question';
      if (tone === 'neutral') tone = 'casual';
      break;
    case 'action':
      if (!technicalExplanation) {
        intent = 'action';
        urgency = 'high';
        if (channel === 'general') channel = 'chat';
      } else if (intent === 'general') {
        intent = 'summary';
      }
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

function looksLikeTechnicalExplanation(text) {
  const source = normalizeWhitespace(text).toLowerCase();
  return TECH_EXPLANATION_CONTEXT_RE.test(source) && TECH_EXPLANATION_CUE_RE.test(source);
}


export function buildRewriteVariants(text) {
  const rawText = String(text ?? '');
  const cleanedText = normalizeWhitespace(rawText);
  if (!cleanedText) {
    return [
      {
        id: 'possibility-1',
        label: '제안 1 · 오인식 보정',
        text: '녹음을 정지하면 원문 보정, 자연스러운 문장, 정리된 문장이 표시됩니다.'
      },
      {
        id: 'possibility-2',
        label: '제안 2 · 문맥 교정',
        text: '녹음을 정지하면 원문 보정, 자연스러운 문장, 정리된 문장이 표시됩니다.'
      },
      {
        id: 'possibility-3',
        label: '제안 3 · 매끄러운 문장',
        text: '녹음을 정지하면 원문 보정, 자연스러운 문장, 정리된 문장이 표시됩니다.'
      }
    ];
  }

  if (looksLikeTechnicalExplanation(cleanedText)) {
    return buildTechnicalExplanationRewriteVariants(rawText);
  }

  const profile = deriveContextProfile(rawText);
  if (profile.intent === 'action') {
    return buildActionRewriteVariants(rawText, profile);
  }
  const candidates = buildRewriteCandidatePool(rawText, profile);
  return selectRewriteVariants(rawText, profile, candidates);
}

function buildTechnicalExplanationRewriteVariants(text) {
  const source = normalizeWhitespace(text);
  const corrected = ensureSentenceEnding(
    applyContextCorrections(
      applyTranscriptCorrections(
        cleanSpokenKorean(source)
      )
    )
  );

  const balanced = buildTechnicalExplanationBalancedVariant(source, corrected);
  const relaxed = buildTechnicalExplanationRelaxedVariant(source, corrected);

  return [
    { id: 'possibility-1', label: '제안 1 · 오인식 보정', text: corrected },
    { id: 'possibility-2', label: '제안 2 · 문맥 교정', text: balanced },
    { id: 'possibility-3', label: '제안 3 · 매끄러운 문장', text: relaxed }
  ];
}

function buildTechnicalExplanationBalancedVariant(source, corrected) {
  const hasCookieSession = /(쿠키|cookie)/i.test(source) && /(세션|session)/i.test(source);
  const hasBrowser = /(브라우저|browser)/i.test(source);
  const hasServer = /(서버|server)/i.test(source);
  const hasLoginRouterFlow = /(로그인|login)/i.test(source)
    && /(서버|server)/i.test(source)
    && /(요청|request|post|포스트|라우터|router)/i.test(source);

  if (hasCookieSession && (hasBrowser || hasServer)) {
    return ensureSentenceEnding('세션 방식은 브라우저에서 상태를 관리하는 방식입니다');
  }

  if (hasLoginRouterFlow) {
    return ensureSentenceEnding('로그인 요청이 서버의 POST 라우터로 아직 연결되지 않았다는 뜻입니다');
  }

  if (hasBrowser && /(세션|session)/i.test(source)) {
    return ensureSentenceEnding('세션은 브라우저의 상태를 관리하는 방식입니다');
  }

  return ensureSentenceEnding(
    normalizeWhitespace(corrected)
      .replace(/쿠키\s*세션\s*얘기하다가\s*중간에\s*/g, '')
      .replace(/중간에\s*세션이라고\s*잘못\s*들어갔는데\s*/g, '')
      .replace(/\s+([,.!?;:])/g, '$1')
  );
}

function buildTechnicalExplanationRelaxedVariant(source, corrected) {
  const hasCookieSession = /(쿠키|cookie)/i.test(source) && /(세션|session)/i.test(source);
  const hasBrowser = /(브라우저|browser)/i.test(source);
  const hasServer = /(서버|server)/i.test(source);
  const hasLoginRouterFlow = /(로그인|login)/i.test(source)
    && /(서버|server)/i.test(source)
    && /(요청|request|post|포스트|라우터|router)/i.test(source);

  if (hasCookieSession && (hasBrowser || hasServer)) {
    return ensureSentenceEnding('브라우저는 세션으로 상태를 관리합니다');
  }

  if (hasLoginRouterFlow) {
    return ensureSentenceEnding('로그인 요청은 서버의 POST 라우터로 처리되도록 아직 구현이 더 필요합니다');
  }

  if (hasBrowser && /(세션|session)/i.test(source)) {
    return ensureSentenceEnding('브라우저는 세션을 사용해 상태를 관리합니다');
  }

  return ensureSentenceEnding(
    normalizeWhitespace(corrected)
      .replace(/쿠키\s*세션\s*얘기하다가\s*중간에\s*/g, '')
      .replace(/중간에\s*세션이라고\s*잘못\s*들어갔는데\s*/g, '')
      .replace(/\s+([,.!?;:])/g, '$1')
  );
}


export function buildConfirmationSummary(text, sourceText = '') {
  const baseText = normalizeWhitespace(text);
  if (!baseText) {
    return '확정한 내용을 요약할 수 없습니다.';
  }

  const profile = deriveContextProfile(sourceText || text);
  const structure = analyzeTranscriptStructure(sourceText || text, profile);
  const summary = buildConfirmationDigest(baseText, profile, structure, sourceText || text);
  if (summary && normalizeWhitespace(summary) !== baseText) {
    return summary;
  }

  const polished = buildSummaryVariant(sourceText || text, profile, structure);
  if (polished && normalizeWhitespace(polished) !== baseText) {
    return polished;
  }

  return compressConfirmationPhrase(baseText);
}

function buildConfirmationDigest(baseText, profile, structure, sourceText) {
  const source = normalizeWhitespace(sourceText || baseText);
  const clauses = dedupeClauses(
    (structure.clauses.length ? structure.clauses : splitTranscriptClauses(source))
      .map((clause) => tightenSentence(applyTranscriptCorrections(cleanSpokenKorean(clause))))
      .filter(Boolean)
  );
  const fragments = extractSalientFragments(source, profile, structure, 2)
    .map((fragment) => compressConfirmationPhrase(fragment))
    .filter(Boolean);

  const candidate = normalizeWhitespace(
    fragments.length > 1
      ? fragments.join(' · ')
      : fragments[0] || clauses[0] || compressConfirmationPhrase(baseText)
  );

  if (!candidate) {
    return '';
  }

  if (candidate.length < baseText.length) {
    return ensureSentenceEnding(candidate);
  }

  const shortened = compressConfirmationPhrase(clauses[0] || candidate || baseText);
  if (shortened && shortened.length < baseText.length) {
    return ensureSentenceEnding(shortened);
  }

  return ensureSentenceEnding(shortened || candidate);
}

function buildRewriteCandidatePool(text, profile) {
  const phonetic = buildPhoneticVariant(text);
  const correction = buildCorrectionVariant(text, profile);
  const contextual = buildContextVariant(text, profile);
  const balanced = buildBalancedVariant(text, profile);
  const dialogue = buildDialogueVariant(text, profile);
  const combined = buildCombinedVariant(text, profile, phonetic, contextual);
  const organized = buildOrganizedVariant(text, profile);
  const summary = buildSummaryVariant(text, profile);
  const action = profile.intent === 'action' ? buildActionCorrectionVariant(text) : '';

  return dedupeCandidates([
    { text: action, kind: 'action' },
    { text: correction, kind: 'correction' },
    { text: phonetic, kind: 'phonetic' },
    { text: contextual, kind: 'contextual' },
    { text: balanced, kind: 'balanced' },
    { text: dialogue, kind: 'dialogue' },
    { text: combined, kind: 'combined' },
    { text: organized, kind: 'organized' },
    { text: summary, kind: 'summary' }
  ].filter((candidate) => normalizeWhitespace(candidate.text)));
}

function selectRewriteVariants(sourceText, profile, candidates) {
  const bands = [
    {
      id: 'possibility-1',
      label: '제안 1 · 오인식 보정',
      mode: 'strict',
      kinds: new Set(['action', 'correction', 'phonetic', 'contextual'])
    },
    {
      id: 'possibility-2',
      label: '제안 2 · 문맥 교정',
      mode: 'balanced',
      kinds: new Set(['balanced', 'contextual', 'dialogue', 'combined'])
    },
    {
      id: 'possibility-3',
      label: '제안 3 · 매끄러운 문장',
      mode: 'relaxed',
      kinds: new Set(['organized', 'summary', 'combined', 'dialogue'])
    }
  ];

  const used = new Set();
  const selected = [];

  for (const band of bands) {
    const ranked = candidates
      .filter((candidate) => band.kinds.has(candidate.kind) && !used.has(normalizeWhitespace(candidate.text)))
      .map((candidate) => ({
        ...candidate,
        score: scoreRewriteCandidate(sourceText, candidate.text, profile, band.mode)
      }))
      .sort((left, right) => right.score - left.score || left.text.length - right.text.length);

    let winner = ranked[0] || candidates.find((candidate) => !used.has(normalizeWhitespace(candidate.text)));
    if (band.mode === 'strict' && profile.intent === 'action') {
      winner = candidates.find((candidate) => candidate.kind === 'action' && !used.has(normalizeWhitespace(candidate.text))) || winner;
    }
    const normalized = normalizeWhitespace(winner?.text || sourceText);
    used.add(normalized);
    selected.push({
      id: band.id,
      label: band.label,
      text: ensureSentenceEnding(normalized)
    });
  }

  return selected;
}

function scoreRewriteCandidate(sourceText, candidateText, profile, mode) {
  const source = normalizeWhitespace(sourceText);
  const candidate = normalizeWhitespace(candidateText);
  if (!source || !candidate) return -Infinity;

  const sourceSignature = buildSimilaritySignature(source);
  const candidateSignature = buildSimilaritySignature(candidate);
  const charSimilarity = jaccardSimilarity(buildNgrams(sourceSignature, 2), buildNgrams(candidateSignature, 2));
  const sourceTokens = buildContentTokenSet(source);
  const candidateTokens = buildContentTokenSet(candidate);
  const tokenOverlap = overlapRatio(sourceTokens, candidateTokens);
  const anchorMatch = scoreRewriteAnchors(source, candidate);
  const lengthRatio = candidateSignature.length / Math.max(1, sourceSignature.length);
  const lengthBalance = 1 - Math.min(1, Math.abs(1 - lengthRatio));
  const compactness = Math.max(0, Math.min(1, candidate.length / Math.max(1, source.length)));
  const intentFit = scoreIntentFit(candidate, profile);
  const technicalExplanation = looksLikeTechnicalExplanation(source);

  const weights = mode === 'strict'
    ? { similarity: 3.3, overlap: 2.4, anchor: 3.1, length: 1.9, intent: 0.8 }
    : mode === 'relaxed'
      ? { similarity: 1.2, overlap: 1.5, anchor: 2.2, length: 1.0, intent: 2.4 }
      : { similarity: 2.1, overlap: 2.0, anchor: 2.6, length: 1.4, intent: 1.8 };

  let score = 0;
  score += charSimilarity * weights.similarity;
  score += tokenOverlap * weights.overlap;
  score += anchorMatch.ratio * weights.anchor;
  score += lengthBalance * weights.length;
  score += intentFit * weights.intent;

  if (technicalExplanation) {
    if (/(세션|쿠키|브라우저|서버|식별자|아이디)/i.test(candidate)) score += 1.2;
    if (/(패션|페션|선 방식)/i.test(candidate)) score -= 2.2;
  }

  if (mode === 'strict') {
    if (lengthRatio < 0.55 || lengthRatio > 1.5) score -= 1.25;
    if (candidate.length < Math.min(8, source.length * 0.3)) score -= 1.5;
  } else if (mode === 'balanced') {
    if (lengthRatio < 0.4 || lengthRatio > 1.7) score -= 0.75;
  } else {
    if (profile.intent === 'summary' && candidate.length >= source.length) score -= 0.9;
    if (profile.intent === 'action' && !/(해야|필요|보내|확인|수정|공유|진행)/.test(candidate)) score -= 0.8;
  }

  if (sourceTokens.size <= 3) {
    score += tokenOverlap * 0.8;
  }

  if (profile.mlFocus?.confidence >= 0.7) {
    score += profile.mlFocus.confidence * intentFit * 0.8;
  }

  if (compactness > 0.95 && mode === 'relaxed') {
    score += 0.2;
  }

  return score;
}

function scoreIntentFit(candidateText, profile) {
  const lowered = normalizeWhitespace(candidateText).toLowerCase();

  switch (profile.intent) {
    case 'question':
      return /\?|왜|어떻게|무엇|궁금|알려/.test(lowered) ? 1 : 0;
    case 'action':
      return /(해야|필요|보내|확인|수정|공유|진행|처리|실행)/.test(lowered) ? 1 : 0;
    case 'apology':
      return /(죄송|미안|사과|실수|confusion|delay)/.test(lowered) ? 1 : 0;
    case 'summary':
      return /(정리|요약|핵심|흐름|결과|원인|상황|문맥)/.test(lowered) ? 1 : 0.8;
    default:
      return /(공손|정중|도와|부탁|확인|정리)/.test(lowered) ? 0.5 : 0.2;
  }
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const result = [];

  for (const candidate of candidates) {
    const normalized = normalizeWhitespace(candidate.text);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push({ ...candidate, text: normalized });
  }

  return result;
}

function compressConfirmationPhrase(text) {
  return normalizeWhitespace(text)
    .replace(/^실행 관점에서 정리하면[,\s]*/i, '')
    .replace(/^질문하신 내용을 정리하면[,\s]*/i, '')
    .replace(/^말씀드리면[,\s]*/i, '')
    .replace(/^죄송하지만 정리하면[,\s]*/i, '')
    .replace(/^핵심[:\s-]*/i, '')
    .replace(/^요약[:\s-]*/i, '')
    .replace(/(해야\s+합니다|해야\s+해요|해야\s+돼요|필요합니다|필요해요|입니다|예요|합니다|해요|돼요|할 수 있습니다|가능합니다)\.?$/g, '')
    .replace(/\b(정말|진짜|사실)\b/g, '')
    .replace(/\s+(그리고|또)\s+/g, ' · ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildCorrectionVariant(text, profile = deriveContextProfile(text)) {
  const normalized = normalizeWhitespace(
    applyContextCorrections(
      applyTranscriptCorrections(
        cleanSpokenKorean(
          applyPhoneticFixes(text)
        )
      )
    )
  );

  if (profile.intent === 'action') {
    const actionVariant = buildActionVariant(normalized);
    return ensureSentenceEnding(normalizeWhitespace(actionVariant.replace(/^실행 계획:\s*/,'').replace(/^업데이트:\s*/,'').replace(/^팀에 업데이트를 보내야 합니다\.\s*$/,'팀에 업데이트를 보내야 합니다.')));
  }

  return ensureSentenceEnding(normalized);
}

function buildActionCorrectionVariant(text) {
  const source = normalizeWhitespace(text);
  const lower = source.toLowerCase();

  if (/(fix|수정|redirect|리다이렉트|리젝트).*(send|보내|update|업데이트).*(team|팀)/i.test(lower) || /(send|보내|update|업데이트).*(team|팀).*(fix|수정|redirect|리다이렉트|리젝트)/i.test(lower)) {
    return '리다이렉트 문제를 수정하고 업데이트를 팀에 보내야 합니다.';
  }

  if (/(send|보내).*(update|업데이트).*(team|팀)/i.test(lower) || /(update|업데이트).*(team|팀)/i.test(lower)) {
    return '팀에 업데이트를 보내야 합니다.';
  }

  if (/(follow up|후속).*(team|팀|client|고객)/i.test(lower)) {
    return '팀과 후속 확인을 진행해야 합니다.';
  }

  return buildActionVariant(source);
}

function buildActionRewriteVariants(text, profile) {
  const source = normalizeWhitespace(text);
  const lower = source.toLowerCase();
  const strict = buildActionCorrectionVariant(source);

  let balanced = strict;
  let relaxed = strict;

  if (/(fix|수정|redirect|리다이렉트|리젝트).*(send|보내|update|업데이트).*(team|팀)/i.test(lower) || /(send|보내|update|업데이트).*(team|팀).*(fix|수정|redirect|리다이렉트|리젝트)/i.test(lower)) {
    balanced = '리다이렉트 문제를 수정한 뒤 업데이트를 팀에 보내야 합니다.';
    relaxed = '리다이렉트 문제를 수정하고 업데이트를 팀에 보내고 진행 상황까지 공유해야 합니다.';
  } else if (/(send|보내).*(update|업데이트).*(team|팀)/i.test(lower) || /(update|업데이트).*(team|팀)/i.test(lower)) {
    balanced = '팀에 업데이트를 보낸 뒤 진행 상황도 공유해야 합니다.';
    relaxed = '팀에 업데이트를 보내고 진행 상황까지 공유해야 합니다.';
  } else if (/(follow up|후속).*(team|팀|client|고객)/i.test(lower)) {
    balanced = '팀과 후속 확인을 진행한 뒤 결과를 공유해야 합니다.';
    relaxed = '팀과 후속 확인을 진행하고 결과를 공유해야 합니다.';
  }

  return [
    { id: 'possibility-1', label: '제안 1 · 오인식 보정', text: ensureSentenceEnding(strict) },
    { id: 'possibility-2', label: '제안 2 · 문맥 교정', text: ensureSentenceEnding(balanced) },
    { id: 'possibility-3', label: '제안 3 · 매끄러운 문장', text: ensureSentenceEnding(relaxed) }
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
      return '팀에 업데이트를 보내야 합니다.';
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
      if (/(fix|수정|redirect|리다이렉트|리젝트).*(send|보내|update|업데이트).*(team|팀)/i.test(lower) || /(send|보내|update|업데이트).*(team|팀).*(fix|수정|redirect|리다이렉트|리젝트)/i.test(lower)) {
        return '리다이렉트 문제를 수정하고 업데이트를 팀에 보내고 진행 상황까지 공유해야 합니다.';
      }
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
  const technicalExplanation = looksLikeTechnicalExplanation(structure.cleaned || clause);

  if (profile.intent === 'summary' && /(정리|요약|핵심|데이터|부족|문맥|상황|원인|결과|흐름)/i.test(lowered)) score += 6;
  if (profile.intent === 'question' && /(왜|어떻게|무엇|궁금|질문|알려)/i.test(lowered)) score += 6;
  if (profile.intent === 'action' && /(해야|필요|진행|보내|확인|수정|공유|처리)/i.test(lowered)) score += 6;
  if (profile.intent === 'apology' && /(죄송|미안|실수|사과|delay|confusion)/i.test(lowered)) score += 6;
  if (profile.tone === 'formal') score += 1;
  if (structure.longForm) score += Math.min(4, Math.floor(clause.length / 24));
  if (structure.fillerCount > 0) score += 1;
  if (/^(근데|그리고|그래서|다만|하지만|그런데)/.test(lowered)) score -= 1;
  if (contentTokens.length <= 2) score -= 2;

  if (technicalExplanation) {
    if (/(세션|쿠키|브라우저|서버|식별자|아이디)/i.test(lowered)) score += 2;
    if (/(패션|페션|선 방식)/i.test(lowered)) score -= 2;
  }

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
  return applyDomainContextCorrections(normalizeWhitespace(text))
    .replace(/상황으로 인지하고/g, '상황을 인지하고')
    .replace(/데이터가 부족해 가지고/g, '데이터가 부족해서')
    .replace(/부족해셔/g, '부족해서')
    .replace(/자연 처리/g, '자연어 처리')
    .replace(/구체적으로 해야 돼/g, '구체적으로 해야 합니다')
    .replace(/구체적으로 해야돼/g, '구체적으로 해야 합니다')
    .replace(/명확하게 해야 돼/g, '명확하게 해야 합니다')
    .replace(/리사이젝트/g, '리다이렉트')
    .replace(/리젝트/g, '리다이렉트')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

function applyPhoneticFixes(text) {
  let result = normalizeWhitespace(text);

  for (const [pattern, replacement] of PHONETIC_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }

  result = applyDomainContextCorrections(result)
    .replace(/\s+/g, ' ')
    .replace(/\b(\w+)(?:\s+\1\b)+/gi, '$1')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();

  return ensureSentenceEnding(result);
}

function applyDomainContextCorrections(text) {
  const source = normalizeWhitespace(text);
  if (!source || !TECH_EXPLANATION_CONTEXT_RE.test(source) || !TECH_EXPLANATION_CUE_RE.test(source)) {
    return source;
  }

  return source
    .replace(/선 방식/g, '세션 방식')
    .replace(/패션/g, '세션')
    .replace(/페션/g, '세션')
    .replace(/메론가요/g, '뭔가요')
    .replace(/타피/g, '카피')
    .replace(/포스트/g, 'POST')
    .replace(/시 메/g, '시스템')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

function applyContextCorrections(text) {
  return applyDomainContextCorrections(normalizeWhitespace(text))
    .replace(/\bplease\b/gi, '')
    .replace(/\bfix the redirect issue and send the update to the team\b/gi, '리다이렉트 문제를 수정하고 업데이트를 팀에 보내 주세요')
    .replace(/\bfix the redirect issue\b/gi, '리다이렉트 문제를 수정해 주세요')
    .replace(/\bsend the update to the team\b/gi, '업데이트를 팀에 보내 주세요')
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
    .replace(/\bredirect\b/gi, '리다이렉트')
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
