import { logger } from '@agent-lcars/logging';
import {
  type GithubAnchor,
  isLive,
  isWorkAnchor,
  type Orchestrator,
  type OrchestratorStore,
  type Run,
  type TaskId,
} from '@agent-lcars/orchestrator';

import type { GithubAnchorLifecycle } from '@/lib/github-anchor-lifecycle';
import {
  githubAnchorProjectionAnchorsFromDelivery,
  githubAnchorProjectionDeletionFromDelivery,
} from '@/lib/github-anchor-projection';
import { refreshCurrentGithubAnchorProjection } from '@/lib/github-anchor-refresh';
import { admitGithubWork } from '@/lib/github-work-admission';
import type { DrainOutboxResult } from '@/lib/orchestrator-dispatch';
import {
  githubAnchorClosureFromDelivery,
  interpretDelivery,
} from '@/lib/orchestrator-ingest';
import { attemptTaggedReplyResume } from '@/lib/tagged-reply-resume';

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
  orchestrator: Orchestrator;
  drain: (limit?: number) => Promise<DrainOutboxResult>;
  /** Exact, bounded GitHub lifecycle read used by maintenance to recover
   * close webhooks that were dropped or predate this behavior. */
  loadGithubAnchorLifecycle?: (
    anchor: Extract<TaskId, { repo: string }>,
  ) => Promise<GithubAnchorLifecycle | undefined>;
  /** Clock for deterministic rotation of the bounded maintenance window. */
  now?: () => string;
  /** Test seam for the exact server-side refresh; production uses the shared
   * reconciler rather than interpreting partial webhook payloads. */
  refreshGithubAnchorProjection?: (
    anchor: TaskId,
    input?: { deleted?: boolean },
  ) => Promise<void>;
  /** Invoked only after the durable projection refresh has completed. The
   * hosted webhook route binds this to the console queue cache tag. */
  invalidateAuthoritativeQueue?: () => void | Promise<void>;
}

const QUEUED_GITHUB_CHECK_LIMIT = 10;

async function reconcileClosedQueuedImplementations(
  deps: OrchestratorRouteDeps,
): Promise<{ canceled: string[]; failed: string[] }> {
  if (deps.loadGithubAnchorLifecycle === undefined) {
    return { canceled: [], failed: [] };
  }
  // The stores already read their queued index in full. Filter that complete
  // live population before choosing the bounded GitHub-read window so native,
  // review, and reply runs cannot form a permanent prefix horizon.
  const queued = await deps.store.listQueuedRuns();
  const eligible = queued.filter(
    (run): run is Run & { task: GithubAnchor } =>
      isLive(run.state) &&
      !isWorkAnchor(run.task) &&
      run.params?.['mode'] === 'implement',
  );
  const tick = Math.floor(
    Date.parse(deps.now?.() ?? new Date().toISOString()) / (5 * 60_000),
  );
  const start =
    eligible.length === 0
      ? 0
      : (tick * QUEUED_GITHUB_CHECK_LIMIT) % eligible.length;
  const candidates = Array.from(
    { length: Math.min(eligible.length, QUEUED_GITHUB_CHECK_LIMIT) },
    (_, offset) =>
      eligible[(start + offset) % eligible.length] as Run & {
        task: GithubAnchor;
      },
  );
  // Each exact read has its own four-second timeout. Run the small bounded set
  // concurrently so one slow repository cannot turn a maintenance request
  // into ten serialized timeout windows.
  const outcomes = await Promise.all(
    candidates.map(async (run) => {
      try {
        const lifecycle = await deps.loadGithubAnchorLifecycle?.(run.task);
        if (lifecycle === undefined) return { failed: run.runId };
        if (lifecycle.state !== 'closed') return {};
        const outcome = await deps.orchestrator.cancelUnclaimedBefore({
          runId: run.runId,
          notAfter: lifecycle.sourceUpdatedAt,
          note: `GitHub anchor confirmed closed at ${lifecycle.sourceUpdatedAt}`,
        });
        return 'refused' in outcome ? {} : { canceled: run.runId };
      } catch (error) {
        logger.error(
          `agent-lcars: queued anchor reconciliation failed for ${run.runId}`,
          error,
        );
        return { failed: run.runId };
      }
    }),
  );
  const canceled = outcomes.flatMap((outcome) =>
    outcome.canceled === undefined ? [] : [outcome.canceled],
  );
  const failed = outcomes.flatMap((outcome) =>
    outcome.failed === undefined ? [] : [outcome.failed],
  );
  if (canceled.length > 0) await deps.invalidateAuthoritativeQueue?.();
  return { canceled, failed };
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
    await deps.invalidateAuthoritativeQueue?.();
    return;
  }
  for (const anchor of githubAnchorProjectionAnchorsFromDelivery(input)) {
    await (
      deps.refreshGithubAnchorProjection ?? refreshCurrentGithubAnchorProjection
    )(anchor);
  }
  await deps.invalidateAuthoritativeQueue?.();
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

