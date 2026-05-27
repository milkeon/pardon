import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const html = readFileSync(path.resolve('index.html'), 'utf8');

test('index.html exposes the simplified Pardon controls', () => {
  assert.ok(html.includes('<h1>Pardon</h1>'));
  assert.ok(html.includes('녹음 시작'));
  assert.ok(html.includes('변환'));
  assert.ok(html.includes('원문 STT'));
  assert.ok(html.includes('제안 3가지'));
  assert.ok(html.includes('차이 읽는 법'));
  assert.ok(html.includes('노란색'));
  assert.ok(html.includes('선택한 문장 복사'));
  assert.ok(html.includes('id="toast"'));
  assert.ok(html.includes('spellcheck="false"'));
  assert.ok(html.includes('autocorrect="off"'));
  assert.ok(!html.includes('문맥 힌트'));
  assert.ok(!html.includes('다시 생성'));
});

test('index.html loads the browser app module and stylesheet', () => {
  assert.ok(html.includes('./styles.css'));
  assert.ok(html.includes('./src/app.js?v=f2c31e5'));
});
