import { buildRewriteVariants, normalizeWhitespace } from './rewrite.js';
import { mergeRecognitionResults } from './stt.js';

const els = {
  startButton: document.querySelector('[data-action="start-recording"]'),
  stopButton: document.querySelector('[data-action="stop-recording"]'),
  clearButton: document.querySelector('[data-action="clear"]'),
  generateButton: document.querySelector('[data-action="generate"]'),
  copyButton: document.querySelector('[data-action="copy"]'),
  transcript: document.querySelector('#transcript'),
  transcriptStatus: document.querySelector('#transcript-status'),
  audioPlayback: document.querySelector('#audio-playback'),
  supportStatus: document.querySelector('#support-status'),
  variantList: document.querySelector('#variant-list'),
  emptyState: document.querySelector('#variants-empty')
};

const state = {
  recorder: null,
  recognition: null,
  stream: null,
  chunks: [],
  transcript: '',
  recognitionSegments: [],
  selectedVariantId: 'possibility-1',
  selectedAudioUrl: '',
  variants: [],
  readyForVariants: false
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
}

async function startCapture() {
  try {
    clearSessionState();
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
    setStatus('녹음을 시작했습니다. 들리는 즉시 STT 원문에 쌓습니다.');
  } catch (error) {
    setStatus(`녹음을 시작할 수 없습니다: ${friendlyError(error)}`);
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
    try {
      state.recorder.stop();
    } catch {
      // ignore
    }
  }

  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }

  state.readyForVariants = true;
  renderVariants();
  setRecording(false);
  setStatus('녹음을 종료했습니다. 음성 보정본, 맥락 보정본, 종합본을 만들었습니다.');
}

function clearAll() {
  stopCapture();
  clearSessionState();
  setTranscript('');
  setAudioUrl('');
  renderVariants();
  setStatus('원문, 오디오, 선택 상태를 초기화했습니다.');
}

function clearSessionState() {
  state.chunks = [];
  state.transcript = '';
  state.recognitionSegments = [];
  state.variants = [];
  state.readyForVariants = false;
  state.selectedVariantId = 'possibility-1';
}

function onChunk(event) {
  if (event.data && event.data.size > 0) {
    state.chunks.push(event.data);
  }
}

function onRecorderStop() {
  if (!state.chunks.length) return;
  const blob = new Blob(state.chunks, { type: state.recorder?.mimeType || 'audio/webm' });
  setAudioUrl(URL.createObjectURL(blob));
}

function onRecognitionResult(event) {
  const recognitionResults = Array.from(event.results, (result) => ({
    transcript: result[0].transcript
  }));
  const merged = mergeRecognitionResults(state.recognitionSegments, recognitionResults);

  state.recognitionSegments = merged.segments;
  state.transcript = merged.transcript;
  setTranscript(merged.transcript);

  if (state.readyForVariants) {
    renderVariants();
  }

  setStatus('음성을 듣고 STT 원문을 즉시 쌓는 중입니다.');
}

function onRecognitionError(event) {
  setStatus(`음성 인식 오류: ${event.error}`);
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
  state.recognitionSegments = [els.transcript.value];
  if (state.readyForVariants) {
    renderVariants();
  }
}

function renderVariants() {
  const transcript = normalizeWhitespace(els.transcript.value || state.transcript);

  if (!state.readyForVariants || !transcript) {
    state.variants = [];
    els.variantList.innerHTML = '';
    els.emptyState.hidden = false;
    els.emptyState.textContent = state.readyForVariants
      ? '원문이 비어 있어서 가능성을 만들 수 없습니다.'
      : '정지하면 음성 보정본, 맥락 보정본, 종합본이 표시됩니다.';
    return;
  }

  const variants = buildRewriteVariants(transcript);
  state.variants = variants;
  renderVariantCards(variants);
}

function renderVariantCards(variants) {
  els.variantList.innerHTML = '';
  els.emptyState.hidden = true;

  if (!variants.some((variant) => variant.id === state.selectedVariantId)) {
    state.selectedVariantId = variants[0]?.id || 'possibility-1';
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

function handleGenerateClicked() {
  state.readyForVariants = true;
  renderVariants();
  if (state.transcript || els.transcript.value) {
    setStatus('현재 원문 기준으로 3가지 가능성을 다시 계산했습니다.');
  } else {
    setStatus('먼저 원문이 있어야 가능성을 계산할 수 있습니다.');
  }
}

async function copySelectedVariant() {
  const variants = state.variants.length
    ? state.variants
    : buildRewriteVariants(normalizeWhitespace(els.transcript.value || state.transcript));
  const selected = variants.find((variant) => variant.id === state.selectedVariantId) || variants[0];

  try {
    await navigator.clipboard.writeText(selected?.text || '');
    setStatus('선택한 가능성을 클립보드에 복사했습니다.');
  } catch {
    setStatus('이 브라우저에서는 클립보드 복사에 실패했습니다.');
  }
}

function createSpeechRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    setStatus('이 브라우저는 SpeechRecognition을 지원하지 않습니다. 원문을 직접 붙여넣어도 됩니다.');
    return null;
  }

  const recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'ko-KR';
  return recognition;
}

function updateSupportStatus() {
  const hasRecorder = typeof MediaRecorder !== 'undefined';
  const hasSpeechRecognition = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);

  els.supportStatus.textContent = [
    hasRecorder ? 'MediaRecorder: 지원됨' : 'MediaRecorder: 지원 안 됨',
    hasSpeechRecognition ? 'SpeechRecognition: 지원됨' : 'SpeechRecognition: 지원 안 됨'
  ].join(' · ');
}

function setRecording(isRecording) {
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
