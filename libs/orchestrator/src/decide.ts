import {
  isLive,
  isWorkAnchor,
  type OutboxEntry,
  requestHistoryKey,
  type RequestSource,
  type Run,
  runRecoveryDeadline,
  runRequestHistoryKey,
  type RunResult,
  startDeadlineElapsed,
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
  /** Additional runs committed in the same transaction. Lease expiry uses
   * this for its successor so a crash cannot separate loss settlement from
   * retry creation. */
  readonly additionalRuns?: readonly Run[];
  readonly outbox: readonly OutboxEntry[];
}

export interface Refusal {
  readonly refused: true;
  readonly reason:
    | 'task-busy' // a live run holds the lock
    | 'duplicate-request' // same requestId as an existing run: return it
    | 'unknown-run'
    | 'run-already-claimed' // guarded cancellation cannot stop active work
    | 'run-newer-than-cutoff' // stale lifecycle event cannot stop newer work
    | 'run-not-live' // report/cancel/renew against a settled run
    | 'stale-lease' // renew/report from a run that already lost the lock
    | 'task-closed' // closeTask set closedAt; no further runs
    | 'missing-work' // strict Task documents always carry the Work payload
    | 'work-spec-mismatch' // caller's immutable Work validation rejected it
    | 'unknown-task' // close on a task that was never created
    | 'not-native' // closeTask on a GitHub anchor: closedAt is native-only
    | 'credential-operation-pending' // external CAS must be resolved before replacement
    | 'not-claimant'; // exit report from a principal/runner that did not claim the run
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

/** Fifteen minutes includes placement, image pull, bootstrap, and the
 * worker's five-minute initial heartbeat interval. Maintenance runs every
 * five minutes, so an unstarted claim normally settles within twenty. */
export const RUN_START_TIMEOUT_MS = 15 * 60_000;

export function runStartDeadlineAt(now: string): string {
  return new Date(Date.parse(now) + RUN_START_TIMEOUT_MS).toISOString();
}

export const RUN_LEASE_MS = 2 * 60 * 60 * 1_000;

export function runLeaseExpiresAt(now: string): string {
  return new Date(Date.parse(now) + RUN_LEASE_MS).toISOString();
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
 * - Same request source/id as the task's live run → that run, idempotently.
 * - Any other live run → refused: the lock is held.
 */
export function requestRun(input: RequestRunInput): Decision | Refusal {
  const { now, taskId, activeRun, requestId } = input;
  if (activeRun !== undefined && isLive(activeRun.state)) {
    if (
      runRequestHistoryKey(activeRun) ===
      requestHistoryKey(input.requestSource ?? 'caller', requestId)
    ) {
      return refused('duplicate-request', activeRun);
    }
    return refused('task-busy', activeRun);
  }
  if (input.task?.closedAt !== undefined) {
    return refused('task-closed');
  }
  const work = input.task?.work ?? input.work;
  if (work === undefined) return refused('missing-work');
  const baseTask: Task = {
    task: taskId,
    runCount: input.task?.runCount ?? 0,
    // Carried over, not reset: only a `finished`/`canceled` report resets
    // the auto-retry streak (see `resetConsecutiveLost`). A request -- manual
    // or the auto-retry itself -- must not accidentally clear the budget
    // `expireLease` just spent computing.
    consecutiveLost: input.task?.consecutiveLost ?? 0,
    // Written once: only the request that creates the task may set `work`.
    work,
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
    requestSource: requestSource ?? 'caller',
    ...(params === undefined ? {} : { params }),
    leaseExpiresAt: runLeaseExpiresAt(now),
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
      leaseExpiresAt: runLeaseExpiresAt(now),
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
  /** Existing authenticated queue token hash; omitted only by internal operations. */
  claimFingerprint?: string;
}): Decision | Refusal {
  const { now, task, run } = input;
  if (
    input.claimFingerprint !== undefined &&
    (run.queue?.state !== 'claimed' ||
      run.queue.tokenHash !== input.claimFingerprint)
  )
    return refused('not-claimant');
  if (!isLive(run.state)) return refused('run-not-live');
  if (task.activeRunId !== run.runId) return refused('stale-lease');
  if (startDeadlineElapsed(run, now)) return refused('stale-lease');
  // Token-authenticated callbacks must retain their live deadline through
  // commit as well as the fingerprint; internal server operations keep their
  // existing lease policy.
  if (
    input.claimFingerprint !== undefined &&
    Date.parse(runRecoveryDeadline(run) ?? run.leaseExpiresAt) <=
      Date.parse(now)
  )
    return refused('stale-lease');
  return {
    task,
    run: {
      ...run,
      ...(run.queue?.state === 'claimed' &&
      run.queue.firstHeartbeatAt === undefined
        ? { queue: { ...run.queue, firstHeartbeatAt: now } }
        : {}),
      leaseExpiresAt: runLeaseExpiresAt(now),
      updatedAt: now,
    },
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
  /** Existing authenticated queue token hash; omitted only by internal operations. */
  claimFingerprint?: string;
  result: RunResult;
}): Decision | Refusal {
  const { now, task, run, result } = input;
  if (
    input.claimFingerprint !== undefined &&
    (run.queue?.state !== 'claimed' ||
      run.queue.tokenHash !== input.claimFingerprint)
  )
    return refused('not-claimant');
  if (run.state === 'finished') return refused('run-not-live', run);
  if (!isLive(run.state)) {
    return refused(
      'run-not-live',
      input.claimFingerprint === undefined ? undefined : run,
    );
  }
  if (task.activeRunId !== run.runId) return refused('stale-lease');
  const pending = run.credentialPendingResult;
  if (
    pending !== undefined &&
    (pending.claimFingerprint !== run.queue?.tokenHash ||
      (['ok', 'summary', 'ref', 'message'] as const).some(
        (key) => pending.result[key] !== result[key],
      ) ||
      JSON.stringify(pending.result.relatedRefs) !==
        JSON.stringify(result.relatedRefs))
  )
    return refused('credential-operation-pending');
  const admittedAt = pending?.requestedAt ?? now;
  if (startDeadlineElapsed(run, admittedAt)) return refused('stale-lease');
  // Token-authenticated callbacks must retain their live deadline through
  // commit as well as the fingerprint; internal server operations keep their
  // existing lease policy.
  if (
    input.claimFingerprint !== undefined &&
    Date.parse(runRecoveryDeadline(run) ?? run.leaseExpiresAt) <=
      Date.parse(admittedAt)
  )
    return refused('stale-lease');
  if (run.credentialOperation !== undefined) {
    if (run.queue?.tokenHash === undefined) return refused('not-claimant');
    return {
      task,
      run: {
        ...run,
        credentialPendingResult: pending ?? {
          claimFingerprint: run.queue.tokenHash,
          requestedAt: now,
          result,
        },
        updatedAt: now,
      },
      outbox: [],
    };
  }
  const { credentialPendingResult: _pending, ...withoutPending } = run;
  const settled: Run = {
    ...withoutPending,
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
  if (run.credentialOperation !== undefined)
    return refused('credential-operation-pending');
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
  const { now, run } = input;
  if (!isLive(run.state)) return refused('run-not-live');
  // QueueExecutor capacity waits are not execution attempts. A queued run
  // may wait past its original request lease without consuming the task's
  // lost-run retry budget; the atomic claim refreshes the execution lease.
  const deadline = runRecoveryDeadline(run);
  if (deadline === undefined || Date.parse(deadline) > Date.parse(now)) {
    return refused('stale-lease'); // not actually expired
  }
  if (input.task.activeRunId !== run.runId) return refused('stale-lease');
  if (input.run.credentialOperation !== undefined)
    return refused('credential-operation-pending');
  return settleLost(input, 'expiry');
}

/** Who is reporting an exit: the authenticated principal's subject and the
 * runner name it claimed with. Both must equal what the claim recorded. */
export interface ExitClaimant {
  readonly subject: string;
  readonly runner: string;
  /** Original Job token hash; legacy reports can only observe terminal runs. */
  readonly claimFingerprint?: string;
}

/**
 * The QueueExecutor observed the claimed run's container or Job terminate
 * while the run was still live: the worker is gone without having reported
 * an outcome (a killed, evicted, out-of-memory, or deadline-exceeded
 * runner -- a runner that fails on its own reports `runner-failed` itself).
 * This is the same judgement lease expiry makes, delivered when the loss
 * happens instead of when the lease runs out.
 *
 * Only the executor that claimed the run may report its original fingerprint:
 * a pipeline grant
 * alone would let any executor kill another's healthy worker by settling
 * its run lost. Ownership is judged first, so even an already-settled run
 * answers its idempotent refusal only to its own claimant. A claim recorded
 * without an authenticated subject (written before subjects were recorded)
 * has no provable owner: while live, only its outcome report or lease
 * expiry settles it; once settled, any report gets the idempotent answer.
 */
export function executorExited(input: {
  now: string;
  task: Task;
  run: Run;
  claimant: ExitClaimant;
}): Decision | Refusal {
  const queue = input.run.queue;
  // A legacy claim (no recorded subject) that already settled changes
  // nothing whoever asks, so answer it idempotently: the executor that
  // claimed it before subjects were recorded stops retrying its report.
  if (
    queue?.state === 'claimed' &&
    queue.claimedBySubject === undefined &&
    !isLive(input.run.state)
  ) {
    return refused('run-not-live');
  }
  if (
    queue?.state !== 'claimed' ||
    queue.claimedBySubject === undefined ||
    queue.claimedBySubject !== input.claimant.subject ||
    queue.claimedBy !== input.claimant.runner ||
    (input.claimant.claimFingerprint !== undefined &&
      queue.tokenHash !== input.claimant.claimFingerprint) ||
    (isLive(input.run.state) && input.claimant.claimFingerprint === undefined)
  ) {
    return refused('not-claimant');
  }
  if (!isLive(input.run.state)) return refused('run-not-live');
  if (input.task.activeRunId !== input.run.runId) return refused('stale-lease');
  if (input.run.credentialOperation !== undefined)
    return refused('credential-operation-pending');
  return settleLost(input, 'executor');
}

function settleLost(
  input: { now: string; task: Task; run: Run },
  by: 'expiry' | 'executor',
): Decision {
  const { now, task, run } = input;
  const settled: Run = {
    ...run,
    state: 'lost',
    events: [
      ...run.events,
      {
        at: now,
        to: 'lost',
        by,
        ...(by === 'expiry' && startDeadlineElapsed(run, now)
          ? { note: 'first heartbeat deadline exceeded' }
          : {}),
      },
    ],
    updatedAt: now,
  };
  return settle(
    {
      ...releaseLock(task, run.runId, now),
      consecutiveLost: task.consecutiveLost + 1,
    },
    settled,
    now,
  );
}

/** Settle a lost run and, while budget remains, mint its deterministic
 * successor. Both runs and both outbox effects are one Decision, hence one
 * store transaction. */
function settleLostAndRetry(
  input: { now: string },
  lost: Decision | Refusal,
): Decision | Refusal {
  if (isRefusal(lost) || lost.task.consecutiveLost > MAX_AUTO_RETRIES) {
    return lost;
  }
  const lostRun = decidedRun(lost);
  const retry = mintRun({
    now: input.now,
    taskId: lostRun.task,
    task: lost.task,
    requestId: `retry:${lostRun.runId}`,
    requestSource: 'auto-retry',
    pipeline: lostRun.pipeline,
    ...(lostRun.params === undefined ? {} : { params: lostRun.params }),
  });
  return {
    task: retry.task,
    run: lostRun,
    additionalRuns: [decidedRun(retry)],
    outbox: [...lost.outbox, ...retry.outbox],
  };
}

/** `executorExited`, then the same bounded auto-retry lease expiry uses. */
export function executorExitedAndRetry(input: {
  now: string;
  task: Task;
  run: Run;
  claimant: ExitClaimant;
}): Decision | Refusal {
  return settleLostAndRetry(input, executorExited(input));
}

/** Atomically settle an expired run and, while budget remains, mint its
 * deterministic successor. Both runs and both outbox effects are one
 * Decision, hence one store transaction. */
export function expireLeaseAndRetry(input: {
  now: string;
  task: Task;
  run: Run;
}): Decision | Refusal {
  return settleLostAndRetry(input, expireLease(input));
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

/**
 * Replaces a native task's `work` payload while no run is live. The payload
 * is otherwise written once at creation; this is the single sanctioned
 * rewrite, used by the work layer's item edit. A live run already carries the
 * payload it was dispatched with, so editing under it would let the item
 * disagree with the work in flight.
 */
export function updateTaskWork(input: {
  now: string;
  task: Task | undefined;
  activeRun: Run | undefined;
  work: Task['work'];
}): Decision | Refusal {
  const { now, task, activeRun, work } = input;
  if (task === undefined) return refused('unknown-task');
  if (!isWorkAnchor(task.task)) return refused('not-native');
  if (activeRun !== undefined && isLive(activeRun.state)) {
    return refused('task-busy', activeRun);
  }
  return { task: { ...task, work, updatedAt: now }, outbox: [] };
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

/** Resets the auto-retry budget after a run settles into a state where
 * retrying makes no sense: `finished` or `canceled`. */
function resetConsecutiveLost(task: Task): Task {
  return { ...task, consecutiveLost: 0 };
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
