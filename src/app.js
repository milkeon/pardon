import { buildConfirmationSummary, buildRewriteVariants, normalizeWhitespace } from './rewrite.js?v=stt-linebreak-22';
import { fetchConfirmationSummary as fetchConfirmationSummaryImpl, fetchRewriteVariants as fetchRewriteVariantsImpl } from './llm.js?v=stt-linebreak-22';
import { transcribeAudioBlob as transcribeAudioBlobImpl } from './asr.js?v=stt-linebreak-22';
import { mergeRecognitionResults } from './stt.js?v=stt-linebreak-22';
import { calculateRms, shouldInsertLineBreakBeforeNextSpeech, shouldRestartRecognition } from './capture.js?v=stt-linebreak-22';

const testHooks = getTestHooks();

function getTestHooks() {
  return typeof window !== 'undefined' ? window.__PARDON_TEST_HOOKS__ || null : null;
}

async function fetchRewriteVariants(transcript) {
  if (typeof testHooks?.fetchRewriteVariants === 'function') {
    return testHooks.fetchRewriteVariants(transcript);
  }

  return fetchRewriteVariantsImpl(transcript);
}

async function fetchConfirmationSummary(selectedText, transcript) {
  if (typeof testHooks?.fetchConfirmationSummary === 'function') {
    return testHooks.fetchConfirmationSummary(selectedText, transcript);
  }

  return fetchConfirmationSummaryImpl(selectedText, transcript);
}

async function transcribeAudioBlob(blob, options = {}) {
  if (typeof testHooks?.transcribeAudioBlob === 'function') {
    return testHooks.transcribeAudioBlob(blob, options);
  }

  return transcribeAudioBlobImpl(blob, options);
}

const els = {
  startButton: document.querySelector('[data-action="start-recording"]'),
  stopButton: document.querySelector('[data-action="stop-recording"]'),
  transcript: document.querySelector('#transcript'),
  transcribeButton: document.querySelector('[data-action="transcribe-recording"]'),
  clearButton: document.querySelector('[data-action="clear"]'),
  generateButton: document.querySelector('[data-action="generate"]'),
  copyButton: document.querySelector('[data-action="copy"]'),
  transcriptStatus: document.querySelector('#transcript-status'),
  transcriptComparisonStatus: document.querySelector('#transcript-comparison-status'),
  recordedTranscript: document.querySelector('#recorded-transcript'),
  comparisonRaw: document.querySelector('#comparison-raw'),
  comparisonRecorded: document.querySelector('#comparison-recorded'),
  comparisonDiff: document.querySelector('#comparison-diff'),
  audioPlayback: document.querySelector('#audio-playback'),
  supportStatus: document.querySelector('#support-status'),
  variantList: document.querySelector('#variant-list'),
  emptyState: document.querySelector('#variants-empty'),
  confirmationStatus: document.querySelector('#confirmation-status'),
  confirmedSummary: document.querySelector('#confirmed-summary'),
  toast: document.querySelector('#toast')
};

const state = {
  recorder: null,
  stream: null,
  audioContext: null,
  audioSource: null,
  audioAnalyser: null,
  audioSamples: null,
  chunks: [],
  transcript: '',
  recordedAudioBlob: null,
  rawTranscript: '',
  cleanedTranscript: '',
  transcriptComparison: null,
  recognition: null,
  liveTranscriptRaw: '',
  recordedTranscriptRaw: '',
  recoveredTranscript: '',
  recognitionSegments: [],
  recognitionCommittedTranscript: '',
  liveTranscriptBackup: '',
  selectedTranscriptSource: 'cleaned',
  selectedVariantId: 'possibility-1',
  selectedAudioUrl: '',
  variants: [],
  confirmedSummary: '',
  readyForVariants: false,
  lastVoiceAt: 0,
  isStopping: false,
  isTranscribing: false,
  captureRevision: 0,
  voiceMonitorTimer: null,
  recognitionRestartTimer: null,
  toastTimer: null,
  isGenerating: false,
  isSummarizing: false,
  pendingLineBreakBeforeNextSpeech: false,
  audioVoiceActive: false
};

