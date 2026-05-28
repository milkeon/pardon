const TRANSCRIBE_MODEL = 'Xenova/whisper-base';
const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';
let transcriberPromise = null;

export async function transcribeAudioBlob(blob) {
  if (!(blob instanceof Blob) || blob.size === 0) return '';

  const audioData = await decodeAudioBlob(blob);
  if (!audioData?.length) return '';

  const transcriber = await getTranscriber();
  const output = await transcriber(audioData, {
    task: 'transcribe',
    chunk_length_s: 30,
    return_timestamps: false
  });

  return normalizeTranscript(output?.text || '');
}

async function getTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = import(TRANSFORMERS_CDN).then(async ({ env, pipeline }) => {
      if (env) {
        env.allowLocalModels = false;
        env.useBrowserCache = true;
      }

      return pipeline('automatic-speech-recognition', TRANSCRIBE_MODEL);
    });
  }

  return transcriberPromise;
}

async function decodeAudioBlob(blob) {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return null;

  const decodeContext = new AudioContextCtor();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const decoded = await decodeContext.decodeAudioData(arrayBuffer.slice(0));
    const monoBuffer = createMonoBuffer(decodeContext, decoded);
    if (!monoBuffer) return null;

    if (monoBuffer.sampleRate === 16000) {
      return monoBuffer.getChannelData(0);
    }

    const offlineContext = new OfflineAudioContext(1, Math.ceil(monoBuffer.duration * 16000), 16000);
    const source = offlineContext.createBufferSource();
    source.buffer = monoBuffer;
    source.connect(offlineContext.destination);
    source.start();

    const resampled = await offlineContext.startRendering();
    return resampled.getChannelData(0);
  } finally {
    try {
      await decodeContext.close();
    } catch {
      // ignore
    }
  }
}

function createMonoBuffer(audioContext, decoded) {
  if (!decoded || !decoded.length) return null;

  if (decoded.numberOfChannels === 1) {
    return decoded;
  }

  const monoBuffer = audioContext.createBuffer(1, decoded.length, decoded.sampleRate);
  const monoData = monoBuffer.getChannelData(0);
  const channelData = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));

  for (let sampleIndex = 0; sampleIndex < decoded.length; sampleIndex += 1) {
    let total = 0;
    for (const data of channelData) {
      total += data[sampleIndex] || 0;
    }
    monoData[sampleIndex] = total / channelData.length;
  }

  return monoBuffer;
}

function normalizeTranscript(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}
