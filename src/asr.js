const TRANSCRIBE_MODEL = 'Xenova/whisper-tiny';
const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';
const DEFAULT_BATCH_SIZE = 15;
const DEFAULT_CHUNK_LENGTH_SECONDS = 15;
let transcriberPromise = null;

export async function transcribeAudioBlob(blob, options = {}) {
  if (!(blob instanceof Blob) || blob.size === 0) return '';

  const chunks = normalizeBlobChunks(options.chunks);
  if (chunks.length > 0) {
    return transcribeChunkBlobs(blob, chunks, options);
  }

  return transcribeBlob(blob, options);
}

async function transcribeChunkBlobs(sourceBlob, chunks, options = {}) {
  const transcriber = options.transcriber || (await getTranscriber());
  const batchSize = normalizePositiveNumber(options.batchSize, DEFAULT_BATCH_SIZE);
  const chunkLengthSeconds = normalizePositiveNumber(options.chunkLengthSeconds, DEFAULT_CHUNK_LENGTH_SECONDS);
  const transcriptParts = [];
  const totalBatches = Math.max(1, Math.ceil(chunks.length / batchSize));

  for (let index = 0; index < chunks.length; index += batchSize) {
    const currentBatch = Math.floor(index / batchSize) + 1;
    if (typeof options.onProgress === 'function') {
      options.onProgress({ currentBatch, totalBatches });
    }

    const batchChunks = chunks.slice(index, index + batchSize);
    const texts = [];
    for (const chunk of batchChunks) {
      const text = await transcribeBlob(chunk, {
        transcriber,
        chunkLengthSeconds,
        returnEmptyOnError: true
      });
      if (text) texts.push(text);
      await yieldToBrowser();
    }

    if (texts.length) {
      transcriptParts.push(texts.join(' '));
    }

    await yieldToBrowser();
  }

  if (typeof options.onProgress === 'function') {
    options.onProgress({ currentBatch: totalBatches, totalBatches });
  }

  const chunkTranscript = normalizeTranscript(transcriptParts.join(' '));
  if (chunkTranscript) {
    return chunkTranscript;
  }

  return transcribeBlob(sourceBlob, {
    transcriber,
    chunkLengthSeconds,
    returnEmptyOnError: options.returnEmptyOnError
  });
}

async function transcribeBlob(blob, options = {}) {
  const transcriber = options.transcriber || (await getTranscriber());
  const objectUrl = URL.createObjectURL(blob);

  try {
    const output = await transcriber(objectUrl, {
      task: 'transcribe',
      chunk_length_s: normalizePositiveNumber(options.chunkLengthSeconds, DEFAULT_CHUNK_LENGTH_SECONDS),
      return_timestamps: false
    });

    return normalizeTranscript(output?.text || '');
  } catch (error) {
    if (options.returnEmptyOnError) {
      return '';
    }

    throw error;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
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

function normalizeBlobChunks(chunks) {
  if (!Array.isArray(chunks)) return [];
  return chunks.filter((chunk) => chunk instanceof Blob && chunk.size > 0);
}

function normalizePositiveNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeTranscript(value) {
  return String(value ?? '').trim();
}

function yieldToBrowser() {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}
