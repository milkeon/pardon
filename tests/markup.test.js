import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const html = readFileSync(path.resolve('index.html'), 'utf8');
const appJs = readFileSync(path.resolve('src/app.js'), 'utf8');
const asrJs = readFileSync(path.resolve('src/asr.js'), 'utf8');
const serverJs = readFileSync(path.resolve('server.js'), 'utf8');

test('index.html exposes the simplified Pardon controls', () => {
  assert.ok(html.includes('<h1>Pardon</h1>'));
  assert.ok(html.includes('녹음 시작'));
  assert.ok(html.includes('변환'));
  assert.ok(html.includes('실시간 원문'));
  assert.ok(html.includes('원문 STT'));
  assert.ok(html.includes('녹음된 오디오'));
  assert.ok(html.includes('STT</button>'));
  assert.ok(html.includes('후보 선택'));
  assert.ok(html.includes('원문을 기준으로 후보 3개를 고릅니다'));
  assert.ok(html.includes('선택한 문장 복사'));
  assert.ok(html.includes('선택 결과'));
  assert.ok(!html.includes('data-action="confirm"'));
  assert.ok(appJs.includes('data-action="choose-variant"'));
  assert.ok(appJs.includes('fetchRewriteVariants({'));
  assert.ok(appJs.includes('baseTranscript,'));
  assert.ok(appJs.includes('evidenceTranscript'));
  assert.ok(appJs.includes('data-action="transcribe-recording"'));
  assert.ok(appJs.includes('transcribeAudioBlob'));
  assert.ok(appJs.includes('audio/flac'));
  assert.ok(html.includes('id="toast"'));
  assert.ok(html.includes('녹음이 진행되는 동안 실시간 받아쓰기 결과가 여기에 표시됩니다.'));
  assert.ok(html.includes('id="transcript"'));
  assert.ok(html.includes('class="transcript-actions"'));
  assert.ok(html.indexOf('data-action="generate"') < html.indexOf('data-action="clear"'));
});

test('index.html loads the browser app module and stylesheet', () => {
  assert.ok(html.includes('./styles.css'));
  assert.ok(html.includes('./src/app.js?v=context-restore-31'));
});

test('Pardon file STT path stays browser-local and does not require server-side OpenAI Whisper setup', () => {
  assert.ok(appJs.includes('transcribeAudioBlobImpl'));
  assert.ok(asrJs.includes("pipeline('automatic-speech-recognition', TRANSCRIBE_MODEL)"));
  assert.ok(!appJs.includes('/api/transcribe'));
  assert.ok(!serverJs.includes("req.url === '/api/transcribe'"));
  assert.ok(!serverJs.includes('callOpenAIWhisper'));
});
