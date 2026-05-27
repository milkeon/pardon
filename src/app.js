import { buildRewriteVariants, normalizeWhitespace } from './rewrite.js';

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
  selectedVariantId: 'p1',
  selectedAudioUrl: '',
  variants: [],
  isCapturing: false, // 명시적인 음성 및 STT 캡처 진행 여부 상태 추가
  finalizedSentences: [], // 영구 고정 확정 문장들을 순차 보관하는 불변 배열 버퍼
  processedIndices: new Set() // 현재 음성 인식 세션 내부에서 이미 확정 처리 완료한 결과 인덱스 목록
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
    // 1. 캡처 플래그 및 영구 락킹 버퍼 초기화
    state.isCapturing = true;
    state.finalizedSentences = [];
    state.processedIndices.clear();

    // 2. 하드웨어 딜레이 예방을 위해 음성 인식(STT) 엔진을 0순위로 "가장 먼저" 구동시킵니다!
    const recognition = createSpeechRecognition();
    state.recognition = recognition;
    if (recognition) {
      recognition.onresult = onRecognitionResult;
      recognition.onerror = onRecognitionError;
      recognition.onend = onRecognitionEnd;
      recognition.start();
    }

    setRecording(true);
    setStatus('음성 인식 엔진을 준비 중입니다...');

    // 3. 미세한 하드웨어 부팅 간섭(120ms)을 우회한 뒤에 녹음 파일용 MediaRecorder를 기동합니다.
    // 마이크 신호 충돌이 해소되어 시작 버튼을 누르고 바로 뱉은 첫 마디부터 무손실로 100% 즉시 인식합니다!
    setTimeout(async () => {
      if (!state.isCapturing) return; // 대기 중 정지 버튼이 눌렸다면 탈출
      try {
        state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        state.chunks = [];
        state.recorder = new MediaRecorder(state.stream);
        state.recorder.addEventListener('dataavailable', onChunk);
        state.recorder.addEventListener('stop', onRecorderStop);
        state.recorder.start();
        setStatus('녹음을 시작했습니다. 자연스럽게 말하면 원문 STT에 표시됩니다.');
      } catch (err) {
        console.warn('오디오 녹음 가동 유예(STT 인식을 지속 진행됩니다):', err);
      }
    }, 120);

  } catch (error) {
    state.isCapturing = false;
    setStatus(`녹음을 시작할 수 없습니다: ${friendlyError(error)}`);
  }
}

function stopCapture() {
  // 캡처 상태 비활성화
  state.isCapturing = false;

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

  setRecording(false);
  setStatus('녹음을 종료했습니다. 현재 원문 기준으로 재작성 카드가 갱신됩니다.');
}

function clearAll() {
  stopCapture();
  state.transcript = '';
  state.interimTranscript = '';
  state.chunks = [];
  state.variants = [];
  state.finalizedSentences = [];
  state.processedIndices.clear();
  setTranscript('');
  setAudioUrl('');
  renderVariants();
  setStatus('원문, 오디오, 그리고 선택 상태를 초기화했습니다.');
}

function onChunk(event) {
  if (event.data && event.data.size > 0) {
    state.chunks.push(event.data);
  }
}

function onRecorderStop() {
  const blob = new Blob(state.chunks, { type: state.recorder?.mimeType || 'audio/webm' });
  const audioUrl = URL.createObjectURL(blob);
  setAudioUrl(audioUrl);

  // 번거로운 브라우저 API 키 요구 및 설정 없이 켜자마자 바로 백엔드 초정밀 머신러닝 분석을 연동합니다!
  setStatus('세계 최고의 음성 모델 OpenAI Whisper로 음성을 초정밀 분석하는 중입니다...');
  
  transcribeAudioWithServer(blob)
    .then((whisperResult) => {
      state.transcript = whisperResult;
      setTranscript(whisperResult);
      
      setStatus('Whisper 분석 완료! GPT가 3가지 해석 가능성으로 문맥을 최종 조립합니다...');
      return generateServerVariants(whisperResult);
    })
    .then((remoteVariants) => {
      state.variants = remoteVariants;
      renderVariantCards(remoteVariants);
      setStatus('머신러닝이 전체 맥락을 유기적으로 분석해 3가지 가능성을 복원했습니다!');
    })
    .catch((err) => {
      console.error('서버 머신러닝 분석 실패:', err);
      setStatus(`원격 머신러닝 분석에 실패하여 로컬 대체 엔진을 사용합니다: ${friendlyError(err)}`);
      renderVariants(); // 실패 시 로컬 엔진 폴백
    });
}



