import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfirmationSummary, buildRewriteVariants, buildRewriteVariantsFromTranscripts, buildTranscriptRecovery } from '../src/rewrite.js';
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
      const expected = buildRewriteVariantsFromTranscripts(transcript, '');

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


test('fetchRewriteVariants는 원문(base)과 녹음(evidence)을 함께 /api/analyze로 전송한다', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = null;
  globalThis.fetch = async (_url, options = {}) => {
    requestBody = JSON.parse(String(options.body || '{}'));
    return {
      ok: true,
      async json() {
        return {
          p1: { label: '제안 1 · 문맥 교정(보수적)', text: '원문 보정 결과' },
          p2: { label: '제안 2 · 문맥 교정(균형형)', text: '균형형 결과' },
          p3: { label: '제안 3 · 문맥 교정(과감형)', text: '과감형 결과' }
        };
      }
    };
  };

  try {
    await withMockedLocation({ hostname: 'localhost', protocol: 'http:' }, async () => {
      const variants = await fetchRewriteVariants({
        baseTranscript: '원문 STT입니다',
        evidenceTranscript: '녹음 STT 입니다',
        hint: '명확함, 자연스러움'
      });

      assert.deepEqual(requestBody, {
        baseTranscript: '원문 STT입니다',
        evidenceTranscript: '녹음 STT 입니다',
        hint: '명확함, 자연스러움'
      });
      assert.equal(variants.length, 3);
      assert.equal(variants[0].text, '원문 보정 결과');
      assert.equal(variants[1].text, '균형형 결과');
      assert.equal(variants[2].text, '과감형 결과');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('buildTranscriptRecovery는 녹음 STT가 더 길어도 원문을 기준으로 두고 필요한 뒷부분만 보조 증거로 붙인다', () => {
  const live = '원문 stt는 여기까지 맞게 나왔습니다';
  const recorded = '원문 stt는 여기까지 맞게 나왔습니다 그리고 뒷부분도 이어서 남아 있습니다';
  const recovery = buildTranscriptRecovery(live, recorded, `${live} ${recorded}`);

  assert.equal(recovery.chosenSource, 'live');
  assert.match(recovery.summary, /뒷부분만 보조 증거/);
  assert.ok(recovery.recoveredText.includes('그리고 뒷부분도 이어서 남아 있습니다'));
});

test('buildTranscriptRecovery는 녹음 STT가 엉뚱하게 달라도 원문을 기준으로 유지한다', () => {
  const live = '원문 stt와 녹음 stt를 같이 비교해 보겠습니다';
  const recorded = '갑자기 전혀 다른 문장으로 혼자 진행해 버립니다';
  const recovery = buildTranscriptRecovery(live, recorded, `${live} ${recorded}`);

  assert.equal(recovery.chosenSource, 'live');
  assert.match(recovery.summary, /보조 증거로만/);
  assert.ok(recovery.recoveredText.startsWith('원문 stt와 녹음 stt를 같이 비교해 보겠습니다'));
  assert.ok(!recovery.recoveredText.includes('갑자기 전혀 다른 문장'));
});

test('buildTranscriptRecovery는 동일하게 깨진 UI 안내문도 기준 문장에서 바뀝니다로 복구한다', () => {
  const broken = '가장 맞는 카드 하나를 고르면 아래 결과가 바로 바힙니다';
  const recovery = buildTranscriptRecovery(broken, broken, broken);

  assert.equal(recovery.chosenSource, 'live');
  assert.equal(recovery.recoveredText, '가장 맞는 카드 하나를 고르면 아래 결과가 바로 바뀝니다.');
  assert.match(recovery.summary, /두 STT가 거의 같아서/);
});

test('fetchRewriteVariants는 정적 폴백에서도 evidence를 반영해 말이 안 되는 토큰을 바로잡는다', async () => {
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    fetchCalled = true;
    throw new Error('fetch should not be called in static fallback mode');
  };

  try {
    await withMockedLocation({ hostname: 'milkeon.github.io', protocol: 'https:' }, async () => {
      const variants = await fetchRewriteVariants({
        baseTranscript: '가장 맞는 카드 하나를 고르면 아래 결과가 바로 바힙니다',
        evidenceTranscript: '가장 맞는 카드 하나를 고르면 아래 결과가 바로 바힙니다'
      });

      assert.equal(fetchCalled, false);
      assert.equal(variants[0].text, '가장 맞는 카드 하나를 고르면 아래 결과가 바로 바뀝니다.');
      assert.ok(variants.every((variant) => !variant.text.includes('바힙니다')));
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
