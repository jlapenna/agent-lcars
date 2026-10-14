/** One minute's runner counts from a lane's `runnerHistory` window. */
export interface RunnerSample {
  at: string;
  registered: number;
  running: number;
}

const MAX_SAMPLES = 30;
/** How long one sample stands for its lane. The autoscaler samples a lane
 * once a minute with a few seconds' jitter; past this the lane has missed a
 * scrape and its bar is left empty. */
const SAMPLE_FRESH_MS = 90_000;

/** A lane's runner window, or undefined when it is absent or malformed. A
 * bad window costs only the sparkline, never the lane's figures. */
export function parseRunnerWindow(value: unknown): RunnerSample[] | undefined {
  const samples = (value as { samples?: unknown } | null | undefined)?.samples;
  if (!Array.isArray(samples) || samples.length > MAX_SAMPLES) return undefined;
  const parsed: RunnerSample[] = [];
  for (const sample of samples) {
    const record = sample as Record<string, unknown> | null;
    if (
      !record ||
      typeof record['at'] !== 'string' ||
      !Number.isFinite(Date.parse(record['at'])) ||
      !Number.isSafeInteger(record['registered']) ||
      (record['registered'] as number) < 0 ||
      !Number.isSafeInteger(record['running']) ||
      (record['running'] as number) < 0
    )
      return undefined;
    parsed.push({
      at: record['at'],
      registered: record['registered'] as number,
      running: record['running'] as number,
    });
  }
  return parsed;
}

/**
 * Runners online and busy, summed across every lane, at the end of each of
 * the last `minutes` minutes. A minute where any lane has no fresh sample is
 * undefined: summing the lanes that answered would draw a dip that never
 * happened. Undefined overall when any lane has no window at all.
 */
export function fleetRunnerHistory(
  lanes: readonly { runnerHistory?: RunnerSample[] }[],
  now: number,
  minutes = 30,
):
  { online: (number | undefined)[]; busy: (number | undefined)[] } | undefined {
  if (lanes.length === 0 || lanes.some((lane) => !lane.runnerHistory))
    return undefined;
  const online: (number | undefined)[] = [];
  const busy: (number | undefined)[] = [];
  for (let i = minutes - 1; i >= 0; i -= 1) {
    const t = now - i * 60_000;
    let registered = 0;
    let running = 0;
    let complete = true;
    for (const lane of lanes) {
      const sample = lane.runnerHistory
        ?.filter((s) => {
          const at = Date.parse(s.at);
          return at <= t && at > t - SAMPLE_FRESH_MS;
        })
        .at(-1);
      if (!sample) {
        complete = false;
        break;
      }
      registered += sample.registered;
      running += sample.running;
    }
    online.push(complete ? registered : undefined);
    busy.push(complete ? running : undefined);
  }
  return { online, busy };
}
