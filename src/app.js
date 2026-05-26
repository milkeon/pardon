import { buildRewriteVariants, normalizeWhitespace } from './rewrite.js';

const els = {
  startButton: document.querySelector('[data-action="start-recording"]'),
  stopButton: document.querySelector('[data-action="stop-recording"]'),
  clearButton: document.querySelector('[data-action="clear"]'),
  generateButton: document.querySelector('[data-action="generate"]'),
  copyButton: document.querySelector('[data-action="copy"]'),
  transcript: document.querySelector('#transcript'),
  transcriptStatus: document.querySelector('#transcript-status'),
  context: document.querySelector('#context'),
  apiKey: document.querySelector('#api-key'),
  audioPlayback: document.querySelector('#audio-playback'),
  supportStatus: document.querySelector('#support-status'),
  recordingBadge: document.querySelector('#recording-badge'),
  variantList: document.querySelector('#variant-list'),
  emptyState: document.querySelector('#variants-empty')
};

const state = {
  recorder: null,
  recognition: null,
  stream: null,
  chunks: [],
  transcript: '',
  interimTranscript: '',
  selectedVariantId: 'clean',
  selectedAudioUrl: '',
  variants: []
};

initialize();

function initialize() {
  updateSupportStatus();
  renderVariants();
  wireEvents();
}

function wireEvents() {
  els.startButton.addEventListener('click', startCapture);
  els.stopButton.addEventListener('click', stopCapture);
  els.clearButton.addEventListener('click', clearAll);
  els.generateButton.addEventListener('click', handleGenerateClicked);
  els.copyButton.addEventListener('click', copySelectedVariant);
  els.transcript.addEventListener('input', onTranscriptEdit);
  els.context.addEventListener('input', () => renderVariants());
}

async function startCapture() {
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.chunks = [];
    state.recorder = new MediaRecorder(state.stream);
    state.recorder.addEventListener('dataavailable', onChunk);
    state.recorder.addEventListener('stop', onRecorderStop);
    state.recorder.start();

    const recognition = createSpeechRecognition();
    state.recognition = recognition;
    if (recognition) {
      recognition.onresult = onRecognitionResult;
      recognition.onerror = onRecognitionError;
      recognition.onend = onRecognitionEnd;
      recognition.start();
    }

    setRecording(true);
    setStatus('Recording started. Speak naturally to populate the raw STT field.');
  } catch (error) {
    setStatus(`Could not start recording: ${friendlyError(error)}`);
  }
}

function stopCapture() {
  if (state.recognition) {
    try {
      state.recognition.stop();
    } catch {
      // ignore
    }
  }

  if (state.recorder && state.recorder.state !== 'inactive') {
    state.recorder.stop();
  }

  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }

  setRecording(false);
  setStatus('Recording stopped. Rewrite cards are updated from the current transcript.');
}

function clearAll() {
  stopCapture();
  state.transcript = '';
  state.interimTranscript = '';
  state.chunks = [];
  state.variants = [];
  setTranscript('');
  setAudioUrl('');
  renderVariants();
  setStatus('Cleared transcript, audio, and variant selection.');
}

function onChunk(event) {
  if (event.data && event.data.size > 0) {
    state.chunks.push(event.data);
  }
}

function onRecorderStop() {
  const blob = new Blob(state.chunks, { type: state.recorder?.mimeType || 'audio/webm' });
  setAudioUrl(URL.createObjectURL(blob));
}

function onRecognitionResult(event) {
  let finalText = '';
  let interimText = '';

  for (let i = event.resultIndex; i < event.results.length; i += 1) {
    const segment = event.results[i][0].transcript;
    if (event.results[i].isFinal) {
      finalText += segment;
    } else {
      interimText += segment;
    }
  }

  if (finalText) {
    state.transcript = normalizeWhitespace(`${state.transcript} ${finalText}`);
    setTranscript(state.transcript + (interimText ? ` ${interimText}` : ''));
    renderVariants();
  } else if (interimText) {
    state.interimTranscript = normalizeWhitespace(interimText);
    setTranscript(normalizeWhitespace(`${state.transcript} ${state.interimTranscript}`));
  }

  setStatus('Listening and transcribing.');
}

function onRecognitionError(event) {
  setStatus(`Speech recognition error: ${event.error}`);
}

function onRecognitionEnd() {
  state.recognition = null;

  if (state.recorder && state.recorder.state !== 'inactive') {
    try {
      state.recorder.stop();
    } catch {
      // ignore
    }
  }

  setRecording(false);
}

function onTranscriptEdit() {
  state.transcript = els.transcript.value;
  renderVariants();
}

function renderVariants() {
  const transcript = normalizeWhitespace(els.transcript.value || state.transcript);
  const context = els.context.value;
  const variants = buildRewriteVariants(transcript, context);
  state.variants = variants;
  renderVariantCards(variants);
}

