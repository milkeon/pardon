import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRewriteVariants, normalizeWhitespace } from '../src/rewrite.js';

test('normalizeWhitespace는 과도한 공백을 정리한다', () => {
  assert.equal(normalizeWhitespace('  hello\n\nworld  '), 'hello world');
});

test('buildRewriteVariants는 선택 가능한 3개 변형을 반환한다', () => {
  const variants = buildRewriteVariants('I need to send this update to the team.');
  assert.equal(variants.length, 3);
  assert.deepEqual(
    variants.map((variant) => variant.id),
    ['p1', 'p2', 'p3']
  );
  assert.ok(variants.every((variant) => typeof variant.text === 'string' && variant.text.length > 0));
});

test('buildRewriteVariants는 원문이 비었을 때 빈 상태 문구를 반환한다', () => {
  const variants = buildRewriteVariants('');
  assert.equal(variants.length, 3);
  assert.ok(variants.every((variant) => variant.text.includes('텍스트가 들어오면')));
});
