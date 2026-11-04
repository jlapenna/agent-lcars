export class PermanentAdmissionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentAdmissionError';
  }
}

export const MAX_PROCESS_ATTEMPTS = 10;

export const MAX_REPAIR_GENERATIONS = 10;
const HOUR_MS = 60 * 60 * 1000;

export function repairSuccessorDelayMs(generation: number): number {
  return Math.min(2 ** generation, 24) * HOUR_MS;
}

export function parseAttempt(retryCount: string | null): number {
  if (retryCount === null || !/^\d+$/u.test(retryCount)) return 1;
  const parsed = Number(retryCount);
  return Number.isSafeInteger(parsed) ? parsed + 1 : 1;
}

/** The durable repair generation is carried separately from Cloud Tasks'
 * per-task retry count. A successor begins at retry one, so reusing the
 * retry count would recreate the same named repair task after every
 * lifecycle. This header is supplied only by our task enqueue path; malformed
 * values are a deterministic delivery error rather than a reason to choose an
 * arbitrary task name. */
export function parseRepairGeneration(value: string | null): number {
  if (value === null) return 0;
  if (!/^\d+$/u.test(value)) {
    throw new PermanentAdmissionError(
      'x-agent-lcars-projection-repair-generation must be a nonnegative integer',
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PermanentAdmissionError(
      'x-agent-lcars-projection-repair-generation must be a safe integer',
    );
  }
  return parsed;
}
