import {
  decidedRun,
  isGithubAnchor,
  isRefusal,
  isWorkAnchor,
  type Orchestrator,
  type OrchestratorStore,
  type RunResult,
} from '@agent-lcars/orchestrator';
import { z } from 'zod';

import { anchorTarget } from '@/lib/anchor-target';
import {
  defaultDispatchRequestId,
  type parseHostedCompletionRequestBody,
  type parseHostedDispatchRequestBody,
} from '@/lib/control-plane-request';
import type { CompletionOidcIdentity } from '@/lib/github-actions-oidc';
import type {
  DispatchTokenProvider,
  DrainOutboxResult,
} from '@/lib/orchestrator-dispatch';
import { interpretDelivery } from '@/lib/orchestrator-ingest';
import type { SettleTerminalRunsResult } from '@/lib/orchestrator-terminal-runs';
import {
  bindCompletionToRun,
  BindingUnavailable,
  type RunBinding,
} from '@/lib/run-binding';

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
  /** Settles live runs whose GitHub workflow run is already terminal (see
   *  `orchestrator-terminal-runs.ts`). Injected rather than called directly
   *  for the same reason `drain` is: it does GitHub I/O, and these handlers
   *  stay drivable in tests without it. */
  settleTerminal: () => Promise<SettleTerminalRunsResult>;
  /** Token provider `defaultBind` (below) uses to fetch the Actions run
   *  named by a completion token's OIDC claims (see `run-binding.ts`).
   *  Optional: a caller that only wants `store`/`orchestrator` -- e.g.
   *  `authoritative-task-state.ts`'s pure Firestore read -- must not be
   *  forced to hold GitHub App credentials just to construct this object.
   *  The production runtime supplies its own `bind` closure instead of
   *  this field (see `orchestrator-runtime.ts`), so `tokens` there stays
   *  unset and `defaultBind` is never actually reached outside tests. */
  tokens?: DispatchTokenProvider;
  /** Injectable for tests; forwarded to `bindCompletionToRun` by
   *  `defaultBind`. */
  fetchImpl?: typeof fetch;
  /** Injectable GitHub REST root; forwarded to `bindCompletionToRun` by
   *  `defaultBind`. */
  githubApiBaseUrl?: string;
  /** Proves a completion token belongs to the run it claims to complete.
   *  Defaults to `defaultBind` (below) when absent; tests inject a stub so
   *  they can drive the binding decision directly rather than through a
   *  real (faked) GitHub fetch. */
  bind?: (
    deps: OrchestratorRouteDeps,
    identity: CompletionOidcIdentity,
    runId: string,
    repo: string,
  ) => Promise<RunBinding>;
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

/**
 * `deps.bind`'s default when the caller doesn't inject one. Reads
 * `deps.tokens`/`fetchImpl`/`githubApiBaseUrl` directly and fails closed
 * (the same `BindingUnavailable` a GitHub outage produces) when `tokens` is
 * absent, rather than silently skipping the binding check. In production
 * this path is never reached -- `createOrchestratorRuntime()` supplies its
 * own `bind` closure, resolved fresh per call the way `drain` is (see
 * `orchestrator-runtime.ts`) -- so this exists for tests that want the real
 * `bindCompletionToRun` behavior without stubbing `bind` themselves.
 */
async function defaultBind(
  deps: OrchestratorRouteDeps,
  identity: CompletionOidcIdentity,
  runId: string,
  repo: string,
): Promise<RunBinding> {
  if (deps.tokens === undefined) {
    throw new BindingUnavailable('no token provider configured');
  }
  return bindCompletionToRun(
    {
      tokens: deps.tokens,
      fetchImpl: deps.fetchImpl,
      githubApiBaseUrl: deps.githubApiBaseUrl,
    },
    identity,
    runId,
    repo,
  );
}

