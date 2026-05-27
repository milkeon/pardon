export function calculateRms(samples = []) {
  const values = Array.from(samples);
  if (!values.length) return 0;

  let sumSquares = 0;
  for (const value of values) {
    sumSquares += value * value;
  }

  return Math.sqrt(sumSquares / values.length);
}

export function hasTimedOutSince(lastActivityAt, now = Date.now(), timeoutMs = 60_000) {
  if (!Number.isFinite(lastActivityAt)) return false;
  return now - lastActivityAt >= timeoutMs;
}

export function shouldRestartRecognition({ isRecording = false, isStopping = false } = {}) {
  return Boolean(isRecording) && !isStopping;
}
