import {
  isLive,
  type OutboxEntry,
  type PendingRequest,
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
  /** A follow-up run minted atomically alongside `run`'s settlement, when
   *  the task's `pendingRequest` was consumed in this same decision (see
   *  `consumePendingRequest`). Absent otherwise -- most decisions never
   *  touch a second run. Kept as a distinct field rather than widening
   *  `run` to a list so every existing reader of `decision.run` (there are
   *  many) keeps meaning "the run this decision is about" without change. */
  readonly followUpRun?: Run;
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

export function isRefusal(
  value: Decision | Refusal | Queued,
): value is Refusal {
  return 'refused' in value;
}

/**
 * `requestRun`'s `queueIfBusy` outcome: the task's `pendingRequest` was set
 * (or replaced -- last-write-wins) but no run was started. Deliberately not
 * a `Decision`: unlike every other outcome in this module, there is no run
 * to report and nothing for the outbox to deliver yet, only a task write.
 * Modeling it as its own type -- rather than making `Decision.run`
 * optional -- means every *existing* consumer of `Decision` (there are
 * many, and none of them expect this outcome) keeps compiling and reading
 * exactly as before; only a caller that actually opts into `queueIfBusy`
 * needs to handle `Queued` at all (see `requestRun`'s and
 * `Orchestrator.request`'s overloads).
 */
export interface Queued {
  readonly queued: true;
  readonly task: Task;
}

export function isQueued(value: Decision | Refusal | Queued): value is Queued {
  return 'queued' in value && value.queued === true;
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
  pipeline: string;
  params?: Record<string, string>;
  /** When the task is busy, queue this request instead of refusing it: sets
   *  (or replaces -- last-write-wins) the task's `pendingRequest`, later
   *  consumed by whichever settle path next releases the lock. Same-
   *  requestId dedup against the *live* run still takes priority over
   *  queueing -- a retried delivery of the request already running maps
   *  back to that run, exactly as when this flag is absent. Default
   *  false/absent: unchanged behavior -- busy is refused, never queued. */
  queueIfBusy?: boolean;
}

/**
 * A request to work a task.
 *
 * - No live run → start one, take the lock, enqueue its dispatch.
 * - Same requestId as the task's live run → that run, idempotently.
 * - Any other live run, `queueIfBusy` unset/false → refused: the lock is
 *   held (unchanged v1 behavior).
 * - Any other live run, `queueIfBusy: true` → queued: see `Queued`.
 *
 * Three overloads pin the return type to what each caller can actually get
 * back: omitting `queueIfBusy` (or passing `false`) keeps every existing
 * caller's `Decision | Refusal` exactly as before, so none of them need to
 * learn about `Queued`; passing the literal `true` adds `Queued` to the
 * type; the general (non-literal `boolean`) fallback exists only so
 * `Orchestrator.request`'s own pass-through overloads can forward a runtime
 * flag value without losing type safety.
 */
export function requestRun(
  input: RequestRunInput & { queueIfBusy?: false },
): Decision | Refusal;
export function requestRun(
  input: RequestRunInput & { queueIfBusy: true },
): Decision | Refusal | Queued;
export function requestRun(input: RequestRunInput): Decision | Refusal | Queued;
export function requestRun(
  input: RequestRunInput,
): Decision | Refusal | Queued {
  const { now, taskId, activeRun, requestId } = input;
  if (activeRun !== undefined && isLive(activeRun.state)) {
    if (activeRun.requestId === requestId) {
      return refused('duplicate-request', activeRun);
    }
    if (input.queueIfBusy === true) {
      return queueRequest(input);
    }
    return refused('task-busy', activeRun);
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
    updatedAt: now,
  };
  return mintRun({
    now,
    taskId,
    task: baseTask,
    requestId,
    pipeline: input.pipeline,
    params: input.params,
  });
}

/** `requestRun`'s `queueIfBusy` outcome: last-write-wins over any request
 *  already queued (a later `queueIfBusy` request simply overwrites the
 *  field, it never accumulates a queue of queues). */
function queueRequest(input: RequestRunInput): Queued {
  const { now, taskId, requestId } = input;
  const baseTask: Task = input.task ?? {
    task: taskId,
    runCount: 0,
    updatedAt: now,
  };
  return {
    queued: true,
    task: {
      ...baseTask,
      pendingRequest: {
        requestId,
        pipeline: input.pipeline,
        ...(input.params === undefined ? {} : { params: input.params }),
      },
      updatedAt: now,
    },
  };
}

/** Starts a fresh run for `task` (already known free -- no live run, no
 *  stale `activeRunId`) and takes the lock. Shared by `requestRun`'s
 *  free-task path and `consumePendingRequest`'s settle-path minting, so a
 *  queued request's follow-up run is built exactly like a normal one. */
function mintRun(input: {
  now: string;
  taskId: TaskId;
  task: Task;
  requestId: string;
  pipeline: string;
  params?: Record<string, string>;
}): Decision {
  const { now, taskId, task, requestId, pipeline, params } = input;
  const runCount = task.runCount + 1;
  const runId = `${taskKey(taskId)}/r${runCount}`;
  const run: Run = {
    runId,
    task: taskId,
    state: 'pending',
    pipeline,
    requestId,
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

/**
 * After a settle path (`reportResult`, `cancelRun`, `expireLease`) releases
 * a task's lock, consume its `pendingRequest` (if any) into a follow-up run
 * -- minted in the SAME decision, so the task update, the new run, and its
 * dispatch outbox entry all commit atomically with the settlement. Clears
 * `pendingRequest` either way (there's nothing left to consume once this
 * runs). Returns the (possibly unchanged) task plus the follow-up run/
 * outbox to merge into the caller's `Decision`.
 *
 * Interaction with auto-retry: `expireLease` bumps `consecutiveLost` and
 * releases the lock, but never itself starts a new run -- `Orchestrator
 * .sweepExpired` does, via its own `request()` call with a deterministic
 * `retry:<lostRunId>` requestId. When `expireLease` consumes a
 * `pendingRequest` here, the follow-up run it mints takes the lock
 * immediately, in the same decision as the loss. `sweepExpired`'s
 * subsequent auto-retry request then finds the task already busy (a
 * *different* requestId than its own) and is refused `task-busy`, same as
 * any other request racing a live run -- no special-casing needed. A
 * human/system's queued request wins over an auto-retry, on purpose: it
 * asked for specific new work, where the auto-retry is just the
 * orchestrator's own best guess at "try again."
 */
function consumePendingRequest(
  task: Task,
  now: string,
): { task: Task; followUpRun?: Run; followUpOutbox: OutboxEntry[] } {
  const pending: PendingRequest | undefined = task.pendingRequest;
  if (pending === undefined) return { task, followUpOutbox: [] };
  const { pendingRequest, ...withoutPending } = task;
  const minted = mintRun({
    now,
    taskId: task.task,
    task: withoutPending,
    requestId: pending.requestId,
    pipeline: pending.pipeline,
    params: pending.params,
  });
  return {
    task: minted.task,
    followUpRun: minted.run,
    followUpOutbox: [...minted.outbox],
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
 * run does not get to overwrite the present. If the task has a
 * `pendingRequest`, it is consumed here -- see `consumePendingRequest`.
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
  return settleWithFollowUp(
    resetConsecutiveLost(releaseLock(task, run.runId, now)),
    settled,
    now,
  );
}

/** An operator stops a run. Releases the lock; reports onward. If the task
 *  has a `pendingRequest`, it is consumed here -- see
 *  `consumePendingRequest`. */
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
  return settleWithFollowUp(
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
 *
 * If the task has a `pendingRequest`, though, it *is* consumed here, same as
 * the other settle paths (see `consumePendingRequest`) -- and that follow-up
 * run takes precedence over `sweepExpired`'s own auto-retry, which finds the
 * task already busy and is refused. See `consumePendingRequest`'s doc
 * comment for why that's the intended precedence.
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
  return settleWithFollowUp(
    {
      ...releaseLock(task, run.runId, now),
      consecutiveLost: (task.consecutiveLost ?? 0) + 1,
    },
    settled,
    now,
  );
}

/** Shared tail of every settle path: fold `consumePendingRequest`'s
 *  possible follow-up run/outbox entry into the settled run's own
 *  `Decision`. */
function settleWithFollowUp(
  releasedTask: Task,
  settledRun: Run,
  now: string,
): Decision {
  const { task, followUpRun, followUpOutbox } = consumePendingRequest(
    releasedTask,
    now,
  );
  return {
    task,
    run: settledRun,
    ...(followUpRun === undefined ? {} : { followUpRun }),
    outbox: [outcomeEntry(settledRun, now), ...followUpOutbox],
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
