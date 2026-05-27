import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRecognitionResults } from '../src/stt.js';

test('mergeRecognitionResults는 이전 확정 구간을 유지하고 새 결과만 갱신한다', () => {
  const first = mergeRecognitionResults(
    { segments: [], committedTranscript: '' },
    [
      { transcript: '팀에 ', isFinal: true },
      { transcript: '업데이트를', isFinal: false }
    ],
    0
  );

  assert.equal(first.transcript, '팀에 업데이트를');
  assert.deepEqual(first.segments, [
    { transcript: '팀에 ', isFinal: true },
    { transcript: '업데이트를', isFinal: false }
  ]);

  const second = mergeRecognitionResults(
    { segments: first.segments, committedTranscript: first.committedTranscript },
    [
      { transcript: '팀에 ', isFinal: true },
      { transcript: '업데이트를 보내야', isFinal: true },
      { transcript: ' 합니다', isFinal: false }
    ],
    1
  );

  assert.equal(second.transcript, '팀에 업데이트를 보내야 합니다');
  assert.deepEqual(second.segments, [
    { transcript: '팀에 ', isFinal: true },
    { transcript: '업데이트를 보내야', isFinal: true },
    { transcript: ' 합니다', isFinal: false }
  ]);
});

test('mergeRecognitionResults는 공백 정규화 없이 원문 조각을 그대로 붙인다', () => {
  const merged = mergeRecognitionResults(
    { segments: [], committedTranscript: '' },
    [
      { transcript: 'A  ', isFinal: true },
      { transcript: 'B\n', isFinal: true },
      { transcript: 'C', isFinal: false }
    ],
    0
  );

  assert.equal(merged.transcript, 'A  B\nC');
});
