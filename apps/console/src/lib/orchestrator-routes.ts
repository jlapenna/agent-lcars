import {
  type AgentPipeline,
  isDispatchPipeline,
  type IssueReference,
  type TriageAnchor,
} from '@agent-lcars/dispatch-contracts';
import { logger } from '@agent-lcars/logging';
import {
  type GithubAnchor,
  isWorkAnchor,
  type Orchestrator,
  type OrchestratorStore,
  type Run,
  type TaskId,
} from '@agent-lcars/orchestrator';
import {
  type JobCredentialObservation,
  type RepositoryAgentObservation,
  repositoryAgentObservationSchema,
} from '@agent-lcars/work';
import { z } from 'zod';

import type { GithubAnchorLifecycle } from '@/lib/github-anchor-lifecycle';
import {
  githubAnchorProjectionAnchorsFromDelivery,
  githubAnchorProjectionDeletionFromDelivery,
  githubAnchorProjectionFromDelivery,
} from '@/lib/github-anchor-projection';
import { refreshCurrentGithubAnchorProjection } from '@/lib/github-anchor-refresh';
import { admitGithubWork } from '@/lib/github-work-admission';
import { issueFromGithubProjection } from '@/lib/issue-trackers';
import type { DrainOutboxResult } from '@/lib/orchestrator-dispatch';
import { wakeDeliveryMonitor } from '@/lib/orchestrator-dispatch';
import {
  githubAnchorClosureFromDelivery,
  type IngestDecision,
  type IngestResult,
  interpretDelivery,
} from '@/lib/orchestrator-ingest';
import { selectCrossModelReviewer } from '@/lib/pr-review-routing';
import { attemptTaggedReplyResume } from '@/lib/tagged-reply-resume';
import { workPayloadFromGithub } from '@/lib/work-from-github';

/**
 * Pure-ish HTTP handlers for the two control-plane routes, kept out of
 * `app/api/**` so they can be driven directly in tests without Next.js's
 * Request/Response plumbing. Each route file is a thin shell: verify auth,
 * parse the body, call the matching handler here, forward its
 * `{status, body}` verbatim. Unexpected failures are caught and turned into
 * a 500 with an opaque body so nothing from `error` (which may carry request
 * internals) reaches the caller. A projection-only refresh failure is the
 * narrow exception: it deliberately reaches the Cloud Tasks shell so that
 * the durable delivery remains retryable.
 */

export interface OrchestratorRouteDeps {
  store: OrchestratorStore;
  executeModelWork?: (deadline: number) => Promise<void>;
  reconcileIssueTriage?: (
    anchor: TriageAnchor,
    deleted?: boolean,
  ) => Promise<void>;
  reconcilePullRequestRemediation?: (
    anchor: GithubAnchor,
    options?: { afterRun?: Run },
  ) => Promise<unknown>;
  reconcileMergedPullRequestConflicts?: (input: {
    repo: string;
    baseRef: string;
    mergedNumber: number;
  }) => Promise<void>;
  reconcileOpenPullRequestRemediations?: (deadline: number) => Promise<void>;
  executeRepositoryJobs?: (deadline: number) => Promise<void>;
  observeJobCredentials?: () => Promise<JobCredentialObservation>;
  /** Repository-owned agent catalog health; a failed read omits it. */
  observeRepositoryAgents?: () => Promise<RepositoryAgentObservation>;
  /** Fence journalled credential IO before expiry can admit a successor. */
  recoverCredentialOperations?: () => Promise<{
    recovered: string[];
    unresolved: string[];
  }>;
  orchestrator: Orchestrator;
  drain: (limit?: number) => Promise<DrainOutboxResult>;
  /** Dispatches `work-session-expiry.yml` for a native item whose open/
   * closed state changed outside the outbox: a parked item's close (no run
   * settles) or a closed item's reopen. The workflow applies whatever state
   * it then reads. Never rejects. */
  expireItemSessions?: (workId: string) => Promise<void>;
  /** Runs the repository's Agent PR Auto-Merge sweep (`agent-automerge.yml`)
   * on its default branch, so an approval arms the PR now instead of at the
   * next push, CI completion or daily run. The workflow decides what to arm.
   * May reject; the caller logs and continues. */
  reconcileAutomerge?: (repo: string, ref: string) => Promise<void>;
  /** Exact GitHub lifecycle read that fences a close delivery against a
   * reopen. A close webhook that is dropped entirely needs no sweep: the
   * claim route repeats this read before a closed anchor's queued
   * implementation run could reach a worker (`runs-router.ts`). */
  loadIssueLifecycle?: (
    anchor: IssueReference,
    repository?: string,
  ) => Promise<GithubAnchorLifecycle | undefined>;
  /** Test seam for the exact server-side refresh; production uses the shared
   * reconciler rather than interpreting partial webhook payloads. */
  refreshGithubAnchorProjection?: (
    anchor: TaskId,
    input?: { deleted?: boolean },
  ) => Promise<void>;
}

