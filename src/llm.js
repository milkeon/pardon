import { buildConfirmationSummary, buildRewriteVariants, buildRewriteVariantsFromTranscripts, deriveContextProfile, normalizeWhitespace } from './rewrite.js?v=context-restore-35';

const REQUEST_TIMEOUT_MS = 12_000;

export async function fetchRewriteVariants(input) {
  const request = normalizeRewriteRequest(input);
  if (shouldUseStaticFallback()) {
    return buildRewriteVariantsFromTranscripts(request.baseTranscript, request.evidenceTranscript);
  }

  const payload = await postJson('/api/analyze', {
    baseTranscript: request.baseTranscript,
    evidenceTranscript: request.evidenceTranscript,
    hint: request.hint || deriveContextProfile(request.baseTranscript || request.evidenceTranscript).hints.join(', ')
  });

  return normalizeRewritePayload(payload);
}

function normalizeRewriteRequest(input) {
  if (typeof input === 'string') {
    return {
      baseTranscript: normalizeWhitespace(input),
      evidenceTranscript: '',
      hint: ''
    };
  }

  return {
    baseTranscript: normalizeWhitespace(input?.baseTranscript),
    evidenceTranscript: normalizeWhitespace(input?.evidenceTranscript),
    hint: normalizeWhitespace(input?.hint)
  };
}

export async function fetchConfirmationSummary(selectedText, transcript) {
  if (shouldUseStaticFallback()) {
    return {
      title: '확정 요약',
      summary: buildConfirmationSummary(selectedText, transcript)
    };
  }

  const payload = await postJson('/api/summary', {
    transcript,
    selectedText,
    hint: deriveContextProfile(transcript || selectedText).hints.join(', ')
  });

  return normalizeSummaryPayload(payload);
}

async function postJson(url, body) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutHost = typeof window !== 'undefined' ? window : globalThis;
  const timeoutId = controller ? timeoutHost.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller?.signal
    });

    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    if (timeoutId) timeoutHost.clearTimeout(timeoutId);
  }
}

function normalizeRewritePayload(payload) {
  const variants = Array.isArray(payload) ? payload : payload ? [payload.p1, payload.p2, payload.p3].filter(Boolean) : [];
  if (variants.length < 3) return null;

  const fallbackLabels = ['제안 1 · 원문 보정', '제안 2 · 자연스러운 문장', '제안 3 · 정리된 문장'];

  return variants.slice(0, 3).map((variant, index) => {
    const text = normalizeWhitespace(typeof variant === 'string' ? variant : variant?.text ?? variant?.content ?? variant?.summary ?? '');
    if (!text) return null;

    const label = normalizeWhitespace(typeof variant === 'object' ? variant?.label : '') || fallbackLabels[index];
    return {
      id: `possibility-${index + 1}`,
      label,
      text
    };
  }).filter(Boolean).length === 3 ? variants.slice(0, 3).map((variant, index) => ({
    id: `possibility-${index + 1}`,
    label: normalizeWhitespace(typeof variant === 'object' ? variant?.label : '') || fallbackLabels[index],
    text: normalizeWhitespace(typeof variant === 'string' ? variant : variant?.text ?? variant?.content ?? variant?.summary ?? '')
  })) : null;
}

function normalizeSummaryPayload(payload) {
  if (!payload) return null;

  if (typeof payload === 'string') {
    const summary = normalizeWhitespace(payload);
    return summary ? { title: '확정 요약', summary } : null;
  }

  const title = normalizeWhitespace(payload.title || payload.label || '확정 요약') || '확정 요약';
  const summary = normalizeWhitespace(payload.summary || payload.text || payload.content || '');
  if (!summary) return null;

  return { title, summary };
}

function shouldUseStaticFallback() {
  if (typeof location === 'undefined') return false;
  return location.hostname.endsWith('github.io') || location.protocol === 'file:';
}
