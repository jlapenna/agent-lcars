/**
 * Histogram windows the runner autoscaler publishes on its runner-status
 * documents (apps/runner-autoscaler/histogram_window.go): 30 minutes of
 * per-minute bucket counts. CI wait p50 reads the ARC lanes' job-startup
 * windows; Work API p95 reads the executor's Work API latency window.
 */

/** Matches the autoscaler's window and the sparklines' 30 bars. */
export const HISTOGRAM_WINDOW_MINUTES = 30;

/** One source's window, projected small enough to stream: minutes with no
 * observation are dropped, and the rest keep only their nonzero buckets. */
export interface HistogramWindow {
  /** Finite bucket upper bounds in seconds, ascending. */
  bounds: number[];
  /** When the oldest interval began: under 30 minutes ago after the
   * autoscaler starts or the window resets. */
  startedAt: string;
  /** The newest interval's end, whether or not it observed anything. */
  endedAt: string;
  minutes: {
    endedAt: string;
    /** [bucket index, count] pairs; index `bounds.length` is `+Inf`. */
    jobs: [number, number][];
  }[];
}

/**
 * Projects an autoscaler histogram window (`jobStartup` on an ARC lane,
 * `workApiLatency` on the executor: cumulative counts per interval). Returns
 * undefined for anything malformed, so a bad field drops only its readout,
 * never the document's capacity.
 */
export function parseHistogramWindow(
  value: unknown,
): HistogramWindow | undefined {
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
    intervals.length > HISTOGRAM_WINDOW_MINUTES
  )
    return undefined;
  const minutes: HistogramWindow['minutes'] = [];
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

export interface WindowSummary {
  /** Undefined when the windows observed nothing. */
  quantile?: number;
  count: number;
  /** How much of the last 30 minutes the windows actually cover. */
  coveredMinutes: number;
  /** Oldest first, one per minute; undefined where nothing was observed. */
  series: (number | undefined)[];
  /** Some windows used another bucket layout, or cover a shorter span than
   * the others. */
  partial: boolean;
}

/**
 * Sums windows per minute and takes the `q` quantile of the total and of each
 * minute. Minutes are counted back from the newest interval any window
 * reports, not from the clock, so the server and client render the same
 * bars. Undefined when there is no window.
 */
export function summarizeWindows(
  windows: readonly HistogramWindow[],
  q: number,
): WindowSummary | undefined {
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
    HISTOGRAM_WINDOW_MINUTES,
    Math.max(1, Math.round((newest - Math.min(...starts)) / 60_000)),
  );
  const minutes = Array.from({ length: HISTOGRAM_WINDOW_MINUTES }, () =>
    Array<number>(bounds.length + 1).fill(0),
  );
  const total = Array<number>(bounds.length + 1).fill(0);
  for (const window of same) {
    for (const minute of window.minutes) {
      // Nearest, not floor: sample jitter puts snapshots a little under or
      // over a minute apart, and each must keep its own bar.
      const age = Math.round((newest - Date.parse(minute.endedAt)) / 60_000);
      const slot = minutes[HISTOGRAM_WINDOW_MINUTES - 1 - age];
      if (!slot) continue;
      for (const [bucket, count] of minute.jobs) {
        slot[bucket] = (slot[bucket] ?? 0) + count;
        total[bucket] = (total[bucket] ?? 0) + count;
      }
    }
  }
  const at = (perBucket: number[]) =>
    histogramQuantile(q, bounds, cumulative(perBucket));
  const quantile = at(total);
  return {
    ...(quantile === undefined ? {} : { quantile }),
    count: total.reduce((sum, count) => sum + count, 0),
    coveredMinutes,
    series: minutes.map(at),
    partial:
      same.length !== windows.length ||
      Math.max(...starts) - Math.min(...starts) > 60_000,
  };
}

function cumulative(perBucket: readonly number[]): number[] {
  let sum = 0;
  return perBucket.map((count) => (sum += count));
}