type RouteResult = { status: number; body: Record<string, unknown> };

/** A projection-only failure must outlive the generic poison-delivery cap:
 * no work admission was attempted, and a deleted anchor may never emit a
 * later event or appear in the open-anchor backfill. */
export class ProjectionRefreshError extends Error {
  override readonly name = 'ProjectionRefreshError';
}

/**
 * A label re-request has no reply text of its own.  Put this opaque marker
 * into the queued run's `context` parameter so the native runtime can
 * select the GitHub comments that appeared after the previous attempt. Adding
 * another queue parameter here would require every worker consumer to update
 * in lockstep; `context` already reaches every supported provider and is
 * deliberately bounded by that action.
 *
 * This is intentionally a timestamp rather than copied comment prose.  The
 * worker's existing authenticated GitHub read remains the source of the
 * thread, so a webhook never needs to persist unbounded, untrusted comments
 * in a Run.params value.
 */
export const GITHUB_COMMENT_WINDOW_CONTEXT_PREFIX =
  'agent-lcars:github-comments-since:v1:';

export function githubCommentWindowContext(since: string): string {
  return `${GITHUB_COMMENT_WINDOW_CONTEXT_PREFIX}${since}`;
}

function newestRunCreatedAt(runs: Run[]): string | undefined {
  return runs.reduce<string | undefined>(
    (newest, run) =>
      newest === undefined || run.createdAt > newest ? run.createdAt : newest,
    undefined,
  );
}

/** Label-triggered implement and review requests have no explicit reply body.
 * First dispatches deliberately carry no extra field; only a later label
 * request gets the bounded comment window. */
async function labelRedispatchParams(
  deps: OrchestratorRouteDeps,
  input: { event: string; taskId: TaskId; params: Record<string, string> },
): Promise<Record<string, string>> {
  if (
    (input.event !== 'issues' && input.event !== 'pull_request') ||
    (input.params['mode'] !== 'implement' && input.params['mode'] !== 'review')
  ) {
    return input.params;
  }
  const previousRunAt = newestRunCreatedAt(
    await deps.store.listRuns(input.taskId),
  );
  return previousRunAt === undefined
    ? input.params
    : {
        ...input.params,
        context: githubCommentWindowContext(previousRunAt),
      };
}

function internalError(context: string, error: unknown): RouteResult {
  logger.error(`agent-lcars: orchestrator ${context} handling failed`, error);
  return { status: 500, body: { error: 'internal' } };
}

/** Projection ingestion is presentation-only after a durable work admission.
 * Projection-only deliveries deliberately rethrow so Cloud Tasks retries a
 * failed tombstone/snapshot instead of permanently acknowledging it. */
