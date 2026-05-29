import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfirmationSummary, buildRewriteVariants, buildTranscriptDiff, compareTranscriptSources, deriveContextProfile, guardRewriteVariant, inferContextHints, normalizeWhitespace, renderTranscriptDiff } from '../src/rewrite.js';
import { predictRewriteFocus } from '../src/ml.js';

test('normalizeWhitespace는 과도한 공백을 정리한다', () => {
  assert.equal(normalizeWhitespace('  hello\n\nworld  '), 'hello world');
});

test('buildTranscriptDiff는 바뀐 부분만 카드로 분리한다', () => {
  const diff = buildTranscriptDiff('원문은 조금 길고 녹음은 짧다', '원문은 아주 조금 길고 녹음은 더 짧다');
  const changed = diff.segments.filter((segment) => segment.kind === 'change');

  assert.ok(changed.length >= 1);
  assert.ok(diff.changeCount >= 1);
  assert.ok(diff.mergedText.length > 0);
  assert.equal(renderTranscriptDiff(diff.segments, diff.selection), diff.mergedText);
  assert.ok(changed.every((segment) => segment.leftText !== segment.rightText));
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

test('buildRewriteVariants는 기술 설명 문맥에서 패션을 세션으로 교정한다', () => {
  const variants = buildRewriteVariants('쿠키 세션 얘기하다가 중간에 패션이라고 잘못 들어갔는데 브라우저에서는 세션으로 관리해야 합니다.');

  assert.equal(variants.length, 3);
  assert.ok(variants[0].text.includes('세션'));
  assert.ok(!variants[0].text.includes('패션'));
  assert.ok(!variants[0].text.startsWith('실행 계획'));
});

test('buildRewriteVariants는 로그인/라우터 설명에서 메론가요와 타피를 실제 용어로 교정한다', () => {
  const source = '예를 들어서 이제 전번 1111하고 자 로그인을 딱 누르면 자 메론가요 이거 서버에 지금 저 로그인이라는 요청으로 그 포스트 모양이 안 돼 있다는 뜻이죠 그래서 포스트 방식의 그 라우터가 아직 구현되지 않았다는 그런 의미입니다. 자 요거 그대로 타피 자 여기다가 붙여넣기 하는데 대신 액정 개시하느라 별로 포스트로만 바꿔 주면 되겠죠.';
  const variants = buildRewriteVariants(source);

  assert.equal(variants.length, 3);
  assert.ok(new Set(variants.map((variant) => variant.text)).size >= 2);
  assert.ok(variants.some((variant) => variant.text.includes('뭔가요') || variant.text.includes('카피') || variant.text.includes('POST')));
  assert.ok(variants.every((variant) => !variant.text.includes('메론가요')));
  assert.ok(variants.some((variant) => variant.text.includes('서버의 POST 라우터')));
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

test('buildRewriteVariants는 UI 설명 STT를 검색바/목록 보기 문맥으로 실제 교정한다', () => {
  const raw = '보통 검색은 어디서 하나면 목록에서 했잖아요 목록 표기에가 보시면 요런 UI에서 좀 검색바다 추가가 되겠지';
  const variants = buildRewriteVariants(raw);
  const texts = variants.map((variant) => variant.text);

  assert.equal(variants.length, 3);
  assert.ok(new Set(texts).size >= 2);
  assert.ok(texts.some((text) => text.includes('검색바')));
  assert.ok(texts.some((text) => text.includes('목록 보기') || text.includes('목록에서')));
  assert.ok(texts.every((text) => !text.includes('검색바다')));
});

test('buildRewriteVariants는 토큰/로컬 스토리지 설명을 세션 문맥으로 교정한다', () => {
  const raw = '유저가 토큰을 로컬 스토리지에 넣어두면 탈취 위험이 커요 그래서 세션 기반으로 가는게 맞아요';
  const variants = buildRewriteVariants(raw);

  assert.equal(variants.length, 3);
  assert.ok(variants[0].text.includes('로컬 스토리지'));
  assert.ok(variants[1].text.includes('탈취 위험'));
  assert.ok(variants[1].text.includes('세션'));
  assert.ok(variants[2].text.includes('로컬 스토리지') || variants[2].text.includes('세션'));
});

test('buildRewriteVariants는 GET/POST 누락 설명을 405 문맥으로 교정한다', () => {
  const raw = '라우터에 겟 포스트 둘다 있어야 되는데 포스트만 빠져서 405가 나는 거예요';
  const variants = buildRewriteVariants(raw);

  assert.equal(variants.length, 3);
  assert.ok(variants[0].text.includes('GET') || variants[0].text.includes('POST'));
  assert.ok(variants[1].text.includes('405'));
  assert.ok(variants[1].text.includes('POST'));
  assert.ok(variants[1].text.includes('빠져'));
});

test('buildConfirmationSummary는 긴 원문을 붙여도 짧은 확정 요약을 유지한다', () => {
  const selected = '브라우저는 세션을 사용하는 상태를 관리하는 방식입니다.';
  const source = '이름의 섹션에 우리가요 리퀘스트 좀 바디를 이렇게 추가하도록 하겠습니다 자 그러면 이때 이때 보면 새로운 로그인이 있다고 전화 한번 찍어 보세요 그러니까 최초의 최초에 한번 로그인을 했을 때 세션 정보가 일단 들어갈 거고 그러면 이제 내가 두 번째 만약에 최초의 로그인이고 내가 이제 뭐 예를 들어서 뭐 브라우저로 갔다가 다시 만약에 로그인 페이지를 요청을 하게 되면은 그때 이제 엑삭하겠지 어이 POST가 아니라 이번에는 백반집에 로그인 찾아야 될 건데 자 이때 얘는 지금 이게 첫 번째 첫 번째로 모이면이 아니라 이미 로그인된 상태인지 알 수가 없어.';
  const summary = buildConfirmationSummary(selected, source);

  assert.ok(summary.length > 0);
  assert.ok(summary.length < source.length);
  assert.notEqual(summary, normalizeWhitespace(source));
  assert.ok(!summary.includes('이름의 섹션에 우리가요 리퀘스트'));
  assert.ok(summary.includes('브라우저') || summary.includes('세션'));
});

test('compareTranscriptSources는 실시간과 녹음 파일 결과를 비교해 더 자연스러운 원문을 고른다', () => {
  const live = '쿠키 세션 세션 얘기하다가 브라우저에서 상태를 관리합니다';
  const recorded = '쿠키와 세션은 브라우저에서 상태를 관리합니다';
  const result = compareTranscriptSources(live, recorded, '쿠키 세션 브라우저 상태 관리');

  assert.equal(result.chosenSource, 'recorded');
  assert.equal(result.recoveredText, recorded);
  assert.ok(result.recordedScore >= result.liveScore);
  assert.ok(result.summary.includes('녹음 파일 STT') || result.summary.includes('실시간 받아쓰기'));
});

