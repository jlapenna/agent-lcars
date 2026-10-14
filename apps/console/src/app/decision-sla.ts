/**
 * How long a decision may wait on the maintainer before the console flags
 * it. design/fleet-console.html marks decisions waiting 2h 20m and 3h 12m
 * "over SLA" and leaves 1h 05m unmarked; two hours is the boundary that
 * mockup draws. One constant so the Bridge and Inbox cannot disagree.
 */
export const DECISION_SLA_MS = 2 * 60 * 60 * 1000;

/** Whether a decision waiting since `waitingSince` has passed the SLA. */
export function isOverDecisionSla(
  waitingSince: string,
  nowMs: number,
): boolean {
  const since = Date.parse(waitingSince);
  return Number.isFinite(since) && nowMs - since > DECISION_SLA_MS;
}

export interface DecisionSlaSummary {
  overSla: number;
  /** The longest-waiting decision's timestamp, when any decision waits. */
  oldest?: string;
}

/** The panel header's `N over SLA · oldest X` across every decision. */
export function decisionSlaSummary(
  waitingSince: readonly string[],
  nowMs: number,
): DecisionSlaSummary {
  let overSla = 0;
  let oldest: string | undefined;
  for (const iso of waitingSince) {
    if (isOverDecisionSla(iso, nowMs)) overSla += 1;
    if (!oldest || Date.parse(iso) < Date.parse(oldest)) oldest = iso;
  }
  return { overSla, oldest };
}