async function refreshGithubAnchorProjection(
  deps: OrchestratorRouteDeps,
  input: { event: string; deliveryId: string; payload: unknown },
): Promise<void> {
  const deletedAnchor = githubAnchorProjectionDeletionFromDelivery(input);
  if (deletedAnchor !== undefined) {
    await (
      deps.refreshGithubAnchorProjection ?? refreshCurrentGithubAnchorProjection
    )(deletedAnchor, { deleted: true });
    if (!isWorkAnchor(deletedAnchor))
      await deps.reconcileIssueTriage?.(deletedAnchor, true);
    return;
  }
  for (const anchor of githubAnchorProjectionAnchorsFromDelivery(input)) {
    await (
      deps.refreshGithubAnchorProjection ?? refreshCurrentGithubAnchorProjection
    )(anchor);
    if (
      !isWorkAnchor(anchor) &&
      (input.event === 'issues' || input.event === 'issue_comment')
    ) {
      const payload = input.payload as { issue?: { pull_request?: unknown } };
      if (payload.issue?.pull_request === undefined)
        await deps.reconcileIssueTriage?.(anchor);
    }
  }
}

async function refreshGithubAnchorProjectionAfterAdmission(
  deps: OrchestratorRouteDeps,
  input: { event: string; deliveryId: string; payload: unknown },
): Promise<void> {
  try {
    await refreshGithubAnchorProjection(deps, input);
  } catch (error) {
    throw new ProjectionRefreshError(
      `Projection refresh failed after admission for ${input.event}/${input.deliveryId}`,
      { cause: error },
    );
  }
}

/** The pull requests a delivery names, for events that can change whether a
 * waiting delivery binding's PR merged, closed, moved or got feedback. */
const deliveryPullRequestsSchema = z.object({
  action: z.string().optional(),
  repository: z.object({ full_name: z.string().min(1) }),
  pull_request: z
    .object({
      number: z.number().int().positive(),
      merged: z.boolean().optional(),
      base: z.object({ ref: z.string().min(1) }).optional(),
    })
    .optional(),
  check_run: z
    .object({
      pull_requests: z.array(z.object({ number: z.number().int().positive() })),
    })
    .optional(),
});

async function wakeDeliveryMonitors(
  deps: OrchestratorRouteDeps,
  input: { event: string; payload: unknown },
): Promise<void> {
  if (
    ![
      'pull_request',
      'pull_request_review',
      'pull_request_review_thread',
      'check_run',
    ].includes(input.event)
  )
    return;
  const parsed = deliveryPullRequestsSchema.safeParse(input.payload);
  if (!parsed.success) return;
  const repo = parsed.data.repository.full_name;
  // A merge into a base branch can make other waiting delivery PRs in the same
  // repository conflict (`dirty`), so wake every waiting monitor in `repo`.
  if (
    input.event === 'pull_request' &&
    parsed.data.action === 'closed' &&
    parsed.data.pull_request?.merged === true
  ) {
    const woken = (await wakeDeliveryMonitor(deps, { repo })).length;
    if (woken > 0) await deps.drain(Math.max(10, woken * 2));
    return;
  }
  const numbers = [
    ...(parsed.data.pull_request === undefined
      ? []
      : [parsed.data.pull_request.number]),
    ...(parsed.data.check_run?.pull_requests.map((pr) => pr.number) ?? []),
  ];
  let woken = 0;
  for (const number of new Set(numbers))
    woken += (await wakeDeliveryMonitor(deps, { repo, number })).length;
  if (woken > 0) await deps.drain(Math.max(10, woken * 2));
}

const approvalSchema = z.object({
  action: z.literal('submitted'),
  repository: z.object({
    full_name: z.string().min(1),
    default_branch: z.string().min(1),
  }),
  review: z.object({ state: z.literal('approved') }),
  pull_request: z.object({
    draft: z.boolean().optional(),
    head: z.object({
      repo: z.object({ full_name: z.string().min(1) }).nullable(),
    }),
  }),
});

/** An approval is the request to land a pull request (jlapenna/agent-lcars#3508).
 * Nothing else wakes the auto-merge sweep when one arrives: CI usually finished
 * before the review did, so an approved PR waited for the next push to the
 * base branch or the daily run. Forks and drafts never reach the sweep's arm. */