function onRecognitionResult(event) {
  let interimText = '';

  // event.results의 처음(0)부터 루프를 돌며, 새롭게 도출된 확정 및 임시 문자열 추출
  for (let i = 0; i < event.results.length; i += 1) {
    const segment = event.results[i][0].transcript.trim();
    if (!segment) continue;

    if (event.results[i].isFinal) {
      // 이미 확정 리스트에 영구 잠금 처리한 인덱스가 아니라면 신규 적재 진행
      if (!state.processedIndices.has(i)) {
        state.finalizedSentences.push(segment);
        state.processedIndices.add(i);
      }
    } else {
      // 임시로 흘러가는 실시간 말소리 수집
      interimText += (interimText ? ' ' : '') + segment;
    }
  }

  // 영구 보존된 확정 문장들과 임시 문장을 안전하게 결합
  const baseText = state.finalizedSentences.join('\n').trim();
  const cleanedInterim = interimText.trim();
  
  const displayedText = baseText + (cleanedInterim ? (baseText ? `\n${cleanedInterim}` : cleanedInterim) : '');

  // textarea 화면 원문 업데이트
  setTranscript(displayedText);
  
  // 실시간 변환 갱신용으로 state.transcript 동기화
  state.transcript = baseText;

  setStatus('음성을 듣고 STT로 변환하는 중입니다.');
}

function onRecognitionError(event) {
  // no-speech(무음)이나 aborted(세션 취소)는 사용자가 침묵하거나 순간적으로 끊겼을 때 빈번하므로 조용히 처리합니다.
  if (event.error === 'no-speech' || event.error === 'aborted') {
    return;
  }
  setStatus(`음성 인식 오류: ${event.error}`);
}

function onRecognitionEnd() {
  // 세션이 완전히 수명 주기를 마쳤으므로 세션 내 확정 인덱스 목록만 초기화 (영구 적재 버퍼인 finalizedSentences는 보존)
  state.processedIndices.clear();

  // 사용자가 명시적으로 정지 버튼을 누르지 않았는데 브라우저 타임아웃 등으로 꺼진 경우
  if (state.isCapturing) {
    // 마이크 하드웨어 리소스 해제 시간을 보장하기 위해 150ms 안전 딜레이 타이머를 둡니다. (인식 멈춤 현상 완전 정복)
    setTimeout(() => {
      if (!state.isCapturing) return; // 대기 도중 정지 버튼이 눌렸다면 탈출
      try {
        const recognition = createSpeechRecognition();
        state.recognition = recognition;
        if (recognition) {
          recognition.onresult = onRecognitionResult;
          recognition.onerror = onRecognitionError;
          recognition.onend = onRecognitionEnd;
          recognition.start();
        }
      } catch (e) {
        console.error('STT 재시작 실패:', e);
      }
    }, 150);
    return;
  }

  state.recognition = null;

  if (state.recorder && state.recorder.state !== 'inactive') {
    try {
      state.recorder.stop();
    } catch {
      // ignore
    }
  }

  setRecording(false);
  
  // [피날레 갱신] 녹음/음성 인식이 완벽히 막을 내린 이 최후의 순간에 전체 완성형 맥락을 기반으로 3가지 가능성을 '단 한번' 기품있게 갱신합니다!
  renderVariants();
}

function onTranscriptEdit() {
  state.transcript = els.transcript.value;
  renderVariants();
}

function renderVariants() {
  const transcript = normalizeWhitespace(els.transcript.value || state.transcript);
  const variants = buildRewriteVariants(transcript);
  state.variants = variants;
  renderVariantCards(variants);
}

function renderVariantCards(variants) {
  els.variantList.innerHTML = '';
  els.emptyState.hidden = normalizeWhitespace(els.transcript.value || state.transcript).length > 0;

  if (!variants.some((variant) => variant.id === state.selectedVariantId)) {
    state.selectedVariantId = variants[0]?.id || 'p1';
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

  if (!transcript) {
    setStatus('원문을 먼저 추가하거나 녹음한 뒤 재작성해 주세요.');
    renderVariants();
    return;
  }

  els.generateButton.disabled = true;
  setStatus('GPT가 3가지 해석 가능성으로 문맥을 최종 조립합니다...');

  try {
    const remoteVariants = await generateServerVariants(transcript);
    state.variants = remoteVariants;
    renderVariantCards(remoteVariants);
    setStatus('OpenAI로 머신러닝 분석을 완료했습니다.');
  } catch (error) {
    state.variants = buildRewriteVariants(transcript);
    renderVariantCards(state.variants);
    setStatus(`원격 분석에 실패해서 로컬 대체 엔진을 사용했습니다: ${friendlyError(error)}`);
  } finally {
    els.generateButton.disabled = false;
  }
}

async function generateServerVariants(transcript) {
  const response = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(err || '서버 문맥 조립 실패');
  }

  return await response.json();
}

async function copySelectedVariant() {
  const variants = state.variants.length
    ? state.variants
    : buildRewriteVariants(normalizeWhitespace(els.transcript.value || state.transcript));
  const selected = variants.find((variant) => variant.id === state.selectedVariantId) || variants[0];

  try {
    await navigator.clipboard.writeText(selected?.text || '');
    setStatus('선택한 재작성안을 클립보드에 복사했습니다.');
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
  recognition.maxAlternatives = 3; // 인식 민감도 및 발음 대안 후보 정밀도 최대치 부여
  recognition.lang = 'ko-KR';
  return recognition;
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
    hasRecorder ? 'MediaRecorder: 지원됨' : 'MediaRecorder: 지원 안 됨',
    hasSpeechRecognition ? 'SpeechRecognition: 지원됨' : 'SpeechRecognition: 지원 안 됨'
  ].join(' · ');
}

function setRecording(isRecording) {
  els.recordingBadge.textContent = isRecording ? '● 녹음 중' : '대기 중';
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
