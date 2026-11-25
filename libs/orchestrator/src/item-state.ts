import { isEffectfulRun, MAX_AUTO_RETRIES, maxAutoRetries } from './decide';
import {
  deliveryWaiting,
  isLive,
  type Run,
  type Task,
  type TaskDerived,
} from './model';

export type ItemState = 'running' | 'done' | 'parked' | 'failed' | 'canceled';

type RunOrder = Pick<Run, 'runId' | 'createdAt'>;

export function compareRunOrder(a: RunOrder, b: RunOrder): number {
  return (
    a.createdAt.localeCompare(b.createdAt) ||
    a.runId.localeCompare(b.runId, undefined, { numeric: true })
  );
}

/** Newest run first: createdAt descending, numeric run generation as a tiebreak.
 * Full Runs and public run views use the same ordering. */
export function latestRun<T extends RunOrder>(
  runs: readonly T[],
): T | undefined {
  return [...runs].sort((a, b) => compareRunOrder(b, a))[0];
}

/**
 * A task's item state, read off the task and its latest run. First match
 * wins, in the order the design spec's table lists them. The orchestrator
 * store also stores it with the task (`taskDerivedFrom`, #3566) so readers
 * can query by it; the store contract checks the stored copy never drifts.
 */
export function deriveItemState(
  task: Pick<
    Task,
    'closedAt' | 'consecutiveLost' | 'delivery' | 'desiredRevision'
  >,
  runs: readonly Run[],
): ItemState {
  const latest = latestRun(runs);
  if (task.closedAt !== undefined || latest?.state === 'canceled')
    return 'canceled';
  if (deliveryWaiting(task) && latest?.state !== 'lost') {
    if (latest?.state === 'finished' && latest.result?.ok === false)
      return 'failed';
    if (latest?.state === 'finished' && latest.result?.summary === 'park')
      return 'parked';
    return 'running';
  }
  if (latest === undefined) return 'running';
  if (isLive(latest.state)) return 'running';
  if (latest.triagePublication?.state === 'complete') return 'done';
  if (latest.sourceRevision !== undefined && task.desiredRevision === undefined)
    return 'canceled';
  if (latest.triagePublication?.state === 'pending') return 'running';
  if (latest.triagePublication?.state === 'failed') return 'failed';
  if (latest.triagePublication?.state === 'superseded') return 'canceled';
  if (
    task.delivery?.state === 'complete' &&
    task.delivery.runId === latest.runId
  )
    return 'done';
  if (latest.state === 'finished') {
    // Only an explicit park is a human handoff. Missing deliverables and
    // execution failures need diagnosis, not a fabricated human decision.
    if (latest.result?.summary === 'park') return 'parked';
    return latest.result?.ok ? 'done' : 'failed';
  }
  // lost: the sweep retries until the budget is spent, then leaves it.
  const retryBudget = maxAutoRetries(latest);
  if (isEffectfulRun(latest) && retryBudget === 0) return 'failed';
  return task.consecutiveLost > retryBudget ||
    (latest.sourceRevision !== undefined &&
      (latest.revisionAttempt ?? 1) > MAX_AUTO_RETRIES)
    ? 'failed'
    : 'running';
}

/** The item state stored with a task document (#3566): written in the same
 * transaction as the task and runs it derives from. */
export function taskDerivedFrom(
  task: Pick<
    Task,
    'closedAt' | 'consecutiveLost' | 'delivery' | 'desiredRevision'
  >,
  runs: readonly Run[],
): TaskDerived {
  const latest = latestRun(runs);
  return {
    state: deriveItemState(task, runs),
    ...(latest === undefined ? {} : { latestRunId: latest.runId }),
    event: runs.some((run) => run.sourceRevision !== undefined),
  };
}