async function reconcileAutomergeOnApproval(
  deps: OrchestratorRouteDeps,
  input: { event: string; deliveryId: string; payload: unknown },
): Promise<void> {
  if (
    input.event !== 'pull_request_review' ||
    deps.reconcileAutomerge === undefined
  )
    return;
  const parsed = approvalSchema.safeParse(input.payload);
  if (!parsed.success) return;
  const { repository, pull_request: pr } = parsed.data;
  if (pr.draft === true || pr.head.repo?.full_name !== repository.full_name)
    return;
  try {
    await deps.reconcileAutomerge(
      repository.full_name,
      repository.default_branch,
    );
  } catch (error) {
    logger.warn(
      'agent-lcars: auto-merge sweep dispatch failed for %s (%s); the next push, CI completion or daily run arms it:',
      repository.full_name,
      input.deliveryId,
      error,
    );
  }
}

const prRemediationTriggerSchema = z.object({
  action: z.string().optional(),
  repository: z.object({ full_name: z.string().min(1) }),
  pull_request: z.object({
    number: z.number().int().positive(),
    merged: z.boolean().optional(),
    base: z.object({ ref: z.string().min(1) }).optional(),
  }),
});

async function maybeReconcilePullRequestRemediation(
  deps: OrchestratorRouteDeps,
  input: { event: string; deliveryId: string; payload: unknown },
  admittedNewRun: boolean,
): Promise<void> {
  if (
    deps.reconcilePullRequestRemediation === undefined &&
    deps.reconcileMergedPullRequestConflicts === undefined
  ) {
    return;
  }
  if (
    ![
      'pull_request',
      'pull_request_review',
      'pull_request_review_thread',
    ].includes(input.event)
  ) {
    return;
  }
  const parsed = prRemediationTriggerSchema.safeParse(input.payload);
  if (!parsed.success) return;
  const repo = parsed.data.repository.full_name;
  const pr = parsed.data.pull_request;
  const action = parsed.data.action;

  try {
    if (
      input.event === 'pull_request' &&
      action === 'closed' &&
      pr.merged === true &&
      pr.base?.ref !== undefined
    ) {
      await deps.reconcileMergedPullRequestConflicts?.({
        repo,
        baseRef: pr.base.ref,
        mergedNumber: pr.number,
      });
      return;
    }

    if (admittedNewRun) return;

    const shouldInspectPr =
      (input.event === 'pull_request_review' &&
        (action === 'submitted' || action === 'edited')) ||
      (input.event === 'pull_request_review_thread' &&
        action === 'unresolved') ||
      (input.event === 'pull_request' &&
        [
          'opened',
          'reopened',
          'ready_for_review',
          'synchronize',
          'unlabeled',
          'labeled',
        ].includes(action ?? ''));
    if (shouldInspectPr) {
      await deps.reconcilePullRequestRemediation?.({
        repo,
        issue: pr.number,
      });
    }
  } catch (error) {
    logger.warn(
      'agent-lcars: automatic PR remediation check failed for %s/%s:',
      input.event,
      input.deliveryId,
      error,
    );
  }
}

export async function handleWebhookDelivery(
  deps: OrchestratorRouteDeps,
  input: { event: string; deliveryId: string; payload: unknown },
): Promise<RouteResult> {
  try {
    // Observe a bound PR's change now rather than on the fallback clock. A
    // failed wake is logged and left to that clock; it never fails intake.
    try {
      await wakeDeliveryMonitors(deps, input);
    } catch (error) {
      logger.warn(
        'agent-lcars: delivery monitor wake failed for %s/%s:',
        input.event,
        input.deliveryId,
        error,
      );
    }
    await reconcileAutomergeOnApproval(deps, input);
    const interpreted = interpretDelivery(input);
    if (interpreted.kind === 'ignore') {
      const ignored = await handleIgnoredDelivery(deps, input, interpreted);
      await maybeReconcilePullRequestRemediation(deps, input, false);
      return ignored;
    }
    const result = await decideDelivery(deps, input, interpreted);
    // Every acknowledged outcome refreshes the anchor's projection exactly
    // once, after the durable decision; a rejected admission (500) is retried
    // by Cloud Tasks and refreshes on the retry that acknowledges it.
    if (result.status === 200) {
      await refreshGithubAnchorProjectionAfterAdmission(deps, input);
      await maybeReconcilePullRequestRemediation(
        deps,
        input,
        typeof result.body['runId'] === 'string' &&
          result.body['duplicate'] !== true,
      );
    }
    return result;
  } catch (error) {
    if (error instanceof ProjectionRefreshError) throw error;
    return internalError('webhook delivery', error);
  }
}

