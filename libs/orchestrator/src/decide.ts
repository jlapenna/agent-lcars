import {
  isLive,
  type OutboxEntry,
  type Run,
  type RunResult,
  type Task,
  type TaskId,
  taskKey,
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
  readonly run: Run;
  readonly outbox: readonly OutboxEntry[];
}

export interface Refusal {
  readonly refused: true;
  readonly reason:
    | 'task-busy' // a live run holds the lock
    | 'duplicate-request' // same requestId as an existing run: return it
    | 'unknown-run'
    | 'run-not-live' // report/cancel/renew against a settled run
    | 'stale-lease'; // renew/report from a run that already lost the lock
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

const LEASE_MS = 30 * 60 * 1_000;

function lease(now: string): string {
  return new Date(Date.parse(now) + LEASE_MS).toISOString();
}

/**
 * A request to work a task.
 *
 * - No live run → start one, take the lock, enqueue its dispatch.
 * - Same requestId as the task's live run → that run, idempotently.
 * - Any other live run → refused: the lock is held.
 */
export function requestRun(input: {
  now: string;
  task: Task | undefined;
  taskId: TaskId;
  activeRun: Run | undefined;
  requestId: string;
  pipeline: string;
  params?: Record<string, string>;
}): Decision | Refusal {
  const { now, taskId, activeRun, requestId } = input;
  if (activeRun !== undefined && isLive(activeRun.state)) {
    if (activeRun.requestId === requestId) {
      return refused('duplicate-request', activeRun);
    }
    return refused('task-busy', activeRun);
  }
  const runCount = (input.task?.runCount ?? 0) + 1;
  const runId = `${taskKey(taskId)}/r${runCount}`;
  const run: Run = {
    runId,
    task: taskId,
    state: 'pending',
    pipeline: input.pipeline,
    requestId,
    ...(input.params === undefined ? {} : { params: input.params }),
    leaseExpiresAt: lease(now),
    events: [{ at: now, to: 'pending', by: 'request' }],
    createdAt: now,
    updatedAt: now,
  };
  const task: Task = {
    task: taskId,
    activeRunId: runId,
    runCount,
    updatedAt: now,
  };
  return {
    task,
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
  return {
    task: releaseLock(task, run.runId, now),
    run: settled,
    outbox: [outcomeEntry(settled, now)],
  };
}

/** An operator stops a run. Releases the lock; reports onward. */
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
  return {
    task: releaseLock(task, run.runId, now),
    run: settled,
    outbox: [outcomeEntry(settled, now)],
  };
}

/**
 * A live run whose lease has expired is presumed lost. This is the only
 * judgement the orchestrator makes about execution, and its only meaning is
 * that the lock is released so the task is not wedged forever. No new run is
 * started automatically: a lost run may have half-finished work behind it,
 * so the next run is a fresh, explicit request.
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
  return {
    task: releaseLock(task, run.runId, now),
    run: settled,
    outbox: [outcomeEntry(settled, now)],
  };
}

function releaseLock(task: Task, runId: string, now: string): Task {
  const { activeRunId, ...rest } = task;
  return activeRunId === runId
    ? { ...rest, updatedAt: now }
    : { ...task, updatedAt: now };
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