/**
 * Handles a finalizer completion callback. The caller's OIDC token proves
 * only "a trusted finalizer on an allow-listed repository" -- it says
 * nothing about *which* run. `bindCompletionToRun` (`run-binding.ts`) closes
 * that gap: it fetches the Actions run the token names and checks its
 * dispatch marker against the run being completed. This is fail-closed --
 * `BindingUnavailable` (GitHub unreachable/non-2xx) answers `503` rather
 * than settling on an unproven token, and an unbound token answers `403`
 * rather than `200`, in both cases leaving the run untouched for a retry
 * or the lease backstop to resolve.
 */
export async function handleCompletion(
  deps: OrchestratorRouteDeps,
  body: HostedCompletionRequestBody,
  identity: CompletionOidcIdentity,
): Promise<RouteResult> {
  try {
    if (body.intentId === undefined) {
      return { status: 200, body: { ignored: 'unknown-run' } };
    }
    const runId = body.intentId;
    const run = await deps.store.readRun(runId);
    if (run === undefined) {
      // A completion for a run this system never created. Not an error --
      // ack it and move on rather than 5xx-ing the caller.
      return { status: 200, body: { ignored: 'unknown-run' } };
    }
    // GitHub anchors keep the issue tie as a cheap local pre-check; native
    // anchors have no issue and rely on the marker binding alone.
    if (isGithubAnchor(run.task) && run.task.issue !== body.issue) {
      // A legacy dispatch-broker run still in flight during cutover.
      // Not an error -- ack it and move on rather than 5xx-ing the caller.
      return { status: 200, body: { ignored: 'unknown-run' } };
    }

    const task = isWorkAnchor(run.task)
      ? (await deps.store.readTask(run.task))?.task
      : undefined;
    const target = anchorTarget(run, task);

    const bind = deps.bind ?? defaultBind;
    let binding;
    try {
      binding = await bind(deps, identity, runId, target.repo);
    } catch (error) {
      if (error instanceof BindingUnavailable) {
        return { status: 503, body: { error: 'binding-unavailable' } };
      }
      throw error;
    }
    if (!binding.bound) {
      return {
        status: 403,
        body: { error: 'unbound-token', reason: binding.reason },
      };
    }

    const result = toRunResult(
      target.repo,
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

/**
 * One reconcile cycle: settle first, then dispatch what the settling
 * produced.
 *
 * Terminal-run settling (#1361) runs *before* the lease sweep on purpose.
 * Both settle a live run to `lost` and release its task's mutex, but the
 * terminal probe knows *why* (the workflow run is over), where the sweep
 * only knows the run went quiet for a full lease. Running it first means a
 * run whose executor already died is settled on this evidence, with its
 * conclusion recorded, rather than waiting out the lease that would settle
 * it hours later; a run the probe cannot resolve falls through to the sweep
 * exactly as before, which is what keeps the lease a backstop rather than a
 * competing mechanism.
 *
 * The response keeps every key `dispatch-reconcile.yml`'s log already shows
 * and adds `terminal` (the runs settled from a terminal workflow run, with
 * the conclusion that proved it). `retried` is the union of both settle
 * paths' auto-retries -- they are the same mechanism, on the same
 * `MAX_AUTO_RETRIES` budget, and a reader wants one list of "what got
 * retried this cycle".
 */
export async function handleReconcile(
  deps: OrchestratorRouteDeps,
): Promise<RouteResult> {
  try {
    const terminal = await deps.settleTerminal();
    const swept = await deps.orchestrator.sweepExpired();
    const drained = await deps.drain();
    return {
      status: 200,
      body: {
        lost: swept.lost.map((run) => run.runId),
        terminal: terminal.settled,
        retried: [...terminal.retried, ...swept.retried],
        dispatched: drained.dispatched,
        reported: drained.reported,
        ...(terminal.failed.length === 0
          ? {}
          : { terminalProbeFailed: terminal.failed }),
      },
    };
  } catch (error) {
    return internalError('reconcile', error);
  }
}