/** An ignored delivery admits nothing. Its projection refresh runs first so
 * the close fence below reads the refreshed anchor; a failure is retryable. */
async function handleIgnoredDelivery(
  deps: OrchestratorRouteDeps,
  input: { event: string; deliveryId: string; payload: unknown },
  interpreted: Extract<IngestResult, { kind: 'ignore' }>,
): Promise<RouteResult> {
  let canceledRunId: string | undefined;
  const closure = githubAnchorClosureFromDelivery(input);
  // An untagged comment lands here (`no-reply-command`) and dispatches
  // nothing -- the trigger tag is the gate (#1788, #1789); it never
  // gets a second, implicit chance to resume a parked anchor.
  try {
    await refreshGithubAnchorProjection(deps, input);
  } catch (error) {
    throw new ProjectionRefreshError(
      `Projection refresh failed for ${input.event}/${input.deliveryId}`,
      { cause: error },
    );
  }
  if (
    closure !== undefined &&
    !isWorkAnchor(closure.taskId) &&
    deps.loadIssueLifecycle !== undefined
  ) {
    // Refresh first, then verify current GitHub state. A delayed close
    // delivery may arrive after the same generation reopened; the old
    // payload timestamp alone cannot distinguish that case.
    const lifecycle = await deps.loadIssueLifecycle({
      tracker: 'github',
      ...closure.taskId,
    });
    if (lifecycle?.state === 'closed') {
      const activeRun = await deps.store.readActiveRun(closure.taskId);
      // Closed anchors still support explicit review and tagged-reply
      // semantics. Only never-started implementation work is stale.
      if (activeRun?.params?.['mode'] === 'implement') {
        const canceled = await deps.orchestrator.cancelUnclaimedBefore({
          runId: activeRun.runId,
          notAfter: lifecycle.sourceUpdatedAt,
          note: `GitHub anchor confirmed closed at ${lifecycle.sourceUpdatedAt}`,
        });
        if (!('refused' in canceled) && canceled.run !== undefined) {
          canceledRunId = canceled.run.runId;
        }
      }
    }
  }
  return {
    status: 200,
    body: {
      ignored: interpreted.reason,
      ...(canceledRunId === undefined ? {} : { canceledRunId }),
    },
  };
}

async function resolveAuthorPipelineFromStore(
  deps: OrchestratorRouteDeps,
  interpreted: IngestDecision,
): Promise<AgentPipeline | undefined> {
  const claimRunId = interpreted.reviewContext?.claimRunId;
  if (claimRunId !== undefined) {
    const claimedRun = await deps.store.readRun(claimRunId);
    if (claimedRun !== undefined && isDispatchPipeline(claimedRun.pipeline)) {
      return claimedRun.pipeline;
    }
  }
  const runs = await deps.store.listRuns(interpreted.taskId);
  let newestImplementRun: Run | undefined;
  for (const run of runs) {
    if (run.params?.['mode'] !== 'implement') continue;
    if (
      newestImplementRun === undefined ||
      run.createdAt > newestImplementRun.createdAt
    ) {
      newestImplementRun = run;
    }
  }
  if (
    newestImplementRun !== undefined &&
    isDispatchPipeline(newestImplementRun.pipeline)
  ) {
    return newestImplementRun.pipeline;
  }
  return undefined;
}

