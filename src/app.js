import { buildRewriteVariants, compareTranscriptSources, normalizeWhitespace } from './rewrite.js?v=llm-variants-30';
import { transcribeAudioBlob as transcribeAudioBlobImpl } from './asr.js?v=llm-variants-30';
import { mergeRecognitionResults } from './stt.js?v=llm-variants-30';
import { calculateRms, shouldCommitTranscriptLineBreakAfterSilence, shouldInsertLineBreakBeforeNextSpeech, shouldRestartRecognition } from './capture.js?v=llm-variants-30';
import { fetchConfirmationSummary as fetchConfirmationSummaryImpl, fetchRewriteVariants as fetchRewriteVariantsImpl } from './llm.js?v=llm-variants-30';

const testHooks = getTestHooks();

function getTestHooks() {
  return typeof window !== 'undefined' ? window.__PARDON_TEST_HOOKS__ || null : null;
}

async function fetchRewriteVariants(request) {
  if (typeof testHooks?.fetchRewriteVariants === 'function') {
    return testHooks.fetchRewriteVariants(request);
  }

  return fetchRewriteVariantsImpl(request);
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
  recordedTranscript: document.querySelector('#recorded-transcript'),
  recordedTranscriptStatus: document.querySelector('#recorded-transcript-status'),
  recoveredTranscript: document.querySelector('#recovered-transcript'),
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
  variantOptions: [],
  selectedVariantId: '',
  selectedAudioUrl: '',
  confirmedSummary: '',
  readyForVariants: false,
  lastVoiceAt: 0,
  isStopping: false,
  isTranscribing: false,
  captureRevision: 0,
  voiceMonitorTimer: null,
  recognitionRestartTimer: null,
  toastTimer: null,
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
  setActionControlsDisabled(false);
  wireEvents();
}

function renderRecordedTranscript() {
  if (!els.recordedTranscript) return;

  const rawTranscriptText = String(state.recordedTranscriptRaw || state.rawTranscript || '');
  const recoveredTranscriptText = String(state.recoveredTranscript || '');
  const hasRawTranscript = Boolean(rawTranscriptText);
  const hasRecoveredTranscript = Boolean(recoveredTranscriptText);
  const comparisonSummary = normalizeWhitespace(state.transcriptComparison?.summary || '');

  els.recordedTranscript.classList.toggle('empty-state', !hasRawTranscript);
  els.recordedTranscript.textContent = hasRawTranscript
    ? rawTranscriptText
    : 'STT 버튼을 누르면 녹음 STT 원문이 아래에 표시됩니다.';

  if (els.recordedTranscriptStatus) {
    els.recordedTranscriptStatus.textContent = comparisonSummary || 'STT 버튼을 누르면 녹음 STT 원문과 비교 기준이 함께 표시됩니다.';
  }

  if (!els.recoveredTranscript) return;

  els.recoveredTranscript.classList.toggle('empty-state', !hasRecoveredTranscript);
  els.recoveredTranscript.textContent = hasRecoveredTranscript
    ? recoveredTranscriptText
    : '아직 비교 기준 문장이 없습니다.';
}

