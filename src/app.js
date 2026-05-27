import { buildRewriteVariants, normalizeWhitespace } from './rewrite.js';
import { mergeRecognitionResults } from './stt.js';
import { calculateRms, hasTimedOutSince, shouldRestartRecognition } from './capture.js';

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
  emptyState: document.querySelector('#variants-empty'),
  toast: document.querySelector('#toast')
};

const state = {
  recorder: null,
  recognition: null,
  stream: null,
  audioContext: null,
  audioSource: null,
  audioAnalyser: null,
  audioSamples: null,
  chunks: [],
  transcript: '',
  recognitionSegments: [],
  recognitionCommittedTranscript: '',
  selectedVariantId: 'possibility-1',
  selectedAudioUrl: '',
  variants: [],
  readyForVariants: false,
  lastVoiceAt: 0,
  isStopping: false,
  voiceMonitorTimer: null,
  recognitionRestartTimer: null,
  toastTimer: null
};

const SILENCE_TIMEOUT_MS = 60_000;
const VOICE_CHECK_INTERVAL_MS = 1000;
const VOICE_LEVEL_THRESHOLD = 0.015;
const RECOGNITION_RESTART_DELAY_MS = 500;

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
    state.isStopping = false;
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.chunks = [];
    state.recorder = new MediaRecorder(state.stream);
    state.recorder.addEventListener('dataavailable', onChunk);
    state.recorder.addEventListener('stop', onRecorderStop);
    state.recorder.start(1000);

    await startVoiceActivityMonitor();

    const recognition = createSpeechRecognition();
    state.recognition = recognition;
    if (recognition) {
      recognition.onresult = onRecognitionResult;
      recognition.onerror = onRecognitionError;
      recognition.onend = onRecognitionEnd;
      recognition.start();
    }

    setRecording(true);
    setStatus('녹음을 시작했습니다. 음성이 들어오는 동안 STT를 계속 듣고, 1분 무음이면 자동 종료합니다.');
  } catch (error) {
    setStatus(`녹음을 시작할 수 없습니다: ${friendlyError(error)}`);
    cleanupAudioActivityMonitor();
  }
}

function stopCapture() {
  state.isStopping = true;
  window.clearTimeout(state.recognitionRestartTimer);
  state.recognitionRestartTimer = null;

  cleanupAudioActivityMonitor();

  if (state.recognition) {
    try {
      state.recognition.stop();
    } catch {
      // ignore
    }
    state.recognition = null;
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
  state.variants = [];
  renderVariantPlaceholder('정지했습니다. 변환 버튼을 누르면 원문을 바탕으로 3가지 결과를 만듭니다.');
  setRecording(false);
  setStatus('녹음을 종료했습니다. 이제 변환 버튼으로 3가지 가능성을 만드세요.');
  state.isStopping = false;
}

function clearAll() {
  stopCapture();
  clearSessionState();
  setTranscript('');
  setAudioUrl('');
  renderVariantPlaceholder('정지하면 변환 버튼으로 3가지 결과를 만들 수 있습니다.');
  setStatus('원문, 오디오, 선택 상태를 초기화했습니다.');
}

function clearSessionState() {
  state.chunks = [];
  state.transcript = '';
  state.recognitionSegments = [];
  state.recognitionCommittedTranscript = '';
  state.variants = [];
  state.readyForVariants = false;
  state.selectedVariantId = 'possibility-1';
  state.lastVoiceAt = 0;
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
    transcript: result[0].transcript,
    isFinal: result.isFinal
  }));
  const merged = mergeRecognitionResults(
    {
      segments: state.recognitionSegments,
      committedTranscript: state.recognitionCommittedTranscript
    },
    recognitionResults,
    event.resultIndex ?? 0
  );

  state.recognitionSegments = merged.segments;
  state.recognitionCommittedTranscript = merged.committedTranscript;
  state.transcript = syncTranscriptDisplay(merged.transcript);

  setStatus('음성을 듣고 STT 원문을 즉시 쌓는 중입니다.');
}

function onRecognitionError(event) {
  setStatus(`음성 인식 오류: ${event.error}`);
  if (event.error === 'no-speech' || event.error === 'aborted') {
    scheduleRecognitionRestart();
  }
}

function onRecognitionEnd() {
  state.recognition = null;

  if (shouldRestartRecognition({ isRecording: state.recorder?.state === 'recording', isStopping: state.isStopping })) {
    scheduleRecognitionRestart();
  }
}

function onTranscriptEdit() {
  state.transcript = els.transcript.value;
  state.recognitionSegments = [{ transcript: els.transcript.value, isFinal: true }];
  state.recognitionCommittedTranscript = els.transcript.value;
  if (state.readyForVariants) {
    state.variants = [];
    renderVariantPlaceholder('원문이 바뀌었습니다. 변환 버튼을 다시 눌러 주세요.');
  }
}

