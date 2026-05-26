import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRewriteVariants, inferContextHints, normalizeWhitespace } from '../src/rewrite.js';

test('normalizeWhitespace collapses excessive whitespace', () => {
  assert.equal(normalizeWhitespace('  hello\n\nworld  '), 'hello world');
});

test('inferContextHints responds to context keywords', () => {
  const hints = inferContextHints('Please rewrite this as a polite email for a customer');
  assert.ok(hints.includes('professional'));
  assert.ok(hints.includes('polished'));
});

test('buildRewriteVariants returns three selectable variants', () => {
  const variants = buildRewriteVariants('I need to send this update to the team.', 'Slack message');
  assert.equal(variants.length, 3);
  assert.deepEqual(
    variants.map((variant) => variant.id),
    ['clean', 'polite', 'action']
  );
  assert.ok(variants.every((variant) => typeof variant.text === 'string' && variant.text.length > 0));
});

test('buildRewriteVariants returns an empty-state message when transcript is blank', () => {
  const variants = buildRewriteVariants('', 'email');
  assert.equal(variants.length, 3);
  assert.ok(variants.every((variant) => variant.text.includes('텍스트가 들어오면')));
});
