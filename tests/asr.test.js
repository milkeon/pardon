import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribeAudioBlob } from '../src/asr.js';

test('transcribeAudioBlob는 청크 전사가 비면 전체 blob 전사로 되돌아간다', async () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalWindow = globalThis.window;
  const calls = [];

  globalThis.window = globalThis.window || globalThis;
  globalThis.window.setTimeout = setTimeout;
  globalThis.window.clearTimeout = clearTimeout;
  URL.createObjectURL = () => `blob:${calls.length + 1}`;
  URL.revokeObjectURL = () => {};

  try {
    let callCount = 0;
    const transcriber = async () => {
      callCount += 1;
      return callCount === 1 ? { text: '' } : { text: '전체 blob 전사' };
    };

    const blob = new Blob(['fake-audio'], { type: 'audio/webm' });
    const chunks = [
      new Blob(['chunk-1'], { type: 'audio/webm' }),
      new Blob(['chunk-2'], { type: 'audio/webm' })
    ];

    const text = await transcribeAudioBlob(blob, {
      chunks,
      transcriber,
      chunkLengthSeconds: 15
    });

    assert.equal(text, '전체 blob 전사');
    assert.equal(callCount, 2);
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    globalThis.window = originalWindow;
  }
});

test('transcribeAudioBlob는 청크가 있어도 먼저 전체 녹음을 전사해 후반 문장을 보존한다', async () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalWindow = globalThis.window;
  const urls = [];

  globalThis.window = globalThis.window || globalThis;
  globalThis.window.setTimeout = setTimeout;
  globalThis.window.clearTimeout = clearTimeout;
  URL.createObjectURL = (blob) => {
    urls.push(blob.size);
    return `blob:${urls.length}`;
  };
  URL.revokeObjectURL = () => {};

  try {
    let callCount = 0;
    const transcriber = async () => {
      callCount += 1;
      return callCount === 1
        ? { text: '앞부분도 있고 뒷부분도 살아 있는 전체 전사' }
        : { text: '앞부분도 있고 뒷부분도 살아 있는 전체 전사 마지막 문장까지 보강됨' };
    };

    const blob = new Blob(['full-audio'], { type: 'audio/webm' });
    const chunks = Array.from({ length: 16 }, (_, index) => new Blob([`chunk-${index + 1}`], { type: 'audio/webm' }));

    const text = await transcribeAudioBlob(blob, {
      chunks,
      transcriber,
      batchSize: 15,
      chunkLengthSeconds: 15
    });

    assert.equal(text, '앞부분도 있고 뒷부분도 살아 있는 전체 전사 마지막 문장까지 보강됨');
    assert.equal(callCount, 3);
    assert.equal(urls.length, 3);
    assert.equal(urls[0], 10);
    assert.ok(urls[1] > urls[0]);
    assert.ok(urls[2] > 0);
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    globalThis.window = originalWindow;
  }
});

test('transcribeAudioBlob는 청크 전사가 엉뚱하면 전체 blob 전사를 유지한다', async () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalWindow = globalThis.window;

  globalThis.window = globalThis.window || globalThis;
  globalThis.window.setTimeout = setTimeout;
  globalThis.window.clearTimeout = clearTimeout;
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = () => {};

  try {
    let callCount = 0;
    const transcriber = async () => {
      callCount += 1;
      return callCount === 1
        ? { text: '브라우저 세션을 유지하고 마지막 안내 문장까지 남깁니다' }
        : { text: '완전히 다른 잡음 텍스트 입니다' };
    };

    const blob = new Blob(['full-audio'], { type: 'audio/webm' });
    const chunks = Array.from({ length: 16 }, (_, index) => new Blob([`chunk-${index + 1}`], { type: 'audio/webm' }));

    const text = await transcribeAudioBlob(blob, {
      chunks,
      transcriber,
      batchSize: 15,
      chunkLengthSeconds: 15
    });

    assert.equal(text, '브라우저 세션을 유지하고 마지막 안내 문장까지 남깁니다');
    assert.equal(callCount, 3);
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    globalThis.window = originalWindow;
  }
});
