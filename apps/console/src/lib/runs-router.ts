import 'server-only';

import { randomBytes } from 'node:crypto';

import {
  formatAttemptId,
  parseRunGeneration,
} from '@agent-lcars/dispatch-contracts';
import { logger } from '@agent-lcars/logging';
import {
  assertCapacityWorkerPermit,
  CapacityProtocol,
  type CapacityWorkerPermit,
  type DeliveryBinding,
  isLive,
  isRefusal,
  isWorkAnchor,
  type Orchestrator,
  type OrchestratorStore,
  retiredKey,
  type Run,
  runRecoveryDeadline,
} from '@agent-lcars/orchestrator';
import { runsContract, workPayloadSchema } from '@agent-lcars/work';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { implement, ORPCError } from '@orpc/server';

import { anchorTarget } from './anchor-target';
import { capacityMetrics } from './capacity-metrics';
import {
  applyCapacityCommand,
  capacityAuthority,
  capacityCall,
  receiptFence,
} from './capacity-routes';
import { verifyCapacityWorkerIdentity } from './capacity-worker-identity';
import { type CodexAuthStore, CodexAuthStoreError } from './codex-auth-store';
import {
  persistCodexCredential,
  releaseCodexCredentialLease,
  renewCodexCredentialLease,
  restoreCodexCredential,
} from './codex-credential-operations';
import { consoleUrl } from './deployment';
import type { GithubAnchorLifecycle } from './github-anchor-lifecycle';
import type {
  DispatchTokenProvider,
  ExpiringDispatchTokenProvider,
} from './github-app-tokens';
import type { DrainOutboxResult } from './orchestrator-dispatch';
import {
  readyDeliveryBinding,
  UnqualifiedDeliveryError,
} from './ready-delivery';
import { toRunResult } from './run-result';
import { hashRunToken, mintRunToken, runTokenMatches } from './run-token';
import { getWatchedRepos } from './watched-repos-config';
import type { WorkPrincipal } from './work-auth';