async function resolveReviewDecisionFromStore(
  deps: OrchestratorRouteDeps,
  interpreted: IngestDecision,
): Promise<IngestDecision> {
  if (
    isWorkAnchor(interpreted.taskId) ||
    interpreted.params['mode'] !== 'review' ||
    interpreted.reviewContext === undefined
  ) {
    return interpreted;
  }
  const authorPipelineFromStore = await resolveAuthorPipelineFromStore(
    deps,
    interpreted,
  );
  if (
    authorPipelineFromStore === undefined ||
    authorPipelineFromStore === interpreted.reviewContext.authorPipeline
  ) {
    return interpreted;
  }
  const selection = selectCrossModelReviewer({
    repo: interpreted.taskId.repo,
    authorPipeline: authorPipelineFromStore,
    requestedPipeline: interpreted.reviewContext.requestedPipeline,
  });
  const work = workPayloadFromGithub({
    title: interpreted.reviewContext.title,
    body: interpreted.reviewContext.body,
    pipeline: selection.pipeline,
    repo: interpreted.taskId.repo,
    actor: interpreted.reviewContext.actor,
  });
  const labelRouting =
    interpreted.labelRouting === undefined
      ? undefined
      : {
          ...interpreted.labelRouting,
          ...(selection.crossModelOverride ? { crossModelOverride: true } : {}),
        };
  return {
    ...interpreted,
    pipeline: selection.pipeline,
    work,
    fallbackPipelines: selection.fallbackPipelines,
    ...(labelRouting === undefined ? {} : { labelRouting }),
  };
}

/** The durable decision for a delivery that names work: a routing-label
 * conflict, a tagged-reply resume, or ordinary admission. Returns the
 * response body only; the caller owns the single projection refresh. */
