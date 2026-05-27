const REWRITE_LABELS = ['polite', 'direct', 'question', 'action', 'summary', 'apology'];

const TRAINING_SAMPLES = [
  { label: 'polite', text: 'Could you please send the update to the client when you have a moment?' },
  { label: 'polite', text: 'I would appreciate it if you could review this draft.' },
  { label: 'polite', text: '가능하시면 오늘 중으로 한 번 확인 부탁드립니다.' },
  { label: 'polite', text: '죄송하지만 일정이 가능하실 때 다시 말씀 부탁드려요.' },
  { label: 'polite', text: 'If possible, could you help me with this request?' },
  { label: 'direct', text: 'Send the file now.' },
  { label: 'direct', text: 'Reply with a yes or no.' },
  { label: 'direct', text: '보내줘.' },
  { label: 'direct', text: '확인해줘 and let me know.' },
  { label: 'direct', text: 'Do it today and reply back.' },
  { label: 'question', text: 'Could you explain why this happened?' },
  { label: 'question', text: 'What is the status of the request?' },
  { label: 'question', text: '어떻게 하면 되나요?' },
  { label: 'question', text: '왜 이렇게 된 건지 알려줄 수 있어?' },
  { label: 'question', text: 'Can you tell me what we should do next?' },
  { label: 'action', text: 'We need to finish this by today and send an update.' },
  { label: 'action', text: 'ASAP, follow up with the team and fix the issue.' },
  { label: 'action', text: 'Send the update now and follow up with the client today.' },
  { label: 'action', text: '지금 처리해야 하는 할 일을 정리해 주세요.' },
  { label: 'action', text: 'Next step is to review the report and notify the client.' },
  { label: 'action', text: '빠르게 대응하고 결과를 공유해야 합니다.' },
  { label: 'summary', text: 'Please summarize the meeting in two bullets.' },
  { label: 'summary', text: 'Give me a concise report and key points.' },
  { label: 'summary', text: '한 줄 요약으로 정리해 주세요.' },
  { label: 'summary', text: '짧게 보고 형태로 바꿔 주세요.' },
  { label: 'summary', text: 'Overview of the issue and the main takeaway.' },
  { label: 'apology', text: 'Sorry about the mistake and the delay.' },
  { label: 'apology', text: 'I apologize for the confusion.' },
  { label: 'apology', text: '미안해요, 제가 실수했습니다.' },
  { label: 'apology', text: '죄송합니다. 다시 정리해서 보내겠습니다.' },
  { label: 'apology', text: '실수에 대해 사과드리고 싶습니다.' }
];

const MODEL = trainNaiveBayes(TRAINING_SAMPLES);

export function predictRewriteFocus(text) {
  const source = normalizeInput(text);
  if (!source) {
    return {
      label: 'direct',
      confidence: 0,
      distribution: Object.fromEntries(REWRITE_LABELS.map((label) => [label, 1 / REWRITE_LABELS.length]))
    };
  }

  const logScores = scoreText(MODEL, source);
  const distribution = softmaxScores(logScores);
  const sorted = Object.entries(distribution).sort((a, b) => b[1] - a[1]);
  const [label, confidence] = sorted[0] || ['direct', 0];

  return {
    label,
    confidence,
    distribution,
    alternatives: sorted.slice(1, 4).map(([alternativeLabel, score]) => ({ label: alternativeLabel, score }))
  };
}

function trainNaiveBayes(samples) {
  const classDocCounts = Object.fromEntries(REWRITE_LABELS.map((label) => [label, 0]));
  const tokenCounts = Object.fromEntries(REWRITE_LABELS.map((label) => [label, Object.create(null)]));
  const totalTokenCounts = Object.fromEntries(REWRITE_LABELS.map((label) => [label, 0]));
  const vocabulary = new Set();

  for (const sample of samples) {
    if (!REWRITE_LABELS.includes(sample.label)) continue;

    classDocCounts[sample.label] += 1;
    for (const token of createFeatures(sample.text)) {
      vocabulary.add(token);
      tokenCounts[sample.label][token] = (tokenCounts[sample.label][token] || 0) + 1;
      totalTokenCounts[sample.label] += 1;
    }
  }

  return {
    classDocCounts,
    tokenCounts,
    totalTokenCounts,
    vocabularySize: vocabulary.size || 1
  };
}

function scoreText(model, text) {
  const features = createFeatures(text);
  const totalDocs = REWRITE_LABELS.reduce((sum, label) => sum + (model.classDocCounts[label] || 0), 0) || 1;
  const scores = {};

  for (const label of REWRITE_LABELS) {
    const docCount = model.classDocCounts[label] || 0;
    const baseScore = Math.log((docCount + 1) / (totalDocs + REWRITE_LABELS.length));
    const tokenTotal = model.totalTokenCounts[label] || 0;
    const tokenMap = model.tokenCounts[label] || Object.create(null);
    let score = baseScore;

    for (const token of features) {
      const tokenCount = tokenMap[token] || 0;
      score += Math.log((tokenCount + 1) / (tokenTotal + model.vocabularySize));
    }

    scores[label] = score;
  }

  return scores;
}

function softmaxScores(scores) {
  const entries = Object.entries(scores);
  if (!entries.length) return {};

  const maxScore = Math.max(...entries.map(([, value]) => value));
  const expEntries = entries.map(([label, value]) => [label, Math.exp(value - maxScore)]);
  const sum = expEntries.reduce((total, [, value]) => total + value, 0) || 1;

  return Object.fromEntries(expEntries.map(([label, value]) => [label, value / sum]));
}

function createFeatures(text) {
  const tokens = tokenize(text);
  if (!tokens.length) return [];

  const features = [...tokens];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    features.push(`${tokens[index]} ${tokens[index + 1]}`);
  }

  return features;
}

function tokenize(text) {
  return normalizeInput(text)
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

function normalizeInput(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
