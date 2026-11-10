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
  MAX_PROVIDER_WAITS,
  type Run,
  RUN_ID_MAX_LENGTH,
  type RunResult,
  type Task,
} from './model';
import {
  type ProviderCooldown,
  providerCooldownForRun,
  providerIsCoolingDown,
} from './provider-cooldown';

/** First quota wait; each later wait doubles it up to the cap. Bounded so a
 * wait never invents a long provider reset (#2537): MAX_PROVIDER_WAITS waits
 * span about 20 hours, enough for a daily quota to reset. */
export const PROVIDER_WAIT_BASE_MS = 15 * 60_000;
export const PROVIDER_WAIT_MAX_MS = 6 * 60 * 60_000;

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
  wait?: { attempt: number; retryAt: string };
}): Decision | Refusal {
  const previous = decidedRun(input.settled);
  const policy = previous.providerFallback;
  if (policy === undefined) return refused('work-spec-mismatch');
  const params = freshParams(previous.params);
  const next = requestRun({
    now: input.now,
    task: input.settled.task,
    issue: previous.issue,
    taskId: previous.task,
    activeRun: undefined,
    requestId: `fallback:${previous.runId}`,
    requestSource: 'provider-fallback',
    pipeline: input.pipeline,
    priority: previous.priority ?? 'normal',
    ...(params === undefined ? {} : { params }),
    providerFallback: {
      ...policy,
      // A wait starts a fresh round: after it, every authorized provider may
      // be tried again in policy order.
      attemptedPipelines:
        input.wait === undefined
          ? [...policy.attemptedPipelines, input.pipeline]
          : [input.pipeline],
      ...(input.wait === undefined
        ? {}
        : {
            providerWait: {
              ...input.wait,
              afterRunId: previous.runId,
            },
          }),
      fromRunId: previous.runId,
      trigger: {
        reason: input.reason,
        failureRunId: input.failureRunId,
        limitedPipeline: previous.pipeline,
      },
    },
  });
  if (isRefusal(next)) return next;
  const run = decidedRun(next);
  return {
    task: next.task,
    run: previous,
    // A waiting review is queued at once, deferred to its retry time: queued
    // waits never expire their lease, and claims skip it until then.
    additionalRuns: [
      input.wait === undefined
        ? run
        : {
            ...run,
            queue: { state: 'queued', deferredUntil: input.wait.retryAt },
          },
    ],
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
  const cooldown = providerCooldownForRun(previous);
  if (cooldown === undefined) return settled;
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
  if (pipeline === undefined)
    return waitForProvider({
      now: input.now,
      settled,
      cooldown,
      authorizedPipelines: input.authorizedPipelines,
    });
  return successor({
    now: input.now,
    settled,
    pipeline,
    reason: 'provider-limit',
    failureRunId: previous.runId,
  });
}

/** When every authorized provider of a PR review has stopped on its limit,
 * the review waits for quota instead of failing (#3300): a deferred successor
 * on the round's first provider. The retry time is the provider's reported
 * reset when the runner preserved one, and never
 * earlier than a bounded, doubling wait. Other work keeps settling as failed. */
function waitForProvider(input: {
  now: string;
  settled: Decision;
  cooldown: ProviderCooldown;
  authorizedPipelines: readonly string[];
}): Decision | Refusal {
  const previous = decidedRun(input.settled);
  const policy = previous.providerFallback;
  if (policy === undefined || previous.params?.['mode'] !== 'review')
    return input.settled;
  const attempt = (policy.providerWait?.attempt ?? 0) + 1;
  if (attempt > MAX_PROVIDER_WAITS) return input.settled;
  // Current authority must still back the fallback policy (repository and
  // review scope); an empty list means it was withdrawn. The wait then retries
  // the round's first provider: the one this request was admitted on, or the
  // authorized alternative an earlier wait chose. That is the same request
  // again, not a new grant.
  if (input.authorizedPipelines.length === 0) return input.settled;
  const pipeline = policy.attemptedPipelines[0];
  if (pipeline === undefined) return input.settled;
  const wait = Math.min(
    PROVIDER_WAIT_BASE_MS * 2 ** (attempt - 1),
    PROVIDER_WAIT_MAX_MS,
  );
  const retryAt = new Date(
    Math.max(
      Date.parse(input.now) + wait,
      Date.parse(input.cooldown.expiresAt),
    ),
  ).toISOString();
  return successor({
    now: input.now,
    settled: input.settled,
    pipeline,
    reason: 'provider-limit',
    failureRunId: previous.runId,
    wait: { attempt, retryAt },
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