function renderVariants() {
  const transcript = els.transcript.value || state.transcript;

  if (!state.readyForVariants) {
    state.variants = [];
    renderVariantPlaceholder('정지하면 변환 버튼으로 3가지 결과를 만들 수 있습니다.');
    return;
  }

  if (!transcript) {
    state.variants = [];
    renderVariantPlaceholder('원문이 비어 있어서 변환할 수 없습니다.');
    return;
  }

  if (!state.variants.length) {
    renderVariantPlaceholder('변환 버튼을 누르면 원문을 바탕으로 3가지 결과를 만듭니다.');
    return;
  }

  renderVariantCards(state.variants);
}

function renderVariantCards(variants) {
  els.variantList.innerHTML = '';
  els.emptyState.hidden = true;

  if (!variants.some((variant) => variant.id === state.selectedVariantId)) {
    state.selectedVariantId = variants[0]?.id || 'possibility-1';
  }

  const sourceText = normalizeWhitespace(els.transcript.value || state.transcript);

  variants.forEach((variant) => {
    const comparison = buildVariantComparison(sourceText, variant.text);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `variant-card ${state.selectedVariantId === variant.id ? 'is-selected' : ''}`;
    card.dataset.variantId = variant.id;
    card.innerHTML = `
      <span class="variant-card__label">${variant.label}</span>
      <span class="variant-card__meta">원문 대비 ${comparison.changedCount === 0 ? '변경 없음' : `${comparison.changedCount}곳 변경`}</span>
      <span class="variant-card__text">${comparison.html}</span>
      <span class="variant-card__diff">${comparison.summary}</span>
    `;
    card.addEventListener('click', () => {
      state.selectedVariantId = variant.id;
      renderVariantCards(variants);
      showToast('복사되었습니다');
      copyTextToClipboard(variant.text).then((copied) => {
        if (!copied) {
          setStatus('이 브라우저에서는 클립보드 복사에 실패했습니다.');
        }
      });
    });
    els.variantList.appendChild(card);
  });
}

function buildVariantComparison(sourceText, variantText) {
  const sourceTokens = tokenizeForDiff(sourceText);
  const variantTokens = tokenizeForDiff(variantText);

  if (!sourceTokens.length || !variantTokens.length) {
    return {
      changedCount: 0,
      html: escapeHtml(variantText),
      summary: '차이를 계산할 수 없습니다.'
    };
  }

  const markedTokens = markChangedTokens(sourceTokens, variantTokens);
  const changedCount = markedTokens.filter(Boolean).length;
  const html = variantTokens
    .map((token, index) => (markedTokens[index] ? `<mark class="diff-token">${escapeHtml(token)}</mark>` : escapeHtml(token)))
    .join(' ');

  return {
    changedCount,
    html,
    summary: changedCount === 0 ? '원문과 거의 동일합니다.' : '노란색이 원문에서 바뀐 부분입니다.'
  };
}

function tokenizeForDiff(value) {
  return String(value ?? '').split(/\s+/).filter(Boolean);
}