const SILENCE_TIMEOUT_MS = 60_000;
const VOICE_CHECK_INTERVAL_MS = 1000;
const VOICE_LEVEL_THRESHOLD = 0.015;
const RECOGNITION_RESTART_DELAY_MS = 500;

initialize();

function initialize() {
  updateSupportStatus();
  renderVariants();
  renderConfirmedSummary('확정하면 아래에 요약이 표시됩니다.', '');
  renderRecordedTranscript();
  renderTranscriptComparison();
  setActionControlsDisabled(false);
  wireEvents();
}

function renderRecordedTranscript() {
  if (!els.recordedTranscript) return;

  const transcriptText = String(state.rawTranscript ?? '');
  const hasTranscript = Boolean(transcriptText);
  els.recordedTranscript.classList.toggle('empty-state', !hasTranscript);
  els.recordedTranscript.textContent = hasTranscript
    ? transcriptText
    : 'STT 버튼을 누르면 녹음 STT가 아래에 표시됩니다.';
}

function wireEvents() {
  els.startButton.addEventListener('click', startCapture);
  els.stopButton.addEventListener('click', stopCapture);
  els.transcript.addEventListener('input', onTranscriptEdit);
  els.transcribeButton.addEventListener('click', handleTranscribeClicked);
  els.clearButton.addEventListener('click', clearAll);
  els.generateButton.addEventListener('click', handleGenerateClicked);
  els.copyButton.addEventListener('click', copySelectedVariant);
  els.comparisonRaw.addEventListener('click', () => selectComparisonSource('raw'));
  els.comparisonRecorded.addEventListener('click', () => selectComparisonSource('cleaned'));
}

