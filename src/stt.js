export function mergeRecognitionResults(previousState = {}, recognitionResults = [], resultIndex = 0, options = {}) {
  const previousSegments = Array.isArray(previousState.segments) ? previousState.segments : [];
  const nextSegments = previousSegments.slice(0, resultIndex);
  let committedTranscript = String(previousState.committedTranscript ?? '');
  let interimTranscript = '';
  const insertLineBreak = Boolean(options.insertLineBreak);
  let lineBreakInserted = false;
  const hasPriorTranscript = Boolean(committedTranscript || previousSegments.some((segment) => normalizeSegmentText(segment?.transcript)));

  for (let index = resultIndex; index < recognitionResults.length; index += 1) {
    let transcript = recognitionResults[index]?.transcript ?? '';
    const isFinal = Boolean(recognitionResults[index]?.isFinal);

    if (insertLineBreak && !lineBreakInserted && hasPriorTranscript && normalizeSegmentText(transcript)) {
      transcript = transcript.startsWith('\n') ? transcript : `\n${transcript}`;
      lineBreakInserted = true;
    }

    nextSegments[index] = { transcript, isFinal };

    if (isFinal) {
      committedTranscript += transcript;
    } else {
      interimTranscript += transcript;
    }
  }

  return {
    segments: nextSegments,
    committedTranscript,
    interimTranscript,
    transcript: `${committedTranscript}${interimTranscript}`
  };
}

function normalizeSegmentText(value) {
  return String(value ?? '').trim();
}
