import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfirmationSummary, buildRewriteVariants, deriveContextProfile, guardRewriteVariant, inferContextHints, normalizeWhitespace } from '../src/rewrite.js';
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

test('buildRewriteVariants는 제안 1, 제안 2, 제안 3을 반환한다', () => {
  const variants = buildRewriteVariants('um I need to send the update to the team');

  assert.equal(variants.length, 3);
  assert.deepEqual(
    variants.map((variant) => variant.id),
    ['possibility-1', 'possibility-2', 'possibility-3']
  );
  assert.deepEqual(
    variants.map((variant) => variant.label),
    ['제안 1 · 오인식 보정', '제안 2 · 문맥 교정', '제안 3 · 매끄러운 문장']
  );
  assert.ok(variants[0].text.includes('제가 해야 합니다') || variants[0].text.includes('팀'));
  assert.ok(variants[2].text.length > 0);
  assert.ok(new Set(variants.map((variant) => variant.text)).size >= 2);
});

test('buildRewriteVariants는 오인식 단어를 실제 용어로 교정한다', () => {
  const variants = buildRewriteVariants('Please fix the redirect issue and send the update to the team. 리사이젝트도 정리해 주세요.');

  assert.ok(variants[0].text.includes('수정'));
  assert.ok(variants[0].text.includes('리다이렉트'));
  assert.ok(variants[0].text.includes('팀'));
  assert.ok(variants[0].text.includes('업데이트'));
  assert.ok(variants[0].text.includes('리다이렉트'));
});

test('buildRewriteVariants는 원문이 비었을 때 안내 문구를 반환한다', () => {
  const variants = buildRewriteVariants('');
  assert.equal(variants.length, 3);
  assert.ok(variants.every((variant) => variant.text.includes('정지하면')));
});

test('guardRewriteVariant는 원문과 너무 멀어진 후보를 되돌린다', () => {
  const source = '이불도 배기덕질해';
  const hallucinated = '이불과 배개 어쩌구 일 것 같은데 유의미하게 바뀌지 않음 아래쪽은 오히려 더 이상함';

  assert.equal(guardRewriteVariant(source, hallucinated, source, 'strict'), '이불도 배기덕질해.');
});

test('guardRewriteVariant는 확실한 기술 용어 교정은 유지한다', () => {
  const source = 'Please fix the redirect issue and send the update to the team.';
  const candidate = '리다이렉트 문제를 수정하고 업데이트를 팀에 보내 주세요.';

  assert.equal(guardRewriteVariant(source, candidate, source, 'strict'), '리다이렉트 문제를 수정하고 업데이트를 팀에 보내 주세요.');
});

test('buildRewriteVariants는 긴 문맥 입력을 실제로 재구성한다', () => {
  const raw = '자연으로 명령을 하면 명령을 받아 보고 상황이라든지 그런 것들이 ai가 상황으로 인지하고 그거에 대한 도장까지 무시해 달라고 해서 원하는 상황을 제시할 수 있어 비용 이런 명령을 이제 제어가 받아들이고 각성이 돼야지 구체적으로 해야 돼 다들 오래 보다 보던 것들 뉴스가 이거는 이제 데이터가 부족해 가지고 이것은 이제 데이터가 부족해 가지고 좀 거래되는지 그런 데이터 자연 처리 부족해셔 그런가.';
  const variants = buildRewriteVariants(raw);

  assert.notEqual(variants[1].text, raw);
  assert.notEqual(variants[2].text, raw);
  assert.ok(variants[1].text.includes('해야 합니다'));
  assert.ok(!/^(핵심은|그리고|정리하면|정리해 보면)\b/.test(variants[2].text));
});

test('buildConfirmationSummary는 확정 내용을 원문보다 짧게 정리한다', () => {
  const source = '팀에 업데이트를 보내고 진행 상황까지 공유해야 합니다. 오늘 안에 확인도 필요합니다.';
  const summary = buildConfirmationSummary(source);

  assert.ok(summary.length > 0);
  assert.ok(summary.length < source.length);
  assert.notEqual(summary, normalizeWhitespace(source));
  assert.ok(summary.includes('팀에 업데이트') || summary.includes('진행 상황'));
  assert.ok(!summary.includes('오늘 안에 확인도 필요합니다'));
});

