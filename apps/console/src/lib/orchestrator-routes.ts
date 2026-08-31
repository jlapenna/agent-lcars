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
import {
  githubAnchorProjectionFromDelivery,
  githubAnchorProjectionSignalFromDelivery,
} from '@/lib/github-anchor-projection';
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
}

export type HostedDispatchRequestBody = ReturnType<
  typeof parseHostedDispatchRequestBody
>;

type RouteResult = { status: number; body: Record<string, unknown> };

const REVIEW_THREAD_ID_LIMIT = 100;

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
    const projection = githubAnchorProjectionFromDelivery({
      event: input.event,
      payload: input.payload,
      observedAt: new Date().toISOString(),
    });
    if (projection !== undefined) {
      await deps.store.upsertGithubAnchorProjection(projection);
    }
    for (const signal of githubAnchorProjectionSignalFromDelivery(input)) {
      await deps.store.updateGithubAnchorProjection(
        signal.anchor,
        (current) => {
          if (current === undefined) return undefined;
          if (signal.comment !== undefined) {
            const latest = current.lastComment;
            const isLatest = latest?.id === signal.comment.id;
            if (signal.comment.action === 'created') {
              if (
                latest?.createdAt !== undefined &&
                latest.createdAt > signal.comment.createdAt
              ) {
                return undefined;
              }
              return {
                ...current,
                lastComment: {
                  id: signal.comment.id,
                  body: signal.comment.body,
                  url: signal.comment.url,
                  ...(signal.comment.author === undefined
                    ? {}
                    : { author: signal.comment.author }),
                  createdAt: signal.comment.createdAt,
                  ...(signal.comment.updatedAt === undefined
                    ? {}
                    : { updatedAt: signal.comment.updatedAt }),
                },
                observedAt: new Date().toISOString(),
              };
            }
            if (!isLatest) {
              // Older comment edit/deletes must not overwrite the preview.
              // An identity-less legacy preview could be the affected latest
              // comment, so clear it rather than serving stale/deleted text.
              if (latest?.id !== undefined) return undefined;
              const { lastComment: _lastComment, ...withoutLastComment } =
                current;
              return {
                ...withoutLastComment,
                observedAt: new Date().toISOString(),
              };
            }
            if (signal.comment.action === 'deleted') {
              const { lastComment: _lastComment, ...withoutLastComment } =
                current;
              return {
                ...withoutLastComment,
                observedAt: new Date().toISOString(),
              };
            }
            return {
              ...current,
              lastComment: {
                ...latest,
                body: signal.comment.body,
                url: signal.comment.url,
                ...(signal.comment.author === undefined
                  ? {}
                  : { author: signal.comment.author }),
                ...(signal.comment.updatedAt === undefined
                  ? {}
                  : { updatedAt: signal.comment.updatedAt }),
              },
              observedAt: new Date().toISOString(),
            };
          }
          if (current.kind !== 'pr') return undefined;
          if (signal.reviewThread !== undefined) {
            const unresolved = new Set(current.unresolvedReviewThreadIds ?? []);
            const omittedCount =
              current.unresolvedReviewThreadOmittedCount ??
              Math.max(
                0,
                (current.unresolvedReviewThreadCount ?? unresolved.size) -
                  unresolved.size,
              );
            const currentCount = unresolved.size + omittedCount;
            if (signal.reviewThread.resolved) {
              const known = unresolved.delete(signal.reviewThread.id);
              // An omitted identity cannot be matched safely. In particular,
              // a duplicate/out-of-order resolve for an already-resolved
              // omitted thread must not decrement a different live blocker.
              if (!known) return undefined;
              return {
                ...current,
                unresolvedReviewThreadIds: [...unresolved],
                unresolvedReviewThreadOmittedCount: omittedCount,
                unresolvedReviewThreadCount: currentCount - 1,
                ...(omittedCount > 0 ? { reviewThreadsTruncated: true } : {}),
                observedAt: new Date().toISOString(),
              };
            }
            if (unresolved.has(signal.reviewThread.id)) return undefined;
            const retained = [...unresolved];
            if (retained.length < REVIEW_THREAD_ID_LIMIT) {
              retained.push(signal.reviewThread.id);
            } else {
              return {
                ...current,
                unresolvedReviewThreadIds: retained,
                unresolvedReviewThreadOmittedCount: omittedCount + 1,
                unresolvedReviewThreadCount: currentCount + 1,
                reviewThreadsTruncated: true,
                observedAt: new Date().toISOString(),
              };
            }
            return {
              ...current,
              unresolvedReviewThreadIds: retained,
              unresolvedReviewThreadOmittedCount: omittedCount,
              unresolvedReviewThreadCount: currentCount + 1,
              observedAt: new Date().toISOString(),
            };
          }
          if (signal.checkRun === undefined) return undefined;
          const existing = (current.checkRuns ?? []).find(
            (check) => check.id === signal.checkRun?.id,
          );
          if (
            existing !== undefined &&
            existing.updatedAt >= signal.checkRun.updatedAt
          ) {
            return undefined;
          }
          const checkRuns = [
            ...(current.checkRuns ?? []).filter(
              (check) => check.id !== signal.checkRun?.id,
            ),
            signal.checkRun,
          ]
            .sort((left, right) =>
              left.updatedAt.localeCompare(right.updatedAt),
            )
            .slice(-100);
          return {
            ...current,
            checkRuns,
            failingChecks: checkRuns
              .filter(
                (check) =>
                  check.status === 'completed' &&
                  check.conclusion === 'failure',
              )
              .map(({ name, url }) => ({ name, url })),
            ciRunning: checkRuns.some((check) => check.status !== 'completed'),
            observedAt: new Date().toISOString(),
          };
        },
      );
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
