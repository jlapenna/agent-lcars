/** Conclusions that count as a failed check; `success`, `neutral` and
 * `skipped` pass. */
const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
  'stale',
]);

export interface CheckRunState {
  readonly id: number;
  /** The check's name; a re-run or a superseded workflow run reports the
   * same name again with a newer id. */
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

/** The newest run of each named check. GitHub lists every run on a commit,
 * including those of a workflow run that a newer one superseded and
 * cancelled, so counting them all reports failures the head no longer has. */
function latestPerCheck(runs: readonly CheckRunState[]): CheckRunState[] {
  const latest = new Map<string, CheckRunState>();
  for (const run of runs) {
    const seen = latest.get(run.name);
    if (seen === undefined || run.id > seen.id) latest.set(run.name, run);
  }
  return [...latest.values()];
}

/**
 * The `checks-finished` outcome for the latest run of each check on a head,
 * or undefined while any of them is still queued or running.
 */
export function finishedChecks(
  headSha: string,
  allRuns: readonly CheckRunState[],
): { id: string; detail: string } | undefined {
  const runs = latestPerCheck(allRuns);
  if (runs.length === 0) return undefined;
  if (runs.some((run) => run.status !== 'completed')) return undefined;
  const failed = runs.filter((run) =>
    FAILED_CONCLUSIONS.has(run.conclusion ?? ''),
  ).length;
  const newest = Math.max(...runs.map((run) => run.id));
  return {
    id: `github.checks.${headSha}.${newest}`,
    detail: failed === 0 ? 'all passed' : `${failed} failed`,
  };
}
