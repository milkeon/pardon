import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRemotePrompt, buildRewriteVariants, deriveContextProfile, inferContextHints, normalizeWhitespace } from '../src/rewrite.js';

test('normalizeWhitespace는 과도한 공백을 정리한다', () => {
  assert.equal(normalizeWhitespace('  hello\n\nworld  '), 'hello world');
});

test('inferContextHints는 문맥 키워드에 반응한다', () => {
  const hints = inferContextHints('Please rewrite this as a polite email for a customer');
  assert.ok(hints.includes('professional'));
  assert.ok(hints.includes('polished'));
});

test('deriveContextProfile는 문맥과 원문을 바탕으로 해석 프로필을 만든다', () => {
  const profile = deriveContextProfile(
    '고객에게 보낼 공식 이메일입니다. 빠른 답변 부탁드려요.',
    'I need to send this update to the team.'
  );

  assert.equal(profile.channel, 'email');
  assert.equal(profile.audience, 'customer');
  assert.equal(profile.tone, 'formal');
  assert.equal(profile.urgency, 'high');
});

test('buildRemotePrompt는 가능성 1, 2, 3을 요구하는 JSON 프롬프트를 만든다', () => {
  const prompt = buildRemotePrompt({
    transcript: 'I need to send this update to the team.',
    context: 'Slack message for the team'
  });

  assert.equal(prompt.model, 'gpt-4o-mini');
  assert.ok(prompt.messages[0].content.includes('가능성 1'));
  assert.ok(prompt.messages[0].content.includes('문맥 프로필'));
  assert.ok(prompt.messages[0].content.includes('가능성 2'));
  assert.ok(prompt.messages[0].content.includes('가능성 3'));
  assert.ok(prompt.messages[1].content.includes('I need to send this update to the team.'));
});

test('buildRewriteVariants는 선택 가능한 3개 가능성을 반환한다', () => {
  const variants = buildRewriteVariants('I need to send this update to the team.', 'Slack message');
  assert.equal(variants.length, 3);
  assert.deepEqual(
    variants.map((variant) => variant.id),
    ['possibility-1', 'possibility-2', 'possibility-3']
  );
  assert.ok(variants.every((variant) => typeof variant.text === 'string' && variant.text.length > 0));
});

test('buildRewriteVariants는 원문이 비었을 때 빈 상태 문구를 반환한다', () => {
  const variants = buildRewriteVariants('', 'email');
  assert.equal(variants.length, 3);
  assert.ok(variants.every((variant) => variant.text.includes('텍스트가 들어오면')));
});
