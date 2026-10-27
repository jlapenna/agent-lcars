import {
  type DeliveryBinding,
  deliveryWaiting,
  isClaimant,
  isLive,
  isWorkAnchor,
  type OperationalIntervention,
  type OutboxEntry,
  type ProviderFallback,
  type ProviderFallbackRequest,
  type QueuePriority,
  queuePrioritySchema,
  recoveryDeadlineElapsed,
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
  type WorkAnchor,
  type WorkPayload,
  type WorkRevision,
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
    | 'pipeline-forbidden' // current authority does not grant the effective provider
    | 'stale-provider-request' // out-of-order or equal-clock label intent
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

/** Fifteen-minute observer/bootstrap budget. Negotiated placement observations
 * renew only while waiting; placement starts the finite worker bootstrap clock.
 * Legacy claims include scheduling in this budget. Maintenance runs every five
 * minutes, so an unobserved/unstarted claim normally settles within twenty. */
export const RUN_START_TIMEOUT_MS = 15 * 60_000;

export function runStartDeadlineAt(now: string): string {
  return new Date(Date.parse(now) + RUN_START_TIMEOUT_MS).toISOString();
}

export const RUN_LEASE_MS = 2 * 60 * 60 * 1_000;

export function runLeaseExpiresAt(now: string): string {
  return new Date(Date.parse(now) + RUN_LEASE_MS).toISOString();
}

/** Pure queued-to-claimed transition shared by the transactional stores and
 * receipt-backed capacity admission. Callers retain selection and persistence. */
export function claimQueuedRun(
  run: Run,
  input: {
    now: string;
    claimedBy: string;
    claimedBySubject?: string;
    tokenHash: string;
    placementAware?: boolean;
  },
): Run {
  return {
    ...run,
    leaseExpiresAt: runLeaseExpiresAt(input.now),
    updatedAt: input.now,
    queue: {
      state: 'claimed',
      claimedAt: input.now,
      startDeadlineAt: runStartDeadlineAt(input.now),
      ...(input.placementAware === true
        ? {
            startupPlacement: {
              state: 'waiting' as const,
              observedAt: input.now,
            },
          }
        : {}),
      claimedBy: input.claimedBy,
      ...(input.claimedBySubject === undefined
        ? {}
        : { claimedBySubject: input.claimedBySubject }),
      tokenHash: input.tokenHash,
    },
  };
}

/** A task whose runs go `lost` this many times in a row stops auto-retrying
 *  and parks instead -- see `expireLease` (which bumps the counter) and
 *  `Orchestrator.sweepExpired` (which reads it to decide whether to
 *  retry). A task's total attempts before parking is `MAX_AUTO_RETRIES + 1`
 *  (the original request plus this many retries). */
export const MAX_AUTO_RETRIES = 2;

/** How many times one task may be redispatched for a scheduler preemption that
 *  provably happened before any provider process was observed starting, since
 *  the last run that `finished` or was `canceled`. Separate from
 *  `MAX_AUTO_RETRIES` because such an attempt produced no provider effects:
 *  charging it to the execution budget converts an infrastructure disruption
 *  into permanent loss of useful work (#2520). The bound is what keeps a
 *  persistently unschedulable task from redispatching forever; past it a
 *  disruption is accounted as an ordinary loss and reaches an explicit
 *  terminal outcome. */
export const MAX_SCHEDULER_DISRUPTION_RECOVERIES = 2;

/** The executor's exact, provider-honest evidence that the claimed attempt was
 *  removed by the scheduler rather than by anything the workload did. Only the
 *  scheduler-preemption kind is recoverable: eviction, node loss, an OOM, or a
 *  bare "the pod is gone" stay on the ordinary terminal path.
 *
 *  `jobUid`/`podUid` are the Kubernetes UIDs of the exact Job and Pod this
 *  observation came from; `observedAt` is the moment the disruption condition
 *  was set on that Pod, never the moment the report was written. */
export interface SchedulerDisruptionEvidence {
  readonly kind: 'scheduler-preemption';
  readonly jobUid: string;
  readonly podUid: string;
  readonly observedAt: string;
}

export interface RequestRunInput {
  now: string;
  task: Task | undefined;
  taskId: TaskId;
  activeRun: Run | undefined;
  requestId: string;
  requestSource?: RequestSource;
  pipeline: string;
  priority?: QueuePriority;
  params?: Record<string, string>;
  intervention?: OperationalIntervention;
  work?: WorkPayload;
  providerFallback?: ProviderFallbackRequest | ProviderFallback;
  sourceRevision?: WorkRevision;
  revisionAttempt?: number;
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
  if (
    input.task !== undefined &&
    deliveryWaiting(input.task) &&
    !(
      input.params?.mode === 'reply' &&
      input.params.replyPrincipal !== undefined
    ) &&
    !(
      input.requestSource !== undefined &&
      input.requestSource !== 'caller' &&
      input.params?.deliveryPredecessor === input.task.delivery?.runId
    )
  )
    return refused('task-busy');
  const work = input.task?.work ?? input.work;
  if (work === undefined) return refused('missing-work');
  const baseTask: Task = {
    task: taskId,
    runCount: input.task?.runCount ?? 0,
    // Carried over, not reset: only a `finished`/`canceled` report resets
    // the auto-retry streak (see `resetLossBudgets`). A request -- manual
    // or the auto-retry itself -- must not accidentally clear the budget
    // `expireLease` just spent computing.
    consecutiveLost: input.task?.consecutiveLost ?? 0,
    // Carried over for the same reason: the disruption bound has to survive
    // a later operator request, or the pre-startup recovery path would be
    // unbounded for anyone willing to re-request.
    schedulerDisruptions: input.task?.schedulerDisruptions ?? 0,
    // Delivery correction/recovery retains logical ownership until a fresh
    // authenticated ready handoff replaces the binding.
    ...(input.task?.delivery === undefined
      ? {}
      : { delivery: input.task.delivery }),
    // Written once: only the request that creates the task may set `work`.
    work,
    ...(input.sourceRevision === undefined
      ? {}
      : {
          desiredRevision: input.sourceRevision,
          ...(input.sourceRevision.observedAt === undefined
            ? {}
            : { sourceObservedAt: input.sourceRevision.observedAt }),
        }),
    ...(input.task?.providerRouting === undefined
      ? {}
      : { providerRouting: input.task.providerRouting }),
    updatedAt: now,
  };
  return mintRun({
    now,
    taskId,
    task: baseTask,
    requestId,
    requestSource: input.requestSource,
    pipeline: input.pipeline,
    priority: input.priority,
    params: input.params,
    intervention: input.intervention,
    providerFallback: input.providerFallback,
    sourceRevision: input.sourceRevision,
    revisionAttempt: input.revisionAttempt,
  });
}

/** Coalesce source updates under the existing task mutex. An unclaimed
 * attempt can be superseded; an executing claim retains ownership until it
 * settles. Admission receipts in the store preserve even skipped revisions. */
export function requestRevisionRun(
  input: RequestRunInput & { sourceRevision: WorkRevision },
): Decision | Refusal {
  const { task, activeRun, sourceRevision, now } = input;
  if (task?.closedAt !== undefined) return refused('task-closed');
  if (task !== undefined && sourceRevision.observedAt !== undefined) {
    const older = Object.entries(task.sourceObservedAt ?? {}).some(
      ([source, observedAt]) =>
        (sourceRevision.observedAt?.[source] ?? '') < observedAt,
    );
    if (older) return { task, outbox: [] };
    if (
      JSON.stringify(task.desiredRevision?.input) ===
      JSON.stringify(sourceRevision.input)
    ) {
      if (
        JSON.stringify(task.sourceObservedAt) ===
        JSON.stringify(sourceRevision.observedAt)
      )
        return refused('duplicate-request');
      return {
        task: { ...task, sourceObservedAt: sourceRevision.observedAt },
        outbox: [],
      };
    }
    if (
      task.sourceObservedAt !== undefined &&
      !Object.entries(sourceRevision.observedAt).some(
        ([source, observedAt]) =>
          observedAt > (task.sourceObservedAt?.[source] ?? ''),
      )
    )
      return { task, outbox: [] };
  }
  if (
    task !== undefined &&
    activeRun !== undefined &&
    isLive(activeRun.state)
  ) {
    const desiredTask = {
      ...task,
      desiredRevision: sourceRevision,
      ...(sourceRevision.observedAt === undefined
        ? {}
        : { sourceObservedAt: sourceRevision.observedAt }),
      updatedAt: now,
    };
    if (activeRun.queue?.state === 'claimed')
      return { task: desiredTask, outbox: [] };
    const canceled = cancelRun({
      now,
      task: desiredTask,
      run: activeRun,
      note: 'Superseded by a newer source revision',
    });
    if (isRefusal(canceled)) return canceled;
    const next = requestRun({
      ...input,
      task: canceled.task,
      activeRun: undefined,
    });
    if (isRefusal(next)) return next;
    return {
      ...next,
      additionalRuns: [decidedRun(canceled)],
      outbox: [...canceled.outbox, ...next.outbox],
    };
  }
  return requestRun(input);
}

/** Ordered source ineligibility fences effects without abandoning a running
 * worker's claim or permanently closing the source's Work item. */
export function invalidateSourceRevision(input: {
  now: string;
  task: Task;
  run: Run;
  observedAt: Record<string, string>;
}): Decision | Refusal {
  const { now, task, run, observedAt } = input;
  if (run.runId !== `${taskKey(task.task)}/r${task.runCount}`)
    return refused('stale-lease');
  if (run.sourceRevision === undefined) return refused('work-spec-mismatch');
  if (
    Object.entries(task.sourceObservedAt ?? {}).some(
      ([source, at]) => (observedAt[source] ?? '') < at,
    ) ||
    !Object.entries(observedAt).some(
      ([source, at]) => at > (task.sourceObservedAt?.[source] ?? ''),
    )
  )
    return { task, outbox: [] };
  const { desiredRevision: _desired, ...rest } = task;
  const invalidated = { ...rest, sourceObservedAt: observedAt, updatedAt: now };
  // A claimed worker retains its logical/physical ownership until settlement.
  // Clearing desiredRevision already prevents it from publishing or retrying.
  if (isLive(run.state) && run.queue?.state !== 'claimed')
    return cancelRun({
      now,
      task: invalidated,
      run,
      note: 'Source is no longer eligible',
    });
  return {
    task: invalidated,
    ...(run.triagePublication?.state === 'pending'
      ? {
          run: {
            ...run,
            triagePublication: {
              ...run.triagePublication,
              state: 'superseded' as const,
            },
            updatedAt: now,
          },
        }
      : {}),
    outbox: [],
  };
}

/** Settlement and successor admission share a transaction. */
function advanceSourceRevision(decision: Decision, now: string): Decision {
  const run = decidedRun(decision);
  const desired = decision.task.desiredRevision;
  if (
    run.sourceRevision === undefined ||
    desired === undefined ||
    decision.task.closedAt !== undefined
  )
    return decision;
  const superseded = run.sourceRevision.key !== desired.key;
  const retry =
    !superseded &&
    run.state === 'finished' &&
    run.result?.ok === false &&
    (run.revisionAttempt ?? 1) <= MAX_AUTO_RETRIES;
  if (!superseded && !retry) return decision;
  const next = mintRun({
    now,
    taskId: run.task,
    task: resetLossBudgets(decision.task),
    requestId: superseded ? desired.key : `retry:${run.runId}`,
    requestSource: superseded ? 'caller' : 'auto-retry',
    pipeline: run.pipeline,
    priority: run.priority,
    params: run.params,
    sourceRevision: desired,
    revisionAttempt: superseded ? 1 : (run.revisionAttempt ?? 1) + 1,
  });
  return {
    ...decision,
    task: next.task,
    additionalRuns: [decidedRun(next)],
    outbox: [...decision.outbox, ...next.outbox],
  };
}

/** Starts a fresh run for a task that has no live run and takes the lock. */
function mintRun(input: {
  now: string;
  taskId: TaskId;
  task: Task;
  requestId: string;
  requestSource?: RequestSource;
  pipeline: string;
  priority?: QueuePriority;
  params?: Record<string, string>;
  intervention?: OperationalIntervention;
  providerFallback?: ProviderFallbackRequest | ProviderFallback;
  sourceRevision?: WorkRevision;
  revisionAttempt?: number;
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
    priority: queuePrioritySchema.parse(input.priority ?? 'normal'),
    requestId,
    requestSource: requestSource ?? 'caller',
    ...(input.sourceRevision === undefined
      ? {}
      : {
          sourceRevision: input.sourceRevision,
          revisionAttempt: input.revisionAttempt ?? 1,
        }),
    ...(params === undefined ? {} : { params }),
    ...(input.providerFallback === undefined ||
    input.providerFallback.allowedPipelines.length === 0
      ? {}
      : {
          providerFallback: {
            ...input.providerFallback,
            allowedPipelines: [...input.providerFallback.allowedPipelines],
            attemptedPipelines:
              'attemptedPipelines' in input.providerFallback
                ? [...input.providerFallback.attemptedPipelines]
                : [pipeline],
            originalRunId:
              'originalRunId' in input.providerFallback
                ? input.providerFallback.originalRunId
                : runId,
          },
        }),
    leaseExpiresAt: runLeaseExpiresAt(now),
    events: [
      {
        at: now,
        to: 'pending',
        by: 'request',
        ...(input.intervention === undefined
          ? {}
          : { intervention: input.intervention }),
      },
    ],
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
  // A `pending` run is always the task's active run: every transition that
  // changes `activeRunId` also leaves `pending`.
  if (run.state !== 'pending') return refused('run-not-live');
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

/** Only the authenticated claiming executor can report physical placement.
 * A fresh Pending observation renews the finite observer deadline; once placed,
 * repeated observations cannot extend bootstrap. Neither is a worker heartbeat. */
export function observeStartupPlacement(input: {
  now: string;
  task: Task;
  run: Run;
  claimant: ExitClaimant;
  jobUid: string;
  observedAt: string;
  placed: boolean;
}): Decision | Refusal {
  const { now, task, run, claimant, jobUid, observedAt, placed } = input;
  const queue = run.queue;
  if (
    claimant.claimFingerprint === undefined ||
    !isClaimant(run, claimant.claimFingerprint) ||
    queue?.startupPlacement === undefined ||
    queue.claimedBy !== claimant.runner ||
    queue.claimedBySubject !== claimant.subject ||
    (queue.startupPlacement.jobUid !== undefined &&
      queue.startupPlacement.jobUid !== jobUid)
  )
    return refused('not-claimant');
  if (!isLive(run.state)) return refused('run-not-live');
  if (task.activeRunId !== run.runId || recoveryDeadlineElapsed(run, now))
    return refused('stale-lease');
  // Reject delayed/replayed observations before extending any clock. The
  // executor's clock is not deadline authority: deadlines use server time.
  if (
    Date.parse(observedAt) > Date.parse(now) + 5_000 ||
    Date.parse(now) - Date.parse(observedAt) > 60_000 ||
    Date.parse(observedAt) <= Date.parse(queue.startupPlacement.observedAt)
  )
    return refused('stale-lease');
  if (
    queue.firstHeartbeatAt !== undefined ||
    queue.startupPlacement.state === 'placed'
  )
    return { task, run, outbox: [] };
  return {
    task,
    run: {
      ...run,
      queue: {
        ...queue,
        startupPlacement: {
          state: placed ? 'placed' : 'waiting',
          jobUid,
          observedAt,
        },
        startDeadlineAt: runStartDeadlineAt(now),
      },
      leaseExpiresAt: runLeaseExpiresAt(now),
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
  providerProcessStarted?: boolean;
}): Decision | Refusal {
  const { now, task, run } = input;
  if (
    input.claimFingerprint !== undefined &&
    !isClaimant(run, input.claimFingerprint)
  )
    return refused('not-claimant');
  if (!isLive(run.state)) return refused('run-not-live');
  if (task.activeRunId !== run.runId) return refused('stale-lease');
  if (startDeadlineElapsed(run, now)) return refused('stale-lease');
  // Token-authenticated callbacks must retain their live deadline through
  // commit as well as the fingerprint; internal server operations keep their
  // existing lease policy.
  if (input.claimFingerprint !== undefined && recoveryDeadlineElapsed(run, now))
    return refused('stale-lease');
  return {
    task,
    run: {
      ...run,
      ...(run.queue?.state === 'claimed'
        ? {
            queue: {
              ...run.queue,
              firstHeartbeatAt: run.queue.firstHeartbeatAt ?? now,
              ...(input.providerProcessStarted === true &&
              input.claimFingerprint !== undefined &&
              run.queue.providerProcessStartedAt === undefined
                ? { providerProcessStartedAt: now }
                : {}),
            },
          }
        : {}),
      leaseExpiresAt: runLeaseExpiresAt(now),
      updatedAt: now,
    },
    outbox: [],
  };
}

/** Executor observations never renew execution leases or count as worker heartbeats.
 * The claim, active lock and recovery deadline are checked at atomic commit. */
export function observePlacement(input: {
  now: string;
  task: Task;
  run: Run;
  claimant: ExitClaimant;
  placement: NonNullable<NonNullable<Run['queue']>['placement']>;
}): Decision | Refusal {
  const { now, task, run, claimant } = input;
  if (
    claimant.claimFingerprint === undefined ||
    !isClaimant(run, claimant.claimFingerprint) ||
    run.queue?.claimedBySubject !== claimant.subject ||
    run.queue.claimedBy !== claimant.runner
  )
    return refused('not-claimant');
  if (!isLive(run.state)) return refused('run-not-live');
  if (task.activeRunId !== run.runId || recoveryDeadlineElapsed(run, now))
    return refused('stale-lease');
  const observed = Date.parse(input.placement.observedAt);
  if (
    !Number.isFinite(observed) ||
    observed > Date.parse(now) ||
    Date.parse(now) - observed > 30_000 ||
    (run.queue.placement !== undefined &&
      observed < Date.parse(run.queue.placement.observedAt))
  )
    return refused('stale-lease');
  return {
    task,
    run: { ...run, queue: { ...run.queue, placement: input.placement } },
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
    !isClaimant(run, input.claimFingerprint)
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
    recoveryDeadlineElapsed(run, admittedAt)
  )
    return refused('stale-lease');
  if (run.credentialOperation !== undefined) {
    // An operation is reserved only on the exact claimant, so its fingerprint
    // is the claim's token hash; a release refuses while it is outstanding.
    return {
      task,
      run: {
        ...run,
        credentialPendingResult: pending ?? {
          claimFingerprint: run.credentialOperation.claimFingerprint,
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
    ...(run.triagePublication !== undefined &&
    task.desiredRevision?.key !== run.sourceRevision?.key
      ? { triagePublication: { ...run.triagePublication, state: 'superseded' } }
      : {}),
    result:
      run.sourceRevision !== undefined &&
      task.desiredRevision?.key !== run.sourceRevision.key
        ? { ...result, summary: 'superseded' }
        : result,
    events: [...run.events, { at: now, to: 'finished', by: 'report' }],
    updatedAt: now,
  };
  const decision = settle(
    resetLossBudgets(releaseLock(task, run.runId, now)),
    settled,
    now,
  );
  if (result.ok && run.delivery !== undefined) {
    const deliveryOutbox: OutboxEntry[] =
      isWorkAnchor(run.task) && run.delivery.state === 'complete'
        ? finalDeliveryOutbox(decision.task, settled, run.delivery, now)
        : [
            {
              entryId: `delivery/${run.runId}`,
              kind: 'monitor-delivery',
              // Completion drains outcomes; monitoring starts after the worker
              // can finish credential cleanup and physical retirement.
              nextAttemptAt: new Date(Date.parse(now) + 60_000).toISOString(),
              task: run.task,
              runId: run.runId,
              state: 'pending',
              attempts: 0,
              createdAt: now,
              updatedAt: now,
            },
          ];
    return {
      ...decision,
      task: { ...decision.task, delivery: run.delivery },
      outbox: [...decision.outbox, ...deliveryOutbox],
    };
  }
  return advanceSourceRevision(decision, now);
}

/** An operator stops a run and releases the lock; reports onward. */
export function cancelRun(input: {
  now: string;
  task: Task;
  run: Run;
  note?: string;
  /** Trusted ingress provenance; absent for automation and historical callers. */
  intervention?: OperationalIntervention;
  /** Server-only native item cancellation, distinct from canceling a run. */
  nativeTask?: WorkAnchor;
}): Decision | Refusal {
  const { now, task, run } = input;
  if (!isLive(run.state)) return refused('run-not-live');
  if (run.credentialOperation !== undefined)
    return refused('credential-operation-pending');
  if (input.nativeTask !== undefined) {
    if (!isWorkAnchor(task.task)) return refused('not-native');
    if (
      task.task.workId !== input.nativeTask.workId ||
      task.activeRunId !== run.runId
    )
      return refused('task-busy');
  }
  const settled: Run = {
    ...run,
    state: 'canceled',
    events: [
      ...run.events,
      {
        at: now,
        to: 'canceled',
        by: 'operator',
        ...(input.intervention === undefined
          ? {}
          : { intervention: input.intervention }),
        ...(input.note === undefined ? {} : { note: input.note }),
      },
    ],
    updatedAt: now,
  };
  const released = resetLossBudgets(releaseLock(task, run.runId, now));
  const closeDelivery = input.nativeTask !== undefined && deliveryWaiting(task);
  return settle(
    closeDelivery ? { ...released, closedAt: now } : released,
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
  const loss = expireLeaseLoss(input);
  return lossRefused(loss) ? loss : loss.decision;
}

/** `expireLease`'s guards, shared with the minting wrapper. */
function expireLeaseLoss(input: {
  now: string;
  task: Task;
  run: Run;
}): LossOutcome {
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

/** A settled loss plus which budget it was charged to. Minting needs the
 * distinction: a loss charged to the scheduler-recovery budget is bounded by
 * that counter, not by the execution budget. */
interface LossSettlement {
  readonly decision: Decision;
  readonly recovered: boolean;
}

/** What a loss guard returns: the settlement, or why there is nothing to
 * settle. */
type LossOutcome = LossSettlement | Refusal;

function lossRefused(outcome: LossOutcome): outcome is Refusal {
  return 'refused' in outcome;
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
 *
 * A report may carry {@link SchedulerDisruptionEvidence} when the executor can
 * name the exact preempted Job and Pod. That evidence only changes *which*
 * bounded budget the loss is charged to, and only when the run provably never
 * reached a provider process start; every other case is the ordinary loss.
 */
export function executorExited(input: {
  now: string;
  task: Task;
  run: Run;
  claimant: ExitClaimant;
  disruption?: SchedulerDisruptionEvidence;
}): Decision | Refusal {
  const loss = executorLoss(input);
  return lossRefused(loss) ? loss : loss.decision;
}

/** `executorExited`'s guards, kept together so the minting wrapper sees the
 * same judgement without re-running the ownership checks. */
function executorLoss(input: {
  now: string;
  task: Task;
  run: Run;
  claimant: ExitClaimant;
  disruption?: SchedulerDisruptionEvidence;
}): LossOutcome {
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
    (queue?.state !== 'claimed' &&
      !(queue?.state === 'retired' && !isLive(input.run.state))) ||
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
  return settleLost(input, 'executor', input.disruption);
}

/**
 * Whether one exit report's disruption evidence is eligible for the separate
 * scheduler-recovery budget. Every condition is a fence, and every fence that
 * fails degrades to the ordinary loss rather than to a refusal: the run is
 * still settled and the task is still unblocked.
 *
 * - No server-accepted provider-process report: nothing the provider could
 *   have replayed was ever observed starting. A run that reported a spawn is
 *   potentially-executed work, so redispatching it could double provider
 *   effects; it stays a normal loss. This is the fence that keeps recovery
 *   provider-honest rather than merely optimistic.
 * - Exact Job UID: when the negotiated startup-placement observer recorded the
 *   Job UID this attempt runs under, the evidence must name that same Job.
 * - Fresh receipt: the disruption must fall inside this attempt's own window.
 *   A condition predating the claim belongs to an older attempt; one dated
 *   after this decision cannot have caused it.
 * - The bound: past `MAX_SCHEDULER_DISRUPTION_RECOVERIES` the loss is counted
 *   as an ordinary one, so a task that keeps being disrupted ends visibly
 *   rather than redispatching forever.
 */
function schedulerDisruptionRecoverable(
  input: { now: string; task: Task; run: Run },
  evidence: SchedulerDisruptionEvidence,
): boolean {
  const queue = input.run.queue;
  if (queue?.providerProcessStartedAt !== undefined) return false;
  const claimedJobUid = queue?.startupPlacement?.jobUid;
  if (claimedJobUid !== undefined && claimedJobUid !== evidence.jobUid) {
    return false;
  }
  const observed = Date.parse(evidence.observedAt);
  if (
    queue?.claimedAt !== undefined &&
    observed < Date.parse(queue.claimedAt)
  ) {
    return false;
  }
  if (observed > Date.parse(input.now)) return false;
  return (
    (input.task.schedulerDisruptions ?? 0) < MAX_SCHEDULER_DISRUPTION_RECOVERIES
  );
}

function settleLost(
  input: { now: string; task: Task; run: Run },
  by: 'expiry' | 'executor',
  disruption?: SchedulerDisruptionEvidence,
): LossSettlement {
  const { now, task, run } = input;
  const evidence =
    disruption !== undefined &&
    schedulerDisruptionRecoverable(input, disruption)
      ? disruption
      : undefined;
  const settled: Run = {
    ...run,
    state: 'lost',
    events: [
      ...run.events,
      {
        at: now,
        to: 'lost',
        by,
        ...(evidence !== undefined
          ? {
              note: `scheduler preemption before provider start (job ${evidence.jobUid}, pod ${evidence.podUid})`,
            }
          : by === 'expiry' && startDeadlineElapsed(run, now)
            ? {
                note:
                  run.queue?.startupPlacement?.state === 'waiting'
                    ? 'placement observation deadline exceeded'
                    : 'first heartbeat deadline exceeded',
              }
            : {}),
      },
    ],
    updatedAt: now,
  };
  // A recovered disruption charges the separate disruption budget and leaves
  // the execution budget alone; anything else is an ordinary loss.
  const released = releaseLock(task, run.runId, now);
  return {
    recovered: evidence !== undefined,
    decision: settle(
      evidence === undefined
        ? { ...released, consecutiveLost: task.consecutiveLost + 1 }
        : {
            ...released,
            schedulerDisruptions: (task.schedulerDisruptions ?? 0) + 1,
          },
      settled,
      now,
    ),
  };
}

/** Settle a lost run and, while budget remains, mint its deterministic
 * successor. Both runs and both outbox effects are one Decision, hence one
 * store transaction. A loss charged to the scheduler-recovery budget mints
 * under its own bound (already checked at settlement) and is not gated on the
 * execution budget: exhausting `consecutiveLost` on earlier losses must not
 * turn a provably pre-provider-startup disruption into permanent loss. */
function settleLostAndRetry(
  input: { now: string },
  loss: LossOutcome,
): Decision | Refusal {
  if (lossRefused(loss)) return loss;
  const lost = loss.decision;
  const desired = advanceSourceRevision(lost, input.now);
  if (desired !== lost) return desired;
  if (!loss.recovered && lost.task.consecutiveLost > MAX_AUTO_RETRIES) {
    return lost;
  }
  const lostRun = decidedRun(lost);
  if (
    lostRun.sourceRevision !== undefined &&
    (lost.task.desiredRevision === undefined ||
      (lostRun.revisionAttempt ?? 1) > MAX_AUTO_RETRIES)
  )
    return lost;
  const retry = mintRun({
    now: input.now,
    taskId: lostRun.task,
    task: lost.task,
    requestId: `retry:${lostRun.runId}`,
    requestSource: 'auto-retry',
    pipeline: lostRun.pipeline,
    priority: lostRun.priority ?? 'normal',
    sourceRevision: lostRun.sourceRevision,
    revisionAttempt:
      lostRun.sourceRevision === undefined
        ? undefined
        : (lostRun.revisionAttempt ?? 1) + 1,
    ...(lostRun.params === undefined ? {} : { params: lostRun.params }),
    ...(lostRun.providerFallback === undefined
      ? {}
      : { providerFallback: lostRun.providerFallback }),
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
  disruption?: SchedulerDisruptionEvidence;
}): Decision | Refusal {
  return settleLostAndRetry(input, executorLoss(input));
}

/** Atomically settle an expired run and, while budget remains, mint its
 * deterministic successor. Both runs and both outbox effects are one
 * Decision, hence one store transaction. */
export function expireLeaseAndRetry(input: {
  now: string;
  task: Task;
  run: Run;
}): Decision | Refusal {
  return settleLostAndRetry(input, expireLeaseLoss(input));
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
    outbox: [
      outcomeEntry(settledRun, now),
      ...(settledRun.state === 'finished' &&
      settledRun.result?.ok &&
      settledRun.triagePublication?.state === 'pending'
        ? [
            {
              ...outcomeEntry(settledRun, now),
              entryId: `triage/${settledRun.runId}`,
              kind: 'publish-triage' as const,
            },
          ]
        : []),
      ...(settledRun.state === 'finished' &&
      settledRun.result?.summary === 'park' &&
      settledRun.result.message?.trim()
        ? [
            {
              ...outcomeEntry(settledRun, now),
              entryId: `handoff-summary/${settledRun.runId}`,
              kind: 'admit-handoff-summary' as const,
            },
          ]
        : []),
    ],
  };
}

function releaseLock(task: Task, runId: string, now: string): Task {
  const { activeRunId, ...rest } = task;
  return activeRunId === runId
    ? { ...rest, updatedAt: now }
    : { ...task, updatedAt: now };
}

/** Resets the retry budgets after a run settles into a state where retrying
 * makes no sense: `finished` or `canceled`. Both budgets count losses since
 * the last such settle, so a completed run clears both streaks. */
function resetLossBudgets(task: Task): Task {
  return { ...task, consecutiveLost: 0, schedulerDisruptions: 0 };
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

/** The original execution outcome is immutable and already delivered. Native
 * logical completion owns a distinct durable event through the same dispatcher. */
export function finalDeliveryOutbox(
  task: Task,
  run: Run,
  delivery: DeliveryBinding,
  now: string,
): OutboxEntry[] {
  if (!isWorkAnchor(task.task) || delivery.state !== 'complete') return [];
  return [
    {
      entryId: `delivery-outcome/${run.runId}`,
      kind: 'report-outcome',
      task: run.task,
      runId: run.runId,
      state: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    },
  ];
}
