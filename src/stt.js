export function mergeRecognitionResults(previousSegments = [], recognitionResults = []) {
  const nextSegments = previousSegments.slice(0, recognitionResults.length);

  for (let index = 0; index < recognitionResults.length; index += 1) {
    nextSegments[index] = recognitionResults[index]?.transcript ?? '';
  }

  return {
    segments: nextSegments,
    transcript: nextSegments.join('')
  };
}
