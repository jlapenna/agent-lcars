import {
  type Orchestrator,
  type OrchestratorStore,
  type Run,
  type TaskId,
} from '@agent-lcars/orchestrator';

import {
  githubAnchorProjectionAnchorsFromDelivery,
  githubAnchorProjectionDeletionFromDelivery,
} from '@/lib/github-anchor-projection';
import { refreshCurrentGithubAnchorProjection } from '@/lib/github-anchor-refresh';
import { admitGithubWork } from '@/lib/github-work-admission';
import type { DrainOutboxResult } from '@/lib/orchestrator-dispatch';
import { interpretDelivery } from '@/lib/orchestrator-ingest';

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
  drain: () => Promise<DrainOutboxResult>;
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
  console.error(`agent-lcars: orchestrator ${context} handling failed`, error);
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
      try {
        await refreshGithubAnchorProjection(deps, input);
      } catch (error) {
        throw new ProjectionRefreshError(
          `Projection refresh failed for ${input.event}/${input.deliveryId}`,
          { cause: error },
        );
      }
      return { status: 200, body: { ignored: interpreted.reason } };
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
      console.error(
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
    const drained = await deps.drain();
    return {
      status: 200,
      body: {
        lost: swept.lost.map((run) => run.runId),
        retried: swept.retried,
        dispatched: drained.dispatched,
        reported: drained.reported,
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
