const TRANSCRIBE_MODEL = 'Xenova/whisper-base';
const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';
const DEFAULT_BATCH_SIZE = 15;
const DEFAULT_CHUNK_LENGTH_SECONDS = 15;
let transcriberPromise = null;

export async function transcribeAudioBlob(blob, options = {}) {
  if (!(blob instanceof Blob) || blob.size === 0) return '';

  const chunks = normalizeBlobChunks(options.chunks);
  if (chunks.length > 0) {
    return transcribeChunkBlobs(chunks, options);
  }

  const audioData = await decodeAudioBlob(blob);
  if (!audioData?.length) return '';

  const transcriber = await getTranscriber();
  const output = await transcriber(audioData, {
    task: 'transcribe',
    chunk_length_s: normalizePositiveNumber(options.chunkLengthSeconds, DEFAULT_CHUNK_LENGTH_SECONDS),
    return_timestamps: false
  });

  return normalizeTranscript(output?.text || '');
}

async function transcribeChunkBlobs(chunks, options = {}) {
  const transcriber = await getTranscriber();
  const batchSize = normalizePositiveNumber(options.batchSize, DEFAULT_BATCH_SIZE);
  const chunkLengthSeconds = normalizePositiveNumber(options.chunkLengthSeconds, DEFAULT_CHUNK_LENGTH_SECONDS);
  const transcriptParts = [];
  const totalBatches = Math.max(1, Math.ceil(chunks.length / batchSize));

  for (let index = 0; index < chunks.length; index += batchSize) {
    const currentBatch = Math.floor(index / batchSize) + 1;
    if (typeof options.onProgress === 'function') {
      options.onProgress({ currentBatch, totalBatches });
    }

    const batchAudio = await decodeAudioChunkBatch(chunks.slice(index, index + batchSize));
    if (batchAudio?.length) {
      const output = await transcriber(batchAudio, {
        task: 'transcribe',
        chunk_length_s: chunkLengthSeconds,
        return_timestamps: false
      });
      const text = normalizeTranscript(output?.text || '');
      if (text) transcriptParts.push(text);
    }

    await yieldToBrowser();
  }

  if (typeof options.onProgress === 'function') {
    options.onProgress({ currentBatch: totalBatches, totalBatches });
  }

  return normalizeTranscript(transcriptParts.join(' '));
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

async function decodeAudioChunkBatch(chunks) {
  const decodedChunks = [];
  let totalLength = 0;

  for (const chunk of chunks) {
    const audioData = await decodeAudioBlob(chunk);
    if (!audioData?.length) continue;
    decodedChunks.push(audioData);
    totalLength += audioData.length;
  }

  if (!totalLength) return null;

  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const audioData of decodedChunks) {
    merged.set(audioData, offset);
    offset += audioData.length;
  }

  return merged;
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

function normalizeBlobChunks(chunks) {
  if (!Array.isArray(chunks)) return [];
  return chunks.filter((chunk) => chunk instanceof Blob && chunk.size > 0);
}

function normalizePositiveNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
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
  return String(value ?? '').trim();
}

function yieldToBrowser() {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}
