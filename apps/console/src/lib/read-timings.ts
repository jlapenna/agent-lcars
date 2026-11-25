import { logger } from '@agent-lcars/logging';

/**
 * Records how long each of a render's independent reads took and logs them
 * as one line, so production shows which read a slow page waited on:
 *
 *   agent-lcars: page read timings {"page":"bridge","totalMs":2140,
 *     "reads":{"queue":310,"activity":480,...}}
 *
 * Query in Cloud Logging with `textPayload:"page read timings"`.
 */
export function readTimings(page: string) {
  const started = performance.now();
  const reads: Record<string, number> = {};
  return {
    time<T>(label: string, read: Promise<T>): Promise<T> {
      const start = performance.now();
      return read.finally(() => {
        reads[label] = Math.round(performance.now() - start);
      });
    },
    log(): void {
      logger.info('agent-lcars: page read timings', {
        page,
        totalMs: Math.round(performance.now() - started),
        reads,
      });
    },
  };
}
