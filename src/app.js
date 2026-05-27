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
  emptyState: document.querySelector('#variants-empty'),
  contextHint: document.querySelector('#context-hint')
};

const state = {
  recorder: null,
  recognition: null,
  stream: null,
  chunks: [],
  transcript: '', // 최종 완성 확정 원문 텍스트 (수동 편집 및 누적 보존용)
  selectedVariantId: 'p1',
  selectedAudioUrl: '',
  variants: [],
  isCapturing: false, // 명시적인 음성 및 STT 캡처 진행 여부 상태
  finalizedSentences: [], // 현재 세션 및 이전 상속 세션에서 완벽히 확정(isFinal=true)된 문장들의 영구 배열
  processedIndices: new Set(), // 현재 음성 인식 세션 내에서 이미 확정 처리 완료한 결과 인덱스 Set (눈사태 중복 도배 방어선!)
  lastInterimText: '' // 현재 발화 중인 실시간 임시 단어의 최장 Watermark 백업 버퍼
};

initialize();

function initialize() {
  updateSupportStatus();
  renderVariants();
  wireEvents();

  // [사용자 규칙] 인풋이 활성화되면 항상 기본으로 커서가 잡히도록 포커싱을 부여합니다!
  if (els.contextHint) {
    els.contextHint.focus();
  }
}

function wireEvents() {
  els.startButton.addEventListener('click', startCapture);
  els.stopButton.addEventListener('click', stopCapture);
  els.clearButton.addEventListener('click', clearAll);
  els.generateButton.addEventListener('click', handleGenerateClicked);
  els.copyButton.addEventListener('click', copySelectedVariant);
  els.transcript.addEventListener('input', onTranscriptEdit);

  // [사용자 규칙] 인풋은 엔터 누르면 확인/저장(다시 분석) 버튼이 항상 연동되도록 이벤트 리스너 바인딩!
  if (els.contextHint) {
    els.contextHint.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleGenerateClicked();
      }
    });
  }
}

