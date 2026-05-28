import { deriveContextProfile, normalizeWhitespace } from './rewrite.js?v=confirm-llm-7';

const REQUEST_TIMEOUT_MS = 12_000;

export async function fetchRewriteVariants(transcript) {
  const payload = await postJson('/api/analyze', {
    transcript,
    hint: deriveContextProfile(transcript).hints.join(', ')
  });

  return normalizeRewritePayload(payload);
}

export async function fetchConfirmationSummary(selectedText, transcript) {
  const payload = await postJson('/api/summary', {
    transcript,
    selectedText,
    hint: deriveContextProfile(transcript || selectedText).hints.join(', ')
  });

  return normalizeSummaryPayload(payload);
}

async function postJson(url, body) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;

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
    if (timeoutId) window.clearTimeout(timeoutId);
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