export async function handleWebhookDelivery(
  deps: OrchestratorRouteDeps,
  input: { event: string; deliveryId: string; payload: unknown },
): Promise<RouteResult> {
  try {
    const interpreted = interpretDelivery(input);
    if (interpreted.kind === 'ignore') {
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
        deps.loadGithubAnchorLifecycle !== undefined
      ) {
        // Refresh first, then verify current GitHub state. A delayed close
        // delivery may arrive after the same generation reopened; the old
        // payload timestamp alone cannot distinguish that case.
        const lifecycle = await deps.loadGithubAnchorLifecycle(closure.taskId);
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
      if (resumed !== undefined) {
        await refreshGithubAnchorProjectionAfterAdmission(deps, input);
        return resumed;
      }
      // `requestReply` declined -- no task yet (`NOT_FOUND`, the
      // start-work-by-comment case that must keep working), a closed
      // task, or the fleet's live-run cap. Fall through to the same
      // admission every other trigger uses; a still-running anchor
      // refuses `task-busy` there too (`decide.ts`'s own concurrency
      // guard), so no second run is ever created.
    }

    // The first label-triggered run stays byte-for-byte on its existing
    // prompt path. On a later label request, carry only the previous run's
    // timestamp; the native runtime uses it to expose a bounded,
    // author-attributed comment window in the brief.
    const params = await labelRedispatchParams(deps, {
      event: input.event,
      taskId: interpreted.taskId,
      params: interpreted.params,
    });

    const outcome = await admitGithubWork(deps, {
      anchor: interpreted.taskId,
      requestId: interpreted.requestId,
      params,
      work: interpreted.work,
      ...(interpreted.requestBinding === undefined
        ? {}
        : { requestBinding: interpreted.requestBinding }),
    });

    if (outcome.kind === 'busy') {
      await refreshGithubAnchorProjectionAfterAdmission(deps, input);
      return { status: 200, body: { refused: 'task-busy' } };
    }
    if (outcome.kind === 'duplicate') {
      await refreshGithubAnchorProjectionAfterAdmission(deps, input);
      return {
        status: 200,
        body: { duplicate: true, runId: outcome.runId },
      };
    }
    if (outcome.kind === 'conflict') {
      await refreshGithubAnchorProjectionAfterAdmission(deps, input);
      return { status: 200, body: { refused: 'work-spec-mismatch' } };
    }
    if (outcome.kind === 'invalid' || outcome.kind === 'forbidden') {
      logger.error(
        'agent-lcars: GitHub webhook admission rejected',
        outcome.message,
      );
      return { status: 500, body: { error: 'internal' } };
    }

    await refreshGithubAnchorProjectionAfterAdmission(deps, input);
    return {
      status: 200,
      body: {
        runId: outcome.runId,
        dispatched: outcome.dispatched,
      },
    };
  } catch (error) {
    if (error instanceof ProjectionRefreshError) throw error;
    return internalError('webhook delivery', error);
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
    const swept = await deps.orchestrator.sweepExpired();
    const closedAnchors = await reconcileClosedQueuedImplementations(deps);
    // One drain owns the whole bounded maintenance pass so its failed-entry
    // exclusion remains effective across all 30 claims. The five-minute
    // ticker continues any larger backlog on its next pass.
    const outboxLimit = 30;
    const drained = await deps.drain(outboxLimit);
    const outboxProcessed =
      drained.dispatched.length +
      drained.reported.length +
      drained.failed.length;
    return {
      status: 200,
      body: {
        lost: swept.lost.map((run) => run.runId),
        retried: swept.retried,
        closedAnchorsCanceled: closedAnchors.canceled,
        ...(closedAnchors.failed.length === 0
          ? {}
          : { closedAnchorChecksFailed: closedAnchors.failed }),
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
