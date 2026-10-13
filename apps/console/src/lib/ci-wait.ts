/**
 * CI wait p50: the fleet's job-startup latency (job assigned to a runner until
 * that runner starts it) over the last 30 minutes. The source is each ARC
 * listener's `gha_job_startup_duration_seconds` histogram, which the
 * autoscaler windows per lane (apps/runner-autoscaler/arc_job_startup.go).
 */

/** Matches the autoscaler's window and the sparkline's 30 bars. */
export const CI_WAIT_MINUTES = 30;

/** One lane's window, projected small enough to stream: minutes with no job
 * start are dropped, and the rest keep only their nonzero buckets. */
export interface JobStartupWindow {
  /** Finite bucket upper bounds in seconds, ascending. */
  bounds: number[];
  /** When the oldest interval began: under 30 minutes ago after the
   * autoscaler starts or the window resets. */
  startedAt: string;
  /** The newest interval's end, whether or not a job started in it. */
  endedAt: string;
  minutes: {
    endedAt: string;
    /** [bucket index, jobs] pairs; index `bounds.length` is `+Inf`. */
    jobs: [number, number][];
  }[];
}

/**
 * Projects the autoscaler's `jobStartup` field (cumulative counts per
 * interval). Returns undefined for anything malformed, so a bad field drops
 * only this readout, never the lane's capacity.
 */
export function parseJobStartupWindow(
  value: unknown,
): JobStartupWindow | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const bounds = record['bounds'];
  const intervals = record['intervals'];
  const startedAt = record['startedAt'];
  if (
    typeof startedAt !== 'string' ||
    !Number.isFinite(Date.parse(startedAt)) ||
    !Array.isArray(bounds) ||
    bounds.length === 0 ||
    bounds.length > 64 ||
    !bounds.every(
      (bound, i) =>
        typeof bound === 'number' &&
        Number.isFinite(bound) &&
        bound >= 0 &&
        (i === 0 || bound > (bounds[i - 1] as number)),
    ) ||
    !Array.isArray(intervals) ||
    intervals.length === 0 ||
    intervals.length > CI_WAIT_MINUTES
  )
    return undefined;
  const minutes: JobStartupWindow['minutes'] = [];
  let newest = startedAt;
  for (const interval of intervals) {
    if (interval === null || typeof interval !== 'object') return undefined;
    const { endedAt, counts } = interval as Record<string, unknown>;
    if (
      typeof endedAt !== 'string' ||
      !Number.isFinite(Date.parse(endedAt)) ||
      Date.parse(endedAt) <= Date.parse(newest) ||
      !Array.isArray(counts) ||
      counts.length !== bounds.length + 1 ||
      !counts.every(
        (count, i) =>
          Number.isSafeInteger(count) &&
          (count as number) >= 0 &&
          (i === 0 || (count as number) >= (counts[i - 1] as number)),
      )
    )
      return undefined;
    newest = endedAt;
    const jobs: [number, number][] = [];
    (counts as number[]).forEach((count, i) => {
      const inBucket = count - (i === 0 ? 0 : (counts[i - 1] as number));
      if (inBucket > 0) jobs.push([i, inBucket]);
    });
    if (jobs.length > 0) minutes.push({ endedAt, jobs });
  }
  return { bounds: bounds as number[], startedAt, endedAt: newest, minutes };
}

/**
 * The `q` quantile of a cumulative histogram, with Prometheus
 * `histogram_quantile` semantics: linear within the bucket, the first bucket
 * starting at zero, and a rank in the `+Inf` bucket reported as the highest
 * finite bound. Undefined when the histogram is empty.
 */
export function histogramQuantile(
  q: number,
  bounds: readonly number[],
  counts: readonly number[],
): number | undefined {
  const total = counts[counts.length - 1] ?? 0;
  if (total === 0) return undefined;
  const rank = q * total;
  const bucket = counts.findIndex((count) => count >= rank);
  if (bucket >= bounds.length) return bounds[bounds.length - 1];
  const lower = bucket === 0 ? 0 : (bounds[bucket - 1] as number);
  const below = bucket === 0 ? 0 : (counts[bucket - 1] as number);
  const inBucket = (counts[bucket] as number) - below;
  const upper = bounds[bucket] as number;
  return inBucket === 0
    ? upper
    : lower + (upper - lower) * ((rank - below) / inBucket);
}

export interface CiWait {
  /** Undefined when no job started in the window. */
  p50Seconds?: number;
  jobs: number;
  /** How much of the last 30 minutes the windows actually cover. */
  coveredMinutes: number;
  /** Oldest first, one per minute; undefined where no job started. */
  series: (number | undefined)[];
  /** Some lanes reported no window, a different bucket layout, or a
   * shorter window than the others. */
  partial: boolean;
}

/**
 * Sums the lanes' windows per minute. Minutes are counted back from the
 * newest interval any lane reports, not from the clock, so the server and
 * client render the same bars. Undefined when no lane has a window.
 */
export function fleetCiWait(
  lanes: readonly { jobStartup?: JobStartupWindow }[],
): CiWait | undefined {
  const windows = lanes
    .map((lane) => lane.jobStartup)
    .filter((window): window is JobStartupWindow => window !== undefined);
  const first = windows[0];
  if (!first) return undefined;
  const { bounds } = first;
  const same = windows.filter(
    (window) =>
      window.bounds.length === bounds.length &&
      window.bounds.every((bound, i) => bound === bounds[i]),
  );
  const newest = Math.max(...same.map((window) => Date.parse(window.endedAt)));
  const starts = same.map((window) => Date.parse(window.startedAt));
  const coveredMinutes = Math.min(
    CI_WAIT_MINUTES,
    Math.max(1, Math.round((newest - Math.min(...starts)) / 60_000)),
  );
  const minutes = Array.from({ length: CI_WAIT_MINUTES }, () =>
    Array<number>(bounds.length + 1).fill(0),
  );
  const total = Array<number>(bounds.length + 1).fill(0);
  for (const window of same) {
    for (const minute of window.minutes) {
      // Nearest, not floor: scrape jitter puts snapshots a little under or
      // over a minute apart, and each must keep its own bar.
      const age = Math.round((newest - Date.parse(minute.endedAt)) / 60_000);
      const slot = minutes[CI_WAIT_MINUTES - 1 - age];
      if (!slot) continue;
      for (const [bucket, jobs] of minute.jobs) {
        slot[bucket] = (slot[bucket] ?? 0) + jobs;
        total[bucket] = (total[bucket] ?? 0) + jobs;
      }
    }
  }
  const p50 = (perBucket: number[]) =>
    histogramQuantile(0.5, bounds, cumulative(perBucket));
  const p50Seconds = p50(total);
  return {
    ...(p50Seconds === undefined ? {} : { p50Seconds }),
    jobs: total.reduce((sum, jobs) => sum + jobs, 0),
    coveredMinutes,
    series: minutes.map(p50),
    partial:
      windows.length !== lanes.length ||
      same.length !== windows.length ||
      Math.max(...starts) - Math.min(...starts) > 60_000,
  };
}

function cumulative(perBucket: readonly number[]): number[] {
  let sum = 0;
  return perBucket.map((jobs) => (sum += jobs));
}