function markChangedTokens(sourceTokens, variantTokens) {
  const sourceLength = sourceTokens.length;
  const variantLength = variantTokens.length;
  const dp = Array.from({ length: sourceLength + 1 }, () => Array(variantLength + 1).fill(0));

  for (let i = sourceLength - 1; i >= 0; i -= 1) {
    for (let j = variantLength - 1; j >= 0; j -= 1) {
      if (sourceTokens[i] === variantTokens[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const marked = Array(variantLength).fill(false);
  let i = 0;
  let j = 0;

  while (i < sourceLength && j < variantLength) {
    if (sourceTokens[i] === variantTokens[j]) {
      i += 1;
      j += 1;
      continue;
    }

    if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
      continue;
    }

    marked[j] = true;
    j += 1;
  }

  while (j < variantLength) {
    marked[j] = true;
    j += 1;
  }

  return marked;
}

function handleGenerateClicked() {
  state.readyForVariants = true;
  const transcript = normalizeWhitespace(els.transcript.value || state.transcript);

  if (!transcript) {
    state.variants = [];
    renderVariantPlaceholder('먼저 원문이 있어야 변환할 수 있습니다.');
    setStatus('먼저 원문이 있어야 가능성을 계산할 수 있습니다.');
    return;
  }

  state.variants = buildRewriteVariants(transcript);
  renderVariants();
  setStatus('현재 원문 기준으로 3가지 가능성을 변환했습니다.');
}

async function copySelectedVariant() {
  const transcript = normalizeWhitespace(els.transcript.value || state.transcript);
  if (!transcript) {
    setStatus('먼저 원문이 있어야 복사할 수 있습니다.');
    return;
  }

  const variants = state.variants.length ? state.variants : buildRewriteVariants(transcript);
  const selected = variants.find((variant) => variant.id === state.selectedVariantId) || variants[0];

  const copied = await copyTextToClipboard(selected?.text || '');
  if (copied) {
    showToast('복사되었습니다');
    setStatus('선택한 가능성을 클립보드에 복사했습니다.');
  } else {
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
  state.transcript = value;
  els.transcript.value = value;
}

function syncTranscriptDisplay(nextValue) {
  const currentValue = els.transcript.value || '';
  const targetValue = String(nextValue ?? '');

  if (currentValue === targetValue) return targetValue;

  const commonPrefixLength = getCommonPrefixLength(currentValue, targetValue);
  const syncedValue = `${currentValue.slice(0, commonPrefixLength)}${targetValue.slice(commonPrefixLength)}`;
  els.transcript.value = syncedValue;
  return syncedValue;
}

function getCommonPrefixLength(left, right) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function renderVariantPlaceholder(message) {
  state.variants = [];
  els.variantList.innerHTML = '';
  els.emptyState.hidden = false;
  els.emptyState.textContent = message;
}

async function startVoiceActivityMonitor() {
  cleanupAudioActivityMonitor();

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor || !state.stream) return;

  state.audioContext = new AudioContextCtor();
  if (state.audioContext.state === 'suspended') {
    try {
      await state.audioContext.resume();
    } catch {
      // ignore
    }
  }

  state.audioSource = state.audioContext.createMediaStreamSource(state.stream);
  state.audioAnalyser = state.audioContext.createAnalyser();
  state.audioAnalyser.fftSize = 2048;
  state.audioSamples = new Float32Array(state.audioAnalyser.fftSize);
  state.audioSource.connect(state.audioAnalyser);
  state.lastVoiceAt = Date.now();

  state.voiceMonitorTimer = window.setInterval(() => {
    if (!state.recorder || state.recorder.state !== 'recording' || !state.audioAnalyser || !state.audioSamples) return;

    state.audioAnalyser.getFloatTimeDomainData(state.audioSamples);
    const level = calculateRms(state.audioSamples);
    if (level >= VOICE_LEVEL_THRESHOLD) {
      state.lastVoiceAt = Date.now();
      return;
    }

    if (hasTimedOutSince(state.lastVoiceAt, Date.now(), SILENCE_TIMEOUT_MS)) {
      stopCapture();
      setStatus('1분 동안 무음이어서 자동으로 녹음을 종료했습니다.');
    }
  }, VOICE_CHECK_INTERVAL_MS);
}

function cleanupAudioActivityMonitor() {
  if (state.voiceMonitorTimer) {
    window.clearInterval(state.voiceMonitorTimer);
    state.voiceMonitorTimer = null;
  }

  if (state.audioSource) {
    try {
      state.audioSource.disconnect();
    } catch {
      // ignore
    }
  }

  if (state.audioAnalyser) {
    try {
      state.audioAnalyser.disconnect();
    } catch {
      // ignore
    }
  }

  if (state.audioContext) {
    try {
      state.audioContext.close();
    } catch {
      // ignore
    }
  }

  state.audioContext = null;
  state.audioSource = null;
  state.audioAnalyser = null;
  state.audioSamples = null;
}

function scheduleRecognitionRestart() {
  if (!shouldRestartRecognition({ isRecording: state.recorder?.state === 'recording', isStopping: state.isStopping })) return;

  window.clearTimeout(state.recognitionRestartTimer);
  state.recognitionRestartTimer = window.setTimeout(() => {
    if (!shouldRestartRecognition({ isRecording: state.recorder?.state === 'recording', isStopping: state.isStopping })) return;

    const recognition = createSpeechRecognition();
    state.recognition = recognition;
    if (!recognition) return;

    recognition.onresult = onRecognitionResult;
    recognition.onerror = onRecognitionError;
    recognition.onend = onRecognitionEnd;

    try {
      recognition.start();
    } catch (error) {
      setStatus(`음성 인식을 다시 시작할 수 없습니다: ${friendlyError(error)}`);
    }
  }, RECOGNITION_RESTART_DELAY_MS);
}

function copyTextToClipboard(text) {
  if (!text) return Promise.resolve(false);

  const fallbackSucceeded = fallbackCopyText(text);
  if (fallbackSucceeded) {
    return Promise.resolve(true);
  }

  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text)
      .then(() => true)
      .catch(() => false);
  }

  return Promise.resolve(false);
}

function fallbackCopyText(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }

  document.body.removeChild(textarea);
  return copied;
}

function showToast(message) {
  if (!els.toast) return;

  window.clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.hidden = false;
  els.toast.classList.add('is-visible');

  state.toastTimer = window.setTimeout(() => {
    els.toast.classList.remove('is-visible');
    els.toast.hidden = true;
  }, 5000);
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
