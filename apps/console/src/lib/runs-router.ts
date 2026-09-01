import 'server-only';

import crypto from 'node:crypto';

import {
  isLive,
  isRefusal,
  isWorkAnchor,
  type Orchestrator,
  type OrchestratorStore,
  type Run,
} from '@agent-lcars/orchestrator';
import { runsContract, workSpecSchema } from '@agent-lcars/work';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { implement, ORPCError } from '@orpc/server';

import { anchorTarget } from './anchor-target';
import { type CodexAuthStore, CodexAuthStoreError } from './codex-auth-store';
import { consoleUrl } from './deployment';
import type { DispatchTokenProvider } from './github-app-tokens';
import { toRunResult } from './run-result';
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
  codexAuth: CodexAuthStore;
  /** Injected clock: every timestamp this router stamps (`requireRunToken`'s
   *  lease-expiry check, `claim`'s `claimedAt`, `checkoutToken`'s
   *  `expiresAt`) must be deterministic under test, not tied to wall-clock
   *  `Date.now()`/`new Date()` -- mirrors `WorkContext.now` (`work-
   *  mint.ts`). The `Orchestrator` instance above owns the clock that
   *  actually stamps `leaseExpiresAt` (its own private `Clock`, not this
   *  field), so production wires both to the same `() => new Date()`
   *  source; a test fixture wires both to the same fictional clock
   *  instead. */
  now: () => Date;
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
  if (Date.parse(run.leaseExpiresAt) <= context.now().getTime()) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Run token expired' });
  }
  return run;
}

async function requireCodexRun(
  context: RunsContext,
  runId: string,
): Promise<{ run: Run; repository: string }> {
  const run = await requireRunToken(context, runId);
  if (run.pipeline !== 'codex') {
    throw new ORPCError('UNAUTHORIZED', {
      message: 'Codex authentication is only available to Codex runs',
    });
  }
  const task =
    'workId' in run.task
      ? (await context.store.readTask(run.task))?.task
      : undefined;
  return { run, repository: anchorTarget(run, task).repo };
}

function codexAuthError(
  error: unknown,
  errors: {
    NOT_FOUND?: (options?: { message?: string }) => Error;
    BAD_REQUEST?: (options?: { message?: string }) => Error;
    CONFLICT?: (options?: { message?: string }) => Error;
    INTERNAL_SERVER_ERROR: (options?: { message?: string }) => Error;
  },
): never {
  if (error instanceof CodexAuthStoreError) {
    if (error.kind === 'not-found' && errors.NOT_FOUND) {
      throw errors.NOT_FOUND();
    }
    if (error.kind === 'invalid' && errors.BAD_REQUEST) {
      throw errors.BAD_REQUEST();
    }
    if (error.kind === 'conflict' && errors.CONFLICT) {
      throw errors.CONFLICT();
    }
  }
  throw errors.INTERNAL_SERVER_ERROR();
}

/** `claim` retry budget for a stale queue entry -- see the loop's own
 *  comment below. */
const MAX_CLAIM_ATTEMPTS = 5;
const MAX_CODEX_LEASE_ATTEMPTS = 5;

async function acquireCodexLease(
  context: RunsContext,
  run: Run,
  repository: string,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_CODEX_LEASE_ATTEMPTS; attempt++) {
    const lease = await context.codexAuth.readLease();
    if (lease === undefined) {
      try {
        await context.codexAuth.createLease({
          runId: run.runId,
          repository,
          expiresAt: run.leaseExpiresAt,
        });
        return;
      } catch (error) {
        if (error instanceof CodexAuthStoreError && error.kind === 'conflict') {
          continue;
        }
        throw error;
      }
    }
    if (lease.runId === run.runId && lease.repository === repository) return;

    // This record is also owned by the hosted GitHub lane, whose run ID is
    // intentionally not a broker run. Its expiry is therefore the shared
    // stale-takeover authority; consulting only the broker store would let a
    // direct runner race a hosted single-use refresh token.
    if (Date.parse(lease.expiresAt) > context.now().getTime()) {
      throw new CodexAuthStoreError(
        'conflict',
        'Codex subscription authentication is already in use',
      );
    }
    try {
      await context.codexAuth.takeLease({
        runId: run.runId,
        repository,
        expiresAt: run.leaseExpiresAt,
        expectedGeneration: lease.generation,
      });
      return;
    } catch (error) {
      if (error instanceof CodexAuthStoreError && error.kind === 'conflict') {
        continue;
      }
      throw error;
    }
  }
  throw new CodexAuthStoreError(
    'conflict',
    'Codex subscription lease changed concurrently',
  );
}

