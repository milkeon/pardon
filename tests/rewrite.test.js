import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRewriteVariants, deriveContextProfile, inferContextHints, normalizeWhitespace } from '../src/rewrite.js';
import { predictRewriteFocus } from '../src/ml.js';

test('normalizeWhitespace는 과도한 공백을 정리한다', () => {
  assert.equal(normalizeWhitespace('  hello\n\nworld  '), 'hello world');
});

test('inferContextHints는 문맥 키워드에 반응한다', () => {
  const hints = inferContextHints('Please rewrite this as a polite email for a customer');
  assert.ok(hints.includes('공손함'));
  assert.ok(hints.includes('문서형'));
});

test('predictRewriteFocus는 로컬 머신러닝 모델로 문맥 의도를 분류한다', () => {
  const polite = predictRewriteFocus('Could you please send a brief update to the client?');
  const action = predictRewriteFocus('Need this done ASAP, send the update now.');

  assert.equal(polite.label, 'polite');
  assert.ok(polite.confidence > 0);
  assert.equal(action.label, 'action');
  assert.ok(action.confidence > 0);
});

test('deriveContextProfile는 원문만으로도 문맥과 ML 신호를 만든다', () => {
  const profile = deriveContextProfile('고객에게 보낼 공식 이메일입니다. 빠른 답변 부탁드려요.');

  assert.equal(profile.channel, 'email');
  assert.equal(profile.tone, 'urgent');
  assert.equal(profile.urgency, 'high');
  assert.ok(profile.mlFocus);
  assert.equal(typeof profile.mlFocus.label, 'string');
});

test('buildRewriteVariants는 음성 보정본, 맥락 보정본, 종합본을 반환한다', () => {
  const variants = buildRewriteVariants('um I need to send the update to the team');

  assert.equal(variants.length, 3);
  assert.deepEqual(
    variants.map((variant) => variant.id),
    ['possibility-1', 'possibility-2', 'possibility-3']
  );
  assert.deepEqual(
    variants.map((variant) => variant.label),
    ['가능성 1 · 음성 보정본', '가능성 2 · 맥락 보정본', '가능성 3 · 종합본']
  );
  assert.ok(variants[0].text.includes('I need to send the update to the team'));
  assert.ok(variants[1].text.includes('업데이트') || variants[1].text.includes('팀'));
  assert.ok(variants[2].text.length > 0);
});

test('buildRewriteVariants는 원문이 비었을 때 안내 문구를 반환한다', () => {
  const variants = buildRewriteVariants('');
  assert.equal(variants.length, 3);
  assert.ok(variants.every((variant) => variant.text.includes('정지하면')));
});