async function startCapture() {
  try {
    // 1. 캡처 플래그 활성화
    state.isCapturing = true;

    // [무한 누적 보존] 이전 원문 텍스트를 날려버리지 않고, 영구 락킹 버퍼에 이식하여 무한 상속시킵니다!
    const existingText = (els.transcript.value || state.transcript).trim();
    if (existingText) {
      state.finalizedSentences = existingText.split('\n').map(line => line.trim()).filter(Boolean);
      state.transcript = state.finalizedSentences.join('\n');
    } else {
      state.finalizedSentences = [];
      state.transcript = '';
    }
    state.processedIndices.clear(); // 새 세션이므로 중복 도배 방지 Set 초기화
    state.lastInterimText = ''; // 임시 버퍼 리셋

    // 2. [마이크 장치 선안정화] 먼저 마이크 권한 및 스트림을 완벽히 획득하여 장치를 안정시킵니다.
    // 가동 중이던 STT 엔진이 getUserMedia 시동에 의해 마이크 장치 가로채기(aborted)로 강제 중단되는 버그를 원천 박멸합니다!
    setStatus('마이크 장치를 준비 중입니다...');
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.chunks = [];

    if (!state.isCapturing) {
      // 대기 중 정지 버튼이 눌렸다면 스트림 해제 후 탈출
      if (state.stream) {
        state.stream.getTracks().forEach(track => track.stop());
        state.stream = null;
      }
      return;
    }

    // 3. 마이크 안정화 직후, 음성 인식(STT) 엔진을 즉시 구동시킵니다!
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

    // 4. 미세한 하드웨어 부팅 간섭(120ms)을 우회한 뒤에 녹음 파일용 MediaRecorder를 기동합니다.
    // STT 엔진이 자리를 잡은 상태에서 녹음기가 가동되어 시작 즉시 뱉은 첫 마디부터 무손실로 100% 즉시 인식합니다!
    setTimeout(() => {
      if (!state.isCapturing || !state.stream) return;
      try {
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
    setRecording(false);
    setStatus(`녹음을 시작할 수 없습니다: ${friendlyError(error)}`);
  }
}

function stopCapture() {
  // 캡처 상태 비활성화
  state.isCapturing = false;

  // [비동기 레이스 컨디션 원천 차단] 멈추는 즉시 아직 확정되지 않은 임시 버퍼가 있다면 강제 영구 적재!
  if (state.lastInterimText) {
    state.finalizedSentences.push(state.lastInterimText);
    state.lastInterimText = ''; // 버퍼 클리어
    state.transcript = state.finalizedSentences.join('\n').trim();
    setTranscript(state.transcript);
  }

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
  state.chunks = [];
  state.variants = [];
  state.finalizedSentences = [];
  state.processedIndices.clear();
  state.lastInterimText = '';
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

  // [원문 보존 철칙] 브라우저 실시간 STT로 받아적은 원시 텍스트가 진짜 "원문"이므로, 
  // 원격 Whisper STT 결과를 덮어씌워 원본을 훼손하지 않고 그대로 보존합니다!
  setStatus('녹음 오디오 저장을 완료했습니다. 원문 그대로를 기반으로 3가지 해석 대안을 생성합니다...');
  
  const finalTranscript = state.transcript.trim();
  if (!finalTranscript) {
    setStatus('원문이 비어 있어 분석 카드를 생성할 수 없습니다.');
    renderVariants();
    return;
  }

  generateServerVariants(finalTranscript)
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

async function transcribeAudioWithServer(audioBlob) {
  const response = await fetch('/api/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'audio/webm' },
    body: audioBlob
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(err || '서버 STT 분석 실패');
  }

  const data = await response.json();
  return data.text || '';
}

function onRecognitionResult(event) {
  let interimText = '';
  let hasNewFinal = false; // 이번 이벤트에서 새로운 확정 문장이 추가되었는지 감지하는 플래그

  // event.results의 처음(0)부터 루프를 돌며, 새롭게 도출된 확정 및 임시 문자열 추출
  for (let i = 0; i < event.results.length; i += 1) {
    const segment = event.results[i][0].transcript.trim();
    if (!segment) continue;

    if (event.results[i].isFinal) {
      // [눈사태 도배 방어선] 이미 확정 리스트에 영구 잠금 처리한 인덱스가 아니라면 신규 적재 진행
      if (!state.processedIndices.has(i)) {
        state.finalizedSentences.push(segment);
        state.processedIndices.add(i);
        hasNewFinal = true;
      }
    } else {
      // 임시로 흘러가는 실시간 말소리 수집
      interimText += (interimText ? ' ' : '') + segment;
    }
  }

  // 새로운 최종 확정 문장이 고정 버퍼에 영구 안착했다면,
  // 중복 기입을 차단하기 위해 임시 백업 버퍼를 스마트하게 리셋합니다.
  if (hasNewFinal) {
    state.lastInterimText = '';
  }

  const baseText = state.finalizedSentences.join('\n').trim();
  const cleanedInterim = interimText.trim();
  
  // [지워짐 방지 워터마크 밸브]
  // 브라우저가 음성을 다듬거나 버그로 인해 이전 이벤트보다 짧거나 텅 빈 임시 문자열을 보낼 경우
  // 이전에 캡처에 성공했던 최장 길이 임시 텍스트(lastInterimText)를 악착같이 지켜내고 덮어쓰지 않습니다!
  if (cleanedInterim.length >= state.lastInterimText.length) {
    state.lastInterimText = cleanedInterim;
  }
  
  // 화면 및 원문에 노출할 때는 항상 보증된 최장 임시 텍스트를 결합하여 단어 춤춤/휘발 현상을 원천 방지합니다.
  const displayedText = baseText + (state.lastInterimText ? (baseText ? `\n${state.lastInterimText}` : state.lastInterimText) : '');

  // textarea 화면 원문 업데이트
  setTranscript(displayedText);
  
  // [실시간 풀-동기화] 현재 노출된 안전 최장 텍스트 전체를 항상 원문에 즉시 박제해둡니다!
  state.transcript = displayedText;

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
  // 1. [임시 데이터 Rescue] 만약 세션이 닫힐 때 미처 finalizedSentences에 들어가지 못한 임시 텍스트가 있다면 영구 복구 적재!
  if (state.lastInterimText) {
    state.finalizedSentences.push(state.lastInterimText);
    state.lastInterimText = ''; // 소모 완료 리셋
    
    // 강제 구제된 텍스트를 원문 텍스트 공간에 안전하게 렌더링 동기화
    state.transcript = state.finalizedSentences.join('\n').trim();
    setTranscript(state.transcript);
  }

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
  } else {
    // 녹음기(MediaRecorder)가 미가동 상태인 경우, 여기서 직접 실시간 원문 기반 원격 분석 카드를 갱신합니다!
    const finalTranscript = state.transcript.trim();
    if (finalTranscript) {
      setStatus('전체 원문 맥락을 기반으로 3가지 가능성을 분석하는 중입니다...');
      generateServerVariants(finalTranscript)
        .then((remoteVariants) => {
          state.variants = remoteVariants;
          renderVariantCards(remoteVariants);
          setStatus('머신러닝이 전체 맥락을 유기적으로 분석해 3가지 가능성을 복원했습니다!');
        })
        .catch((err) => {
          console.error('서버 머신러닝 분석 실패:', err);
          setStatus(`원격 머신러닝 분석에 실패하여 로컬 대체 엔진을 사용합니다: ${friendlyError(err)}`);
          renderVariants();
        });
    } else {
      renderVariants();
    }
  }

  setRecording(false);
}

function onTranscriptEdit() {
  state.transcript = els.transcript.value;
  // 사용자가 수동 수정한 텍스트도 영구 락킹 버퍼에 즉각 동기화하여 날아감 방지!
  const trimmed = state.transcript.trim();
  if (trimmed) {
    state.finalizedSentences = trimmed.split('\n').map(line => line.trim()).filter(Boolean);
  } else {
    state.finalizedSentences = [];
  }
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
  const hint = els.contextHint ? els.contextHint.value.trim() : '';
  const response = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript, hint })
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
