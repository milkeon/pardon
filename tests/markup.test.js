import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const html = readFileSync(path.resolve('index.html'), 'utf8');

test('index.html exposes the core Pardon controls', () => {
  assert.ok(html.includes('녹음 시작'));
  assert.ok(html.includes('원문 STT'));
  assert.ok(html.includes('가능성 3가지'));
  assert.ok(html.includes('선택한 문장 복사'));
});

test('index.html loads the browser app module and stylesheet', () => {
  assert.ok(html.includes('./styles.css'));
  assert.ok(html.includes('./src/app.js'));
});