async function decideDelivery(
  deps: OrchestratorRouteDeps,
  input: { event: string; deliveryId: string; payload: unknown },
  interpreted: Exclude<IngestResult, { kind: 'ignore' }>,
): Promise<RouteResult> {
  if (interpreted.kind === 'conflict') {
    // Permanent intent conflicts are acknowledged, not retried by Cloud
    // Tasks. No Work, run, label rewrite, or assignment change is requested.
    return {
      status: 200,
      body: {
        refused: interpreted.reason,
        namespace: interpreted.namespace,
        labels: interpreted.labels,
        message: interpreted.message,
      },
    };
  }

  // A *tagged* reply (`@claude`/`@agent`/`/codex`/`/oc`, matched by
  // `interpretIssueCommentEvent`) is the only path that can carry
  // `mode: 'reply'` here -- label-triggered `issues`/`pull_request`
  // decisions are always `implement`/`review`. Give a PARKED or DONE
  // anchor a chance to resume its existing session with this comment as
  // its next turn before falling into the ordinary admission below:
  // resumable-conversations plan 2 (#1773), re-gated behind the trigger
  // tag instead of an allowlist (#1789).
  if (
    input.event === 'issue_comment' &&
    interpreted.params['mode'] === 'reply'
  ) {
    const resumed = await attemptTaggedReplyResume(deps, {
      ...input,
      pipeline: interpreted.pipeline,
    });
    if (resumed !== undefined) return resumed;
    // `requestReply` declined -- no task yet (`NOT_FOUND`, the
    // start-work-by-comment case that must keep working), a closed
    // task, or a busy task. Fall through to the same
    // admission every other trigger uses; a still-running anchor
    // refuses `task-busy` there too (`decide.ts`'s own concurrency
    // guard), so no second run is ever created.
  }

  const resolvedDecision = await resolveReviewDecisionFromStore(
    deps,
    interpreted,
  );

  // The first label-triggered run stays byte-for-byte on its existing
  // prompt path. On a later label request, carry only the previous run's
  // timestamp; the native runtime uses it to expose a bounded,
  // author-attributed comment window in the brief.
  const params = await labelRedispatchParams(deps, {
    event: input.event,
    taskId: resolvedDecision.taskId,
    params: resolvedDecision.params,
  });

  const projection = githubAnchorProjectionFromDelivery({
    ...input,
    event: input.event === 'issue_comment' ? 'issues' : input.event,
    observedAt: new Date().toISOString(),
  });
  const outcome = await admitGithubWork(deps, {
    ...(projection === undefined
      ? {}
      : { issue: issueFromGithubProjection(projection) }),
    anchor: resolvedDecision.taskId,
    requestId: resolvedDecision.requestId,
    params,
    work: resolvedDecision.work,
    workMirrorsAnchor: true,
    ...(resolvedDecision.labelRouting === undefined
      ? {}
      : { labelRouting: resolvedDecision.labelRouting }),
    ...(resolvedDecision.fallbackPipelines === undefined
      ? {}
      : { fallbackPipelines: resolvedDecision.fallbackPipelines }),
    ...(resolvedDecision.requestBinding === undefined
      ? {}
      : { requestBinding: resolvedDecision.requestBinding }),
  });

  switch (outcome.kind) {
    case 'busy':
      return { status: 200, body: { refused: 'task-busy' } };
    case 'duplicate':
      return { status: 200, body: { duplicate: true, runId: outcome.runId } };
    case 'conflict':
      if (
        'providerRouting' in outcome &&
        outcome.providerRouting !== undefined
      ) {
        return {
          status: 200,
          body: {
            refused: outcome.providerRouting.reason,
            providerRouting: outcome.providerRouting,
          },
        };
      }
      return {
        status: 200,
        body:
          'reason' in outcome
            ? {
                refused: outcome.reason,
                namespace: outcome.namespace,
                labels: outcome.labels,
                message: outcome.message,
              }
            : {
                refused:
                  outcome.message === 'stale-provider-request'
                    ? outcome.message
                    : 'work-spec-mismatch',
              },
      };
    case 'invalid':
    case 'forbidden':
      logger.error(
        'agent-lcars: GitHub webhook admission rejected',
        outcome.message,
      );
      return { status: 500, body: { error: 'internal' } };
    case 'accepted':
      return {
        status: 200,
        body: { runId: outcome.runId, dispatched: outcome.dispatched },
      };
  }
}

/** The executor reads at most 64 KiB of the maintenance reply. */
const MAINTENANCE_REPLY_BUDGET_BYTES = 60 * 1024;

/** `observation` when it parses on the wire and fits beside `rest`. */
function fitObservation(
  observation: RepositoryAgentObservation | undefined,
  rest: object,
): RepositoryAgentObservation | undefined {
  if (observation === undefined) return undefined;
  const parsed = repositoryAgentObservationSchema.safeParse(observation);
  if (!parsed.success) {
    logger.warn('Repository agent observation omitted: invalid on the wire');
    return undefined;
  }
  const bytes = Buffer.byteLength(
    JSON.stringify({ ...rest, repositoryAgents: parsed.data }),
  );
  if (bytes > MAINTENANCE_REPLY_BUDGET_BYTES) {
    logger.warn('Repository agent observation omitted: reply budget');
    return undefined;
  }
  return parsed.data;
}

/** `observation`'s value, or undefined if it fails or is still pending at
 * `deadline` (epoch ms). It never rejects and never outlives the deadline. */
