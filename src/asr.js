const TRANSCRIBE_MODEL = 'Xenova/whisper-tiny';
const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';
const DEFAULT_BATCH_SIZE = 15;
const DEFAULT_CHUNK_LENGTH_SECONDS = 15;
let transcriberPromise = null;

export async function transcribeAudioBlob(blob, options = {}) {
  if (!(blob instanceof Blob) || blob.size === 0) return '';

  const chunks = normalizeBlobChunks(options.chunks);
  if (chunks.length > 0) {
    return transcribeBlobWithChunkFallback(blob, chunks, options);
  }

  return transcribeBlob(blob, options);
}

async function transcribeBlobWithChunkFallback(blob, chunks, options = {}) {
  const transcriber = options.transcriber || (await getTranscriber());
  const batchSize = normalizePositiveNumber(options.batchSize, DEFAULT_BATCH_SIZE);
  const chunkLengthSeconds = normalizePositiveNumber(options.chunkLengthSeconds, DEFAULT_CHUNK_LENGTH_SECONDS);

  try {
    const fullTranscript = await transcribeBlob(blob, {
      transcriber,
      chunkLengthSeconds,
      returnEmptyOnError: true
    });

    if (fullTranscript) {
      if (chunks.length <= batchSize) {
        return fullTranscript;
      }

      const chunkTranscript = await transcribeChunkBlobs(blob, chunks, {
        ...options,
        transcriber,
        batchSize,
        chunkLengthSeconds,
        skipFinalFullFallback: true
      });

      return selectPreferredTranscript(fullTranscript, chunkTranscript);
    }

    const chunkTranscript = await transcribeChunkBlobs(blob, chunks, {
      ...options,
      transcriber,
      batchSize,
      chunkLengthSeconds,
      skipFinalFullFallback: true
    });

    if (chunkTranscript) {
      return chunkTranscript;
    }
  } catch {
    // 전체 blob 전사가 실패하면 청크 전사로 폴백한다.
  }

  return transcribeChunkBlobs(blob, chunks, {
    ...options,
    transcriber,
    batchSize,
    chunkLengthSeconds
  });
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
    const batchBlob = new Blob(batchChunks, { type: batchChunks[0]?.type || sourceBlob?.type || 'audio/webm' });
    const text = await transcribeBlob(batchBlob, {
      transcriber,
      chunkLengthSeconds,
      returnEmptyOnError: true
    });

    if (text) {
      pushTranscriptPart(transcriptParts, text);
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

  if (options.skipFinalFullFallback) {
    return '';
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

function pushTranscriptPart(parts, text) {
  const normalizedText = normalizeTranscript(text);
  if (!normalizedText) {
    return;
  }

  const lastPart = parts.at(-1);
  if (!lastPart) {
    parts.push(normalizedText);
    return;
  }

  if (lastPart === normalizedText || lastPart.startsWith(normalizedText)) {
    return;
  }

  if (normalizedText.startsWith(lastPart)) {
    parts[parts.length - 1] = normalizedText;
    return;
  }

  const overlap = findTokenOverlap(lastPart, normalizedText);
  if (overlap) {
    const nextTokens = normalizedText.split(/\s+/).filter(Boolean);
    parts[parts.length - 1] = `${lastPart} ${nextTokens.slice(overlap).join(' ')}`.trim();
    return;
  }

  parts.push(normalizedText);
}

function selectPreferredTranscript(fullTranscript, chunkTranscript) {
  const full = normalizeTranscript(fullTranscript);
  const chunk = normalizeTranscript(chunkTranscript);

  if (!full) return chunk;
  if (!chunk) return full;
  if (full === chunk) return full;

  const fullTokens = full.split(/\s+/).filter(Boolean);
  const chunkTokens = chunk.split(/\s+/).filter(Boolean);
  const prefixLength = countMatchingPrefixTokens(fullTokens, chunkTokens);
  const minTokenLength = Math.min(fullTokens.length, chunkTokens.length);
  const tailCompatible = prefixLength >= Math.max(3, Math.floor(minTokenLength * 0.6));

  if (tailCompatible) {
    return chunkTokens.length > fullTokens.length ? chunk : full;
  }

  return full;
}

function countMatchingPrefixTokens(leftTokens, rightTokens) {
  const limit = Math.min(leftTokens.length, rightTokens.length);
  let index = 0;

  while (index < limit && leftTokens[index] === rightTokens[index]) {
    index += 1;
  }

  return index;
}

function findTokenOverlap(leftText, rightText) {
  const leftTokens = normalizeTranscript(leftText).split(/\s+/).filter(Boolean);
  const rightTokens = normalizeTranscript(rightText).split(/\s+/).filter(Boolean);
  const maxOverlap = Math.min(leftTokens.length, rightTokens.length);

  for (let size = maxOverlap; size >= 3; size -= 1) {
    const leftSuffix = leftTokens.slice(-size).join(' ');
    const rightPrefix = rightTokens.slice(0, size).join(' ');
    if (leftSuffix === rightPrefix) {
      return size;
    }
  }

  return 0;
}

function yieldToBrowser() {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}
