import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const html = readFileSync(path.resolve('index.html'), 'utf8');

test('index.html exposes the core Pardon controls', () => {
  assert.ok(html.includes('Start recording'));
  assert.ok(html.includes('Raw STT'));
  assert.ok(html.includes('Rewrite variants'));
  assert.ok(html.includes('Copy selected rewrite'));
});

test('index.html loads the browser app module and stylesheet', () => {
  assert.ok(html.includes('./styles.css'));
  assert.ok(html.includes('./src/app.js'));
});
