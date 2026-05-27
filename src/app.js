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
  selectedVariantId: 'p1',
  selectedAudioUrl: '',
  variants: [],
  isCapturing: false // 명시적인 음성 및 STT 캡처 진행 여부 상태 추가
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

    // 캡처 상태 활성화
    state.isCapturing = true;

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

  // 양 끝 공백을 정돈한 클린 텍스트 획득
  const cleanedFinal = finalText.trim();
  const cleanedInterim = interimText.trim();

  if (cleanedFinal) {
    const current = state.transcript.trim();
    if (current) {
      // 기존 원문이 존재하면 줄바꿈(\n)으로 구분하여 신규 인식 문장을 안전하게 덧붙임
      state.transcript = `${current}\n${cleanedFinal}`;
    } else {
      state.transcript = cleanedFinal;
    }
    
    // 임시 텍스트(실시간 입력 중인 문장)가 남아 있으면 다음 줄에 임시 덧붙여 보여줌
    const displayedText = state.transcript + (cleanedInterim ? `\n${cleanedInterim}` : '');
    setTranscript(displayedText);
    renderVariants();
  } else if (cleanedInterim) {
    const current = state.transcript.trim();
    // 현재 실시간 타이핑 중인 문장을 기존 텍스트 밑에 새로운 줄로 연결하여 표시
    const displayedText = current ? `${current}\n${cleanedInterim}` : cleanedInterim;
    setTranscript(displayedText);
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
  // 사용자가 명시적으로 정지 버튼을 누르지 않았는데 브라우저 타임아웃 등으로 꺼진 경우 새 인스턴스로 자동 재시작
  if (state.isCapturing) {
    try {
      const recognition = createSpeechRecognition();
      state.recognition = recognition;
      if (recognition) {
        recognition.onresult = onRecognitionResult;
        recognition.onerror = onRecognitionError;
        recognition.onend = onRecognitionEnd;
        recognition.start();
      }
      return;
    } catch (e) {
      console.error('STT 재시작 실패:', e);
    }
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
  const context = els.context.value;
  const variants = buildRewriteVariants(transcript, context);
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
  const context = els.context.value;
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
    const remoteVariants = await generateRemoteVariants({ transcript, context, apiKey });
    state.variants = remoteVariants;
    renderVariantCards(remoteVariants);
    setStatus('OpenAI로 재작성 안을 생성했습니다.');
  } catch (error) {
    state.variants = buildRewriteVariants(transcript, context);
    renderVariantCards(state.variants);
    setStatus(`원격 생성에 실패해서 로컬 대체 엔진을 사용했습니다: ${friendlyError(error)}`);
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
          content: '입력된 원문 STT는 브라우저 머신러닝의 한계로 인해 오인식이나 맞춤법 오타가 있을 가능성이 높습니다. 사용자가 제공한 문맥 힌트를 기반으로, 화자가 원래 말하려고 했던 가장 유력한 3가지 문장 가능성(해석 대안)을 추정해 주세요. 키는 p1, p2, p3만 사용하며, 엄격한 JSON 형태로 반환해 주세요. 추가 설명은 넣지 마세요.'
        },
        {
          role: 'user',
          content: JSON.stringify({ transcript, context })
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
  const localFallback = buildRewriteVariants(transcript, context);

  return [
    { id: 'p1', label: '가능성 1 (가장 유력)', text: finalizeVariantText(parsed?.p1 || '') || localFallback[0].text },
    { id: 'p2', label: '가능성 2 (유사 발음 교정)', text: finalizeVariantText(parsed?.p2 || '') || localFallback[1].text },
    { id: 'p3', label: '가능성 3 (문맥 의도 보정)', text: finalizeVariantText(parsed?.p3 || '') || localFallback[2].text }
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