async function withinDeadline<T>(
  observation: Promise<T> | undefined,
  deadline: number,
): Promise<T | undefined> {
  if (observation === undefined) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      observation.catch((error: unknown) => {
        logger.error('Repository agent observation failed', error);
        return undefined;
      }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(
          () => {
            logger.warn('Repository agent observation missed its deadline');
            resolve(undefined);
          },
          Math.max(0, Math.ceil(deadline - Date.now())),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One QueueExecutor reconcile cycle: expire lost leases, then dispatch the
 * resulting retry work. Provider workers report completion through the Work
 * API; no GitHub Actions workflow probing is part of this path.
 */
export async function handleReconcile(
  deps: OrchestratorRouteDeps,
): Promise<RouteResult> {
  try {
    // Leave headroom inside the production ticker’s 60-second HTTP deadline.
    const modelDeadline = Date.now() + 45_000;
    const credentialRecovery = await deps.recoverCredentialOperations?.();
    const swept = await deps.orchestrator.sweepExpired();
    // Keep provider-cooldown rerouting in maintenance, outside the executor's
    // ten-second claim request. Every choice rechecks the requesting grant;
    // the ordinary claim transaction still enforces the executor grant.
    const rerouted = await deps.orchestrator.rerouteQueued();
    // Enqueue any missed open-PR remediations before the single outbox drain
    // below so newly minted `dispatch-run` entries share `drained` and its
    // failed-entry exclusion without a second drain pass.
    if (deps.reconcileOpenPullRequestRemediations !== undefined) {
      try {
        await deps.reconcileOpenPullRequestRemediations(
          Math.min(modelDeadline, Date.now() + 25_000),
        );
      } catch (error) {
        logger.warn(
          'agent-lcars: open PR remediation sweep failed during reconcile:',
          error,
        );
      }
    }
    // One drain owns the whole bounded maintenance pass so its failed-entry
    // exclusion remains effective across all 30 claims. The five-minute
    // ticker continues any larger backlog on its next pass.
    const outboxLimit = 30;
    const drained = await deps.drain(outboxLimit);
    // Health telemetry only, read beside the passes below and bounded by
    // the same deadline: a failed or slow catalog read omits the observation
    // (the executor reports it unavailable) and never fails or delays
    // maintenance past the executor's HTTP deadline.
    const repositoryAgentObservation = withinDeadline(
      deps.observeRepositoryAgents?.(),
      modelDeadline,
    );
    // Independent I/O-bound maintenance shares the same wall-clock window.
    // Await every pass even on failure; none may outlive the HTTP request.
    const maintenance = await Promise.allSettled([
      deps.executeModelWork?.(modelDeadline),
      deps.executeRepositoryJobs?.(modelDeadline),
      deps.observeJobCredentials?.(),
    ]);
    for (const result of maintenance)
      if (result.status === 'rejected') throw result.reason;
    const observed = await repositoryAgentObservation;
    const outboxProcessed =
      drained.dispatched.length +
      drained.reported.length +
      drained.failed.length;
    const credentialObservation = maintenance[2];
    const jobCredentials =
      credentialObservation?.status === 'fulfilled'
        ? credentialObservation.value
        : undefined;
    // Optional health telemetry is attached only when it is valid on the
    // wire and the whole reply still fits the executor's 64 KiB limit; it
    // never turns a completed maintenance pass into a failed one.
    const repositoryAgents = fitObservation(observed, {
      jobCredentials,
      credentialRecovery,
      lost: swept.lost.map((run) => run.runId),
      retried: swept.retried,
      rerouted,
      dispatched: drained.dispatched,
      reported: drained.reported,
      outboxDrainFailed: drained.failed,
    });
    return {
      status: 200,
      body: {
        ...(jobCredentials === undefined ? {} : { jobCredentials }),
        ...(repositoryAgents === undefined ? {} : { repositoryAgents }),
        ...(credentialRecovery === undefined ? {} : { credentialRecovery }),
        lost: swept.lost.map((run) => run.runId),
        retried: swept.retried,
        rerouted,
        dispatched: drained.dispatched,
        reported: drained.reported,
        outboxProcessed,
        outboxContinuationNeeded: outboxProcessed === outboxLimit,
        // #1548: the drain itself now logs every per-entry failure (see
        // `orchestrator-dispatch.ts`'s `logOutboxFailure`), but surfacing it
        // here means a reconcile run's response already shows an outbox
        // problem without needing a separate log lookup.
        ...(drained.failed.length === 0
          ? {}
          : { outboxDrainFailed: drained.failed }),
      },
    };
  } catch (error) {
    return internalError('reconcile', error);
  }
}
