import 'server-only';

import {
  isLive,
  isRefusal,
  type Orchestrator,
  type OrchestratorStore,
  type Run,
} from '@agent-lcars/orchestrator';
import { runsContract } from '@agent-lcars/work';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { implement, ORPCError } from '@orpc/server';

import { anchorTarget } from './anchor-target';
import type { DispatchTokenProvider } from './github-app-tokens';
import { toRunResult } from './orchestrator-routes';
import { hashRunToken, mintRunToken, runTokenMatches } from './run-token';
import type { WorkPrincipal } from './work-auth';

export interface RunsContext {
  /** Set by the route from `Authorization: Bearer <token>` verbatim --
   *  unlike `WorkContext.principal`, never itself verified against Google/
   *  session auth: every run-token route below hashes it and compares
   *  against the claimed run's own `queue.tokenHash`. */
  bearerToken?: string;
  /** Set only when the bearer verified as a Google ID token (`claim`'s
   *  gate); `undefined` for a raw run-token bearer, which never resolves
   *  to a `WorkPrincipal`. */
  principal?: WorkPrincipal;
  store: OrchestratorStore;
  orchestrator: Orchestrator;
  tokens: DispatchTokenProvider;
  checkoutTokens: DispatchTokenProvider;
}

const os = implement(runsContract).$context<RunsContext>();

/** `claim`'s gate: a Google-ID-token principal carrying `work.executor`.
 *  Structurally identical to `work-router.ts`'s `operator` middleware.
 *  Built with `os.use(...)`, NOT `os.claim.use(...)` -- `@orpc/server`
 *  2.0.0-beta.31's `ProcedureImplementer.use` returns an implementer for
 *  that SAME procedure, not a reusable builder, so `os.claim.use(mw)`
 *  cannot be chained into `.claim.handler(...)` the way this looked at
 *  first. `os.use(mw)` returns a router-level implementer instead, whose
 *  own `.claim` accessor carries the middleware -- applied below to
 *  exactly the one procedure that needs it. */
const executor = os.use(async ({ context, next }) => {
  if (!context.principal?.scopes.has('work.executor')) {
    throw new ORPCError('UNAUTHORIZED', {
      message: 'work.executor scope required',
    });
  }
  return next({ context: { principal: context.principal } });
});

/** Loads the run named by the path, verifies the bearer's hash against
 *  `run.queue.tokenHash` in constant time, that the run is still live
 *  (`isLive(run.state)`), and that its lease has not already expired --
 *  in that order, so a completed run's leaked token is refused even if
 *  its `leaseExpiresAt` (never advanced past settlement) happens to still
 *  read as "in the future". This is the token-invalidation mechanism the
 *  design spec's "Token model" describes as emergent from liveness: it is
 *  emergent only because THIS check enforces it, on every run-token
 *  route, not because `report`/`cancel` clear anything extra. Every
 *  non-`claim` route calls this first, by hand (not middleware: the runId
 *  lives in the validated input, which middleware registered via `.use`
 *  cannot see). */
async function requireRunToken(
  context: RunsContext,
  runId: string,
  now: () => string = () => new Date().toISOString(),
): Promise<Run> {
  const run = await context.store.readRun(runId);
  const token = context.bearerToken;
  if (
    run?.queue?.tokenHash === undefined ||
    token === undefined ||
    !runTokenMatches(token, run.queue.tokenHash)
  ) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Invalid run token' });
  }
  if (!isLive(run.state)) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Run is no longer live' });
  }
  if (Date.parse(run.leaseExpiresAt) <= Date.parse(now())) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Run token expired' });
  }
  return run;
}

/** `claim` retry budget for a stale queue entry -- see the loop's own
 *  comment below. */
const MAX_CLAIM_ATTEMPTS = 5;

