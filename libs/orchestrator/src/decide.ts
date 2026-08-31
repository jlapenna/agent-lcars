import {
  isLive,
  isWorkAnchor,
  type OutboxEntry,
  type RequestSource,
  type Run,
  type RunResult,
  type Task,
  type TaskId,
  taskKey,
  type WorkPayload,
} from './model';

/**
 * Pure decision logic. Given current state and one input, produce the next
 * state and any effects — no I/O, no clock reads, no randomness. Storage
 * applies a decision atomically or not at all.
 *
 * Every function here either returns a `Decision` or a `Refusal`. A refusal
 * is a normal outcome, not an error: "this task is already being worked" is
 * the orchestrator doing its one job.
 */

export interface Decision {
  readonly task: Task;
  /** Absent only for decisions that touch the task alone (`closeTask`). */
  readonly run?: Run;
  readonly outbox: readonly OutboxEntry[];
}

export interface Refusal {
  readonly refused: true;
  readonly reason:
    | 'task-busy' // a live run holds the lock
    | 'duplicate-request' // same requestId as an existing run: return it
    | 'unknown-run'
    | 'run-not-live' // report/cancel/renew against a settled run
    | 'stale-lease' // renew/report from a run that already lost the lock
    | 'task-closed' // closeTask set closedAt; no further runs
    | 'unknown-task' // close on a task that was never created
    | 'not-native'; // closeTask on a GitHub anchor: closedAt is native-only
  /** For `duplicate-request`, the run the request already maps to. */
  readonly existingRun?: Run;
}

export function refused(reason: Refusal['reason'], existingRun?: Run): Refusal {
  return existingRun === undefined
    ? { refused: true, reason }
    : { refused: true, reason, existingRun };
}

export function isRefusal(value: Decision | Refusal): value is Refusal {
  return 'refused' in value;
}

/** For decisions that always carry a run; throws if the invariant breaks. */
export function decidedRun(decision: Decision): Run {
  if (decision.run === undefined) {
    throw new Error('decision unexpectedly carries no run');
  }
  return decision.run;
}

const LEASE_MS = 2 * 60 * 60 * 1_000;

function lease(now: string): string {
  return new Date(Date.parse(now) + LEASE_MS).toISOString();
}

/** A task whose runs go `lost` this many times in a row stops auto-retrying
 *  and parks instead -- see `expireLease` (which bumps the counter) and
 *  `Orchestrator.sweepExpired` (which reads it to decide whether to
 *  retry). A task's total attempts before parking is `MAX_AUTO_RETRIES + 1`
 *  (the original request plus this many retries). */
export const MAX_AUTO_RETRIES = 2;

export interface RequestRunInput {
  now: string;
  task: Task | undefined;
  taskId: TaskId;
  activeRun: Run | undefined;
  requestId: string;
  requestSource?: RequestSource;
  pipeline: string;
  params?: Record<string, string>;
  work?: WorkPayload;
}

/**
 * A request to work a task.
 *
 * - No live run → start one, take the lock, enqueue its dispatch.
 * - Same requestId as the task's live run → that run, idempotently.
 * - Any other live run → refused: the lock is held.
 */
export function requestRun(input: RequestRunInput): Decision | Refusal {
  const { now, taskId, activeRun, requestId } = input;
  if (activeRun !== undefined && isLive(activeRun.state)) {
    if (activeRun.requestId === requestId) {
      return refused('duplicate-request', activeRun);
    }
    return refused('task-busy', activeRun);
  }
  if (input.task?.closedAt !== undefined) {
    return refused('task-closed');
  }
  const baseTask: Task = {
    task: taskId,
    runCount: input.task?.runCount ?? 0,
    // Carried over, not reset: only a `finished`/`canceled` report resets
    // the auto-retry streak (see `resetConsecutiveLost`). A request -- manual
    // or the auto-retry itself -- must not accidentally clear the budget
    // `expireLease` just spent computing.
    ...(input.task?.consecutiveLost === undefined
      ? {}
      : { consecutiveLost: input.task.consecutiveLost }),
    // Written once: only the request that creates the task may set `work`.
    ...(input.task?.work !== undefined
      ? { work: input.task.work }
      : input.work !== undefined
        ? { work: input.work }
        : {}),
    updatedAt: now,
  };
  return mintRun({
    now,
    taskId,
    task: baseTask,
    requestId,
    requestSource: input.requestSource,
    pipeline: input.pipeline,
    params: input.params,
  });
}

