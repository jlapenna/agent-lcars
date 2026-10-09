// One immutable monotonic budget per native scenario, shared with its resume,
// correction and finalization fixtures. Wall time is diagnostic metadata only.
export function createProbeBudget(timeoutMs, now = () => performance.now()) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error('Probe timeout must be positive and finite');
  const started = now();
  const expires = started + timeoutMs;
  const remainingMs = () => Math.max(0, Math.floor(expires - now()));
  return Object.freeze({
    timeoutMs,
    remainingMs,
    expired: () => remainingMs() === 0,
    elapsedMs: () => Math.max(0, now() - started),
  });
}
