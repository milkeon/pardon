import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRms, hasTimedOutSince, shouldRestartRecognition } from '../src/capture.js';

test('calculateRms는 입력 샘플의 평균 제곱근 값을 계산한다', () => {
  const rms = calculateRms([0, 0.5, -0.5, 0]);
  assert.ok(rms > 0.35 && rms < 0.36);
});

test('hasTimedOutSince는 마지막 음성 시각이 1분을 넘기면 true를 반환한다', () => {
  assert.equal(hasTimedOutSince(1_000, 61_000, 60_000), true);
  assert.equal(hasTimedOutSince(1_000, 59_000, 60_000), false);
});

test('shouldRestartRecognition은 사용자가 정지하지 않았고 아직 녹음 중일 때만 true를 반환한다', () => {
  assert.equal(shouldRestartRecognition({ isRecording: true, isStopping: false }), true);
  assert.equal(shouldRestartRecognition({ isRecording: true, isStopping: true }), false);
  assert.equal(shouldRestartRecognition({ isRecording: false, isStopping: false }), false);
});
