/**
 * CI wait p50: the fleet's job-startup latency (job assigned to a runner until
 * that runner starts it) over the last 30 minutes. The source is each ARC
 * listener's `gha_job_startup_duration_seconds` histogram, which the
 * autoscaler windows per lane (apps/runner-autoscaler/arc_job_startup.go).
 */
import {
  HISTOGRAM_WINDOW_MINUTES,
  type HistogramWindow,
  summarizeWindows,
} from './histogram-window';

export const CI_WAIT_MINUTES = HISTOGRAM_WINDOW_MINUTES;

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

/** Sums the lanes' windows per minute; undefined when no lane has one. */
export function fleetCiWait(
  lanes: readonly { jobStartup?: HistogramWindow }[],
): CiWait | undefined {
  const windows = lanes
    .map((lane) => lane.jobStartup)
    .filter((window): window is HistogramWindow => window !== undefined);
  const summary = summarizeWindows(windows, 0.5);
  if (!summary) return undefined;
  return {
    ...(summary.quantile === undefined ? {} : { p50Seconds: summary.quantile }),
    jobs: summary.count,
    coveredMinutes: summary.coveredMinutes,
    series: summary.series,
    partial: summary.partial || windows.length !== lanes.length,
  };
}