async function startCapture() {
  try {
    clearSessionState();
    state.isStopping = false;
    state.isTranscribing = false;
    state.captureRevision += 1;
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.chunks = [];
    const recorderOptions = getPreferredRecorderOptions();
    state.recorder = recorderOptions
      ? new MediaRecorder(state.stream, recorderOptions)
      : new MediaRecorder(state.stream);
    state.recorder.addEventListener('dataavailable', onChunk);
    state.recorder.addEventListener('stop', () => onRecorderStop(state.captureRevision));
    state.recorder.start(1000);

    void startVoiceActivityMonitor();

    const recognition = createSpeechRecognition();
    state.recognition = recognition;
    if (recognition) {
      recognition.onresult = onRecognitionResult;
      recognition.onerror = onRecognitionError;
      recognition.onend = onRecognitionEnd;
      recognition.start();
    }

    setRecording(true);
    setStatus('녹음을 시작했습니다. 위쪽 실시간 원문은 계속 표시되고, 정지하면 오디오 옆 STT 버튼으로 파일 전사를 합니다.');
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

  state.readyForVariants = false;
  state.variants = [];
  state.isTranscribing = false;
  state.recordedAudioBlob = null;
  renderVariantPlaceholder('정지하면 오디오 옆 STT 버튼으로 파일 전사를 시작할 수 있습니다.');
  renderRecordedTranscript();
  renderTranscriptComparison();
  setRecording(false);
  updateTranscribeButtonState();
  setStatus('녹음을 종료했습니다. 오디오 옆 STT 버튼을 눌러 파일 전사를 시작하세요.');
  state.isStopping = false;
}

function clearAll() {
  stopCapture();
  state.captureRevision += 1;
  clearSessionState();
  setTranscript('');
  setAudioUrl('');
  renderRecordedTranscript();
  renderVariantPlaceholder('STT 버튼을 눌러 원문과 녹음 STT를 비교하세요.');
  setStatus('원문, 오디오, 선택 상태를 초기화했습니다.');
}

function clearSessionState() {
  state.chunks = [];
  state.transcript = '';
  state.recordedAudioBlob = null;
  state.rawTranscript = '';
  state.cleanedTranscript = '';
  state.transcriptComparison = null;
  state.recognition = null;
  state.liveTranscriptRaw = '';
  state.recordedTranscriptRaw = '';
  state.recoveredTranscript = '';
  state.recognitionSegments = [];
  state.recognitionCommittedTranscript = '';
  state.liveTranscriptBackup = '';
  state.selectedTranscriptSource = 'cleaned';
  state.variants = [];
  state.confirmedSummary = '';
  state.readyForVariants = false;
  state.selectedVariantId = 'possibility-1';
  state.lastVoiceAt = 0;
  state.pendingLineBreakBeforeNextSpeech = false;
  state.audioVoiceActive = false;
  if (els.transcript) {
    els.transcript.value = '';
  }
  setAudioUrl('');
  renderConfirmedSummary('확정하면 아래에 요약이 표시됩니다.', '');
  renderRecordedTranscript();
  renderTranscriptComparison();
}

function onChunk(event) {
  if (event.data && event.data.size > 0) {
    state.chunks.push(event.data);
  }
}

function onRecorderStop(captureRevision) {
  if (captureRevision !== state.captureRevision) {
    return;
  }

  if (!state.chunks.length) {
    state.recordedAudioBlob = null;
    updateTranscribeButtonState();
    renderTranscriptComparison();
    return;
  }

  const blob = new Blob(state.chunks, { type: state.recorder?.mimeType || getPreferredRecorderMimeType() || 'audio/webm' });
  state.recordedAudioBlob = blob;
  setAudioUrl(URL.createObjectURL(blob));
  updateTranscribeButtonState();
  renderTranscriptComparison();
}

async function handleTranscribeClicked() {
  if (!state.recordedAudioBlob || state.isTranscribing) {
    return;
  }

  state.isTranscribing = true;
  state.readyForVariants = false;
  setActionControlsDisabled(true);
  updateTranscribeButtonState();
  setStatus('녹음 파일을 STT하는 중입니다.');
  renderVariantPlaceholder('녹음 파일 STT를 계산하는 중입니다. 잠시만 기다려 주세요.');

  try {
    const rawTranscript = await transcribeAudioBlob(state.recordedAudioBlob, {
      chunks: state.chunks,
      batchSize: 15,
      chunkLengthSeconds: 15,
      onProgress: ({ currentBatch, totalBatches }) => {
        setStatus(`녹음 파일을 STT하는 중입니다. ${currentBatch}/${totalBatches} 청크를 처리 중입니다.`);
      }
    });
    const normalizedRaw = String(rawTranscript || '');
    const cleanedTranscript = normalizeWhitespace(buildRewriteVariants(normalizedRaw)[0]?.text || normalizedRaw);

    state.rawTranscript = normalizedRaw;
    state.cleanedTranscript = cleanedTranscript || normalizedRaw;
    state.transcriptComparison = buildTranscriptComparison(state.rawTranscript, state.cleanedTranscript);
    state.selectedTranscriptSource = state.transcriptComparison.changedCount === 0 ? 'raw' : 'cleaned';
    state.readyForVariants = Boolean(normalizeWhitespace(getRewriteSourceText()));

    renderRecordedTranscript();
    renderTranscriptComparison();
    renderVariantPlaceholder(state.readyForVariants ? '원문 STT 또는 녹음 STT를 선택한 뒤 변환하세요.' : '녹음 파일 STT가 비어 있습니다. 다시 시도해 주세요.');
    setStatus(state.readyForVariants ? 'STT가 끝났습니다. 아래 녹음 STT 결과와 비교 카드가 함께 표시됩니다.' : '녹음 파일 STT 결과가 비어 있습니다.');
  } catch (error) {
    state.rawTranscript = '';
    state.cleanedTranscript = '';
    state.transcriptComparison = null;
    state.selectedTranscriptSource = 'cleaned';
    renderRecordedTranscript();
    renderTranscriptComparison();
    renderVariantPlaceholder('녹음 파일 STT에 실패했습니다.');
    setStatus(`녹음 파일 STT에 실패했습니다: ${friendlyError(error)}`);
  } finally {
    state.isTranscribing = false;
    setActionControlsDisabled(false);
    updateTranscribeButtonState();
  }
}

function selectComparisonSource(source) {
  if (!state.rawTranscript && !state.cleanedTranscript) {
    return;
  }

  state.selectedTranscriptSource = source;
  state.readyForVariants = Boolean(normalizeWhitespace(getRewriteSourceText()));
  renderTranscriptComparison();
}

function buildTranscriptComparison(rawText, cleanedText) {
  const comparison = buildVariantComparison(rawText, cleanedText);
  return {
    ...comparison,
    rawText,
    cleanedText
  };
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
    event.resultIndex ?? 0,
    { insertLineBreak: state.pendingLineBreakBeforeNextSpeech }
  );

  state.recognitionSegments = merged.segments;
  state.recognitionCommittedTranscript = merged.committedTranscript;
  state.liveTranscriptRaw = merged.transcript;
  state.transcript = merged.transcript;
  els.transcript.value = merged.transcript;
  state.pendingLineBreakBeforeNextSpeech = false;

  if (!state.isTranscribing) {
    setStatus('녹음 중입니다. 정지하면 실시간 원문과 녹음 파일 STT를 비교합니다.');
  }
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
  state.liveTranscriptRaw = els.transcript.value;
  state.recognitionSegments = [{ transcript: els.transcript.value, isFinal: true }];
  state.recognitionCommittedTranscript = els.transcript.value;
  state.recoveredTranscript = '';
  state.transcriptComparison = null;
  if (state.readyForVariants) {
    state.variants = [];
    state.confirmedSummary = '';
    renderVariantPlaceholder('원문이 바뀌었습니다. 변환 버튼을 다시 눌러 주세요.');
    renderConfirmedSummary('확정하면 아래에 요약이 표시됩니다.', '');
  }
  refreshTranscriptComparison();
}

