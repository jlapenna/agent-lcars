import {
  decidedRun,
  type Decision,
  isRefusal,
  type Refusal,
  refused,
  reportResult,
  requestRun,
} from './decide';
import {
  type Run,
  RUN_ID_MAX_LENGTH,
  type RunResult,
  type Task,
} from './model';
import {
  providerCooldownForRun,
  providerIsCoolingDown,
} from './provider-cooldown';

/** Policy order is preserved; current authority and availability only narrow it. */
export function selectFallbackPipeline(
  run: Run,
  authorizedPipelines: readonly string[],
  availablePipelines: readonly string[],
): string | undefined {
  const policy = run.providerFallback;
  if (policy === undefined) return undefined;
  return policy.allowedPipelines.find(
    (pipeline) =>
      pipeline !== run.pipeline &&
      !policy.attemptedPipelines.includes(pipeline) &&
      authorizedPipelines.includes(pipeline) &&
      availablePipelines.includes(pipeline),
  );
}

/** Resume artifacts belong to the original provider; fresh alternatives retain
 * the human request/context, never the provider's archived conversation. */
function freshParams(params: Run['params']): Run['params'] {
  if (params === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(params).filter(
      ([key]) => key !== 'resumeSessionId' && key !== 'resumeTranscriptGcsUri',
    ),
  );
}

function successor(input: {
  now: string;
  settled: Decision;
  pipeline: string;
  reason: 'provider-limit' | 'provider-cooldown';
  failureRunId: string;
}): Decision | Refusal {
  const previous = decidedRun(input.settled);
  const policy = previous.providerFallback;
  if (policy === undefined) return refused('work-spec-mismatch');
  const params = freshParams(previous.params);
  const next = requestRun({
    now: input.now,
    task: input.settled.task,
    taskId: previous.task,
    activeRun: undefined,
    requestId: `fallback:${previous.runId}`,
    requestSource: 'provider-fallback',
    pipeline: input.pipeline,
    ...(params === undefined ? {} : { params }),
    providerFallback: {
      ...policy,
      attemptedPipelines: [...policy.attemptedPipelines, input.pipeline],
      fromRunId: previous.runId,
      trigger: {
        reason: input.reason,
        failureRunId: input.failureRunId,
        limitedPipeline: previous.pipeline,
      },
    },
  });
  if (isRefusal(next)) return next;
  return {
    task: next.task,
    run: previous,
    additionalRuns: [decidedRun(next)],
    outbox: [...input.settled.outbox, ...next.outbox],
  };
}

/** Settlement, cooldown write, successor identity and dispatch share one commit. */
export function reportResultWithFallback(input: {
  now: string;
  task: Task;
  run: Run;
  result: RunResult;
  claimFingerprint?: string;
  authorizedPipelines: readonly string[];
  availablePipelines: readonly string[];
}): Decision | Refusal {
  const settled = reportResult(input);
  if (isRefusal(settled)) return settled;
  return settleProviderFallback({ ...input, settled });
}

/** The same authorized policy applies when an exact deferred result settles
 * after credential IO recovery. Its original report and successor share one
 * store Decision; callers supply current authority and transactional inventory. */
export function settleProviderFallback(input: {
  now: string;
  settled: Decision;
  authorizedPipelines: readonly string[];
  availablePipelines: readonly string[];
}): Decision | Refusal {
  const { settled } = input;
  const previous = decidedRun(settled);
  if (providerCooldownForRun(previous) === undefined) return settled;
  // Temporary occupancy/cooldown must not erase the user's remaining intent.
  // Prefer an available alternative; otherwise queue the first still-authorized
  // unattempted provider. Its ordinary claim retains the same capacity/cooldown
  // fences, and its deterministic successor owns the task while it waits.
  const pipeline =
    selectFallbackPipeline(
      previous,
      input.authorizedPipelines,
      input.availablePipelines,
    ) ??
    selectFallbackPipeline(
      previous,
      input.authorizedPipelines,
      input.authorizedPipelines,
    );
  if (pipeline === undefined) return settled;
  return successor({
    now: input.now,
    settled,
    pipeline,
    reason: 'provider-limit',
    failureRunId: previous.runId,
  });
}

/** A queued intent can encounter a cooldown caused by another task. Replace
 * only its exact unclaimed run, with the triggering failure linked explicitly. */
export function rerouteQueuedRun(input: {
  now: string;
  task: Task;
  run: Run;
  cooldown: unknown;
  authorizedPipelines: readonly string[];
  availablePipelines: readonly string[];
}): Decision | Refusal {
  const { now, task, run, cooldown } = input;
  if (task.activeRunId !== run.runId) return refused('stale-lease');
  if (run.queue?.state === 'claimed') return refused('run-already-claimed');
  if (
    run.queue?.state !== 'queued' ||
    (run.state !== 'pending' && run.state !== 'running') ||
    (run.queue.deferredUntil !== undefined && run.queue.deferredUntil > now)
  )
    return refused('run-not-live');
  if (
    !providerIsCoolingDown(cooldown, now) ||
    typeof cooldown !== 'object' ||
    cooldown === null ||
    !('runId' in cooldown) ||
    typeof cooldown.runId !== 'string' ||
    cooldown.runId.length === 0 ||
    cooldown.runId.length > RUN_ID_MAX_LENGTH ||
    !('pipeline' in cooldown) ||
    cooldown.pipeline !== run.pipeline
  )
    return refused('stale-lease');
  const pipeline = selectFallbackPipeline(
    run,
    input.authorizedPipelines,
    input.availablePipelines,
  );
  if (pipeline === undefined) return refused('work-spec-mismatch');
  // Cancellation is a routing decision, not a fabricated execution failure.
  const { activeRunId: _activeRunId, ...released } = task;
  const settled: Decision = {
    task: { ...released, updatedAt: now },
    run: {
      ...run,
      state: 'canceled',
      updatedAt: now,
      events: [
        ...run.events,
        {
          at: now,
          to: 'canceled',
          by: 'provider-fallback',
          note: `Provider cooldown from ${cooldown.runId}; fresh fallback to ${pipeline}`,
        },
      ],
    },
    // The successor outcome carries the auditable reroute. Do not publish an
    // operator-cancellation outcome for work the user still expects to run.
    outbox: [],
  };
  return successor({
    now,
    settled,
    pipeline,
    reason: 'provider-cooldown',
    failureRunId: cooldown.runId,
  });
}