function wireEvents() {
  els.startButton.addEventListener('click', startCapture);
  els.stopButton.addEventListener('click', stopCapture);
  els.transcript.addEventListener('input', onTranscriptEdit);
  els.transcribeButton.addEventListener('click', handleTranscribeClicked);
  els.clearButton.addEventListener('click', clearAll);
  els.generateButton.addEventListener('click', handleGenerateClicked);
  els.copyButton.addEventListener('click', copySelectedVariant);
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
  state.diffModel = null;
  state.diffSelections = {};
  state.isTranscribing = false;
  state.recordedAudioBlob = null;
  renderVariantPlaceholder('정지하면 변환 버튼으로 원문 기반 LLM 후보 3개를 만들 수 있습니다.');
  renderRecordedTranscript();
  renderSelectedDiffSummary();
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
  renderVariantPlaceholder('STT 버튼을 누른 뒤 변환하면 원문 기반 LLM 후보 3개를 만들 수 있습니다.');
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
  state.diffModel = null;
  state.diffSelections = {};
  state.confirmedSummary = '';
  state.readyForVariants = false;
  state.lastVoiceAt = 0;
  state.pendingLineBreakBeforeNextSpeech = false;
  state.audioVoiceActive = false;
  if (els.transcript) {
    els.transcript.value = '';
  }
  setAudioUrl('');
  renderConfirmedSummary('확정하면 아래에 요약이 표시됩니다.', '');
  renderRecordedTranscript();
  renderSelectedDiffSummary();
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
    renderVariantPlaceholder('녹음 파일이 아직 준비되지 않았습니다.');
    return;
  }

  const blob = new Blob(state.chunks, { type: state.recorder?.mimeType || getPreferredRecorderMimeType() || 'audio/webm' });
  state.recordedAudioBlob = blob;
  setAudioUrl(URL.createObjectURL(blob));
  updateTranscribeButtonState();
}

async function handleTranscribeClicked() {
  if (!state.recordedAudioBlob || state.isTranscribing) {
    return;
  }

  state.isTranscribing = true;
  state.readyForVariants = false;
  state.diffModel = null;
  state.diffSelections = {};
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
    const transcriptComparison = compareTranscriptSources(
      state.liveTranscriptRaw,
      normalizedRaw,
      state.transcript || state.liveTranscriptRaw || normalizedRaw
    );
    const recoveredTranscript = normalizeWhitespace(transcriptComparison.recoveredText || normalizedRaw);
    const cleanedTranscript = normalizeWhitespace(buildRewriteVariants(recoveredTranscript)[0]?.text || recoveredTranscript);

    state.rawTranscript = normalizedRaw;
    state.recordedTranscriptRaw = normalizedRaw;
    state.recoveredTranscript = recoveredTranscript || normalizedRaw;
    state.cleanedTranscript = cleanedTranscript || recoveredTranscript || normalizedRaw;
    state.transcriptComparison = transcriptComparison;
    state.readyForVariants = Boolean(normalizeWhitespace(state.rawTranscript) || normalizeWhitespace(state.recoveredTranscript));

    renderRecordedTranscript();
    renderVariantPlaceholder(state.readyForVariants ? '변환 버튼을 누르면 원문 기반 LLM 후보 3개를 생성합니다.' : '녹음 파일 STT 결과가 비어 있습니다. 다시 시도해 주세요.');
    renderSelectedDiffSummary();
    setStatus(state.readyForVariants ? `STT가 끝났습니다. ${transcriptComparison.summary}` : '녹음 파일 STT 결과가 비어 있습니다.');
  } catch (error) {
    state.rawTranscript = '';
    state.cleanedTranscript = '';
    state.recoveredTranscript = '';
    state.recordedTranscriptRaw = '';
    state.transcriptComparison = null;
    state.diffModel = null;
    state.diffSelections = {};
    renderRecordedTranscript();
    renderVariantPlaceholder('녹음 파일 STT에 실패했습니다.');
    setStatus(`녹음 파일 STT에 실패했습니다: ${friendlyError(error)}`);
  } finally {
    state.isTranscribing = false;
    setActionControlsDisabled(false);
    updateTranscribeButtonState();
  }
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
    setStatus('녹음 중입니다. 정지 후 파일 STT를 만들고, 변환 시 원문 기반 후보 3개를 생성합니다.');
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
  state.diffModel = null;
  state.diffSelections = {};
  state.confirmedSummary = '';
  if (state.readyForVariants) {
    renderVariantPlaceholder('원문이 바뀌었습니다. 후보 3개를 다시 생성하려면 변환 버튼을 다시 눌러 주세요.');
    renderConfirmedSummary('확정하면 아래에 요약이 표시됩니다.', '');
  }
  renderSelectedDiffSummary();
}

