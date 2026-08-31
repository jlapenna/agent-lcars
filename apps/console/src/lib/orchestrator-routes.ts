import {
  decidedRun,
  isRefusal,
  type Orchestrator,
  type OrchestratorStore,
  type Run,
  type TaskId,
} from '@agent-lcars/orchestrator';

import {
  defaultDispatchRequestId,
  type parseHostedDispatchRequestBody,
} from '@/lib/control-plane-request';
import { githubAnchorProjectionAnchorsFromDelivery } from '@/lib/github-anchor-projection';
import { refreshCurrentGithubAnchorProjection } from '@/lib/github-anchor-reconcile';
import type { DrainOutboxResult } from '@/lib/orchestrator-dispatch';
import { interpretDelivery } from '@/lib/orchestrator-ingest';

/**
 * Pure-ish HTTP handlers for the three control-plane routes, kept out of
 * `app/api/**` so they can be driven directly in tests without Next.js's
 * Request/Response plumbing. Each route file is a thin shell: verify auth,
 * parse the body, call the matching handler here, forward its
 * `{status, body}` verbatim. No handler here ever throws -- an unexpected
 * failure is caught and turned into a 500 with an opaque body so nothing
 * from `error` (which may carry request internals) reaches the caller.
 */

export interface OrchestratorRouteDeps {
  store: OrchestratorStore;
  orchestrator: Orchestrator;
  drain: () => Promise<DrainOutboxResult>;
  /** Test seam for the exact server-side refresh; production uses the shared
   * reconciler rather than interpreting partial webhook payloads. */
  refreshGithubAnchorProjection?: (anchor: TaskId) => Promise<void>;
}

export type HostedDispatchRequestBody = ReturnType<
  typeof parseHostedDispatchRequestBody
>;

type RouteResult = { status: number; body: Record<string, unknown> };

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

export async function handleWebhookDelivery(
  deps: OrchestratorRouteDeps,
  input: { event: string; deliveryId: string; payload: unknown },
): Promise<RouteResult> {
  try {
    for (const anchor of githubAnchorProjectionAnchorsFromDelivery(input)) {
      await (
        deps.refreshGithubAnchorProjection ??
        refreshCurrentGithubAnchorProjection
      )(anchor);
    }
    const interpreted = interpretDelivery(input);
    if (interpreted.kind === 'ignore') {
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

    const outcome = await deps.orchestrator.request({
      taskId: interpreted.taskId,
      requestId: interpreted.requestId,
      pipeline: interpreted.pipeline,
      params,
      work: interpreted.work,
    });

    if (isRefusal(outcome)) {
      if (outcome.reason === 'task-busy') {
        return { status: 200, body: { refused: 'task-busy' } };
      }
      if (outcome.reason === 'duplicate-request') {
        return {
          status: 200,
          body: { duplicate: true, runId: outcome.existingRun?.runId },
        };
      }
      // `request()` only ever refuses with `task-busy` or
      // `duplicate-request` (see decide.ts's `requestRun`) -- any other
      // reason means the decision layer's contract changed underneath us.
      console.error(
        'agent-lcars: unexpected orchestrator refusal on request',
        outcome.reason,
      );
      return { status: 500, body: { error: 'internal' } };
    }

    const drained = await deps.drain();
    // `request()` never refuses this outcome without carrying a run.
    const { runId } = decidedRun(outcome);
    return {
      status: 200,
      body: {
        runId,
        dispatched: drained.dispatched.includes(runId),
      },
    };
  } catch (error) {
    return internalError('webhook delivery', error);
  }
}

/** Builds the params record forwarded to `orchestrator.request` -- a key is
 *  present only when the caller actually sent that field, mirroring
 *  `interpretDelivery`'s params (each trigger only includes what it has
 *  something to say about). An absent `runbook`/`context` still reaches the
 *  worker as `''` -- see `orchestrator-dispatch.ts`'s dispatch inputs -- this
 *  just keeps that default out of the stored `Run.params` itself. */
function dispatchRequestParams(
  body: HostedDispatchRequestBody,
): Record<string, string> {
  const params: Record<string, string> = {};
  if (body.mode !== undefined) params['mode'] = body.mode;
  if (body.reply !== undefined) params['reply'] = body.reply;
  if (body.runbook !== undefined) params['runbook'] = body.runbook;
  if (body.context !== undefined) params['context'] = body.context;
  return params;
}

/**
 * The OIDC-authenticated internal-workflow request path (#1215): an
 * onboarded repository's own main-branch automation (sprinkles's pr-heal,
 * playbook-unstick-prs, visual-refresh, post-deploy-verify today) asking the
 * control plane to work an issue, carrying `runbook`/`context` dispatch
 * parameters the label-admission webhook has no way to express.
 *
 * `repository`/`callerRunId` come from the caller's already-verified OIDC
 * claims (`verifyRequestOidcToken`), never from the request body itself --
 * the body only names the issue and the dispatch parameters, not which repo
 * it's for.
 *
 * Refusals are answered the same idempotent-friendly way
 * `handleWebhookDelivery` answers them, with one difference: `task-busy`
 * also returns the live run's id (`existingRun`), because an internal-
 * automation caller -- unlike a human relabeling an issue -- has no other
 * way to discover it and reasonably wants to know what it's waiting on.
 */
export async function handleDispatchRequest(
  deps: OrchestratorRouteDeps,
  input: {
    repository: string;
    callerRunId: number;
    body: HostedDispatchRequestBody;
  },
): Promise<RouteResult> {
  try {
    const { body } = input;
    const requestId =
      body.requestId ??
      defaultDispatchRequestId({
        repository: input.repository,
        issue: body.issue,
        ...(body.runbook === undefined ? {} : { runbook: body.runbook }),
        callerRunId: input.callerRunId,
      });

    const outcome = await deps.orchestrator.request({
      taskId: { repo: input.repository, issue: body.issue },
      requestId,
      pipeline: body.pipeline,
      params: dispatchRequestParams(body),
      // #1633 owns migration of this residual workflow endpoint to the
      // contract-first Work API after its external consumers move.
    });

    if (isRefusal(outcome)) {
      if (outcome.reason === 'task-busy') {
        return {
          status: 200,
          body: { refused: 'task-busy', runId: outcome.existingRun?.runId },
        };
      }
      if (outcome.reason === 'duplicate-request') {
        return {
          status: 200,
          body: { duplicate: true, runId: outcome.existingRun?.runId },
        };
      }
      // Same contract as `handleWebhookDelivery`: `request()` only ever
      // refuses with `task-busy` or `duplicate-request`.
      console.error(
        'agent-lcars: unexpected orchestrator refusal on dispatch request',
        outcome.reason,
      );
      return { status: 500, body: { error: 'internal' } };
    }

    const drained = await deps.drain();
    // `request()` never refuses this outcome without carrying a run.
    const { runId } = decidedRun(outcome);
    return {
      status: 200,
      body: {
        runId,
        dispatched: drained.dispatched.includes(runId),
      },
    };
  } catch (error) {
    return internalError('dispatch request', error);
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