export interface RunsContext {
  /** Set by the route from `Authorization: Bearer <token>` verbatim --
   *  unlike `WorkContext.principal`, never itself verified against Google/
   *  session auth: every run-token route below hashes it and compares
   *  against the claimed run's own `queue.tokenHash`. */
  bearerToken?: string;
  capacityEnabled?: boolean;
  workerIdentityToken?: string;
  workerGeneration?: number;
  workerPermit?: CapacityWorkerPermit;
  verifyWorkerIdentity?: typeof verifyCapacityWorkerIdentity;
  /** Set only when the bearer verified as a Google ID token (`claim`'s
   *  gate); `undefined` for a raw run-token bearer, which never resolves
   *  to a `WorkPrincipal`. */
  principal?: WorkPrincipal;
  store: OrchestratorStore;
  orchestrator: Orchestrator;
  tokens: DispatchTokenProvider;
  checkoutTokens: ExpiringDispatchTokenProvider;
  codexAuth: CodexAuthStore;
  /** Same outbox drain every other mutating route reaches through
   *  `WorkContext.runtime.drain` (`work-router.ts`, `work-mint.ts`,
   *  `work-reply.ts`) -- `RunsContext` has no `runtime` object of its own
   *  (it is built from the pieces of `OrchestratorRouteDeps` this
   *  router's other routes already needed, not the whole thing), so
   *  `complete` reaches it through this flat field instead. Wired in
   *  production from the same `createOrchestratorRuntime()` the route
   *  file already constructs for `work-router.ts` (see
   *  `app/api/work/v1/[[...rest]]/route.ts`). */
  drain: () => Promise<DrainOutboxResult>;
  loadReadyDeliveryBinding?: typeof readyDeliveryBinding;
  /** Exact lifecycle read before exposing a claimed GitHub implementation
   * run to a worker. Undefined is allowed for isolated callers/tests. */
  loadGithubAnchorLifecycle?: (
    anchor: Extract<Run['task'], { repo: string }>,
  ) => Promise<GithubAnchorLifecycle | undefined>;
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

/** `claim`'s and `exit`'s gate: a Google-ID-token principal carrying
 *  `work.executor`. Structurally identical to `work-router.ts`'s `operator` middleware.
 *  Built with `os.use(...)`, NOT `os.claim.use(...)` -- `@orpc/server`
 *  2.0.0-beta.31's `ProcedureImplementer.use` returns an implementer for
 *  that SAME procedure, not a reusable builder, so `os.claim.use(mw)`
 *  cannot be chained into `.claim.handler(...)` the way this looked at
 *  first. `os.use(mw)` returns a router-level implementer instead, whose
 *  own `.claim` accessor carries the middleware -- applied below to
 *  exactly the executor-authenticated procedures. */
const executor = os.use(async ({ context, next }) => {
  if (!context.principal?.scopes.has('work.executor')) {
    throw new ORPCError('UNAUTHORIZED', {
      message: 'work.executor scope required',
    });
  }
  return next({ context: { principal: context.principal } });
});

/** `exit`'s answer when the caller lacks the run's pipeline grant. The
 *  QueueExecutor matches this text to keep the report retryable. */
const EXIT_PIPELINE_NOT_GRANTED = 'pipeline not granted to this executor';

/** The authenticated identity a claim is bound to: the principal's
 *  verified subject, lower-cased because grants resolve subjects
 *  case-insensitively (`work-grants.ts`'s `resolvePrincipal`). Recorded at
 *  `claim` as `queue.claimedBySubject` and required again by `exit`, so only
 *  the claiming executor can declare a run's worker gone. */
function claimantSubject(principal: WorkPrincipal): string {
  return principal.subject.toLowerCase();
}

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
  if (
    Date.parse(runRecoveryDeadline(run) ?? run.leaseExpiresAt) <=
    context.now().getTime()
  ) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Run token expired' });
  }
  const protocol = new CapacityProtocol(context.store);
  const state = await protocol.read(context.now().toISOString());
  const receipt = state.receipts.find((value) => value.runId === runId);
  if (
    receipt !== undefined ||
    state.policies.some(
      (policy) => policy.enforced && policy.domains[run.pipeline] !== undefined,
    )
  ) {
    if (
      receipt === undefined ||
      context.workerIdentityToken === undefined ||
      context.workerGeneration === undefined
    )
      throw new ORPCError('UNAUTHORIZED', {
        message: 'Bound active worker identity required',
      });
    let identity: Awaited<ReturnType<typeof verifyCapacityWorkerIdentity>>;
    try {
      identity = await (
        context.verifyWorkerIdentity ?? verifyCapacityWorkerIdentity
      )(context.workerIdentityToken, receipt.poolId);
    } catch {
      throw new ORPCError('UNAUTHORIZED', {
        message: 'Invalid bound worker identity',
      });
    }
    const policy = state.policies.find(
      (value) => value.poolId === receipt.poolId,
    );
    if (policy?.namespace !== identity.namespace)
      throw new ORPCError('UNAUTHORIZED', {
        message: 'Worker namespace mismatch',
      });
    const permit: CapacityWorkerPermit = {
      poolId: receipt.poolId,
      runId,
      podUid: identity.podUid,
      generation: context.workerGeneration,
      tokenHash: hashRunToken(token),
    };
    await capacityCall(() =>
      context.store.transactCapacity({
        now: context.now().toISOString(),
        recordKeys: [retiredKey(runId)],
        decide: (snapshot) => {
          assertCapacityWorkerPermit(
            snapshot.state,
            snapshot.records.get(retiredKey(runId)),
            permit,
          );
          return { value: true };
        },
      }),
    );
    context.workerPermit = permit;
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
  if (error instanceof ORPCError) throw error;
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
/**
 * `complete`'s drain, guarded -- unlike every other mutating route's own
 * unguarded `await ...drain()` (`work-router.ts`'s cancel/redispatch,
 * `work-mint.ts`, `work-reply.ts`,
 * `github-work-admission.ts`). Those routes are fine letting a drain
 * failure fail the whole request: their caller is a human, a webhook
 * delivery, or a cron tick, any of which can simply be retried (GitHub
 * redelivers, an operator resubmits). This route's caller is a
 * QueueExecutor runner blocked on this exact HTTP response, and it has
 * already finished its work -- there is no "retry the completion" for it
 * to fall back to, only a runner left hanging on a request that should
 * have already succeeded. A drain problem here must not turn a genuinely
 * successful completion into an error the runner sees; the next drain
 * (another route's, or the maintenance tick) picks up whatever this
 * one missed, same as any other transiently-failed outbox entry.
 */
async function drainAfterCompletion(
  context: Pick<RunsContext, 'drain'>,
  runId: string,
): Promise<void> {
  try {
    await context.drain();
  } catch (error) {
    logger.error(
      'agent-lcars: outbox drain after completing %s failed: %s',
      runId,
      error,
    );
  }
}

export const runsRouter = os.router({
  capacityInventory: os.capacityInventory.handler(async ({ context }) => {
    const authority = capacityAuthority(context.principal);
    if (
      !authority.capabilities.has('recover') &&
      !authority.capabilities.has('operator')
    )
      throw new ORPCError('UNAUTHORIZED', {
        message: 'Capacity inventory authority required',
      });
    const state = await new CapacityProtocol(context.store).read(
      context.now().toISOString(),
    );
    return {
      revision: state.revision,
      policy: state.policies.find(
        (policy) => policy.poolId === authority.poolId,
      ),
      receipts: state.receipts
        .filter(
          (receipt) =>
            receipt.poolId === authority.poolId &&
            authority.pipelines.includes(receipt.pipeline),
        )
        .map((receipt) => {
          const { tokenHash: _tokenHash, ...redacted } = receipt;
          return redacted;
        }),
    };
  }),
  capacityMetrics: os.capacityMetrics.handler(async ({ context }) => {
    const authority = capacityAuthority(context.principal);
    if (
      !authority.capabilities.has('recover') &&
      !authority.capabilities.has('operator')
    )
      throw new ORPCError('UNAUTHORIZED', {
        message: 'Capacity inventory authority required',
      });
    const state = await new CapacityProtocol(context.store).read(
      context.now().toISOString(),
    );
    return capacityMetrics(state, context.now().toISOString());
  }),
  capacity: os.capacity.handler(async ({ input, context }) => {
    if (context.capacityEnabled !== true)
      throw new ORPCError('UNAUTHORIZED', {
        message: 'Capacity API is disabled',
      });
    const authority = capacityAuthority(context.principal);
    return capacityCall(
      () =>
        applyCapacityCommand(
          new CapacityProtocol(context.store),
          authority,
          input,
          context.now().toISOString(),
        ),
      input.action,
    );
  }),
  activate: os.activate.handler(async ({ input, context }) => {
    if (context.capacityEnabled !== true)
      throw new ORPCError('UNAUTHORIZED', {
        message: 'Capacity API is disabled',
      });
    if (
      context.bearerToken === undefined ||
      context.workerIdentityToken === undefined
    )
      throw new ORPCError('UNAUTHORIZED', {
        message: 'Bound worker identity required',
      });
    let identity: Awaited<ReturnType<typeof verifyCapacityWorkerIdentity>>;
    try {
      identity = await (
        context.verifyWorkerIdentity ?? verifyCapacityWorkerIdentity
      )(context.workerIdentityToken, input.fence.poolId);
    } catch {
      throw new ORPCError('UNAUTHORIZED', {
        message: 'Invalid bound worker identity',
      });
    }
    const protocol = new CapacityProtocol(context.store);
    const state = await protocol.read(context.now().toISOString());
    if (
      state.policies.find((value) => value.poolId === input.fence.poolId)
        ?.namespace !== identity.namespace
    )
      throw new ORPCError('UNAUTHORIZED', {
        message: 'Worker namespace mismatch',
      });
    const generation = await capacityCall(
      () =>
        protocol.activate({
          fence: input.fence,
          podUid: identity.podUid,
          jobUid: input.jobUid,
          tokenHash: hashRunToken(context.bearerToken ?? ''),
          now: context.now().toISOString(),
        }),
      'activate',
    );
    return { generation };
  }),
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
    if (context.principal.capacityPool !== undefined) {
      if (context.capacityEnabled !== true)
        throw new ORPCError('CONFLICT', {
          message: 'Capacity API is disabled',
        });
      if (
        input.capacityVersion === undefined ||
        input.producerId === undefined ||
        input.claimRequestId === undefined
      )
        throw new ORPCError('CONFLICT', {
          message: 'Receipt-aware claim identity required',
        });
      const token = mintRunToken();
      const version = input.capacityVersion;
      const producerId = input.producerId;
      const claimRequestId = input.claimRequestId;
      const claimed = await capacityCall(
        () =>
          new CapacityProtocol(context.store).claim(
            capacityAuthority(context.principal),
            {
              version,
              producerId,
              claimRequestId,
              runner: input.runner,
              placementAware: input.placementAware,
              tokenHash: hashRunToken(token),
              nonce: randomBytes(16).toString('hex'),
              now: context.now().toISOString(),
            },
          ),
        'claim',
      );
      if (
        claimed.kind === 'claim' &&
        !isWorkAnchor(claimed.run.task) &&
        claimed.run.params?.['mode'] === 'implement'
      ) {
        let lifecycle: GithubAnchorLifecycle | undefined;
        try {
          lifecycle = await context.loadGithubAnchorLifecycle?.(
            claimed.run.task,
          );
        } catch {
          lifecycle = undefined;
        }
        if (lifecycle === undefined || lifecycle.state === 'closed') {
          await new CapacityProtocol(context.store).quarantine(
            capacityAuthority(context.principal),
            receiptFence(claimed.receipt),
            context.now().toISOString(),
          );
          if (lifecycle?.state === 'closed') {
            const canceled = await context.orchestrator.cancel(
              claimed.run.runId,
              `GitHub anchor confirmed closed at ${lifecycle.sourceUpdatedAt}`,
            );
            if (!isRefusal(canceled)) await context.drain();
          }
          return {
            kind: 'quarantined-unrecoverable-token' as const,
            receipt: receiptFence(claimed.receipt),
            runId: claimed.run.runId,
            jobName: claimed.receipt.jobName,
          };
        }
      }
      if (claimed.kind === 'claim')
        return {
          kind: claimed.kind,
          receipt: receiptFence(claimed.receipt),
          runId: claimed.run.runId,
          pipeline: claimed.run.pipeline,
          token,
          expiresAt: claimed.run.leaseExpiresAt,
          ...(claimed.run.queue?.startupPlacement === undefined
            ? {}
            : { placementAware: true as const }),
          jobName: claimed.receipt.jobName,
        };
      if (claimed.kind === 'recover-owned-secret')
        return {
          kind: claimed.kind,
          receipt: receiptFence(claimed.receipt),
          runId: claimed.receipt.runId,
          jobName: claimed.receipt.jobName,
          jobUid: claimed.receipt.jobUid,
          secretUid: claimed.receipt.secretUid ?? '',
        };
      return claimed;
    }

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
      const claimed = await capacityCall(
        () =>
          context.store.claimQueuedRun({
            pipelines: context.principal.pipelines,
            now: context.now().toISOString(),
            claimedBy: input.runner,
            placementAware: input.placementAware,
            claimedBySubject: claimantSubject(context.principal),
            tokenHash: hashRunToken(token),
          }),
        'claim',
      );
      if (claimed === undefined) return undefined;
      if (!isLive(claimed.state)) continue;
      if (
        !isWorkAnchor(claimed.task) &&
        claimed.params?.['mode'] === 'implement' &&
        context.loadGithubAnchorLifecycle !== undefined
      ) {
        const lifecycle = await context.loadGithubAnchorLifecycle(claimed.task);
        if (lifecycle === undefined) {
          // The QueueExecutor's whole claim request is bounded at ten
          // seconds. Return uncertain work to the queue under the exact
          // claim identity and retry on a later poll; never expose a run we
          // could not prove still actionable, and never consume its work.
          const released = await context.store.releaseQueuedRunClaim({
            runId: claimed.runId,
            claimedBy: input.runner,
            tokenHash: hashRunToken(token),
            now: context.now().toISOString(),
            deferredUntil: new Date(
              context.now().getTime() + 5 * 60_000,
            ).toISOString(),
          });
          if (!released) {
            const current = await context.store.readRun(claimed.runId);
            if (current !== undefined && isLive(current.state)) {
              throw new Error(
                'could not safely release unverifiable queue claim',
              );
            }
          }
          return undefined;
        }
        if (lifecycle?.state === 'closed') {
          // No run token has left this handler yet, so settling the freshly
          // claimed run here cannot interrupt a worker. This final check
          // closes the maintenance interval and recovers arbitrarily old
          // queued records without waiting for another webhook.
          const canceled = await context.orchestrator.cancel(
            claimed.runId,
            `GitHub anchor confirmed closed at ${lifecycle.sourceUpdatedAt}`,
          );
          if (!isRefusal(canceled)) {
            await context.drain();
            return undefined;
          }
          const current = await context.store.readRun(claimed.runId);
          if (current === undefined || !isLive(current.state)) continue;
        }
      }
      return {
        runId: claimed.runId,
        ...('workId' in claimed.task ? { workId: claimed.task.workId } : {}),
        pipeline: claimed.pipeline,
        token,
        expiresAt: claimed.leaseExpiresAt,
        ...(claimed.queue?.startupPlacement === undefined
          ? {}
          : { placementAware: true as const }),
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
    const resumeSessionId = run.params?.['resumeSessionId'];
    const resumeTranscriptGcsUri = run.params?.['resumeTranscriptGcsUri'];
    if (
      (resumeSessionId === undefined) !==
      (resumeTranscriptGcsUri === undefined)
    ) {
      throw errors.UNAUTHORIZED({
        message: 'run has an incomplete resume request',
      });
    }
    const resume =
      resumeSessionId !== undefined && resumeTranscriptGcsUri !== undefined
        ? {
            sessionId: resumeSessionId,
            transcriptGcsUri: resumeTranscriptGcsUri,
          }
        : undefined;
    const params = {
      mode,
      reply: run.params?.['reply'] ?? '',
      replyChannel: run.params?.['replyChannel'] ?? '',
      replyPrincipal: run.params?.['replyPrincipal'] ?? '',
      runbook: run.params?.['runbook'] ?? '',
      context: run.params?.['context'] ?? '',
      // #1993's `agent-option:cross-repo` -- true iff admission captured
      // that label on the anchor. `checkoutToken` (below) reads the same
      // `run.params['crossRepo']` string independently; this is only the
      // brief's own copy of the fact for the runner to act on.
      crossRepo: run.params?.['crossRepo'] === 'true',
    };
    const generation = parseRunGeneration(run.runId);
    if (generation === undefined || generation < 1) {
      // A stored identity is authoritative: never invent an attempt for a
      // corrupt run. The brief contract requires a positive generation.
      throw new ORPCError('INTERNAL_SERVER_ERROR', {
        message: 'run has corrupted generation',
      });
    }
    const shared = {
      deliveryHandoffVersion: 1 as const,
      pipeline: run.pipeline,
      ...params,
      attemptId: formatAttemptId({ generation, intentId: run.runId }),
      generation,
      intentId: run.runId,
      ...(resume === undefined ? {} : { resume }),
    };

    if (!isWorkAnchor(run.task)) {
      const parsed = workPayloadSchema.safeParse(task?.task.work);
      if (!parsed.success) {
        throw errors.UNAUTHORIZED({ message: 'run has no dispatchable Work' });
      }
      return {
        anchor: {
          type: 'github' as const,
          repo: run.task.repo,
          issue: run.task.issue,
          html_url: `https://github.com/${run.task.repo}/issues/${run.task.issue}`,
        },
        work: { spec: parsed.data.spec },
        ...shared,
      };
    }

    const work = task?.task.work;
    if (work === undefined || task === undefined) {
      throw errors.UNAUTHORIZED({ message: 'run has no dispatchable Work' });
    }
    // `mintItem` never stores a payload that doesn't already pass this exact
    // schema, so a claimed run whose stored Work fails to parse here is not a
    // caller mistake -- it is a server bug (a schema tightened out from under
    // an already-stored task, or corrupted data). Logged with the parse
    // issues for diagnosis; the caller gets only the generic 500, never the
    // detail or raw stored value.
    const parsed = workPayloadSchema.safeParse(work);
    if (!parsed.success) {
      logger.error(
        'agent-lcars: claimed run has stored Work that no longer parses',
        { runId: run.runId, workId: run.task.workId, error: parsed.error },
      );
      throw new ORPCError('INTERNAL_SERVER_ERROR', {
        message: 'run has corrupted Work',
      });
    }
    const { spec } = parsed.data;
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

  introspect: os.introspect.handler(async ({ input, context }) => {
    // Only this authentication pass may supply returned worker metadata.
    delete context.workerPermit;
    let run = await requireRunToken(context, input.runId);
    const task = isWorkAnchor(run.task)
      ? (await context.store.readTask(run.task))?.task
      : undefined;
    if (isWorkAnchor(run.task)) {
      // Native lookup may await cancellation, reclaim or worker retirement.
      // Authenticate again after it, then finalize Run and permit together.
      delete context.workerPermit;
      await requireRunToken(context, input.runId);
    }
    // Worker authentication awaits JWT and capacity IO. Read Run liveness and
    // its worker permit together after those awaits, without writing either.
    const authenticatedPermit = (context as RunsContext).workerPermit;
    const verified = await capacityCall(() =>
      context.store.transactCapacity({
        now: context.now().toISOString(),
        runId: input.runId,
        recordKeys: [retiredKey(input.runId)],
        decide: (snapshot) => {
          const current = snapshot.runs.find(
            (value) => value.runId === input.runId,
          );
          const token = context.bearerToken;
          if (
            current?.queue?.tokenHash === undefined ||
            token === undefined ||
            !runTokenMatches(token, current.queue.tokenHash)
          )
            throw new ORPCError('UNAUTHORIZED', {
              message: 'Invalid run token',
            });
          if (!isLive(current.state))
            throw new ORPCError('UNAUTHORIZED', {
              message: 'Run is no longer live',
            });
          const verifiedAt = context.now().toISOString();
          if (
            Date.parse(
              runRecoveryDeadline(current) ?? current.leaseExpiresAt,
            ) <= Date.parse(verifiedAt)
          )
            throw new ORPCError('UNAUTHORIZED', {
              message: 'Run token expired',
            });
          if (
            authenticatedPermit === undefined &&
            (snapshot.state.receipts.some(
              (value) => value.runId === input.runId,
            ) ||
              snapshot.state.policies.some(
                (policy) =>
                  policy.enforced &&
                  policy.domains[current.pipeline] !== undefined,
              ))
          )
            throw new ORPCError('UNAUTHORIZED', {
              message: 'Bound active worker identity required',
            });
          if (authenticatedPermit !== undefined)
            assertCapacityWorkerPermit(
              snapshot.state,
              snapshot.records.get(retiredKey(input.runId)),
              authenticatedPermit,
            );
          return {
            value: { run: current, permit: authenticatedPermit, verifiedAt },
          };
        },
      }),
    );
    run = verified.run;
    const target = anchorTarget(run, task);
    const verifiedAt = verified.verifiedAt;
    const validUntil = runRecoveryDeadline(run) ?? run.leaseExpiresAt;
    if (Date.parse(validUntil) <= context.now().getTime()) {
      throw new ORPCError('UNAUTHORIZED', { message: 'Run token expired' });
    }
    const permit = verified.permit;
    return {
      version: 1 as const,
      runId: run.runId,
      repository: target.repo,
      anchor: isWorkAnchor(run.task)
        ? { workId: run.task.workId }
        : { repo: run.task.repo, issue: run.task.issue },
      issueUrl:
        target.issue === undefined
          ? null
          : `https://github.com/${target.repo}/issues/${target.issue}`,
      verifiedAt,
      validUntil,
      worker:
        permit === undefined
          ? null
          : {
              poolId: permit.poolId,
              podUid: permit.podUid,
              generation: permit.generation,
            },
    };
  }),

  heartbeat: os.heartbeat.handler(async ({ input, context }) => {
    const run = await requireRunToken(context, input.runId);
    // Preserve the token that authenticated this callback through the atomic
    // Task+Run decision. A same-run release/reclaim changes this fingerprint.
    const renew = async () => {
      const renewed = await capacityCall(() =>
        context.orchestrator.renew(
          run.runId,
          run.queue?.tokenHash ?? '',
          input.providerProcessStarted,
          context.workerPermit,
        ),
      );
      if (isRefusal(renewed))
        throw new ORPCError('UNAUTHORIZED', {
          message: 'Run heartbeat refused',
        });
      return renewed.run ?? run;
    };
    const renewed =
      run.pipeline === 'codex'
        ? await renewCodexCredentialLease(context, run, renew)
        : await renew();
    const expiresAt = renewed.leaseExpiresAt;
    return {
      runId: run.runId,
      expiresAt,
    };
  }),

  placement: executor.placement.handler(async ({ input, context, errors }) => {
    const run = await context.store.readRun(input.runId);
    if (run === undefined) throw errors.NOT_FOUND();
    if (!context.principal.pipelines.includes(run.pipeline))
      throw errors.FORBIDDEN();
    const result = await context.orchestrator.observePlacement(
      input.runId,
      {
        subject: claimantSubject(context.principal),
        runner: input.runner,
        claimFingerprint: input.claimFingerprint,
      },
      input.placement,
    );
    if (isRefusal(result)) throw errors.FORBIDDEN();
    return { runId: input.runId };
  }),

  startupPlacement: executor.startupPlacement.handler(
    async ({ input, context, errors }) => {
      const run = await context.store.readRun(input.runId);
      if (run === undefined) throw errors.NOT_FOUND();
      if (!context.principal.pipelines.includes(run.pipeline))
        throw errors.FORBIDDEN();
      const result = await capacityCall(
        () =>
          context.orchestrator.observeStartupPlacement(
            input.runId,
            {
              subject: claimantSubject(context.principal),
              runner: input.runner,
              claimFingerprint: input.claimFingerprint,
            },
            {
              jobUid: input.jobUid,
              observedAt: input.observedAt,
              placed: input.placed,
              poolId: context.principal.capacityPool,
            },
          ),
        'placement',
      );
      if (isRefusal(result)) {
        if (result.reason === 'not-claimant') throw errors.FORBIDDEN();
        throw errors.CONFLICT();
      }
      return {
        runId: input.runId,
        jobUid: input.jobUid,
        expiresAt: runRecoveryDeadline(result.run ?? run) ?? run.leaseExpiresAt,
      };
    },
  ),

  claimStatus: executor.claimStatus.handler(
    async ({ input, context, errors }) => {
      const run = await context.store.readRun(input.runId);
      if (run === undefined) throw errors.NOT_FOUND();
      if (
        !context.principal.pipelines.includes(run.pipeline) ||
        run.queue?.claimedBySubject !== claimantSubject(context.principal) ||
        run.queue.claimedBy !== input.runner ||
        run.queue.tokenHash !== input.claimFingerprint
      ) {
        throw errors.FORBIDDEN();
      }
      // Expiry is not retirement: a heartbeat admitted before its deadline may
      // still commit. Only irreversible settlement permits executor cleanup.
      // The fingerprint also distinguishes same-millisecond release/reclaims.
      return {
        runId: run.runId,
        runner: input.runner,
        claimFingerprint: input.claimFingerprint,
        status: isLive(run.state) ? ('live' as const) : ('settled' as const),
      };
    },
  ),

  exit: executor.exit.handler(async ({ input, context, errors }) => {
    const run = await context.store.readRun(input.runId);
    if (run === undefined) throw errors.NOT_FOUND();
    // Declaring a worker gone kills the run and dispatches a retry, so it
    // needs ownership, not just capability: the executor must still hold
    // the run's pipeline grant AND be the authenticated principal that
    // claimed it, reporting under the same runner name. The ownership check
    // runs inside the settling transaction (`decide.ts`'s `executorExited`);
    // every ownership failure answers the same FORBIDDEN so a caller learns
    // nothing about another executor's claim. A missing grant is a fact about
    // the caller's own (changeable) configuration, so it carries its own
    // message: the executor retries it, while it never retries a claimant
    // mismatch, which cannot change.
    if (!context.principal.pipelines.includes(run.pipeline)) {
      throw errors.FORBIDDEN({ message: EXIT_PIPELINE_NOT_GRANTED });
    }
    const settled = await context.orchestrator.executorExited(
      run.runId,
      {
        subject: claimantSubject(context.principal),
        runner: input.runner,
        ...(input.claimFingerprint === undefined
          ? {}
          : { claimFingerprint: input.claimFingerprint }),
      },
      input.disruption,
    );
    if (
      isRefusal(settled) &&
      settled.reason === 'credential-operation-pending'
    ) {
      throw new ORPCError('CONFLICT', {
        message: 'Credential operation pending recovery',
      });
    }
    if (isRefusal(settled) && settled.reason === 'not-claimant') {
      logger.warn(
        'agent-lcars: refused exit report for run %s from %s (runner %s): not its claimant',
        run.runId,
        context.principal.principal,
        input.runner,
      );
      throw errors.FORBIDDEN();
    }
    if (isRefusal(settled)) {
      // The usual case: the worker reported its outcome, then exited.
      const current = await context.store.readRun(run.runId);
      return { runId: run.runId, state: current?.state ?? run.state };
    }
    logger.warn(
      'agent-lcars: run %s lost: executor %s reported its worker exited before completing',
      run.runId,
      input.runner,
    );
    if (run.pipeline === 'codex') {
      try {
        await releaseCodexCredentialLease(context, run);
      } catch (error) {
        // The lease still expires on its own; never fail the loss report.
        logger.error(
          'agent-lcars: releasing the Codex lease of lost run %s failed: %s',
          run.runId,
          error,
        );
      }
    }
    // Deliver the loss outcome and dispatch the retry now, not on the next
    // maintenance tick. A drain failure leaves the entries pending for it.
    await drainAfterCompletion(context, run.runId);
    return { runId: run.runId, state: 'lost' };
  }),

  complete: os.complete.handler(async ({ input, context }) => {
    const run = await requireRunToken(context, input.runId);
    // Same task fetch checkoutToken already needs below: a native run's
    // anchorTarget cannot resolve spec.target.repo from the run alone.
    const task = (await context.store.readTask(run.task))?.task;
    const target = anchorTarget(run, task);
    // The shared outcome mapper validates exact references against this
    // stored run's anchor and mode, not caller-supplied identity metadata.
    const result = toRunResult(
      target.repo,
      input.outcome,
      input.outcomeReference,
      input.message,
      { issue: target.issue, mode: run.params?.mode },
    );
    const deliveryCorrection =
      run.params?.deliveryPredecessor !== undefined ||
      (task?.delivery !== undefined &&
        task.delivery.state !== 'complete' &&
        task.delivery.runId !== run.runId);
    if (
      deliveryCorrection &&
      result.ok &&
      result.summary !== 'park' &&
      (!['pull-request', 'merged-deliverable'].includes(result.summary ?? '') ||
        !/\/pull\/\d+$/u.test(result.ref ?? ''))
    )
      throw new ORPCError('CONFLICT', {
        message:
          'A delivery correction must publish its freshly marked PR or explicitly park',
      });
    let delivery: DeliveryBinding | undefined;
    if (
      result.ok &&
      result.ref?.match(/\/pull\/\d+$/u) &&
      result.summary !== 'park' &&
      run.params?.mode !== 'review'
    ) {
      const reference = result.ref?.match(/\/pull\/(\d+)$/u);
      if (task === undefined || reference === undefined || reference === null)
        throw new ORPCError('CONFLICT', {
          message: 'Ready delivery evidence missing',
        });
      try {
        delivery = await (
          context.loadReadyDeliveryBinding ?? readyDeliveryBinding
        )(
          { tokens: context.tokens },
          {
            run,
            task,
            repo: target.repo,
            number: Number(reference[1]),
            now: context.now().toISOString(),
          },
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // Fail closed by default. The single relaxation: an initial
        // pull-request result whose own exact attempt-marked, ready PR the
        // authoritative read proved, but which is not armed yet (a
        // repository's arming workflow can land after the executor exits)
        // or merged without independent review. It settles as an ordinary
        // pull-request result without durable delivery ownership instead of
        // discarding the deliverable as runner-failed. Read failures,
        // malformed or missing evidence, corrections and merged-deliverable
        // claims all stay refused.
        if (
          !(error instanceof UnqualifiedDeliveryError) ||
          deliveryCorrection ||
          result.summary !== 'pull-request'
        ) {
          console.warn(
            `agent-lcars: ready delivery handoff refused for ${run.runId}: ${reason}`,
          );
          throw new ORPCError('CONFLICT', {
            message:
              'Ready delivery handoff refused; exact review and protected delivery evidence required',
          });
        }
        console.warn(
          `agent-lcars: ready delivery handoff not established for ${run.runId}; settling the PR without delivery ownership: ${reason}`,
        );
      }
    }
    const settled = await capacityCall(() =>
      context.orchestrator.report(
        run.runId,
        result,
        run.queue?.tokenHash ?? '',
        undefined,
        context.workerPermit,
        delivery,
      ),
    );
    if (
      isRefusal(settled) &&
      settled.reason === 'credential-operation-pending'
    ) {
      throw new ORPCError('CONFLICT', {
        message: 'Credential operation pending recovery',
      });
    }
    if (isRefusal(settled) && settled.reason === 'not-claimant') {
      throw new ORPCError('UNAUTHORIZED', { message: 'Run claim changed' });
    }
    if (
      !isRefusal(settled) &&
      settled.run?.credentialPendingResult !== undefined
    ) {
      return { runId: run.runId, state: 'completion-pending' };
    }
    // #1799: this is the route that CREATES the `report-outcome` outbox
    // entry (`orchestrator.report`'s `settle`), but it used to be the
    // one mutating route that never drained it -- every other one
    // (`work-router.ts`'s cancel/redispatch, `work-reply.ts`,
    // `work-mint.ts`, `github-work-admission.ts`,
    // `orchestrator-routes.ts`'s reconcile) does. The outcome comment
    // and `status:needs-human` label then waited on an unrelated
    // webhook delivery or the 30-minute reconcile tick instead of
    // landing right away. Only on a settled report: a refusal (stale
    // lease, already-settled run) created no new entry, so there is
    // nothing fresh for this drain to deliver.
    // A terminal claim cannot be released/reclaimed. Its transaction snapshot
    // can safely authorize cleanup of that same credential lease even when
    // a concurrent cancel/report settled it first. Live refusals and changed
    // fingerprints never release another attempt's credential ownership.
    const terminalSameClaim =
      isRefusal(settled) &&
      settled.existingRun !== undefined &&
      !isLive(settled.existingRun.state) &&
      settled.existingRun.queue?.tokenHash === run.queue?.tokenHash;
    if (!isRefusal(settled) || terminalSameClaim) {
      try {
        if (!isRefusal(settled)) await drainAfterCompletion(context, run.runId);
      } finally {
        if (run.pipeline === 'codex') {
          await releaseCodexCredentialLease(context, run);
        }
      }
    }
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

    if (run.params?.['crossRepo'] !== 'true') {
      const token = await context.checkoutTokens.expiringTokenFor(target.repo);
      return {
        token: token.token,
        repository: target.repo,
        expiresAt: token.expiresAt,
      };
    }

    // agent-option:cross-repo (#1993): the run's credential covers every
    // watched repository, not just its own anchor's. One installation
    // token can never span two GitHub owners (GitHub's own constraint --
    // each App installation is per-account), so this mints one grant per
    // distinct owner among `getWatchedRepos()`, each scoped to every
    // watched repo name under that owner.
    const namesByOwner = new Map<string, string[]>();
    for (const repo of getWatchedRepos()) {
      const names = namesByOwner.get(repo.owner);
      if (names === undefined) namesByOwner.set(repo.owner, [repo.name]);
      else names.push(repo.name);
    }
    const grants = await Promise.all(
      [...namesByOwner.entries()].map(async ([owner, repositories]) => {
        const token = await context.checkoutTokens.expiringTokenForRepositories(
          owner,
          repositories,
        );
        return {
          owner,
          repositories,
          token: token.token,
          expiresAt: token.expiresAt,
        };
      }),
    );
    const anchorOwner = target.repo.slice(0, target.repo.indexOf('/'));
    const anchorGrant = grants.find((grant) => grant.owner === anchorOwner);
    if (anchorGrant === undefined) {
      // Invariant: the anchor's own repository is always among the fleet's
      // watched repos (dispatch only ever admits a watched-repo anchor), so
      // its owner always has a grant above. A run somehow reaching this
      // without one has a corrupted anchor/watched-repos config, not a
      // recoverable per-request condition.
      throw new ORPCError('INTERNAL_SERVER_ERROR', {
        message: `checkout token: anchor owner ${JSON.stringify(anchorOwner)} has no grant among watched repos`,
      });
    }
    // The singular token/repository/expiresAt fields keep meaning exactly
    // what they meant before this option existed -- the anchor repo's own
    // credential -- by simply reusing its owner's grant token, so a runner
    // that never reads `grants` keeps working unmodified.
    return {
      token: anchorGrant.token,
      repository: target.repo,
      expiresAt: anchorGrant.expiresAt,
      grants,
    };
  }),

  codexAuth: os.codexAuth.handler(async ({ input, context, errors }) => {
    const { run, repository } = await requireCodexRun(context, input.runId);
    try {
      return await restoreCodexCredential(context, run, repository);
    } catch (error) {
      return codexAuthError(error, errors);
    }
  }),

  persistCodexAuth: os.persistCodexAuth.handler(
    async ({ input, context, errors }) => {
      const { run, repository } = await requireCodexRun(context, input.runId);
      try {
        return await persistCodexCredential(context, run, repository, input);
      } catch (error) {
        return codexAuthError(error, errors);
      }
    },
  ),
});

export function createRunsHandler(): OpenAPIHandler<RunsContext> {
  return new OpenAPIHandler(runsRouter);
}