function renderVariants() {
  if (!state.readyForVariants) {
    renderVariantPlaceholder('STT가 끝나면 변환 버튼으로 원문 기반 LLM 후보 3개를 만들 수 있습니다.');
    return;
  }

  if (!state.variantOptions.length) {
    renderVariantPlaceholder('변환 버튼을 누르면 원문 기반 LLM 후보 3개를 보여줍니다.');
    return;
  }

  renderVariantCards(state.variantOptions);
}

function renderVariantCards(variants) {
  els.variantList.innerHTML = '';
  els.emptyState.hidden = true;

  const variantOptions = Array.isArray(variants) ? variants : [];
  if (!variantOptions.length) {
    renderVariantPlaceholder('제안 후보가 아직 없습니다.');
    renderSelectedDiffSummary();
    return;
  }

  const sourceText = getRewriteSourceText();

  variantOptions.forEach((variant, index) => {
    const isSelected = state.selectedVariantId === variant.id;
    const comparison = buildVariantComparison(sourceText, variant.text);
    const card = document.createElement('article');
    card.className = `variant-card${isSelected ? ' is-selected' : ''}`;
    card.dataset.variantId = variant.id;
    card.innerHTML = `
      <div class="variant-card__body">
        <button type="button" class="variant-choice ${isSelected ? 'is-selected' : ''}" data-action="choose-variant" aria-pressed="${isSelected}">
          <span class="variant-card__label">${escapeHtml(variant.label || `제안 ${index + 1}`)}</span>
          <span class="variant-card__meta">변경 토큰 ${comparison.changedCount}개</span>
          <span class="variant-card__text">${comparison.html}</span>
          <span class="variant-card__diff">${escapeHtml(comparison.summary)} 카드 전체를 눌러 선택하세요.</span>
        </button>
      </div>
    `;

    card.querySelector('[data-action="choose-variant"]')?.addEventListener('click', () => {
      setSelectedVariant(variant.id);
    });

    els.variantList.appendChild(card);
  });

  renderSelectedDiffSummary();
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
  const liveTranscript = normalizeWhitespace(state.transcript || state.liveTranscriptRaw || state.recoveredTranscript);
  const recordedTranscript = normalizeWhitespace(state.recoveredTranscript || state.rawTranscript);

  if (!liveTranscript && !recordedTranscript) {
    state.variantOptions = [];
    state.selectedVariantId = '';
    renderVariantPlaceholder('먼저 원문 STT나 녹음 STT가 있어야 변환할 수 있습니다.');
    setStatus('원문 STT 또는 복구된 녹음 STT가 준비되면 후보 3개를 생성할 수 있습니다.');
    renderSelectedDiffSummary();
    return;
  }

  const baseTranscript = liveTranscript || recordedTranscript;
  const evidenceTranscript = recordedTranscript && recordedTranscript !== baseTranscript ? recordedTranscript : normalizeWhitespace(state.rawTranscript);

  setActionControlsDisabled(true);
  renderVariantPlaceholder('원문을 기준으로 녹음 STT를 교차검증해 후보 3개를 생성하는 중입니다.');
  setStatus('변환 엔진이 원문 기반 후보 3개를 생성하는 중입니다.');

  try {
    const variants = await fetchRewriteVariants({
      baseTranscript,
      evidenceTranscript
    });
    const safeVariants = Array.isArray(variants) && variants.length ? variants : buildRewriteVariants(baseTranscript);
    state.variantOptions = safeVariants;
    state.selectedVariantId = safeVariants[0]?.id || '';
    renderVariants();
    setStatus(`원문 기반 후보 ${safeVariants.length}개를 만들었습니다. 원하는 카드를 고르세요.`);
  } catch (error) {
    state.variantOptions = buildRewriteVariants(baseTranscript);
    state.selectedVariantId = state.variantOptions[0]?.id || '';
    renderVariants();
    setStatus(`후보 생성에 실패해 로컬 후보로 전환했습니다: ${friendlyError(error)}`);
  } finally {
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

function commitTranscriptLineBreak() {
  const transcript = String(state.transcript ?? '');
  const committedTranscript = String(state.recognitionCommittedTranscript ?? '');

  if (!transcript || transcript.endsWith('\n') || transcript !== committedTranscript) {
    return false;
  }

  state.transcript = `${transcript}\n`;
  state.recognitionCommittedTranscript = `${committedTranscript}\n`;
  state.liveTranscriptRaw = state.transcript;
  state.pendingLineBreakBeforeNextSpeech = false;

  if (els.transcript) {
    els.transcript.value = state.transcript;
  }

  return true;
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
  renderSelectedDiffSummary();
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

function setSelectedVariant(variantId) {
  if (!variantId) {
    return;
  }

  state.selectedVariantId = variantId;
  renderVariantCards(state.variantOptions);
}

function getSelectedDiffText() {
  if (!state.variantOptions.length) {
    return '';
  }

  return normalizeWhitespace(state.variantOptions.find((variant) => variant.id === state.selectedVariantId)?.text || state.variantOptions[0]?.text || '');
}

function renderSelectedDiffSummary() {
  const mergedText = getSelectedDiffText();
  const sourceLabel = state.variantOptions.find((variant) => variant.id === state.selectedVariantId)?.label || '';
  renderConfirmedSummary(mergedText || '확정하면 아래에 요약이 표시됩니다.', sourceLabel);
}

function renderVariantPlaceholder(message) {
  els.variantList.innerHTML = '';
  els.emptyState.hidden = false;
  els.emptyState.textContent = message;
  renderSelectedDiffSummary();
  setActionControlsDisabled(false);
}

function copySelectedVariant() {
  const text = getSelectedDiffText();
  if (!text) {
    setStatus('먼저 원문과 녹음 STT로 후보 3개를 생성해야 복사할 수 있습니다.');
    return;
  }

  void copyTextToClipboard(text).then((copied) => {
    if (copied) {
      showToast('복사되었습니다');
      setStatus('선택한 결과를 클립보드에 복사했습니다.');
    } else {
      setStatus('이 브라우저에서는 클립보드 복사에 실패했습니다.');
    }
  });
}

function renderConfirmedSummary(summaryText, sourceLabel) {
  const hasSummary = Boolean(normalizeWhitespace(summaryText));
  const content = hasSummary ? summaryText : '확정하면 아래에 요약이 표시됩니다.';
  state.confirmedSummary = content;

  if (!els.confirmedSummary) return;

  els.confirmationStatus.textContent = sourceLabel ? `현재 상태: ${sourceLabel}` : '선택 결과';
  els.confirmedSummary.hidden = false;
  els.confirmedSummary.classList.toggle('empty-state', !hasSummary);
  els.confirmedSummary.innerHTML = hasSummary
    ? `<p class="confirmed-summary__label">선택 결과</p><p class="confirmed-summary__text">${escapeHtml(content)}</p>`
    : escapeHtml(content);
}

function setActionControlsDisabled(isBusy) {
  const hasTranscript = Boolean(normalizeWhitespace(state.rawTranscript) || normalizeWhitespace(state.recoveredTranscript) || normalizeWhitespace(state.cleanedTranscript));
  const hasSelection = Boolean(normalizeWhitespace(getSelectedDiffText()));
  const busy = Boolean(isBusy || state.isTranscribing);
  els.generateButton.disabled = busy || !hasTranscript;
  els.copyButton.disabled = busy || !hasSelection;
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

      if (!isSpeaking) {
        if (shouldCommitTranscriptLineBreakAfterSilence({
          hasTranscript: Boolean(state.recognitionCommittedTranscript),
          wasSpeaking,
          isSpeaking,
          lastVoiceAt: state.lastVoiceAt,
          now,
          silenceMs: 1000
        })) {
          commitTranscriptLineBreak();
        }

        if (wasSpeaking) {
          state.audioVoiceActive = false;
        }

        return;
      }

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