async function requireCodexLeaseOwner(
  context: RunsContext,
  runId: string,
  repository: string,
): Promise<void> {
  const lease = await context.codexAuth.readLease();
  if (lease?.runId !== runId || lease.repository !== repository) {
    throw new CodexAuthStoreError(
      'conflict',
      'Codex subscription lease is not owned by this run',
    );
  }
}

/** Renew the shared credential lease with the QueueExecutor run's freshly
 * renewed expiry, so no executor may continue using the rotating credential
 * after its record becomes stealable. */
async function renewCodexLease(
  context: RunsContext,
  runId: string,
  expiresAt: string,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_CODEX_LEASE_ATTEMPTS; attempt++) {
    const lease = await context.codexAuth.readLease();
    if (lease?.runId !== runId) {
      throw new CodexAuthStoreError(
        'conflict',
        'Codex subscription lease is not owned by this run',
      );
    }
    try {
      await context.codexAuth.takeLease({
        runId,
        repository: lease.repository,
        expiresAt,
        expectedGeneration: lease.generation,
      });
      return;
    } catch (error) {
      if (error instanceof CodexAuthStoreError && error.kind === 'conflict') {
        continue;
      }
      throw error;
    }
  }
  throw new CodexAuthStoreError(
    'conflict',
    'Codex subscription lease changed concurrently',
  );
}

