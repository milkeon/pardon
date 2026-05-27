import { buildRewriteVariants, normalizeWhitespace } from './rewrite.js';

const els = {
  startButton: document.querySelector('[data-action="start-recording"]'),
  stopButton: document.querySelector('[data-action="stop-recording"]'),
  clearButton: document.querySelector('[data-action="clear"]'),
  generateButton: document.querySelector('[data-action="generate"]'),
  copyButton: document.querySelector('[data-action="copy"]'),
  transcript: document.querySelector('#transcript'),
  transcriptStatus: document.querySelector('#transcript-status'),
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
  selectedVariantId: 'p1',
  selectedAudioUrl: '',
  variants: [],
  isCapturing: false, // 명시적인 음성 및 STT 캡처 진행 여부 상태 추가
  currentSessionFinal: '' // 현재 음성 인식 세션의 누적 확정 텍스트 버퍼
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
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.chunks = [];
    state.recorder = new MediaRecorder(state.stream);
    state.recorder.addEventListener('dataavailable', onChunk);
    state.recorder.addEventListener('stop', onRecorderStop);
    state.recorder.start();

    // 캡처 상태 및 세션 버퍼 초기화
    state.isCapturing = true;
    state.currentSessionFinal = '';

    const recognition = createSpeechRecognition();
    state.recognition = recognition;
    if (recognition) {
      recognition.onresult = onRecognitionResult;
      recognition.onerror = onRecognitionError;
      recognition.onend = onRecognitionEnd;
      recognition.start();
    }

    setRecording(true);
    setStatus('녹음을 시작했습니다. 자연스럽게 말하면 원문 STT에 표시됩니다.');
  } catch (error) {
    state.isCapturing = false;
    state.currentSessionFinal = '';
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
  state.currentSessionFinal = '';
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
  setAudioUrl(URL.createObjectURL(blob));
}

function onRecognitionResult(event) {
  let sessionFinalText = '';
  let sessionInterimText = '';

  // 변동 인덱스 방식이 아닌, 현재 세션 전체의 results[0]부터 실시간 완전 동기화 진행
  for (let i = 0; i < event.results.length; i += 1) {
    const segment = event.results[i][0].transcript;
    if (event.results[i].isFinal) {
      sessionFinalText += segment;
    } else {
      sessionInterimText += segment;
    }
  }

  // 실시간 보정을 위해 이번 세션의 확정 문장 업데이트
  state.currentSessionFinal = sessionFinalText.trim();
  const cleanedInterim = sessionInterimText.trim();

  // 이전 세션들의 전체 누적 텍스트와 현재 진행 중인 세션 결과를 정갈하게 동기화
  const base = state.transcript.trim();
  
  let displayedText = base;
  if (state.currentSessionFinal) {
    displayedText = base ? `${base}\n${state.currentSessionFinal}` : state.currentSessionFinal;
  }
  
  if (cleanedInterim) {
    displayedText = displayedText ? `${displayedText}\n${cleanedInterim}` : cleanedInterim;
  }

  setTranscript(displayedText);
  
  // 새로운 문맥이 최종 확정될 때마다 우측 카드 리스트 갱신
  if (state.currentSessionFinal) {
    renderVariants();
  }

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
  // 세션이 완전히 마무리되었으므로, 이번 세션의 확정본을 안전하게 state.transcript에 통합
  if (state.currentSessionFinal) {
    const current = state.transcript.trim();
    state.transcript = current ? `${current}\n${state.currentSessionFinal}` : state.currentSessionFinal;
    state.currentSessionFinal = ''; // 리셋
  }

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
  const apiKey = normalizeWhitespace(els.apiKey.value);

  if (!transcript) {
    setStatus('원문을 먼저 추가하거나 녹음한 뒤 재작성해 주세요.');
    renderVariants();
    return;
  }

  if (!apiKey) {
    setStatus('브라우저 API 키가 없어서 로컬 결정적 재작성 엔진을 사용합니다.');
    renderVariants();
    return;
  }

  els.generateButton.disabled = true;
  setStatus('브라우저에 내장된 OpenAI로 재작성 안을 생성하는 중입니다...');

  try {
    const remoteVariants = await generateRemoteVariants({ transcript, apiKey });
    state.variants = remoteVariants;
    renderVariantCards(remoteVariants);
    setStatus('OpenAI로 재작성 안을 생성했습니다.');
  } catch (error) {
    state.variants = buildRewriteVariants(transcript);
    renderVariantCards(state.variants);
    setStatus(`원격 생성에 실패해서 로컬 대체 엔진을 사용했습니다: ${friendlyError(error)}`);
  } finally {
    els.generateButton.disabled = false;
  }
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

async function generateRemoteVariants({ transcript, apiKey }) {
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
          content: '화자는 한국어와 영어를 수시로 혼용하여 사용하는 IT 엔지니어/개발자입니다. 브라우저 머신러닝의 한계로 인해, 영어를 강제로 억지 한글 발음으로 받아썼거나(예: "에이피아이", "커밋해줘", "도커") 발음이 심하게 꼬여 오인식되었을 확률이 매우 높습니다. 해당 발음이 본래 무엇을 의미하려 한 것인지 유유히 유추하여, 영어(API, Git, commit, Docker, DB, PR, server 등)와 한글이 올바르게 혼용된 고도로 자연스러운 실무 개발자 문장 3가지 가능성을 엄격한 JSON 형태로 추정 반환하십시오. 키는 p1, p2, p3만 사용하고, 설명은 절대로 덧붙이지 마세요.'
        },
        {
          role: 'user',
          content: JSON.stringify({ transcript })
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`원격 생성 요청이 실패했습니다 (${response.status})`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  const parsed = parseJsonMaybe(content);
  const localFallback = buildRewriteVariants(transcript);

  return [
    { id: 'p1', label: '가능성 1 (가장 유력)', text: finalizeVariantText(parsed?.p1 || '') || localFallback[0].text },
    { id: 'p2', label: '가능성 2 (유사 발음 교정)', text: finalizeVariantText(parsed?.p2 || '') || localFallback[1].text },
    { id: 'p3', label: '가능성 3 (구어 정돈 보정)', text: finalizeVariantText(parsed?.p3 || '') || localFallback[2].text }
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
