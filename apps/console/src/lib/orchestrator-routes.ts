import {
  isRefusal,
  type Orchestrator,
  type OrchestratorStore,
  type RunResult,
} from '@agent-lcars/orchestrator';
import { z } from 'zod';

import {
  defaultDispatchRequestId,
  type parseHostedCompletionRequestBody,
  type parseHostedDispatchRequestBody,
} from '@/lib/control-plane-request';
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

export type HostedCompletionRequestBody = ReturnType<
  typeof parseHostedCompletionRequestBody
>;

export type HostedDispatchRequestBody = ReturnType<
  typeof parseHostedDispatchRequestBody
>;

type RouteResult = { status: number; body: Record<string, unknown> };

function internalError(context: string, error: unknown): RouteResult {
  console.error(`agent-lcars: orchestrator ${context} handling failed`, error);
  return { status: 500, body: { error: 'internal' } };
}

export async function handleWebhookDelivery(
  deps: OrchestratorRouteDeps,
  input: { event: string; deliveryId: string; payload: unknown },
): Promise<RouteResult> {
  try {
    const interpreted = interpretDelivery(input);
    if (interpreted.kind === 'ignore') {
      return { status: 200, body: { ignored: interpreted.reason } };
    }

    const outcome = await deps.orchestrator.request({
      taskId: interpreted.taskId,
      requestId: interpreted.requestId,
      pipeline: interpreted.pipeline,
      params: interpreted.params,
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
    return {
      status: 200,
      body: {
        runId: outcome.run.runId,
        dispatched: drained.dispatched.includes(outcome.run.runId),
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
    return {
      status: 200,
      body: {
        runId: outcome.run.runId,
        dispatched: drained.dispatched.includes(outcome.run.runId),
      },
    };
  } catch (error) {
    return internalError('dispatch request', error);
  }
}

/** Outcomes the executor reports that count as the run having succeeded. */
const OK_OUTCOMES: ReadonlySet<string> = new Set([
  'pull-request',
  'merged-deliverable',
  'comment',
  'review',
  'no-op',
  'unknown-success',
]);

const pullRequestOutcomeReferenceSchema = z.object({
  kind: z.literal('pull-request'),
  number: z.number(),
});

/** Maps the worker's opaque completion callback fields onto the
 *  orchestrator's `RunResult` -- verbatim `summary`, a best-effort `ref`
 *  URL when the reference is a recognizable pull request, `ok` from the
 *  fixed outcome vocabulary above. */
function toRunResult(
  repo: string,
  outcome: unknown,
  outcomeReference: unknown,
): RunResult {
  const summary = typeof outcome === 'string' ? outcome : undefined;
  const parsedRef =
    pullRequestOutcomeReferenceSchema.safeParse(outcomeReference);
  return {
    ok: typeof outcome === 'string' && OK_OUTCOMES.has(outcome),
    ...(summary === undefined ? {} : { summary }),
    ...(parsedRef.success
      ? { ref: `https://github.com/${repo}/pull/${parsedRef.data.number}` }
      : {}),
  };
}

export async function handleCompletion(
  deps: OrchestratorRouteDeps,
  body: HostedCompletionRequestBody,
): Promise<RouteResult> {
  try {
    if (body.intentId === undefined) {
      return { status: 200, body: { ignored: 'unknown-run' } };
    }
    const runId = body.intentId;
    const run = await deps.store.readRun(runId);
    if (run === undefined || run.task.issue !== body.issue) {
      // Either a legacy dispatch-broker run still in flight during cutover,
      // or a completion for a run this system never created. Neither is an
      // error -- ack it and move on rather than 5xx-ing the caller.
      return { status: 200, body: { ignored: 'unknown-run' } };
    }

    const result = toRunResult(
      run.task.repo,
      body.outcome,
      body.outcomeReference,
    );
    const outcome = await deps.orchestrator.report(runId, result);

    if (isRefusal(outcome)) {
      if (outcome.reason === 'unknown-run') {
        return { status: 200, body: { ignored: 'unknown-run' } };
      }
      // `run-not-live` (duplicate completion) or `stale-lease`: idempotent
      // no-ops from the caller's point of view, not errors.
      return { status: 200, body: { refused: outcome.reason } };
    }

    await deps.drain();
    return { status: 200, body: { runId, state: 'finished' } };
  } catch (error) {
    return internalError('completion', error);
  }
}

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
      },
    };
  } catch (error) {
    return internalError('reconcile', error);
  }
}