export const runsRouter = os.router({
  claim: executor.claim.handler(async ({ input, context }) => {
    // A `work.executor` principal may only claim pipelines its own grant
    // lists -- the same rule `work-router.ts`'s `forbiddenReason` applies
    // to `create`/`redispatch`, just answering "nothing claimed" instead
    // of a 403 (there is no caller-actionable error to report here: an
    // executor's grant is an infra concern, not something a claim request
    // can be retried its way around). Intersecting BEFORE the store call,
    // rather than filtering `claimQueuedRun`'s result afterward, is what
    // matters: a claim outside the grant must never reach `claimed` --
    // and therefore never reach `checkoutToken`, which would otherwise
    // mint a real GitHub write token for a repo this principal was never
    // trusted with.
    const allowedPipelines = input.pipelines.filter((pipeline) =>
      context.principal.pipelines.includes(pipeline),
    );
    if (allowedPipelines.length === 0) return undefined;

    // `claimQueuedRun` claims by `queue.state === 'queued'` alone; it says
    // nothing about whether the run itself is still live. Cancellation and
    // the lease-expiry sweep both settle a run (and release its task's
    // lock) without touching `Run.queue` -- see the design spec's queue
    // state machine -- so a claim can legitimately land on a run that is
    // already `canceled`/`lost`/`finished`. Each attempt still moves that
    // entry to `claimed` (taking it out of future claims), so retrying is
    // enough to skip past it rather than needing a separate "release"
    // call the store has no method for; bounded at
    // `MAX_CLAIM_ATTEMPTS` so one pathological run of stale queue entries
    // cannot spin unboundedly before answering "nothing queued".
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
      // Mint the token BEFORE the one claimQueuedRun call: minting is a
      // local crypto.randomBytes call, not a network round trip, so the
      // "wasted mint on a claim that turns out already taken" cost of
      // minting speculatively is negligible next to the alternative --
      // claiming first with a placeholder hash, then overwriting it --
      // which would need a second store round trip that Task 2's
      // `claimQueuedRun` was never designed to compose safely with a race.
      // One call, one transaction, no store signature change.
      const token = mintRunToken();
      const claimed = await context.store.claimQueuedRun({
        pipelines: allowedPipelines,
        now: new Date().toISOString(),
        claimedBy: input.runner,
        tokenHash: hashRunToken(token),
      });
      if (claimed === undefined) return undefined;
      if (!isLive(claimed.state)) continue;
      const renewed = await context.orchestrator.renew(claimed.runId);
      const expiresAt = isRefusal(renewed)
        ? claimed.leaseExpiresAt
        : (renewed.run?.leaseExpiresAt ?? claimed.leaseExpiresAt);
      return {
        runId: claimed.runId,
        workId: 'workId' in claimed.task ? claimed.task.workId : '',
        pipeline: claimed.pipeline,
        token,
        expiresAt,
      };
    }
    return undefined;
  }),

  brief: os.brief.handler(async ({ input, context, errors }) => {
    const run = await requireRunToken(context, input.runId);
    if (!('workId' in run.task)) throw errors.UNAUTHORIZED();
    const task = await context.store.readTask(run.task);
    const work = task?.task.work;
    const spec = work?.['spec'];
    if (spec === undefined || typeof spec !== 'object' || task === undefined) {
      throw errors.UNAUTHORIZED({ message: 'run has no dispatchable spec' });
    }
    const target = anchorTarget(run, task.task);
    const generationMatch = /\/r(\d+)$/u.exec(run.runId);
    const generation = generationMatch ? Number(generationMatch[1]) : 1;
    const specRecord = spec as {
      title: string;
      description: string;
      target: { repo: string };
    };
    return {
      id: run.task.workId,
      spec: specRecord as never,
      anchor: {
        type: 'work' as const,
        id: run.task.workId,
        title: specRecord.title,
        body: specRecord.description,
        target_repo: target.repo,
        html_url: `${process.env['AGENT_LCARS_CONSOLE_URL'] ?? 'https://lcars.jlapenna.net'}/work/${run.task.workId}`,
      },
      attemptId: `g${generation}:${run.runId}`,
      generation,
      intentId: run.runId,
    };
  }),

  heartbeat: os.heartbeat.handler(async ({ input, context }) => {
    const run = await requireRunToken(context, input.runId);
    const renewed = await context.orchestrator.renew(run.runId);
    if (isRefusal(renewed)) {
      return { runId: run.runId, expiresAt: run.leaseExpiresAt };
    }
    return {
      runId: run.runId,
      expiresAt: renewed.run?.leaseExpiresAt ?? run.leaseExpiresAt,
    };
  }),

  complete: os.complete.handler(async ({ input, context }) => {
    const run = await requireRunToken(context, input.runId);
    // Same task fetch checkoutToken already needs below: a native run's
    // anchorTarget cannot resolve spec.target.repo from the run alone.
    const task =
      'workId' in run.task
        ? (await context.store.readTask(run.task))?.task
        : undefined;
    const target = anchorTarget(run, task);
    // Reuses orchestrator-routes.ts's own outcome-vocabulary mapping
    // (OK_OUTCOMES, the pull-request ref shape) rather than a smaller
    // local reimplementation -- one mapping, one place it can drift.
    const result = toRunResult(
      target.repo,
      input.outcome,
      input.outcomeReference,
    );
    const settled = await context.orchestrator.report(run.runId, result);
    return {
      runId: run.runId,
      state: isRefusal(settled) ? settled.reason : 'finished',
    };
  }),

  checkoutToken: os.checkoutToken.handler(async ({ input, context }) => {
    const run = await requireRunToken(context, input.runId);
    const task =
      'workId' in run.task
        ? (await context.store.readTask(run.task))?.task
        : undefined;
    const target = anchorTarget(run, task);
    const token = await context.checkoutTokens.tokenFor(target.repo);
    return {
      token,
      repository: target.repo,
      // The provider caches per-repo until close to expiry (see
      // `AppInstallationTokenProvider`) but does not expose that instant;
      // installation tokens are always valid ~1h, so a conservative fixed
      // window is honest here rather than fabricating precision the
      // provider does not return.
      expiresAt: new Date(Date.now() + 45 * 60_000).toISOString(),
    };
  }),
});

export function createRunsHandler(): OpenAPIHandler<RunsContext> {
  return new OpenAPIHandler(runsRouter);
}
