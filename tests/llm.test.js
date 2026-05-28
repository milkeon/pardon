import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfirmationSummary, buildRewriteVariants } from '../src/rewrite.js';
import { fetchConfirmationSummary, fetchRewriteVariants } from '../src/llm.js';

function withMockedLocation(locationValue, fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    value: locationValue,
    configurable: true,
    writable: true
  });

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (original) {
        Object.defineProperty(globalThis, 'location', original);
      } else {
        delete globalThis.location;
      }
    });
}

test('fetchRewriteVariants는 GitHub Pages에서 /api/analyze를 호출하지 않고 정적 변환을 즉시 반환한다', async () => {
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    fetchCalled = true;
    throw new Error('fetch should not be called in static fallback mode');
  };

  try {
    await withMockedLocation({ hostname: 'milkeon.github.io', protocol: 'https:' }, async () => {
      const transcript = 'Please fix the redirect issue and send the update to the team.';
      const variants = await fetchRewriteVariants(transcript);
      const expected = buildRewriteVariants(transcript);

      assert.deepEqual(variants, expected);
      assert.equal(fetchCalled, false);
      assert.equal(variants.length, 3);
      assert.ok(variants[0].text.includes('리다이렉트'));
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchConfirmationSummary는 file: 환경에서 /api/summary 대신 로컬 요약을 반환한다', async () => {
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    fetchCalled = true;
    throw new Error('fetch should not be called in static fallback mode');
  };

  try {
    await withMockedLocation({ hostname: '', protocol: 'file:' }, async () => {
      const selectedText = '브라우저는 세션을 사용하는 상태를 관리하는 방식입니다.';
      const transcript = '이름의 섹션에 우리가요 리퀘스트 좀 바디를 이렇게 추가하도록 하겠습니다.';
      const result = await fetchConfirmationSummary(selectedText, transcript);
      const expected = buildConfirmationSummary(selectedText, transcript);

      assert.deepEqual(result, {
        title: '확정 요약',
        summary: expected
      });
      assert.equal(fetchCalled, false);
      assert.ok(result.summary.includes('세션') || result.summary.includes('브라우저'));
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
