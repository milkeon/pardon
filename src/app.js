import { buildConfirmationSummary, buildRewriteVariants, compareTranscriptSources, normalizeWhitespace } from './rewrite.js?v=confirm-llm-8';
import { fetchConfirmationSummary, fetchRewriteVariants } from './llm.js?v=confirm-llm-8';
import { transcribeAudioBlob } from './asr.js?v=confirm-llm-8';
import { mergeRecognitionResults } from './stt.js?v=confirm-llm-5';
import { calculateRms, hasTimedOutSince, shouldRestartRecognition } from './capture.js?v=confirm-llm-5';

const els = {
  startButton: document.querySelector('[data-action="start-recording"]'),
  stopButton: document.querySelector('[data-action="stop-recording"]'),
  clearButton: document.querySelector('[data-action="clear"]'),
  generateButton: document.querySelector('[data-action="generate"]'),
  copyButton: document.querySelector('[data-action="copy"]'),
  transcript: document.querySelector('#transcript'),
  transcriptStatus: document.querySelector('#transcript-status'),
  transcriptComparisonStatus: document.querySelector('#transcript-comparison-status'),
  liveTranscript: document.querySelector('#live-transcript'),
  recordedTranscript: document.querySelector('#recorded-transcript'),
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
  recognition: null,
  stream: null,
  audioContext: null,
  audioSource: null,
  audioAnalyser: null,
  audioSamples: null,
  chunks: [],
  transcript: '',
  liveTranscriptRaw: '',
  recordedTranscriptRaw: '',
  recoveredTranscript: '',
  transcriptComparison: null,
  recognitionSegments: [],
  recognitionCommittedTranscript: '',
  liveTranscriptBackup: '',
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
  renderTranscriptComparison();
  setActionControlsDisabled(false);
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
    state.isTranscribing = false;
    state.captureRevision += 1;
    const captureRevision = state.captureRevision;
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.chunks = [];
    state.recorder = new MediaRecorder(state.stream);
    state.recorder.addEventListener('dataavailable', onChunk);
    state.recorder.addEventListener('stop', () => onRecorderStop(captureRevision));
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
    setStatus('녹음을 시작했습니다. 정지하면 녹음 파일을 STT로 다시 읽어서 원문을 만듭니다.');
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
  state.isTranscribing = true;
  renderVariantPlaceholder('녹음 파일을 STT로 다시 읽는 중입니다. 잠시만 기다려 주세요.');
  renderTranscriptComparison();
  setRecording(false);
  setStatus('녹음을 종료했습니다. 녹음 파일을 STT로 다시 읽는 중입니다.');
  state.isStopping = false;
}

function clearAll() {
  stopCapture();
  state.captureRevision += 1;
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
  state.liveTranscriptBackup = '';
  state.variants = [];
  state.confirmedSummary = '';
  state.readyForVariants = false;
  state.selectedVariantId = 'possibility-1';
  state.lastVoiceAt = 0;
  state.pendingLineBreakBeforeNextSpeech = false;
  state.audioVoiceActive = false;
  state.liveTranscriptRaw = '';
  state.recordedTranscriptRaw = '';
  state.recoveredTranscript = '';
  state.transcriptComparison = null;
  renderConfirmedSummary('확정하면 아래에 요약이 표시됩니다.', '');
  renderTranscriptComparison();
}

function onChunk(event) {
  if (event.data && event.data.size > 0) {
    state.chunks.push(event.data);
  }
}