function renderVariantCards(variants) {
  els.variantList.innerHTML = '';
  els.emptyState.hidden = normalizeWhitespace(els.transcript.value || state.transcript).length > 0;

  if (!variants.some((variant) => variant.id === state.selectedVariantId)) {
    state.selectedVariantId = variants[0]?.id || 'clean';
  }

  variants.forEach((variant) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `variant-card ${state.selectedVariantId === variant.id ? 'is-selected' : ''}`;
    card.dataset.variantId = variant.id;
    card.innerHTML = `
      <span class="variant-card__label">${variant.label}</span>
      <span class="variant-card__text">${escapeHtml(variant.text).replace(/\n/g, '<br>')}</span>
    `;
    card.addEventListener('click', () => {
      state.selectedVariantId = variant.id;
      renderVariantCards(variants);
    });
    els.variantList.appendChild(card);
  });
}

async function handleGenerateClicked() {
  const transcript = normalizeWhitespace(els.transcript.value || state.transcript);
  const context = els.context.value;
  const apiKey = normalizeWhitespace(els.apiKey.value);

  if (!transcript) {
    setStatus('Add or record a transcript before generating rewrites.');
    renderVariants();
    return;
  }

  if (!apiKey) {
    setStatus('No API key provided. Using the local deterministic rewrite engine.');
    renderVariants();
    return;
  }

  els.generateButton.disabled = true;
  setStatus('Generating rewrite variants with OpenAI...');

  try {
    const remoteVariants = await generateRemoteVariants({ transcript, context, apiKey });
    state.variants = remoteVariants;
    renderVariantCards(remoteVariants);
    setStatus('Generated rewrite variants with OpenAI.');
  } catch (error) {
    state.variants = buildRewriteVariants(transcript, context);
    renderVariantCards(state.variants);
    setStatus(`Remote generation failed, so the local fallback was used: ${friendlyError(error)}`);
  } finally {
    els.generateButton.disabled = false;
  }
}

async function copySelectedVariant() {
  const variants = state.variants.length
    ? state.variants
    : buildRewriteVariants(normalizeWhitespace(els.transcript.value || state.transcript), els.context.value);
  const selected = variants.find((variant) => variant.id === state.selectedVariantId) || variants[0];

  try {
    await navigator.clipboard.writeText(selected?.text || '');
    setStatus('Selected rewrite copied to clipboard.');
  } catch {
    setStatus('Clipboard copy failed in this browser.');
  }
}

function createSpeechRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    setStatus('SpeechRecognition is not supported in this browser. You can paste transcript text manually.');
    return null;
  }

  const recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'ko-KR';
  return recognition;
}

async function generateRemoteVariants({ transcript, context, apiKey }) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Rewrite the transcript into exactly three alternatives. Return strict JSON with keys clean, polite, action. Keep the meaning and use the user context. Do not add commentary.'
        },
        {
          role: 'user',
          content: JSON.stringify({ transcript, context })
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed (${response.status})`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  const parsed = parseJsonMaybe(content);
  const localFallback = buildRewriteVariants(transcript, context);

  return [
    { id: 'clean', label: '깔끔하게', text: finalizeVariantText(parsed?.clean || '') || localFallback[0].text },
    { id: 'polite', label: '공손하게', text: finalizeVariantText(parsed?.polite || '') || localFallback[1].text },
    { id: 'action', label: '실행 중심', text: finalizeVariantText(parsed?.action || '') || localFallback[2].text }
  ];
}

function parseJsonMaybe(value) {
  if (typeof value !== 'string') return value || null;

  try {
    return JSON.parse(value);
  } catch {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) return null;

    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function finalizeVariantText(value) {
  return String(value ?? '')
    .split(/\n+/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function updateSupportStatus() {
  const hasRecorder = typeof MediaRecorder !== 'undefined';
  const hasSpeechRecognition = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);

  els.supportStatus.textContent = [
    hasRecorder ? 'MediaRecorder: supported' : 'MediaRecorder: unavailable',
    hasSpeechRecognition ? 'SpeechRecognition: supported' : 'SpeechRecognition: unavailable'
  ].join(' · ');
}

function setRecording(isRecording) {
  els.recordingBadge.textContent = isRecording ? '● recording' : 'ready';
  els.recordingBadge.classList.toggle('is-recording', isRecording);
  els.startButton.disabled = isRecording;
  els.stopButton.disabled = !isRecording;
}

function setStatus(message) {
  els.transcriptStatus.textContent = message;
}

function setTranscript(value) {
  els.transcript.value = value;
}

function setAudioUrl(url) {
  if (state.selectedAudioUrl) {
    URL.revokeObjectURL(state.selectedAudioUrl);
  }
  state.selectedAudioUrl = url;
  els.audioPlayback.hidden = !url;
  els.audioPlayback.src = url || '';
}

function friendlyError(error) {
  if (error instanceof DOMException) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