export const runsRouter = os.router({
  claim: executor.claim.handler(async ({ input, context }) => {
    // The executor's authenticated grant is the only claim capability
    // source; a caller cannot choose a pipeline set that competes with
    // server-side authorization.
    // Passing the executor grant directly to the transactional store is what
    // prevents an ungranted run from reaching `claimed` (and therefore ever
    // minting a checkout token). Codex's subscription lease is enforced only
    // by its credential adapter after a run is claimed; it never changes the
    // shared executor grant or the route used to claim any provider.
    if (context.principal.pipelines.length === 0) return undefined;

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
        pipelines: context.principal.pipelines,
        now: context.now().toISOString(),
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
        ...('workId' in claimed.task ? { workId: claimed.task.workId } : {}),
        pipeline: claimed.pipeline,
        token,
        expiresAt,
      };
    }
    return undefined;
  }),

  brief: os.brief.handler(async ({ input, context, errors }) => {
    const run = await requireRunToken(context, input.runId);
    const task = await context.store.readTask(run.task);
    const mode = run.params?.['mode'];
    if (!mode || !['implement', 'review', 'reply'].includes(mode)) {
      throw errors.UNAUTHORIZED({ message: 'run has no valid dispatch mode' });
    }
    const params = {
      mode,
      reply: run.params?.['reply'] ?? '',
      runbook: run.params?.['runbook'] ?? '',
      context: run.params?.['context'] ?? '',
    };
    const generationMatch = /\/r(\d+)$/u.exec(run.runId);
    const generation = generationMatch ? Number(generationMatch[1]) : 1;
    const shared = {
      pipeline: run.pipeline,
      ...params,
      attemptId: `g${generation}:${run.runId}`,
      generation,
      intentId: run.runId,
      ...(run.params?.['resumeSessionId'] !== undefined &&
      run.params?.['resumeTranscriptGcsUri'] !== undefined
        ? {
            resume: {
              sessionId: run.params['resumeSessionId'],
              transcriptGcsUri: run.params['resumeTranscriptGcsUri'],
            },
          }
        : {}),
    };

    if (!isWorkAnchor(run.task)) {
      const parsed = workSpecSchema.safeParse(task?.task.work?.['spec']);
      if (!parsed.success) {
        throw errors.UNAUTHORIZED({ message: 'run has no dispatchable spec' });
      }
      return {
        anchor: {
          type: 'github' as const,
          repo: run.task.repo,
          issue: run.task.issue,
          html_url: `https://github.com/${run.task.repo}/issues/${run.task.issue}`,
        },
        work: { spec: parsed.data },
        ...shared,
      };
    }

    const work = task?.task.work;
    if (work === undefined || task === undefined) {
      throw errors.UNAUTHORIZED({ message: 'run has no dispatchable spec' });
    }
    // `mintItem` never stores a spec that doesn't already pass this exact
    // schema, so a claimed run whose stored spec fails to parse here is
    // not a caller mistake -- it is a server bug (a schema tightened out
    // from under an already-stored task, or corrupted data). Logged with
    // the parse issues for diagnosis; the caller gets only the generic
    // 500 an undeclared `ORPCError` already produces, never the parse
    // detail or the raw stored value.
    const parsed = workSpecSchema.safeParse(work['spec']);
    if (!parsed.success) {
      console.error(
        'agent-lcars: claimed run has a stored spec that no longer parses',
        { runId: run.runId, workId: run.task.workId, error: parsed.error },
      );
      throw new ORPCError('INTERNAL_SERVER_ERROR', {
        message: 'run has a corrupted spec',
      });
    }
    const spec = parsed.data;
    const target = anchorTarget(run, task.task);
    return {
      id: run.task.workId,
      spec,
      anchor: {
        type: 'work' as const,
        id: run.task.workId,
        title: spec.title,
        body: spec.description,
        target_repo: target.repo,
        html_url: `${consoleUrl()}/work/${run.task.workId}`,
      },
      ...shared,
    };
  }),

  heartbeat: os.heartbeat.handler(async ({ input, context }) => {
    const run = await requireRunToken(context, input.runId);
    const renewed = await context.orchestrator.renew(run.runId);
    if (isRefusal(renewed)) {
      return { runId: run.runId, expiresAt: run.leaseExpiresAt };
    }
    const expiresAt = renewed.run?.leaseExpiresAt ?? run.leaseExpiresAt;
    if (run.pipeline === 'codex') {
      await renewCodexLease(context, run.runId, expiresAt);
    }
    return {
      runId: run.runId,
      expiresAt,
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
    try {
      const settled = await context.orchestrator.report(run.runId, result);
      return {
        runId: run.runId,
        state: isRefusal(settled) ? settled.reason : 'finished',
      };
    } finally {
      if (run.pipeline === 'codex') {
        await context.codexAuth.releaseLease(run.runId);
      }
    }
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
      // provider does not return. `context.now()`, not `Date.now()`,
      // matches `requireRunToken`'s own injected clock -- deterministic
      // under test.
      expiresAt: new Date(context.now().getTime() + 45 * 60_000).toISOString(),
    };
  }),

  codexAuth: os.codexAuth.handler(async ({ input, context, errors }) => {
    const { run, repository } = await requireCodexRun(context, input.runId);
    let acquired = false;
    try {
      await acquireCodexLease(context, run, repository);
      acquired = true;
      return await context.codexAuth.read();
    } catch (error) {
      if (acquired) await context.codexAuth.releaseLease(run.runId);
      return codexAuthError(error, errors);
    }
  }),

  persistCodexAuth: os.persistCodexAuth.handler(
    async ({ input, context, errors }) => {
      const { repository } = await requireCodexRun(context, input.runId);
      let persisted = false;
      let result:
        | { status: 'skipped-burned' }
        | { status: 'unchanged' }
        | { status: 'updated' }
        | undefined;
      let operationError: unknown;
      try {
        await requireCodexLeaseOwner(context, input.runId, repository);

        // #1192: a Codex process that positively reported one of the three
        // known refresh-failure signatures must never advance the stored
        // lineage. The direct runner derives this narrow enum from trusted
        // Codex failure events/stderr; the broker makes the refusal
        // authoritative before any GCS write.
        if (input.authFailure !== undefined) {
          result = { status: 'skipped-burned' };
        } else {
          const bytes = Buffer.from(input.authBase64, 'base64');
          const endSha256 = crypto
            .createHash('sha256')
            .update(bytes)
            .digest('hex');
          if (endSha256 === input.restoredSha256) {
            result = { status: 'unchanged' };
          } else {
            await context.codexAuth.replace({
              expectedGeneration: input.generation,
              authBase64: input.authBase64,
            });
            persisted = true;
            result = { status: 'updated' };
          }
        }
      } catch (error) {
        operationError = error;
      }
      try {
        await context.codexAuth.releaseLease(input.runId);
      } catch (error) {
        // Once the replacement is durable, a best-effort delete cannot make
        // that successful rotation look like a 500/no-deliverable. If the
        // operation failed, retain that operation's original response rather
        // than letting cleanup mask it.
        if (persisted || operationError !== undefined) {
          console.error('agent-lcars: failed to release Codex auth lease', {
            runId: input.runId,
            error,
          });
        } else {
          return codexAuthError(error, errors);
        }
      }
      if (operationError !== undefined)
        return codexAuthError(operationError, errors);
      if (result === undefined) {
        return codexAuthError(
          new Error('Codex credential persistence produced no result'),
          errors,
        );
      }
      return result;
    },
  ),
});

export function createRunsHandler(): OpenAPIHandler<RunsContext> {
  return new OpenAPIHandler(runsRouter);
}
