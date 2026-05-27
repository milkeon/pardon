import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRecognitionResults } from '../src/stt.js';

test('mergeRecognitionResults는 이전 확정 구간을 유지하고 새 결과만 갱신한다', () => {
  const first = mergeRecognitionResults([], [
    { transcript: '팀에 ' },
    { transcript: '업데이트를' }
  ]);

  assert.equal(first.transcript, '팀에 업데이트를');
  assert.deepEqual(first.segments, ['팀에 ', '업데이트를']);

  const second = mergeRecognitionResults(first.segments, [
    { transcript: '팀에 ' },
    { transcript: '업데이트를 보내야' },
    { transcript: ' 합니다' }
  ]);

  assert.equal(second.transcript, '팀에 업데이트를 보내야 합니다');
  assert.deepEqual(second.segments, ['팀에 ', '업데이트를 보내야', ' 합니다']);
});

test('mergeRecognitionResults는 공백 정규화 없이 원문 조각을 그대로 붙인다', () => {
  const merged = mergeRecognitionResults([], [
    { transcript: 'A  ' },
    { transcript: 'B\n' },
    { transcript: 'C' }
  ]);

  assert.equal(merged.transcript, 'A  B\nC');
});
