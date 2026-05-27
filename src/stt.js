export function mergeRecognitionResults(previousState = {}, recognitionResults = [], resultIndex = 0) {
  const previousSegments = Array.isArray(previousState.segments) ? previousState.segments : [];
  const nextSegments = previousSegments.slice(0, resultIndex);
  let committedTranscript = String(previousState.committedTranscript ?? '');
  let interimTranscript = '';

  for (let index = resultIndex; index < recognitionResults.length; index += 1) {
    const transcript = recognitionResults[index]?.transcript ?? '';
    const isFinal = Boolean(recognitionResults[index]?.isFinal);

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
