import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const html = readFileSync(path.resolve('index.html'), 'utf8');
const appJs = readFileSync(path.resolve('src/app.js'), 'utf8');

test('index.html exposes the simplified Pardon controls', () => {
  assert.ok(html.includes('<h1>Pardon</h1>'));
  assert.ok(html.includes('녹음 시작'));
  assert.ok(html.includes('변환'));
  assert.ok(html.includes('원문 STT'));
  assert.ok(html.includes('제안 3가지'));
  assert.ok(html.includes('차이 읽는 법'));
  assert.ok(html.includes('노란색'));
  assert.ok(html.includes('선택한 문장 복사'));
  assert.ok(html.includes('확정 요약'));
  assert.ok(!html.includes('data-action="confirm"'));
  assert.ok(appJs.includes('data-action="confirm-variant"'));
  assert.ok(appJs.includes('data-action="copy-variant"'));
  assert.ok(appJs.includes('transcribeAudioBlob'));
  assert.ok(html.includes('id="toast"'));
  assert.ok(html.includes('녹음이 끝나면 STT 결과가 여기에 표시됩니다. 직접 붙여넣어도 됩니다.'));
  assert.ok(html.includes('autocorrect="off"'));
  assert.ok(!html.includes('문맥 힌트'));
  assert.ok(!html.includes('다시 생성'));
  assert.ok(html.includes('class="transcript-actions"'));
  assert.ok(html.indexOf('data-action="generate"') < html.indexOf('data-action="clear"'));
});

test('index.html loads the browser app module and stylesheet', () => {
  assert.ok(html.includes('./styles.css'));
  assert.ok(html.includes('./src/app.js?v=confirm-llm-7'));
});