function renderVariants() {
  const transcript = getRewriteSourceText();

  if (!state.readyForVariants) {
    state.variants = [];
    renderVariantPlaceholder('STT가 끝나면 변환 버튼으로 3가지 결과를 만들 수 있습니다.');
    return;
  }

  if (!transcript) {
    state.variants = [];
    renderVariantPlaceholder('선택한 원문이 비어 있어서 변환할 수 없습니다.');
    return;
  }

  if (!state.variants.length) {
    renderVariantPlaceholder('변환 버튼을 누르면 선택한 원문을 바탕으로 3가지 결과를 만듭니다.');
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

  const sourceText = getRewriteSourceText();

  variants.forEach((variant) => {
    const comparison = buildVariantComparison(sourceText, variant.text);
    const card = document.createElement('article');
    card.className = `variant-card ${state.selectedVariantId === variant.id ? 'is-selected' : ''}`;
    card.dataset.variantId = variant.id;
    card.innerHTML = `
      <div class="variant-card__body">
        <span class="variant-card__label">${variant.label}</span>
        <span class="variant-card__meta">원문 대비 ${comparison.changedCount === 0 ? '변경 없음' : `${comparison.changedCount}곳 변경`}</span>
        <span class="variant-card__text">${comparison.html}</span>
        <span class="variant-card__diff">${comparison.summary}</span>
      </div>
      <div class="variant-card__actions">
        <button class="button button--small" type="button" data-action="copy-variant">복사</button>
        <button class="button button--primary button--small" type="button" data-action="confirm-variant">확정</button>
      </div>
    `;

    card.addEventListener('click', () => {
      state.selectedVariantId = variant.id;
      renderVariantCards(variants);
    });

    card.querySelector('[data-action="copy-variant"]')?.addEventListener('click', async (event) => {
      event.stopPropagation();
      await copyVariant(variant);
    });

    card.querySelector('[data-action="confirm-variant"]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      void confirmVariant(variant);
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

async function handleGenerateClicked() {
  state.readyForVariants = true;
  const transcript = getRewriteSourceText();

  if (!transcript) {
    state.variants = [];
    renderVariantPlaceholder('먼저 원문이 있어야 변환할 수 있습니다.');
    setStatus('먼저 원문이 있어야 제안을 계산할 수 있습니다.');
    return;
  }

  state.isGenerating = true;
  setActionControlsDisabled(true);
  setStatus('제안을 계산하는 중입니다. 서버 LLM이 있으면 먼저 사용하고, 없으면 로컬 보정으로 채웁니다.');

  try {
    const remoteVariants = await fetchRewriteVariants(transcript);
    state.variants = remoteVariants || buildRewriteVariants(transcript);
    renderVariants();
    setStatus(remoteVariants ? 'LLM으로 3가지 제안을 만들었습니다.' : '현재 원문 기준으로 3가지 제안을 만들었습니다.');
  } finally {
    state.isGenerating = false;
    setActionControlsDisabled(false);
  }
}

async function copySelectedVariant() {
  const transcript = getRewriteSourceText();
  if (!transcript) {
    setStatus('먼저 원문이 있어야 복사할 수 있습니다.');
    return;
  }

  const variants = state.variants.length ? state.variants : buildRewriteVariants(transcript);
  const selected = variants.find((variant) => variant.id === state.selectedVariantId) || variants[0];

  await copyVariant(selected);
}

async function copyVariant(variant) {
  const transcript = getRewriteSourceText();
  if (!transcript) {
    setStatus('먼저 원문이 있어야 복사할 수 있습니다.');
    return;
  }

  const selected = variant || state.variants.find((item) => item.id === state.selectedVariantId) || state.variants[0] || buildRewriteVariants(transcript)[0];
  if (!selected) {
    setStatus('먼저 제안을 만든 뒤 복사해 주세요.');
    return;
  }

  const copied = await copyTextToClipboard(selected?.text || '');
  if (copied) {
    showToast('복사되었습니다');
    state.selectedVariantId = selected.id;
    if (state.variants.length) {
      renderVariantCards(state.variants);
    }
    setStatus(`${selected.label}을 클립보드에 복사했습니다.`);
  } else {
    setStatus('이 브라우저에서는 클립보드 복사에 실패했습니다.');
  }
}

async function confirmVariant(variant) {
  const transcript = getRewriteSourceText();
  if (!transcript) {
    setStatus('먼저 원문이 있어야 확정할 수 있습니다.');
    return;
  }

  const selected = variant || state.variants.find((item) => item.id === state.selectedVariantId) || state.variants[0] || buildRewriteVariants(transcript)[0];
  if (!selected) {
    setStatus('먼저 제안을 만든 뒤 확정해 주세요.');
    return;
  }

  state.selectedVariantId = selected.id;
  state.isSummarizing = true;
  setActionControlsDisabled(true);
  setStatus(`확정한 ${selected.label}을 아래에 요약하는 중입니다.`);

  try {
    const remoteSummary = await fetchConfirmationSummary(selected.text, transcript);
    const localSummary = buildConfirmationSummary(selected.text, transcript);
    const remoteSummaryText = normalizeWhitespace(remoteSummary?.summary || '');
    const summaryText = chooseConfirmationSummary(remoteSummaryText, localSummary, selected.text, transcript);
    renderConfirmedSummary(summaryText, selected.label);
    setStatus('확정한 제안을 아래에 더 짧게 정리해서 보여줍니다.');
    renderVariantCards(state.variants.length ? state.variants : buildRewriteVariants(transcript));
  } finally {
    state.isSummarizing = false;
    setActionControlsDisabled(false);
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
  const hasRecognition = typeof SpeechRecognition !== 'undefined' || typeof webkitSpeechRecognition !== 'undefined';

  els.supportStatus.textContent = [
    hasRecorder ? 'MediaRecorder: 지원됨' : 'MediaRecorder: 지원 안 됨',
    hasRecognition ? 'SpeechRecognition: 지원됨' : 'SpeechRecognition: 지원 안 됨',
    '녹음 포맷: FLAC 우선 · 브라우저 호환 포맷 자동 선택',
    '파일 STT: STT 버튼으로 실행'
  ].join(' · ');
}

function getPreferredRecorderMimeType() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }

  const preferredTypes = ['audio/flac', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
  return preferredTypes.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function getPreferredRecorderOptions() {
  const mimeType = getPreferredRecorderMimeType();
  return mimeType ? { mimeType } : null;
}

function setRecording(isRecording) {
  els.startButton.disabled = isRecording;
  els.stopButton.disabled = !isRecording;
  updateTranscribeButtonState();
}

function setStatus(message) {
  els.transcriptStatus.textContent = message;
}

function setTranscript(value) {
  state.transcript = String(value ?? '');
  state.liveTranscriptRaw = state.transcript;
  if (els.transcript) {
    els.transcript.value = state.transcript;
  }
}

function getRewriteSourceText() {
  if (normalizeWhitespace(state.transcript)) {
    return normalizeWhitespace(state.transcript);
  }

  if (!state.transcriptComparison) {
    return '';
  }

  return normalizeWhitespace(
    state.selectedTranscriptSource === 'raw'
      ? state.transcriptComparison.rawText
      : state.transcriptComparison.cleanedText
  );
}

function refreshTranscriptComparison() {
  renderTranscriptComparison();
}

function syncTranscriptDisplay(nextValue) {
  return String(nextValue ?? '');
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
  setActionControlsDisabled(false);
}

function renderTranscriptComparison() {
  const rawText = state.rawTranscript || '';
  const cleanedText = state.cleanedTranscript || '';
  const comparison = state.transcriptComparison || (rawText || cleanedText ? buildTranscriptComparison(rawText, cleanedText || rawText) : null);
  const rawCardText = rawText || 'STT 버튼을 누르면 원문 STT가 여기에 표시됩니다.';
  const cleanedCardText = cleanedText || 'STT 버튼을 누르면 녹음 STT가 여기에 표시됩니다.';
  const diffText = comparison?.summary || 'STT를 마치면 차이가 여기 표시됩니다.';

  if (els.comparisonRaw) {
    els.comparisonRaw.classList.toggle('is-selected', state.selectedTranscriptSource === 'raw');
    els.comparisonRaw.querySelector('.transcript-surface__text').innerHTML = comparison?.rawText ? escapeHtml(rawCardText) : escapeHtml(rawCardText);
  }

  if (els.comparisonRecorded) {
    els.comparisonRecorded.classList.toggle('is-selected', state.selectedTranscriptSource === 'cleaned');
    els.comparisonRecorded.querySelector('.transcript-surface__text').innerHTML = comparison?.cleanedText
      ? comparison.html
      : escapeHtml(cleanedCardText);
  }

  if (els.comparisonDiff) {
    els.comparisonDiff.textContent = diffText;
  }

  if (els.transcriptComparisonStatus) {
    if (!comparison || (!rawText && !cleanedText)) {
      els.transcriptComparisonStatus.textContent = 'STT 버튼을 누르면 원문 STT와 녹음 STT를 비교합니다.';
      return;
    }

    const pickedLabel = state.selectedTranscriptSource === 'raw' ? '원문 STT' : '녹음 STT';
    els.transcriptComparisonStatus.textContent = `${pickedLabel}를 기준으로 변환합니다. ${comparison.summary}`;
  }
}

function renderConfirmedSummary(summaryText, sourceLabel) {
  const hasSummary = Boolean(normalizeWhitespace(summaryText));
  const content = hasSummary ? summaryText : '확정하면 아래에 요약이 표시됩니다.';
  state.confirmedSummary = content;

  if (!els.confirmedSummary) return;

  els.confirmationStatus.textContent = sourceLabel ? `확정한 제안: ${sourceLabel}` : '확정 요약';
  els.confirmedSummary.hidden = false;
  els.confirmedSummary.classList.toggle('empty-state', !hasSummary);
  els.confirmedSummary.innerHTML = hasSummary
    ? `<p class="confirmed-summary__label">확정 요약</p><p class="confirmed-summary__text">${escapeHtml(content)}</p>`
    : escapeHtml(content);
}

function chooseConfirmationSummary(remoteSummaryText, localSummary, selectedText, transcript) {
  const remote = normalizeWhitespace(remoteSummaryText);
  const local = normalizeWhitespace(localSummary);
  const selected = normalizeWhitespace(selectedText);
  const source = normalizeWhitespace(transcript);

  if (!remote) {
    return local;
  }

  if (!local) {
    return remote;
  }

  if (remote === selected) {
    return local;
  }

  const remoteSentenceCount = remote.split(/(?<=[.!?])\s+/).filter(Boolean).length;
  const remoteTooLong = remote.length >= local.length || (source && remote.length >= Math.floor(source.length * 0.6));
  const remoteTooBroad = remoteSentenceCount > 1 && source && remote.length >= Math.floor(source.length * 0.4);

  if (remoteTooLong || remoteTooBroad) {
    return local;
  }

  return remote;
}

function setActionControlsDisabled(isBusy) {
  const hasTranscript = Boolean(getRewriteSourceText());
  const hasVariants = state.variants.length > 0;
  const busy = Boolean(isBusy || state.isTranscribing);
  els.generateButton.disabled = busy || !hasTranscript;
  els.copyButton.disabled = busy || !hasTranscript || !hasVariants;
  updateTranscribeButtonState();
}

function updateTranscribeButtonState() {
  if (!els.transcribeButton) return;

  els.transcribeButton.disabled = Boolean(
    !state.recordedAudioBlob || state.isTranscribing || state.isStopping || (state.recorder && state.recorder.state === 'recording')
  );
}

async function startVoiceActivityMonitor() {
  cleanupAudioActivityMonitor();

  if (!state.stream) {
    return;
  }

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    return;
  }

  try {
    state.audioContext = new AudioContextCtor();
    state.audioSource = state.audioContext.createMediaStreamSource(state.stream);
    state.audioAnalyser = state.audioContext.createAnalyser();
    state.audioAnalyser.fftSize = 1024;
    state.audioSamples = new Uint8Array(state.audioAnalyser.fftSize);
    state.audioSource.connect(state.audioAnalyser);
    state.lastVoiceAt = Date.now();
    state.audioVoiceActive = false;

    state.voiceMonitorTimer = window.setInterval(() => {
      if (!state.audioAnalyser || !state.audioSamples) {
        return;
      }

      if (!state.stream || state.isStopping) {
        cleanupAudioActivityMonitor();
        return;
      }

      state.audioAnalyser.getByteTimeDomainData(state.audioSamples);
      const rms = calculateRms(Array.from(state.audioSamples, (sample) => (sample - 128) / 128));
      const now = Date.now();
      const isSpeaking = rms >= VOICE_LEVEL_THRESHOLD;
      const wasSpeaking = state.audioVoiceActive;

      if (isSpeaking) {
        if (shouldInsertLineBreakBeforeNextSpeech({
          hasTranscript: Boolean(state.recognitionCommittedTranscript),
          wasSpeaking,
          isSpeaking,
          lastVoiceAt: state.lastVoiceAt,
          now,
          silenceMs: 1000
        })) {
          state.pendingLineBreakBeforeNextSpeech = true;
        }

        state.lastVoiceAt = now;
        state.audioVoiceActive = true;
        return;
      }

      if (wasSpeaking) {
        state.audioVoiceActive = false;
      }
    }, VOICE_CHECK_INTERVAL_MS);
  } catch {
    cleanupAudioActivityMonitor();
  }
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
