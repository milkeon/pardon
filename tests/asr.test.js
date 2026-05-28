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
      return callCount <= 2 ? { text: '' } : { text: '전체 blob 전사' };
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
    assert.equal(callCount, 3);
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    globalThis.window = originalWindow;
  }
});