/** Starts a fresh run for a task that has no live run and takes the lock. */
function mintRun(input: {
  now: string;
  taskId: TaskId;
  task: Task;
  requestId: string;
  requestSource?: RequestSource;
  pipeline: string;
  params?: Record<string, string>;
}): Decision {
  const { now, taskId, task, requestId, requestSource, pipeline, params } =
    input;
  const runCount = task.runCount + 1;
  const runId = `${taskKey(taskId)}/r${runCount}`;
  const run: Run = {
    runId,
    task: taskId,
    state: 'pending',
    pipeline,
    requestId,
    ...(requestSource === undefined ? {} : { requestSource }),
    ...(params === undefined ? {} : { params }),
    leaseExpiresAt: lease(now),
    events: [{ at: now, to: 'pending', by: 'request' }],
    createdAt: now,
    updatedAt: now,
  };
  return {
    task: { ...task, activeRunId: runId, runCount, updatedAt: now },
    run,
    outbox: [
      {
        entryId: `dispatch/${runId}`,
        kind: 'dispatch-run',
        task: taskId,
        runId,
        state: 'pending',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

/** Dispatch confirmed: the run exists in the outside world. */
export function confirmDispatch(input: {
  now: string;
  task: Task;
  run: Run;
}): Decision | Refusal {
  const { now, task, run } = input;
  if (run.state === 'running') return { task, run, outbox: [] }; // idempotent
  if (run.state !== 'pending') return refused('run-not-live');
  if (task.activeRunId !== run.runId) return refused('stale-lease');
  return {
    task: { ...task, updatedAt: now },
    run: {
      ...run,
      state: 'running',
      leaseExpiresAt: lease(now),
      events: [...run.events, { at: now, to: 'running', by: 'dispatch' }],
      updatedAt: now,
    },
    outbox: [],
  };
}

/** A live run extends its lease by showing up. */
export function renewLease(input: {
  now: string;
  task: Task;
  run: Run;
}): Decision | Refusal {
  const { now, task, run } = input;
  if (!isLive(run.state)) return refused('run-not-live');
  if (task.activeRunId !== run.runId) return refused('stale-lease');
  return {
    task,
    run: { ...run, leaseExpiresAt: lease(now), updatedAt: now },
    outbox: [],
  };
}

/**
 * The run reports its result. The result is recorded verbatim; the lock is
 * released; reporting onward is an outbox effect. A report from a run that
 * already lost the lock is refused — its successor may be live, and a stale
 * run does not get to overwrite the present.
 */
export function reportResult(input: {
  now: string;
  task: Task;
  run: Run;
  result: RunResult;
}): Decision | Refusal {
  const { now, task, run, result } = input;
  if (run.state === 'finished') return refused('run-not-live', run);
  if (!isLive(run.state)) return refused('run-not-live');
  if (task.activeRunId !== run.runId) return refused('stale-lease');
  const settled: Run = {
    ...run,
    state: 'finished',
    result,
    events: [...run.events, { at: now, to: 'finished', by: 'report' }],
    updatedAt: now,
  };
  return settle(
    resetConsecutiveLost(releaseLock(task, run.runId, now)),
    settled,
    now,
  );
}

/** An operator stops a run and releases the lock; reports onward. */
export function cancelRun(input: {
  now: string;
  task: Task;
  run: Run;
  note?: string;
}): Decision | Refusal {
  const { now, task, run } = input;
  if (!isLive(run.state)) return refused('run-not-live');
  const settled: Run = {
    ...run,
    state: 'canceled',
    events: [
      ...run.events,
      {
        at: now,
        to: 'canceled',
        by: 'operator',
        ...(input.note === undefined ? {} : { note: input.note }),
      },
    ],
    updatedAt: now,
  };
  return settle(
    resetConsecutiveLost(releaseLock(task, run.runId, now)),
    settled,
    now,
  );
}

/**
 * A live run whose lease has expired is presumed lost. This is the only
 * judgement the orchestrator makes about execution, and its only meaning is
 * that the lock is released so the task is not wedged forever. This
 * function itself never starts a new run *for its own sake* -- a lost run
 * may have half-finished work behind it -- but it does bump the task's
 * `consecutiveLost` streak; `Orchestrator.sweepExpired` reads that back to
 * decide whether to auto-retry (bounded by `MAX_AUTO_RETRIES`) or leave the
 * task parked for a manual request.
 */
export function expireLease(input: {
  now: string;
  task: Task;
  run: Run;
}): Decision | Refusal {
  const { now, task, run } = input;
  if (!isLive(run.state)) return refused('run-not-live');
  if (Date.parse(run.leaseExpiresAt) > Date.parse(now)) {
    return refused('stale-lease'); // not actually expired
  }
  const settled: Run = {
    ...run,
    state: 'lost',
    events: [...run.events, { at: now, to: 'lost', by: 'expiry' }],
    updatedAt: now,
  };
  return settle(
    {
      ...releaseLock(task, run.runId, now),
      consecutiveLost: (task.consecutiveLost ?? 0) + 1,
    },
    settled,
    now,
  );
}

/**
 * Close a native task that has no live run: sets `closedAt`, after which
 * `requestRun` refuses it. The one piece of item state the orchestrator
 * stores on behalf of the work layer, kept here so it lives in the same
 * transaction discipline as everything else that touches a task.
 */
export function closeTask(input: {
  now: string;
  task: Task | undefined;
  activeRun: Run | undefined;
}): Decision | Refusal {
  const { now, task, activeRun } = input;
  if (task === undefined) return refused('unknown-task');
  if (!isWorkAnchor(task.task)) return refused('not-native');
  if (task.closedAt !== undefined) return refused('task-closed');
  if (activeRun !== undefined && isLive(activeRun.state)) {
    return refused('task-busy', activeRun);
  }
  return { task: { ...task, closedAt: now, updatedAt: now }, outbox: [] };
}

/** Shared tail of every settle path. */
function settle(releasedTask: Task, settledRun: Run, now: string): Decision {
  return {
    task: releasedTask,
    run: settledRun,
    outbox: [outcomeEntry(settledRun, now)],
  };
}

function releaseLock(task: Task, runId: string, now: string): Task {
  const { activeRunId, ...rest } = task;
  return activeRunId === runId
    ? { ...rest, updatedAt: now }
    : { ...task, updatedAt: now };
}

/** Drops `consecutiveLost` (equivalent to resetting the auto-retry budget
 *  to 0) after a run settles into a state where retrying makes no sense:
 *  `finished` or `canceled`. */
function resetConsecutiveLost(task: Task): Task {
  const { consecutiveLost, ...rest } = task;
  return rest;
}

function outcomeEntry(run: Run, now: string): OutboxEntry {
  return {
    entryId: `outcome/${run.runId}`,
    kind: 'report-outcome',
    task: run.task,
    runId: run.runId,
    state: 'pending',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
}