function onRecorderStop(captureRevision) {
  if (captureRevision !== state.captureRevision) {
    state.isTranscribing = false;
    return;
  }

  if (!state.chunks.length) {
    state.isTranscribing = false;
    state.readyForVariants = Boolean(normalizeWhitespace(state.liveTranscriptRaw || state.transcript));
    renderTranscriptComparison();
    return;
  }

  const blob = new Blob(state.chunks, { type: state.recorder?.mimeType || 'audio/webm' });
  setAudioUrl(URL.createObjectURL(blob));

  void (async () => {
    try {
      const recordedTranscript = await transcribeAudioBlob(blob);
      if (captureRevision !== state.captureRevision) {
        return;
      }

      state.recordedTranscriptRaw = recordedTranscript || '';
      refreshTranscriptComparison();

      const finalTranscript = normalizeWhitespace(state.recoveredTranscript || state.liveTranscriptRaw || state.transcript);

      state.readyForVariants = Boolean(finalTranscript);
      renderVariantPlaceholder(finalTranscript ? '실시간 원문과 녹음 파일 STT를 비교했습니다. 변환 버튼을 누르면 3가지 결과를 만듭니다.' : 'STT 원문이 비어 있습니다. 다시 녹음하거나 원문을 직접 붙여넣어 주세요.');
      setStatus(finalTranscript ? '실시간 STT와 녹음 파일 STT를 비교해 복구했습니다. 이제 변환 버튼으로 3가지 제안을 만드세요.' : '녹음 파일 STT에 실패했습니다. 원문을 다시 확인해 주세요.');
    } catch (error) {
      if (captureRevision !== state.captureRevision) {
        return;
      }

      const fallbackTranscript = normalizeWhitespace(state.liveTranscriptRaw || state.transcript);
      if (fallbackTranscript) {
        state.recoveredTranscript = fallbackTranscript;
      }

      state.readyForVariants = Boolean(fallbackTranscript);
      renderTranscriptComparison();
      renderVariantPlaceholder(fallbackTranscript ? '녹음 파일 STT를 못 해서, 실시간 원문을 기준으로 복구했습니다.' : 'STT 원문이 비어 있습니다. 다시 녹음하거나 원문을 직접 붙여넣어 주세요.');
      setStatus(`녹음 파일 STT에 실패했습니다: ${friendlyError(error)}`);
    } finally {
      if (captureRevision === state.captureRevision) {
        state.isTranscribing = false;
        setActionControlsDisabled(false);
      }
    }
  })();
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

function getRewriteSourceText() {
  return normalizeWhitespace(state.recoveredTranscript || els.transcript.value || state.liveTranscriptRaw || state.transcript);
}

function refreshTranscriptComparison() {
  const liveTranscript = normalizeWhitespace(state.liveTranscriptRaw || els.transcript.value || state.transcript);
  const recordedTranscript = normalizeWhitespace(state.recordedTranscriptRaw || '');

  if (!liveTranscript && !recordedTranscript) {
    state.recoveredTranscript = '';
    state.transcriptComparison = null;
    renderTranscriptComparison();
    return;
  }

  const comparison = compareTranscriptSources(liveTranscript, recordedTranscript, state.transcript);
  state.transcriptComparison = comparison;
  state.recoveredTranscript = comparison.recoveredText || liveTranscript || recordedTranscript;
  renderTranscriptComparison();
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
  setActionControlsDisabled(false);
}

function renderTranscriptComparison() {
  const liveText = state.liveTranscriptRaw || els.transcript.value || '';
  const recordedText = state.recordedTranscriptRaw || '';
  const recoveredText = state.recoveredTranscript || '';

  if (els.liveTranscript) {
    els.liveTranscript.textContent = liveText || '실시간 받아쓰기가 여기에 표시됩니다.';
  }

  if (els.recordedTranscript) {
    els.recordedTranscript.textContent = recordedText || '녹음이 끝나면 파일 기반 STT 결과가 여기에 표시됩니다.';
  }

  if (els.recoveredTranscript) {
    els.recoveredTranscript.textContent = recoveredText || '실시간 STT와 녹음 STT를 비교해 복구하면 여기에 표시됩니다.';
  }

  if (els.transcriptComparisonStatus) {
    if (!state.transcriptComparison) {
      els.transcriptComparisonStatus.textContent = '실시간 원문과 녹음 파일 STT를 각각 비교합니다.';
      return;
    }

    const { chosenSource, liveScore, recordedScore, summary } = state.transcriptComparison;
    const pickedLabel = chosenSource === 'recorded' ? '녹음 파일 STT' : '실시간 받아쓰기';
    els.transcriptComparisonStatus.textContent = `${pickedLabel}를 기준으로 복구합니다. ${summary} (실시간 ${liveScore.toFixed(2)} · 녹음 ${recordedScore.toFixed(2)})`;
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
      if (!state.audioVoiceActive && state.lastVoiceAt && Date.now() - state.lastVoiceAt >= 1000 && normalizeWhitespace(els.transcript.value || state.transcript)) {
        state.pendingLineBreakBeforeNextSpeech = true;
      }
      state.audioVoiceActive = true;
      state.lastVoiceAt = Date.now();
      return;
    }

    state.audioVoiceActive = false;

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
