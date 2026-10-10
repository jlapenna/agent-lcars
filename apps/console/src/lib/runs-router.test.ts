import crypto from 'node:crypto';

import {
  changeCredentialOperation,
  type CredentialMutation,
  FirestoreStore,
  MemoryStore,
  Orchestrator,
  type OrchestratorStore,
  reserveCredentialOperation,
  type Run,
} from '@agent-lcars/orchestrator';
import { deriveItemState } from '@agent-lcars/work/derive';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CODEX_GLOBAL_LEASE_OBJECT,
  CodexAuthStoreError,
  GcsCodexAuthStore,
} from './codex-auth-store';
import { recoverCodexCredentialOperations } from './codex-credential-operations';
import { codexCentralAuthObject } from './deployment';
import { drainOutbox } from './orchestrator-dispatch';
import { hashRunToken, mintRunToken } from './run-token';
import { createRunsHandler, type RunsContext } from './runs-router';
import { ConditionalCodexBucket, deferred } from './testing/codex-auth-bucket';
import { truncatedDescription } from './work-from-github';

/**
 * `requireRunToken` (`runs-router.ts`) now reads its "is this lease still
 * good" clock from `RunsContext.now()` rather than the real wall clock, so
 * every context this suite builds shares one fixture-controlled clock with
 * the `Orchestrator` instance that actually stamps `leaseExpiresAt` --
 * `fixture()`'s `now` field, below. There is no more need to pin that
 * clock years in the future to outrun the real clock (the pre-#1502 sub-
 * project-4 shape of this suite did exactly that): an ordinary fixed
 * instant works, since nothing here is ever compared against real wall
 * time anymore.
 */
const NOW = '2026-08-26T10:00:00.000Z';

/** Native `claim` and `brief` output schemas pin `workId` to
 *  `workIdSchema` -- a strict 26-character Crockford-base32 pattern (see
 *  `libs/work/src/contract.ts`'s `WORK_ID_PATTERN`), not just "some
 *  string". A readable label like `'work-a'` fails that regex and 500s
 *  ("Output validation failed") the moment a test's flow reaches one of
 *  those routes -- so every `workId` this suite seeds is produced through
 *  this helper instead of a literal, deterministically turning a readable
 *  label into a 26-character id built only from the pattern's allowed
 *  alphabet (digits plus A-Z minus I/L/O/U). */
function wid(label: string): string {
  const upper = label
    .toUpperCase()
    .replace(/[^0-9A-Z]/gu, '')
    .replace(/[ILOU]/gu, 'X');
  return (upper + '0'.repeat(26)).slice(0, 26);
}

function fixture(initialNow: string = NOW) {
  const store = new MemoryStore();
  let now = initialNow;
  const orchestrator = new Orchestrator(store, { now: () => now });
  return {
    store,
    orchestrator,
    /** The same clock the `Orchestrator` above stamps `leaseExpiresAt`
     *  with, exposed the way `RunsContext.now` is -- so `requireRunToken`'s
     *  lease-expiry check runs against this fixture's own clock instead of
     *  the real wall clock. */
    now: () => new Date(now),
    /** Advances the fixture's own clock -- used to prove a renewed lease
     *  actually moved forward. */
    setNow: (next: string) => {
      now = next;
    },
  };
}

async function seedQueuedRun(
  store: MemoryStore,
  orchestrator: Orchestrator,
  opts: {
    workId: string;
    pipeline?: string;
    now: string;
    /** Overrides the stored spec's shape entirely -- used by corrupted Work
     *  brief tests, which need stored data a real request path (create,
     *  redispatch, the schedule tick) can never produce since they all
     *  validate through the canonical Work schema first. */
    spec?: unknown;
    /** Overrides the complete persisted Work payload for malformed-record
     *  tests. The orchestrator deliberately stores Work opaquely. */
    work?: Record<string, unknown>;
    /** A Codex credential run must still be authorized for this exact target
     * repository even though the credential lineage itself is central. */
    targetRepo?: string;
    /** Mirrors the explicit dispatch behavior persisted by native admission
     *  and redispatch; used by the brief resume tests below. */
    params?: Record<string, string>;
  },
): Promise<string> {
  const pipeline = opts.pipeline ?? 'claude';
  const outcome = await orchestrator.request({
    taskId: { workId: opts.workId },
    requestId: opts.workId,
    pipeline,
    work: opts.work ?? {
      origin: { principal: 'user:jlapenna', channel: 'api' },
      spec: opts.spec ?? {
        title: 't',
        description: 'd',
        pipeline,
        target: { repo: opts.targetRepo ?? 'jlapenna/agent-lcars' },
      },
    },
    params: opts.params ?? { mode: 'implement' },
  });
  if ('refused' in outcome) {
    throw new Error(`unexpected refusal seeding ${opts.workId}`);
  }
  const runId = outcome.run!.runId;
  await store.enqueueRun({ runId, now: opts.now });
  await orchestrator.confirmDispatch(runId);
  return runId;
}

async function seedQueuedGithubRun(
  store: OrchestratorStore,
  orchestrator: Orchestrator,
  issue: number,
  mode = 'implement',
  pipeline = 'claude',
  fallback = false,
): Promise<string> {
  const outcome = await orchestrator.request({
    taskId: { repo: 'jlapenna/agent-lcars', issue },
    requestId: `github-${issue}`,
    pipeline,
    ...(fallback
      ? {
          providerFallback: {
            principal: 'user:operator',
            allowedPipelines: ['claude'],
          },
        }
      : {}),
    params: { mode },
    work: {
      origin: { principal: 'github:jlapenna', channel: 'github' },
      spec: {
        title: `GitHub issue ${issue}`,
        description: 'Queued implementation work.',
        pipeline,
        target: { repo: 'jlapenna/agent-lcars' },
      },
    },
  });
  if ('refused' in outcome || outcome.run === undefined) {
    throw new Error(`unexpected refusal seeding GitHub issue ${issue}`);
  }
  await store.enqueueRun({ runId: outcome.run.runId, now: NOW });
  await orchestrator.confirmDispatch(outcome.run.runId);
  return outcome.run.runId;
}

/** Forces `run.leaseExpiresAt` into the past directly on the store,
 *  simulating a runner that claimed and then went silent past its lease --
 *  no route exists to do this, so the test reaches under the router. */
async function forceLeaseExpired(
  store: MemoryStore,
  runId: string,
): Promise<void> {
  const run = await store.readRun(runId);
  if (run === undefined) throw new Error(`missing run ${runId}`);
  const versioned = await store.readTask(run.task);
  if (versioned === undefined) throw new Error(`missing task for ${runId}`);
  await store.apply({
    decision: {
      task: versioned.task,
      run: { ...run, leaseExpiresAt: '2000-01-01T00:00:00.000Z' },
      outbox: [],
    },
    expectedRevision: versioned.revision,
  });
}

/** Forces `task.activeRunId` to name a different run while `runId`'s own
 *  run document stays `running` (live) with a valid, unexpired lease --
 *  simulating the race `decide.ts`'s `reportResult` calls `stale-lease`
 *  (a report from a run that already lost the lock). `requireRunToken`
 *  never looks at `task.activeRunId`, only the run's own state/lease, so
 *  this is the one piece of state that has to be forced directly on the
 *  store rather than through a route -- #1799's "does not drain on
 *  refusal" test needs a `complete` call that reaches
 *  `orchestrator.report` and gets refused there, not one blocked earlier
 *  by the token gate. */
async function forceStaleLease(
  store: MemoryStore,
  runId: string,
): Promise<void> {
  const run = await store.readRun(runId);
  if (run === undefined) throw new Error(`missing run ${runId}`);
  const versioned = await store.readTask(run.task);
  if (versioned === undefined) throw new Error(`missing task for ${runId}`);
  await store.apply({
    decision: {
      task: { ...versioned.task, activeRunId: 'some-other-run' },
      run,
      outbox: [],
    },
    expectedRevision: versioned.revision,
  });
}

function executorPrincipal(pipelines: readonly string[] = ['claude']) {
  return {
    principal: 'svc:autoscaler',
    subject: 'google:autoscaler@example.iam.gserviceaccount.com',
    scopes: new Set(['work.executor'] as const),
    pipelines,
    via: 'google' as const,
  };
}

function operatorPrincipal() {
  return {
    principal: 'user:jlapenna',
    subject: 'github:jlapenna',
    scopes: new Set(['work.operator'] as const),
    pipelines: ['claude'],
    via: 'session' as const,
  };
}

/** A real native run id (`work:<workId>/r<n>`) contains a `/`, which the
 *  oRPC OpenAPI router's single `{runId}` path segment does not accept
 *  literally -- confirmed empirically: an unencoded slash makes the whole
 *  request fail to match any route at all (`handle()`'s `matched: false`),
 *  not a 404. Percent-encoding the slash (`%2F`) round-trips correctly --
 *  oRPC decodes it back to the literal run id before the handler ever sees
 *  it. Every path built below goes through this helper for that reason;
 *  Task 7's own smoke tests sidestepped the question entirely by using a
 *  run id with no `/` in it (see that file's own comment). */
function runPath(runId: string, suffix: string): string {
  return `/runs/${encodeURIComponent(runId)}${suffix}`;
}

async function call(
  context: RunsContext,
  method: string,
  path: string,
  body?: unknown,
) {
  const handler = createRunsHandler();
  const { response } = await handler.handle(
    new Request(`https://lcars.test/api/work/v1${path}`, {
      method,
      // Only set a content type when there IS a body: a POST carrying
      // `content-type: application/json` with an empty body is a malformed
      // JSON request, and oRPC (correctly) answers 400 rather than reaching
      // the procedure at all -- mirrors work-router.test.ts's `call`.
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    }),
    { prefix: '/api/work/v1', context },
  );
  // `claim` answers 200 with a genuinely EMPTY body when nothing is
  // claimed (not 204 -- confirmed empirically; oRPC's OpenAPI codec keeps
  // the contract's declared `successStatus: 200` even for an `undefined`
  // handler return). `Response.json()` throws on an empty string, so the
  // empty-body case is handled explicitly rather than assumed away.
  const text = response === undefined ? undefined : await response.text();
  return {
    status: response?.status,
    json:
      text === undefined || text === ''
        ? undefined
        : (JSON.parse(text) as unknown),
  };
}

const context = {
  tokens: { tokenFor: async () => 'ambient-token' },
  checkoutTokens: {
    tokenFor: async () => 'checkout-token',
    expiringTokenFor: async () => ({
      token: 'checkout-token',
      expiresAt: '2026-08-26T11:00:00.000Z',
    }),
    expiringTokenForRepositories: async () => ({
      token: 'checkout-token',
      expiresAt: '2026-08-26T11:00:00.000Z',
    }),
  },
  // #1799: every test below that does not care about draining gets a
  // no-op stub -- only the `complete` drain tests override it.
  drain: async () => ({ dispatched: [], reported: [], failed: [] }),
  codexAuth: {
    read: async () => ({
      authBase64: Buffer.from('{"tokens":{}}').toString('base64'),
      generation: '7',
      sha256: 'a'.repeat(64),
    }),
    readLease: async () => undefined,
    createLease: async (input) => ({ ...input, generation: '11' }),
    takeLease: async (input) => ({ ...input, generation: '12' }),
    releaseLease: async () => undefined,
    replace: async () => undefined,
    fenceMutation: async () => ({}),
  },
};

describe('claim', () => {
  it('starts the execution lease atomically after a long queue wait', async () => {
    const { store, orchestrator, now, setNow } = fixture();
    await seedQueuedRun(store, orchestrator, {
      workId: wid('capacity-wait'),
      now: NOW,
    });
    setNow('2026-08-26T16:00:00.000Z');
    const claim = store.claimQueuedRun.bind(store);
    vi.spyOn(store, 'claimQueuedRun').mockImplementation(async (input) => {
      const result = await claim(input);
      // Reconcile between the durable claim and the HTTP response. A split
      // claim/renew would lose the run here after its six-hour queue wait.
      expect(await orchestrator.sweepExpired()).toEqual({
        lost: [],
        retried: [],
      });
      return result;
    });
    const response = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        principal: executorPrincipal(['claude']),
      },
      'POST',
      '/runs/claim',
      { runner: 'worker-with-capacity' },
    );
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      expiresAt: '2026-08-26T18:00:00.000Z',
    });
  });

  it('refuses a request with no principal', async () => {
    const { store, orchestrator, now } = fixture();
    const r = await call(
      { store, orchestrator, now, ...context, principal: undefined },
      'POST',
      '/runs/claim',
      { runner: 'runner-1' },
    );
    expect(r.status).toBe(401);
  });

  it('refuses an operator-scoped principal (no work.executor scope)', async () => {
    const { store, orchestrator, now } = fixture();
    const r = await call(
      { store, orchestrator, now, ...context, principal: operatorPrincipal() },
      'POST',
      '/runs/claim',
      { runner: 'runner-1' },
    );
    expect(r.status).toBe(401);
  });

  it('returns 200 with an empty body when nothing is queued', async () => {
    const { store, orchestrator, now } = fixture();
    const r = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        principal: executorPrincipal(['claude']),
      },
      'POST',
      '/runs/claim',
      { runner: 'runner-1' },
    );
    expect(r.status).toBe(200);
    expect(r.json).toBeUndefined();
  });

  // Final-review fix: `claim` used to stamp `claimedAt` from the real wall
  // clock (`new Date().toISOString()`) rather than `context.now()`, the
  // same injected clock `requireRunToken`'s lease-expiry check and the
  // `Orchestrator` instance already share -- making this exact value
  // untestable without a wall-clock-sensitive assertion. NOW is a fixed
  // fixture instant with no relation to whatever day this suite actually
  // runs on, so this only passes if `claimedAt` came from the injected
  // clock.
  it('stamps claimedAt from context.now(), not the wall clock', async () => {
    const { store, orchestrator, now } = fixture();
    await seedQueuedRun(store, orchestrator, {
      workId: wid('work-claimed-at'),
      now: NOW,
    });
    const r = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        principal: executorPrincipal(['claude']),
      },
      'POST',
      '/runs/claim',
      { runner: 'runner-1' },
    );
    expect(r.status).toBe(200);
    const claimed = r.json as { runId: string };
    const run = await store.readRun(claimed.runId);
    expect(run?.queue?.claimedAt).toBe(NOW);
  });

  it('derives claim eligibility only from the executor grant', async () => {
    const { store, orchestrator, now } = fixture();
    await seedQueuedRun(store, orchestrator, {
      workId: wid('work-codex'),
      pipeline: 'codex',
      now: NOW,
    });
    const claimSpy = vi.spyOn(store, 'claimQueuedRun');
    const r = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        principal: executorPrincipal(['claude']),
      },
      'POST',
      '/runs/claim',
      { runner: 'runner-1' },
    );
    expect(r.status).toBe(200);
    expect(r.json).toBeUndefined();
    expect(claimSpy).toHaveBeenCalledWith(
      expect.objectContaining({ pipelines: ['claude'] }),
    );
  });

  it('claims Codex from the executor grant', async () => {
    const { store, orchestrator, now } = fixture();
    const codexRunId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-codex-staged-off'),
      pipeline: 'codex',
      now: NOW,
    });
    const claudeRunId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-claude-staged-off'),
      pipeline: 'claude',
      now: NOW,
    });
    const r = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        principal: executorPrincipal(['codex', 'claude']),
      },
      'POST',
      '/runs/claim',
      { runner: 'runner-1' },
    );

    expect(r.status).toBe(200);
    expect((r.json as { runId: string }).runId).toBe(codexRunId);
    expect((await store.readRun(claudeRunId))?.queue?.state).toBe('queued');
  });

  it('rejects a caller-selected pipeline list', async () => {
    const { store, orchestrator, now } = fixture();
    const codexRunId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-codex-older'),
      pipeline: 'codex',
      now: NOW,
    });
    const claudeRunId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-claude-newer'),
      pipeline: 'claude',
      now: NOW,
    });
    const r = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        principal: executorPrincipal(['claude']),
      },
      'POST',
      '/runs/claim',
      { runner: 'runner-1', pipelines: ['codex', 'opencode'] },
    );
    expect(r.status).toBe(400);
    // Neither run can be claimed when the request violates the contract.
    expect((await store.readRun(codexRunId))?.queue?.state).toBe('queued');
    expect((await store.readRun(claudeRunId))?.queue?.state).toBe('queued');
  });

  it('skips a non-live queued run and returns the next live one', async () => {
    const { store, orchestrator, now } = fixture();
    const staleRunId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-stale'),
      now: NOW,
    });
    // Cancellation settles the run without touching `Run.queue` (Task 7's
    // own report, deviation 2) -- so this run stays `queue.state: 'queued'`
    // while `run.state` is no longer live.
    const canceled = await orchestrator.cancel(staleRunId);
    expect('refused' in canceled).toBe(false);
    const liveRunId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-live'),
      now: NOW,
    });
    const r = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        principal: executorPrincipal(['claude']),
      },
      'POST',
      '/runs/claim',
      { runner: 'runner-1' },
    );
    expect(r.status).toBe(200);
    expect((r.json as { runId: string }).runId).toBe(liveRunId);
  });

  it('settles at most one closed GitHub backlog item per claim request', async () => {
    const { store, orchestrator, now } = fixture();
    const closedRunId = await seedQueuedGithubRun(store, orchestrator, 70);
    const openRunId = await seedQueuedGithubRun(store, orchestrator, 71);
    const lifecycle = vi.fn(async (anchor: { issue: number }) => ({
      state: anchor.issue === 70 ? ('closed' as const) : ('open' as const),
      sourceUpdatedAt: NOW,
    }));
    const drain = vi
      .fn()
      .mockResolvedValue({ dispatched: [], reported: [], failed: [] });

    const response = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        drain,
        loadGithubAnchorLifecycle: lifecycle,
        principal: executorPrincipal(['claude']),
      },
      'POST',
      '/runs/claim',
      { runner: 'runner-after-stale-backlog' },
    );

    expect(response.status).toBe(200);
    expect(response.json).toBeUndefined();
    expect(await store.readRun(closedRunId)).toMatchObject({
      state: 'canceled',
      queue: { state: 'claimed' },
    });
    expect(lifecycle).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(1);

    const next = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        drain,
        loadGithubAnchorLifecycle: lifecycle,
        principal: executorPrincipal(['claude']),
      },
      'POST',
      '/runs/claim',
      { runner: 'runner-after-stale-backlog' },
    );
    expect((next.json as { runId: string }).runId).toBe(openRunId);
    expect(lifecycle).toHaveBeenCalledTimes(2);
  });

  it('returns unverifiable GitHub work to the queue without exposing a token', async () => {
    const { store, orchestrator, now, setNow } = fixture();
    const runId = await seedQueuedGithubRun(store, orchestrator, 72);
    const healthyRunId = await seedQueuedGithubRun(store, orchestrator, 73);
    const lifecycle = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ state: 'open', sourceUpdatedAt: NOW });

    const response = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        loadGithubAnchorLifecycle: lifecycle,
        principal: executorPrincipal(['claude']),
      },
      'POST',
      '/runs/claim',
      { runner: 'runner-with-uncertain-github' },
    );

    expect(response.status).toBe(200);
    expect(response.json).toBeUndefined();
    expect(await store.readRun(runId)).toMatchObject({
      state: 'running',
      queue: {
        state: 'queued',
        deferredUntil: '2026-08-26T10:05:00.000Z',
      },
    });

    const next = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        loadGithubAnchorLifecycle: lifecycle,
        principal: executorPrincipal(['claude']),
      },
      'POST',
      '/runs/claim',
      { runner: 'runner-with-uncertain-github' },
    );
    expect((next.json as { runId: string }).runId).toBe(healthyRunId);

    setNow('2026-08-26T10:05:00.001Z');
    const retried = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        loadGithubAnchorLifecycle: lifecycle,
        principal: executorPrincipal(['claude']),
      },
      'POST',
      '/runs/claim',
      { runner: 'runner-retrying-uncertain-github' },
    );
    expect((retried.json as { runId: string }).runId).toBe(runId);
  });

  it('grants only one token on a double claim of the same run', async () => {
    const { store, orchestrator, now } = fixture();
    await seedQueuedRun(store, orchestrator, {
      workId: wid('work-single'),
      now: NOW,
    });
    const ctx: RunsContext = {
      store,
      orchestrator,
      now,
      ...context,
      principal: executorPrincipal(['claude']),
    };
    const first = await call(ctx, 'POST', '/runs/claim', {
      runner: 'runner-1',
    });
    const second = await call(ctx, 'POST', '/runs/claim', {
      runner: 'runner-2',
    });
    expect(first.status).toBe(200);
    expect(first.json).toBeDefined();
    expect(second.status).toBe(200);
    expect(second.json).toBeUndefined();
  });

  it('gives two claimers two different queued runs', async () => {
    const { store, orchestrator, now } = fixture();
    const runA = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-a'),
      now: NOW,
    });
    const runB = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-b'),
      now: NOW,
    });
    const ctx: RunsContext = {
      store,
      orchestrator,
      now,
      ...context,
      principal: executorPrincipal(['claude']),
    };
    const first = await call(ctx, 'POST', '/runs/claim', {
      runner: 'runner-1',
    });
    const second = await call(ctx, 'POST', '/runs/claim', {
      runner: 'runner-2',
    });
    expect((first.json as { runId: string }).runId).toBe(runA);
    expect((second.json as { runId: string }).runId).toBe(runB);
  });
});

describe('claim -> brief -> heartbeat -> complete', () => {
  it('settles the run finished/ok and the item derives done', async () => {
    const { store, orchestrator, now } = fixture();
    const runId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-happy-path'),
      now: NOW,
    });

    const claimed = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        principal: executorPrincipal(['claude']),
      },
      'POST',
      '/runs/claim',
      { runner: 'runner-1' },
    );
    expect(claimed.status).toBe(200);
    const {
      runId: claimedRunId,
      token,
      workId,
      pipeline,
    } = claimed.json as {
      runId: string;
      token: string;
      workId: string;
      pipeline: string;
    };
    expect(claimedRunId).toBe(runId);
    expect(workId).toBe(wid('work-happy-path'));
    expect(pipeline).toBe('claude');

    const runCtx: RunsContext = {
      store,
      orchestrator,
      now,
      ...context,
      bearerToken: token,
    };

    const brief = await call(runCtx, 'GET', runPath(runId, '/brief'));
    expect(brief.status).toBe(200);
    expect(brief.json).toMatchObject({
      generation: 1,
      attemptId: `g1:${runId}`,
    });
    expect((brief.json as { intentId: string; id: string }).intentId).toBe(
      runId,
    );
    expect((brief.json as { id: string }).id).toBe(workId);

    const heartbeat = await call(runCtx, 'POST', runPath(runId, '/heartbeat'));
    expect(heartbeat.status).toBe(200);

    const complete = await call(runCtx, 'POST', runPath(runId, '/complete'), {
      outcome: 'pull-request',
      outcomeReference: { kind: 'pull-request', number: 12 },
    });
    expect(complete.status).toBe(200);
    expect((complete.json as { state: string }).state).toBe('finished');

    const settled = await store.readRun(runId);
    expect(settled?.state).toBe('finished');
    expect(settled?.result?.ok).toBe(true);
    expect(settled?.result?.ref).toBe(
      'https://github.com/jlapenna/agent-lcars/pull/12',
    );

    const task = await store.readTask({ workId });
    const runs = await store.listRuns({ workId });
    expect(task).toBeDefined();
    expect(deriveItemState(task!.task, runs)).toBe('done');
  });

  it('settles a park outcome finished/ok and the item derives parked, not done (#1757)', async () => {
    const { store, orchestrator, now } = fixture();
    const runId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-park-outcome'),
      now: NOW,
    });

    const claimed = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        principal: executorPrincipal(['claude']),
      },
      'POST',
      '/runs/claim',
      { runner: 'runner-1' },
    );
    expect(claimed.status).toBe(200);
    const { token, workId } = claimed.json as { token: string; workId: string };

    const runCtx: RunsContext = {
      store,
      orchestrator,
      now,
      ...context,
      bearerToken: token,
    };

    const complete = await call(runCtx, 'POST', runPath(runId, '/complete'), {
      outcome: 'park',
      outcomeReference: null,
    });
    expect(complete.status).toBe(200);
    expect((complete.json as { state: string }).state).toBe('finished');

    // #1608 put `park` in OK_OUTCOMES, so this settles `ok: true` -- but
    // the item must still derive `parked`, not `done`.
    const settled = await store.readRun(runId);
    expect(settled?.state).toBe('finished');
    expect(settled?.result?.ok).toBe(true);
    expect(settled?.result?.summary).toBe('park');

    const task = await store.readTask({ workId });
    const runs = await store.listRuns({ workId });
    expect(task).toBeDefined();
    expect(deriveItemState(task!.task, runs)).toBe('parked');
  });

  it("carries the agent's final message onto the stored result", async () => {
    const { store, orchestrator, now } = fixture();
    const runId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-park-message'),
      now: NOW,
    });

    const claimed = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        principal: executorPrincipal(['claude']),
      },
      'POST',
      '/runs/claim',
      { runner: 'runner-1' },
    );
    expect(claimed.status).toBe(200);
    const { token, workId } = claimed.json as { token: string; workId: string };

    const runCtx: RunsContext = {
      store,
      orchestrator,
      now,
      ...context,
      bearerToken: token,
    };

    const complete = await call(runCtx, 'POST', runPath(runId, '/complete'), {
      outcome: 'park',
      outcomeReference: null,
      message: 'Which database?',
    });
    expect(complete.status).toBe(200);
    expect((complete.json as { state: string }).state).toBe('finished');

    const settled = await store.readRun(runId);
    expect(settled?.result?.message).toBe('Which database?');

    const task = await store.readTask({ workId });
    const runs = await store.listRuns({ workId });
    expect(task).toBeDefined();
    expect(deriveItemState(task!.task, runs)).toBe('parked');
  });
});

describe.each([
  { repo: 'octo/example', issue: 42 },
  { workId: wid('brief-identity') },
])('brief identity for %j', (taskId) => {
  it.each([
    ['/r12', 12],
    ['/r9007199254740991', Number.MAX_SAFE_INTEGER],
    ['/missing', undefined],
    ['/r9007199254740993', undefined],
    ['/r0', undefined],
  ])('handles the authoritative suffix %s', async (suffix, generation) => {
    const { store, orchestrator, now } = fixture();
    const outcome = await orchestrator.request({
      taskId,
      requestId: 'brief-identity',
      pipeline: 'claude',
      params: { mode: 'implement' },
      work: {
        origin: { principal: 'user:jlapenna', channel: 'api' },
        spec: {
          title: 'Brief identity',
          description: 'Use the stored generation.',
          pipeline: 'claude',
          target: { repo: 'octo/example' },
        },
      },
    });
    if ('refused' in outcome || outcome.run === undefined) {
      throw new Error('expected a queued run');
    }
    const runId = outcome.run.runId.replace('/r1', suffix);
    const versioned = await store.readTask(taskId);
    if (versioned === undefined) throw new Error('missing task');
    // Model an already-stored identity, including corruption admission would
    // never mint. The real route still authenticates the run token.
    await store.apply({
      decision: {
        task: { ...versioned.task, activeRunId: runId },
        run: { ...outcome.run, runId },
        outbox: [],
      },
      expectedRevision: versioned.revision,
    });
    await store.enqueueRun({ runId, now: NOW });
    const token = mintRunToken();
    await store.claimQueuedRun({
      pipelines: ['claude'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(token),
    });
    const response = await call(
      { store, orchestrator, now, ...context, bearerToken: token },
      'GET',
      runPath(runId, '/brief'),
    );
    expect(response.status).toBe(generation === undefined ? 500 : 200);
    expect(response.json).toMatchObject(
      generation === undefined
        ? { message: 'run has corrupted generation' }
        : { generation, intentId: runId, attemptId: `g${generation}:${runId}` },
    );
    expect((response.json as { attemptId?: string }).attemptId).toBe(
      generation === undefined ? undefined : `g${generation}:${runId}`,
    );
  });
});

describe('brief', () => {
  it('serves a GitHub issue or pull-request anchor with all direct-runner metadata', async () => {
    const { store, orchestrator, now } = fixture();
    const outcome = await orchestrator.request({
      taskId: { repo: 'octo/example', issue: 42 },
      requestId: 'github-brief',
      pipeline: 'opencode',
      work: {
        origin: { principal: 'github:jlapenna', channel: 'github' },
        spec: {
          title: 'GitHub brief',
          description: 'Direct runner metadata.',
          pipeline: 'opencode',
          target: { repo: 'octo/example' },
        },
      },
      params: {
        mode: 'review',
        reply: '/opencode review this',
        runbook: 'pr-heal',
        context: 'nightly sweep',
      },
    });
    if ('refused' in outcome || outcome.run === undefined) {
      throw new Error('expected a queued GitHub run');
    }
    const runId = outcome.run.runId;
    await store.enqueueRun({ runId, now: NOW });
    await orchestrator.confirmDispatch(runId);
    const token = mintRunToken();
    await store.claimQueuedRun({
      pipelines: ['opencode'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(token),
    });

    const r = await call(
      { store, orchestrator, now, ...context, bearerToken: token },
      'GET',
      runPath(runId, '/brief'),
    );

    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      anchor: {
        type: 'github',
        repo: 'octo/example',
        issue: 42,
        html_url: 'https://github.com/octo/example/issues/42',
      },
      pipeline: 'opencode',
      mode: 'review',
      reply: '/opencode review this',
      runbook: 'pr-heal',
      context: 'nightly sweep',
      intentId: runId,
      generation: 1,
      attemptId: 'g1:octo/example#42/r1',
    });
    expect(r.json).toMatchObject({
      work: {
        spec: {
          title: 'GitHub brief',
          pipeline: 'opencode',
          target: { repo: 'octo/example' },
        },
      },
    });
  });

  it('serves the normalized stored Work spec for a GitHub anchor', async () => {
    const { store, orchestrator, now } = fixture();
    const rawBody = '漢'.repeat(12_000);
    const description = truncatedDescription(rawBody);
    const outcome = await orchestrator.request({
      taskId: { repo: 'octo/example', issue: 43 },
      requestId: 'github-brief-normalized-spec',
      pipeline: 'claude',
      work: {
        origin: {
          principal: 'github-actions:octo/example:workflow:dispatch.yml',
          channel: 'github',
        },
        spec: {
          title: 'A real GitHub title',
          description,
          pipeline: 'claude',
          target: { repo: 'octo/example' },
        },
      },
      params: { mode: 'implement' },
    });
    if ('refused' in outcome || outcome.run === undefined) {
      throw new Error('expected a queued GitHub run');
    }
    const runId = outcome.run.runId;
    await store.enqueueRun({ runId, now: NOW });
    await orchestrator.confirmDispatch(runId);
    const token = mintRunToken();
    await store.claimQueuedRun({
      pipelines: ['claude'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(token),
    });

    const r = await call(
      { store, orchestrator, now, ...context, bearerToken: token },
      'GET',
      runPath(runId, '/brief'),
    );

    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      anchor: { type: 'github', repo: 'octo/example', issue: 43 },
      work: {
        spec: {
          title: 'A real GitHub title',
          description,
          pipeline: 'claude',
          target: { repo: 'octo/example' },
        },
      },
    });
  });

  it('refuses a GitHub run whose stored Work has no origin', async () => {
    const { store, orchestrator, now } = fixture();
    const outcome = await orchestrator.request({
      taskId: { repo: 'octo/example', issue: 44 },
      requestId: 'github-brief-missing-origin',
      pipeline: 'claude',
      params: { mode: 'implement' },
      // The durable core stores opaque bounded Work, so this represents an
      // old/corrupt record rather than a value current admission can create.
      work: {
        spec: {
          title: 'Missing origin',
          description: 'Must not execute.',
          pipeline: 'claude',
          target: { repo: 'octo/example' },
        },
      },
    });
    if ('refused' in outcome || outcome.run === undefined) {
      throw new Error('expected a queued GitHub run');
    }
    const runId = outcome.run.runId;
    await store.enqueueRun({ runId, now: NOW });
    await orchestrator.confirmDispatch(runId);
    const token = mintRunToken();
    await store.claimQueuedRun({
      pipelines: ['claude'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(token),
    });

    const r = await call(
      { store, orchestrator, now, ...context, bearerToken: token },
      'GET',
      runPath(runId, '/brief'),
    );
    expect(r.status).toBe(401);
    expect(r.json).toMatchObject({ message: 'run has no dispatchable Work' });
  });

  it('500s on a native stored Work with an invalid origin, without leaking it', async () => {
    // No real request path can produce this -- `mintItem` always validates
    // through `workPayloadSchema` first (`work-mint.ts`) -- so this reaches
    // under the router the same way `forceLeaseExpired` does, to prove the
    // handler itself treats a corrupted stored Work as the server bug it
    // is: a 500 that never echoes the raw stored value back to the caller.
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const { store, orchestrator, now } = fixture();
    const runId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-corrupt-spec'),
      now: NOW,
      work: {
        origin: { principal: 'user:jlapenna', channel: 'not-a-channel' },
        spec: {
          title: 't',
          description: 'd',
          pipeline: 'claude',
          target: { repo: 'jlapenna/agent-lcars' },
          secretField: 'do-not-leak-me',
        },
      },
    });
    const token = mintRunToken();
    await store.claimQueuedRun({
      pipelines: ['claude'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(token),
    });
    const r = await call(
      { store, orchestrator, now, ...context, bearerToken: token },
      'GET',
      runPath(runId, '/brief'),
    );
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.json)).not.toContain('secretField');
    expect(JSON.stringify(r.json)).not.toContain('do-not-leak-me');
    expect(errorSpy).toHaveBeenCalledWith(
      'agent-lcars: claimed run has stored Work that no longer parses',
      expect.objectContaining({ runId }),
    );
    errorSpy.mockRestore();
  });

  it('includes resume when the claimed run carries resumeSessionId', async () => {
    const { store, orchestrator, now } = fixture();
    const runId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-resume'),
      now: NOW,
      params: {
        mode: 'implement',
        resumeSessionId: 'sess_1',
        resumeTranscriptGcsUri: 'gs://bucket/runs/x/claude-code/sess_1.jsonl',
      },
    });
    const token = mintRunToken();
    await store.claimQueuedRun({
      pipelines: ['claude'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(token),
    });
    const r = await call(
      { store, orchestrator, now, ...context, bearerToken: token },
      'GET',
      runPath(runId, '/brief'),
    );
    expect(r.status).toBe(200);
    expect(
      (
        r.json as {
          resume?: { sessionId: string; transcriptGcsUri: string };
        }
      ).resume,
    ).toEqual({
      sessionId: 'sess_1',
      transcriptGcsUri: 'gs://bucket/runs/x/claude-code/sess_1.jsonl',
    });
  });

  it('omits resume when the claimed run carries no resumeSessionId', async () => {
    const { store, orchestrator, now } = fixture();
    const runId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-no-resume'),
      now: NOW,
    });
    const token = mintRunToken();
    await store.claimQueuedRun({
      pipelines: ['claude'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(token),
    });
    const r = await call(
      { store, orchestrator, now, ...context, bearerToken: token },
      'GET',
      runPath(runId, '/brief'),
    );
    expect(r.status).toBe(200);
    expect((r.json as { resume?: unknown }).resume).toBeUndefined();
  });

  it('refuses a claimed run with only one persisted resume field', async () => {
    const { store, orchestrator, now } = fixture();
    const runId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-partial-resume'),
      now: NOW,
      params: { mode: 'implement', resumeSessionId: 'sess_1' },
    });
    const token = mintRunToken();
    await store.claimQueuedRun({
      pipelines: ['claude'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(token),
    });

    const r = await call(
      { store, orchestrator, now, ...context, bearerToken: token },
      'GET',
      runPath(runId, '/brief'),
    );
    expect(r.status).toBe(401);
    expect(r.json).toMatchObject({
      message: 'run has an incomplete resume request',
    });
  });

  it('refuses a claimed run with no persisted dispatch mode', async () => {
    const { store, orchestrator, now } = fixture();
    const runId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-no-mode'),
      now: NOW,
      params: {},
    });
    const token = mintRunToken();
    await store.claimQueuedRun({
      pipelines: ['claude'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(token),
    });

    const r = await call(
      { store, orchestrator, now, ...context, bearerToken: token },
      'GET',
      runPath(runId, '/brief'),
    );
    expect(r.status).toBe(401);
    expect(r.json).toMatchObject({ message: 'run has no valid dispatch mode' });
  });

  it('refuses a claimed run with an invalid persisted dispatch mode', async () => {
    const { store, orchestrator, now } = fixture();
    const runId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-invalid-mode'),
      now: NOW,
      params: { mode: 'legacy' },
    });
    const token = mintRunToken();
    await store.claimQueuedRun({
      pipelines: ['claude'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(token),
    });

    const r = await call(
      { store, orchestrator, now, ...context, bearerToken: token },
      'GET',
      runPath(runId, '/brief'),
    );
    expect(r.status).toBe(401);
    expect(r.json).toMatchObject({ message: 'run has no valid dispatch mode' });
  });
});

describe('run-token gate', () => {
  it('refuses every run-token route on a missing bearer', async () => {
    const { store, orchestrator, now } = fixture();
    const runId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-missing-bearer'),
      now: NOW,
    });
    await store.claimQueuedRun({
      pipelines: ['claude'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(mintRunToken()),
    });
    const ctx: RunsContext = { store, orchestrator, now, ...context };
    for (const [method, suffix, body] of [
      ['GET', '/brief', undefined],
      ['POST', '/heartbeat', undefined],
      ['POST', '/complete', { outcome: 'pull-request' }],
      ['GET', '/checkout-token', undefined],
      ['GET', '/codex-auth', undefined],
      [
        'PUT',
        '/codex-auth',
        {
          generation: '7',
          restoredSha256: '0'.repeat(64),
          authBase64: Buffer.from('{"tokens":{}}').toString('base64'),
        },
      ],
    ] as const) {
      const r = await call(ctx, method, runPath(runId, suffix), body);
      expect(r.status, `${method} ${suffix}`).toBe(401);
    }
  });

  it('refuses every run-token route on a wrong bearer', async () => {
    const { store, orchestrator, now } = fixture();
    const runId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-wrong-bearer'),
      now: NOW,
    });
    await store.claimQueuedRun({
      pipelines: ['claude'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(mintRunToken()),
    });
    const ctx: RunsContext = {
      store,
      orchestrator,
      now,
      ...context,
      bearerToken: 'definitely-the-wrong-token',
    };
    for (const [method, suffix, body] of [
      ['GET', '/brief', undefined],
      ['POST', '/heartbeat', undefined],
      ['POST', '/complete', { outcome: 'pull-request' }],
      ['GET', '/checkout-token', undefined],
    ] as const) {
      const r = await call(ctx, method, runPath(runId, suffix), body);
      expect(r.status, `${method} ${suffix}`).toBe(401);
    }
  });

  it('refuses a token whose lease has already expired', async () => {
    const { store, orchestrator, now } = fixture();
    const runId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-expired-lease'),
      now: NOW,
    });
    const token = mintRunToken();
    await store.claimQueuedRun({
      pipelines: ['claude'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(token),
    });
    await forceLeaseExpired(store, runId);
    const r = await call(
      { store, orchestrator, now, ...context, bearerToken: token },
      'POST',
      runPath(runId, '/heartbeat'),
    );
    expect(r.status).toBe(401);
  });

  it('refuses a completed run its own token on every run route', async () => {
    const { store, orchestrator, now } = fixture();
    const runId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-already-complete'),
      now: NOW,
    });
    const token = mintRunToken();
    await store.claimQueuedRun({
      pipelines: ['claude'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(token),
    });
    const ctx: RunsContext = {
      store,
      orchestrator,
      now,
      ...context,
      bearerToken: token,
    };
    const completed = await call(ctx, 'POST', runPath(runId, '/complete'), {
      outcome: 'pull-request',
      outcomeReference: { kind: 'pull-request', number: 1 },
    });
    expect(completed.status).toBe(200);

    const brief = await call(ctx, 'GET', runPath(runId, '/brief'));
    expect(brief.status).toBe(401);
    const heartbeat = await call(ctx, 'POST', runPath(runId, '/heartbeat'));
    expect(heartbeat.status).toBe(401);
    const checkoutToken = await call(
      ctx,
      'GET',
      runPath(runId, '/checkout-token'),
    );
    expect(checkoutToken.status).toBe(401);
    const codexAuth = await call(ctx, 'GET', runPath(runId, '/codex-auth'));
    expect(codexAuth.status).toBe(401);
  });

  it('refuses a canceled run its own token on every run route, even though queue.state stays claimed', async () => {
    // Deviation 2 (design spec, "Queue state machine"): cancellation
    // settles the run without touching `Run.queue` at all -- so
    // `run.queue.state` is still whatever `claimQueuedRun` set it to
    // (`'claimed'`, not `'queued'` here, since this run was claimed before
    // being canceled -- see `claim`'s own "skips a non-live queued run"
    // test above for the still-`'queued'` case). Liveness alone must gate
    // every run-token route; `requireRunToken` must never trust
    // `run.queue.state` as a proxy for "is this run still live".
    const { store, orchestrator, now } = fixture();
    const runId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-canceled-claimed'),
      now: NOW,
    });
    const token = mintRunToken();
    await store.claimQueuedRun({
      pipelines: ['claude'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(token),
    });
    const canceled = await orchestrator.cancel(runId);
    expect('refused' in canceled).toBe(false);
    expect((await store.readRun(runId))?.queue?.state).toBe('claimed');

    const ctx: RunsContext = {
      store,
      orchestrator,
      now,
      ...context,
      bearerToken: token,
    };
    for (const [method, suffix, body] of [
      ['GET', '/brief', undefined],
      ['POST', '/heartbeat', undefined],
      ['POST', '/complete', { outcome: 'pull-request' }],
      ['GET', '/checkout-token', undefined],
      ['GET', '/codex-auth', undefined],
    ] as const) {
      const r = await call(ctx, method, runPath(runId, suffix), body);
      expect(r.status, `${method} ${suffix}`).toBe(401);
    }
  });

  it("refuses run A's token on run B's routes", async () => {
    const { store, orchestrator, now } = fixture();
    const runA = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-run-a'),
      now: NOW,
    });
    const runB = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-run-b'),
      now: NOW,
    });
    const tokenA = mintRunToken();
    const tokenB = mintRunToken();
    // Oldest queued run claims first, so this claims runA then runB.
    await store.claimQueuedRun({
      pipelines: ['claude'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(tokenA),
    });
    await store.claimQueuedRun({
      pipelines: ['claude'],
      now: NOW,
      claimedBy: 'runner-2',
      tokenHash: hashRunToken(tokenB),
    });
    const r = await call(
      { store, orchestrator, now, ...context, bearerToken: tokenA },
      'GET',
      runPath(runB, '/brief'),
    );
    expect(r.status).toBe(401);
    // Sanity: tokenA is genuinely valid on its own run.
    const own = await call(
      { store, orchestrator, now, ...context, bearerToken: tokenA },
      'GET',
      runPath(runA, '/brief'),
    );
    expect(own.status).toBe(200);
  });
});

describe('heartbeat', () => {
  it("extends the run's leaseExpiresAt", async () => {
    const { store, orchestrator, now, setNow } = fixture();
    const runId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-heartbeat'),
      now: NOW,
    });
    const token = mintRunToken();
    await store.claimQueuedRun({
      pipelines: ['claude'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(token),
    });
    const before = (await store.readRun(runId))!.leaseExpiresAt;

    // An hour on, still well inside the 2h lease (`LEASE_MS`, `decide.ts`)
    // -- far enough to prove the renewed `leaseExpiresAt` moved forward,
    // not so far that this shared fixture clock (now also
    // `requireRunToken`'s own clock, via `RunsContext.now`) would expire
    // the very token this call is renewing before it got there.
    await orchestrator.renew(runId);
    setNow('2026-08-26T11:00:00.000Z');
    const r = await call(
      { store, orchestrator, now, ...context, bearerToken: token },
      'POST',
      runPath(runId, '/heartbeat'),
    );
    expect(r.status).toBe(200);
    const after = (r.json as { expiresAt: string }).expiresAt;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
    expect((await store.readRun(runId))!.leaseExpiresAt).toBe(after);
  });

  it('records only the first authenticated provider-process observation', async () => {
    const { store, orchestrator, now, setNow } = fixture();
    const runId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-provider-start'),
      now: NOW,
    });
    const token = mintRunToken();
    await store.claimQueuedRun({
      pipelines: ['claude'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(token),
    });
    const ctx = { store, orchestrator, now, ...context, bearerToken: token };
    expect((await call(ctx, 'POST', runPath(runId, '/heartbeat'))).status).toBe(
      200,
    );
    expect(
      (await store.readRun(runId))!.queue!.providerProcessStartedAt,
    ).toBeUndefined();
    setNow('2026-08-26T10:01:00.000Z');
    expect(
      (
        await call(ctx, 'POST', runPath(runId, '/heartbeat'), {
          providerProcessStarted: true,
        })
      ).status,
    ).toBe(200);
    expect((await store.readRun(runId))!.queue!.providerProcessStartedAt).toBe(
      '2026-08-26T10:01:00.000Z',
    );
    setNow('2026-08-26T10:02:00.000Z');
    expect(
      (
        await call(ctx, 'POST', runPath(runId, '/heartbeat'), {
          providerProcessStarted: true,
        })
      ).status,
    ).toBe(200);
    expect((await store.readRun(runId))!.queue!.providerProcessStartedAt).toBe(
      '2026-08-26T10:01:00.000Z',
    );
    expect(
      (
        await call(
          { ...ctx, bearerToken: 'wrong' },
          'POST',
          runPath(runId, '/heartbeat'),
          { providerProcessStarted: true },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await call(ctx, 'POST', runPath(runId, '/heartbeat'), {
          providerProcessStarted: false,
        })
      ).status,
    ).toBe(400);
  });

  it('extends the shared Codex credential lease with each broker heartbeat', async () => {
    const { store, orchestrator, now, setNow } = fixture();
    const runId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-codex-heartbeat'),
      pipeline: 'codex',
      now: NOW,
    });
    const token = mintRunToken();
    await store.claimQueuedRun({
      pipelines: ['codex'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(token),
    });
    const takeLease = vi.fn(context.codexAuth.takeLease);
    await orchestrator.renew(runId);
    setNow('2026-08-26T11:00:00.000Z');

    const r = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        bearerToken: token,
        codexAuth: {
          ...context.codexAuth,
          readLease: async () => ({
            runId,
            repository: 'jlapenna/agent-lcars',
            expiresAt: '2026-08-26T12:00:00.000Z',
            generation: '31',
            claimFingerprint: hashRunToken(token),
          }),
          takeLease,
        },
      },
      'POST',
      runPath(runId, '/heartbeat'),
    );

    expect(r.status).toBe(200);
    expect(takeLease).toHaveBeenCalledWith({
      runId,
      repository: 'jlapenna/agent-lcars',
      expiresAt: (r.json as { expiresAt: string }).expiresAt,
      expectedGeneration: '31',
      claimFingerprint: hashRunToken(token),
      operationId: expect.any(String),
    });
  });
});

describe('claimStatus', () => {
  async function claimed() {
    const f = fixture();
    const runId = await seedQueuedRun(f.store, f.orchestrator, {
      workId: wid('claim-status'),
      now: NOW,
    });
    const principal = executorPrincipal();
    const response = await call(
      { ...f, ...context, principal },
      'POST',
      '/runs/claim',
      { runner: 'runner-1' },
    );
    const token = (response.json as { token: string }).token;
    const fingerprint = hashRunToken(token);
    const path =
      runPath(runId, '/claim-status') +
      '?' +
      new URLSearchParams({
        runner: 'runner-1',
        claimFingerprint: fingerprint,
      });
    return { ...f, runId, token, fingerprint, path, principal };
  }

  it('records placement without renewing heartbeat, lease or provider start', async () => {
    const f = await claimed();
    const before = await f.store.readRun(f.runId);
    const placement = {
      phase: 'waiting-for-placement',
      reason: 'unschedulable',
      observedAt: NOW,
      jobCreatedAt: NOW,
    };
    const response = await call(
      { ...f, ...context },
      'POST',
      runPath(f.runId, '/placement'),
      {
        runner: 'runner-1',
        claimFingerprint: f.fingerprint,
        placement,
      },
    );
    expect(response.status).toBe(200);
    const after = await f.store.readRun(f.runId);
    expect(after?.queue?.placement).toEqual(placement);
    expect(after?.leaseExpiresAt).toBe(before?.leaseExpiresAt);
    expect(after?.queue?.firstHeartbeatAt).toBeUndefined();
    expect(after?.queue?.providerProcessStartedAt).toBeUndefined();
    expect(after?.queue?.startDeadlineAt).toBe(before?.queue?.startDeadlineAt);
    expect(after?.state).toBe(before?.state);
  });

  it.each([
    'subject',
    'runner',
    'fingerprint',
    'pipeline',
    'scope',
    'expired',
    'future',
    'stale',
    'lost',
    'reclaimed',
  ])('fences placement reports for %s', async (kind) => {
    const f = await claimed();
    let principal: RunsContext['principal'] = f.principal;
    let runner = 'runner-1';
    let claimFingerprint = f.fingerprint;
    let observedAt = NOW;
    if (kind === 'subject')
      principal = { ...f.principal, subject: 'other@example.com' };
    if (kind === 'runner') runner = 'other';
    if (kind === 'fingerprint') claimFingerprint = 'a'.repeat(64);
    if (kind === 'pipeline') principal = executorPrincipal(['codex']);
    if (kind === 'scope') principal = undefined;
    if (kind === 'expired') f.setNow('2026-08-26T10:16:00.000Z');
    if (kind === 'future') observedAt = '2026-08-26T10:00:01.000Z';
    if (kind === 'stale') observedAt = '2026-08-26T09:59:00.000Z';
    if (kind === 'lost')
      await f.orchestrator.executorExited(f.runId, {
        subject: f.principal.subject,
        runner: 'runner-1',
        claimFingerprint: f.fingerprint,
      });
    if (kind === 'reclaimed') {
      await f.store.releaseQueuedRunClaim({
        runId: f.runId,
        claimedBy: 'runner-1',
        tokenHash: f.fingerprint,
        now: NOW,
      });
      await call({ ...f, ...context }, 'POST', '/runs/claim', {
        runner: 'runner-1',
      });
    }
    const before = await f.store.readRun(f.runId);
    const response = await call(
      { ...f, ...context, principal },
      'POST',
      runPath(f.runId, '/placement'),
      {
        runner,
        claimFingerprint,
        placement: {
          phase: 'waiting-for-placement',
          reason: 'pending',
          observedAt,
        },
      },
    );
    expect(response.status).toBe(kind === 'scope' ? 401 : 403);
    expect(await f.store.readRun(f.runId)).toEqual(before);
  });

  it('reads only its exact claim, preserving expired live runs until settlement', async () => {
    const f = await claimed();
    f.setNow('2026-08-26T10:16:00.000Z');
    const before = await f.store.readRun(f.runId);
    const drain = vi.fn(context.drain);
    const r = await call({ ...f, ...context, drain }, 'GET', f.path);
    expect(r).toMatchObject({
      status: 200,
      json: {
        runId: f.runId,
        runner: 'runner-1',
        claimFingerprint: f.fingerprint,
        status: 'live',
      },
    });
    expect(await f.store.readRun(f.runId)).toEqual(before);
    expect(drain).not.toHaveBeenCalled();
    await f.orchestrator.executorExited(f.runId, {
      subject: f.principal.subject,
      runner: 'runner-1',
      claimFingerprint: f.fingerprint,
    });
    const settled = await call({ ...f, ...context }, 'GET', f.path);
    expect(settled).toMatchObject({
      status: 200,
      json: { status: 'settled', claimFingerprint: f.fingerprint },
    });
  });

  it.each(['scope', 'pipeline', 'subject', 'runner', 'fingerprint', 'missing'])(
    'fails closed for %s without mutations',
    async (kind) => {
      const f = await claimed();
      let principal: RunsContext['principal'] = f.principal;
      let path = f.path;
      if (kind === 'scope') principal = undefined;
      if (kind === 'pipeline') principal = executorPrincipal(['codex']);
      if (kind === 'subject')
        principal = { ...f.principal, subject: 'google:other@example.com' };
      if (kind === 'runner') path = path.replace('runner-1', 'runner-2');
      if (kind === 'fingerprint')
        path = path.replace(f.fingerprint, 'a'.repeat(64));
      if (kind === 'missing')
        path =
          runPath('work:' + wid('missing') + '/r1', '/claim-status') +
          '?' +
          new URLSearchParams({
            runner: 'runner-1',
            claimFingerprint: f.fingerprint,
          });
      const before = await f.store.readRun(f.runId);
      const r = await call({ ...f, ...context, principal }, 'GET', path);
      expect(r.status).toBe(
        kind === 'scope' ? 401 : kind === 'missing' ? 404 : 403,
      );
      expect(await f.store.readRun(f.runId)).toEqual(before);
    },
  );

  it('refuses an old fingerprint after a same-millisecond release/reclaim', async () => {
    const f = await claimed();
    const before = await f.store.readRun(f.runId);
    await f.store.releaseQueuedRunClaim({
      runId: f.runId,
      claimedBy: 'runner-1',
      tokenHash: f.fingerprint,
      now: NOW,
    });
    const fresh = await call({ ...f, ...context }, 'POST', '/runs/claim', {
      runner: 'runner-1',
    });
    const current = await f.store.readRun(f.runId);
    expect(current?.queue?.claimedAt).toBe(before?.queue?.claimedAt);
    expect(current?.queue?.tokenHash).not.toBe(f.fingerprint);
    expect(fresh.status).toBe(200);
    expect((await call({ ...f, ...context }, 'GET', f.path)).status).toBe(403);
  });
});

describe('exit', () => {
  /** Claims through the real `claim` route, so every exit test exercises
   *  the binding `claim` records, not a hand-written queue record. */
  async function claimedRun(pipeline = 'claude') {
    const f = fixture();
    const runId = await seedQueuedRun(f.store, f.orchestrator, {
      workId: wid(`exit-${pipeline}`),
      pipeline,
      now: NOW,
    });
    const claim = await call(
      {
        store: f.store,
        orchestrator: f.orchestrator,
        now: f.now,
        ...context,
        principal: executorPrincipal([pipeline]),
      },
      'POST',
      '/runs/claim',
      { runner: 'runner-1' },
    );
    const claimed = claim.json as { runId: string; token: string };
    expect(claimed.runId).toBe(runId);
    return { ...f, runId, token: claimed.token };
  }

  /** A second executor holding the same pipeline grant: the attacker the
   *  claimant binding exists to stop. */
  function otherExecutor(pipelines: readonly string[] = ['claude']) {
    return {
      ...executorPrincipal(pipelines),
      principal: 'svc:other-executor',
      subject: 'google:other-executor@example.iam.gserviceaccount.com',
    };
  }

  it('records the authenticated claimant subject on the claim', async () => {
    const { store, runId } = await claimedRun();
    expect((await store.readRun(runId))?.queue).toMatchObject({
      state: 'claimed',
      claimedBy: 'runner-1',
      claimedBySubject: 'google:autoscaler@example.iam.gserviceaccount.com',
    });
  });

  it.each([
    [
      'another principal with the same pipeline grant',
      otherExecutor(),
      'runner-1',
    ],
    [
      'the claiming principal under another runner name',
      executorPrincipal(['claude']),
      'runner-2',
    ],
    [
      'another principal reusing the claimant runner name',
      otherExecutor(),
      'runner-1',
    ],
  ])(
    'refuses %s with 403 and leaves the healthy run running',
    async (_, principal, runner) => {
      const { store, orchestrator, now, runId, token } = await claimedRun();
      const drain = vi.fn(context.drain);

      const response = await call(
        { store, orchestrator, now, ...context, drain, principal },
        'POST',
        runPath(runId, '/exit'),
        { runner, claimFingerprint: hashRunToken(token) },
      );

      expect(response).toMatchObject({
        status: 403,
        json: { message: 'executor may not report this run' },
      });
      expect((await store.readRun(runId))?.state).toBe('running');
      expect(await store.listRuns({ workId: wid('exit-claude') })).toHaveLength(
        1,
      );
      expect(drain).not.toHaveBeenCalled();
    },
  );

  it('refuses every reporter for a claim recorded without a claimant subject', async () => {
    // Claims made before `claimedBySubject` existed have no provable owner:
    // only their own outcome report or lease expiry may settle them.
    const { store, orchestrator, now } = fixture();
    const runId = await seedQueuedRun(store, orchestrator, {
      workId: wid('exit-legacy'),
      now: NOW,
    });
    await store.claimQueuedRun({
      pipelines: ['claude'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(mintRunToken()),
    });

    const response = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        principal: executorPrincipal(['claude']),
      },
      'POST',
      runPath(runId, '/exit'),
      { runner: 'runner-1' },
    );

    expect(response.status).toBe(403);
    expect((await store.readRun(runId))?.state).toBe('running');
  });

  it('matches the claimant subject case-insensitively, as grants do', async () => {
    const { store, orchestrator, now, runId, token } = await claimedRun();
    const principal = executorPrincipal(['claude']);

    const response = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        principal: { ...principal, subject: principal.subject.toUpperCase() },
      },
      'POST',
      runPath(runId, '/exit'),
      { runner: 'runner-1', claimFingerprint: hashRunToken(token) },
    );

    expect(response).toEqual({ status: 200, json: { runId, state: 'lost' } });
  });

  it('settles the run once the claimant regains a temporarily revoked grant', async () => {
    const { store, orchestrator, now, runId, token } = await claimedRun();
    const base = { store, orchestrator, now, ...context };

    const revoked = await call(
      { ...base, principal: executorPrincipal(['opencode']) },
      'POST',
      runPath(runId, '/exit'),
      { runner: 'runner-1', claimFingerprint: hashRunToken(token) },
    );
    expect(revoked.status).toBe(403);
    expect((await store.readRun(runId))?.state).toBe('running');

    const restored = await call(
      { ...base, principal: executorPrincipal(['claude']) },
      'POST',
      runPath(runId, '/exit'),
      { runner: 'runner-1', claimFingerprint: hashRunToken(token) },
    );
    expect(restored).toEqual({ status: 200, json: { runId, state: 'lost' } });
  });

  it('answers a settled run only to its claimant', async () => {
    const { store, orchestrator, now, runId, token } = await claimedRun();
    await call(
      { store, orchestrator, now, ...context, bearerToken: token },
      'POST',
      runPath(runId, '/complete'),
      { outcome: 'no-op' },
    );

    expect(
      (
        await call(
          { store, orchestrator, now, ...context, principal: otherExecutor() },
          'POST',
          runPath(runId, '/exit'),
          { runner: 'runner-1', claimFingerprint: hashRunToken(token) },
        )
      ).status,
    ).toBe(403);
  });

  it('settles a still-live claimed run lost at once, retries it, and drains', async () => {
    const { store, orchestrator, now, runId, token } = await claimedRun();
    const drain = vi.fn(context.drain);

    const response = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        drain,
        principal: executorPrincipal(['claude']),
      },
      'POST',
      runPath(runId, '/exit'),
      { runner: 'runner-1', claimFingerprint: hashRunToken(token) },
    );

    expect(response).toEqual({ status: 200, json: { runId, state: 'lost' } });
    const lost = await store.readRun(runId);
    expect(lost?.state).toBe('lost');
    expect(lost?.events.at(-1)).toMatchObject({ to: 'lost', by: 'executor' });
    const task = await store.readTask({ workId: wid('exit-claude') });
    expect(task?.task.activeRunId).not.toBe(runId);
    expect(task?.task.consecutiveLost).toBe(1);
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('answers the settled state unchanged for a run that already completed', async () => {
    const { store, orchestrator, now, runId, token } = await claimedRun();
    expect(
      (
        await call(
          { store, orchestrator, now, ...context, bearerToken: token },
          'POST',
          runPath(runId, '/complete'),
          { outcome: 'no-op' },
        )
      ).status,
    ).toBe(200);
    const drain = vi.fn(context.drain);

    const response = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        drain,
        principal: executorPrincipal(['claude']),
      },
      'POST',
      runPath(runId, '/exit'),
      { runner: 'runner-1', claimFingerprint: hashRunToken(token) },
    );

    expect(response).toEqual({
      status: 200,
      json: { runId, state: 'finished' },
    });
    expect(drain).not.toHaveBeenCalled();
    expect(await store.listRuns({ workId: wid('exit-claude') })).toHaveLength(
      1,
    );
  });

  it('releases the Codex subscription lease of a lost Codex run', async () => {
    const { store, orchestrator, now, runId, token } =
      await claimedRun('codex');
    const releaseLease = vi.fn(async () => undefined);

    const response = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        codexAuth: {
          ...context.codexAuth,
          releaseLease,
          readLease: async () => ({
            runId,
            repository: 'jlapenna/agent-lcars',
            expiresAt: '2026-08-28T12:00:00.000Z',
            generation: '11',
            claimFingerprint: hashRunToken(token),
          }),
        },
        principal: executorPrincipal(['codex']),
      },
      'POST',
      runPath(runId, '/exit'),
      { runner: 'runner-1', claimFingerprint: hashRunToken(token) },
    );

    expect(response.status).toBe(200);
    expect(releaseLease).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        claimFingerprint: hashRunToken(token),
        generation: expect.any(String),
      }),
      expect.any(String),
    );
  });

  it('requires the work.executor scope, the run pipeline grant, and a known run', async () => {
    const { store, orchestrator, now, runId, token } = await claimedRun();
    const base = { store, orchestrator, now, ...context };
    const body = {
      runner: 'runner-1',
      claimFingerprint: hashRunToken(token),
    };

    expect(
      (await call(base, 'POST', runPath(runId, '/exit'), body)).status,
    ).toBe(401);
    expect(
      (
        await call(
          { ...base, principal: operatorPrincipal() },
          'POST',
          runPath(runId, '/exit'),
          body,
        )
      ).status,
    ).toBe(401);
    // The executor retries only this grant denial, so a temporarily revoked
    // grant cannot strand the claimant's report until lease expiry.
    expect(
      await call(
        { ...base, principal: executorPrincipal(['opencode']) },
        'POST',
        runPath(runId, '/exit'),
        body,
      ),
    ).toMatchObject({
      status: 403,
      json: { message: 'pipeline not granted to this executor' },
    });
    // The executor only treats a 404 carrying this message as delivered.
    expect(
      await call(
        { ...base, principal: executorPrincipal(['claude']) },
        'POST',
        runPath('work:missing/r1', '/exit'),
        body,
      ),
    ).toMatchObject({ status: 404, json: { message: 'unknown run' } });
    expect((await store.readRun(runId))?.state).toBe('running');
  });
});

describe('complete', () => {
  it('refuses a malformed body with 400 and leaves the run state unchanged', async () => {
    const { store, orchestrator, now } = fixture();
    const runId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-malformed-complete'),
      now: NOW,
    });
    const token = mintRunToken();
    await store.claimQueuedRun({
      pipelines: ['claude'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(token),
    });
    const handler = createRunsHandler();
    const { response } = await handler.handle(
      new Request(
        `https://lcars.test/api/work/v1${runPath(runId, '/complete')}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // Unparseable JSON -- oRPC refuses this before the handler is
          // ever reached (`complete`'s own `outcome: z.unknown()` cannot
          // reject a well-formed-but-wrong outcome value; only a body that
          // fails to parse at all triggers 400 here).
          body: '{not valid json',
        },
      ),
      {
        prefix: '/api/work/v1',
        context: { store, orchestrator, now, ...context, bearerToken: token },
      },
    );
    expect(response?.status).toBe(400);
    expect((await store.readRun(runId))?.state).toBe('running');
  });

  // #1799: `complete` is the route that creates the `report-outcome`
  // outbox entry (via `orchestrator.report`'s `settle`), but it never
  // drained it -- so a run's outcome comment and `status:needs-human`
  // label waited on an unrelated webhook delivery or the 30-minute
  // reconcile tick instead of landing immediately. These three tests pin
  // the fix: drain on a settled report, never on a refused one, and never
  // let a drain failure turn a successful completion into an error the
  // waiting runner sees.
  it('drains the outbox after a report settles the run, delivering the outcome comment', async () => {
    const { store, orchestrator, now } = fixture();
    const outcome = await orchestrator.request({
      taskId: { repo: 'octo/example', issue: 99 },
      requestId: 'github-complete-drain',
      pipeline: 'claude',
      work: {
        origin: { principal: 'github:jlapenna', channel: 'github' },
        spec: {
          title: 'Drain on completion',
          description: 'd',
          pipeline: 'claude',
          target: { repo: 'octo/example' },
        },
      },
      params: { mode: 'implement' },
    });
    if ('refused' in outcome || outcome.run === undefined) {
      throw new Error('expected a queued GitHub run');
    }
    const runId = outcome.run.runId;
    await store.enqueueRun({ runId, now: NOW });
    await orchestrator.confirmDispatch(runId);
    const token = mintRunToken();
    await store.claimQueuedRun({
      pipelines: ['claude'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(token),
    });

    // A real `drainOutbox`, not a spy -- proves the outcome comment was
    // actually delivered, not merely that some `drain` function was
    // invoked. Fixture mirrors `backend-actions.test.ts`'s own.
    const calls: { url: string }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push({ url: String(input) });
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    const drain = () =>
      drainOutbox({
        store,
        orchestrator,
        tokens: { tokenFor: async () => 'gh-test-token' },
        fetchImpl,
        now: () => now().toISOString(),
      });

    const r = await call(
      { store, orchestrator, now, ...context, bearerToken: token, drain },
      'POST',
      runPath(runId, '/complete'),
      {
        outcome: 'pull-request',
        outcomeReference: { kind: 'pull-request', number: 7 },
      },
    );

    expect(r.status).toBe(200);
    expect((r.json as { state: string }).state).toBe('finished');
    expect(calls).toContainEqual(
      expect.objectContaining({
        url: 'https://api.github.com/repos/octo/example/issues/99/comments',
      }),
    );
  });

  it('does not drain when the report is refused', async () => {
    const { store, orchestrator, now } = fixture();
    const runId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-complete-refusal'),
      now: NOW,
    });
    const token = mintRunToken();
    await store.claimQueuedRun({
      pipelines: ['claude'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(token),
    });
    // `requireRunToken` only checks the run's own state/lease, not
    // `task.activeRunId` -- so a run that already lost the lock still
    // passes the token gate and reaches `orchestrator.report`, which then
    // refuses it (`stale-lease`). That is the refusal path this test
    // needs; see `forceStaleLease`'s own comment.
    await forceStaleLease(store, runId);

    const drain = vi.fn(async () => ({
      dispatched: [],
      reported: [],
      failed: [],
    }));
    const r = await call(
      { store, orchestrator, now, ...context, bearerToken: token, drain },
      'POST',
      runPath(runId, '/complete'),
      {
        outcome: 'pull-request',
        outcomeReference: { kind: 'pull-request', number: 1 },
      },
    );

    expect(r.status).toBe(200);
    expect((r.json as { state: string }).state).toBe('stale-lease');
    expect(drain).not.toHaveBeenCalled();
  });

  it('still returns its normal success body when the drain itself throws', async () => {
    const { store, orchestrator, now } = fixture();
    const runId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-complete-drain-throws'),
      now: NOW,
    });
    const token = mintRunToken();
    await store.claimQueuedRun({
      pipelines: ['claude'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(token),
    });

    const drain = vi.fn(async () => {
      throw new Error('outbox store unavailable');
    });
    const r = await call(
      { store, orchestrator, now, ...context, bearerToken: token, drain },
      'POST',
      runPath(runId, '/complete'),
      {
        outcome: 'pull-request',
        outcomeReference: { kind: 'pull-request', number: 2 },
      },
    );

    // The runner is waiting on this HTTP call and has already done its
    // work -- a drain problem must not turn a successful completion into
    // an error it sees.
    expect(r.status).toBe(200);
    expect((r.json as { state: string }).state).toBe('finished');
    expect(drain).toHaveBeenCalledOnce();
    const settled = await store.readRun(runId);
    expect(settled?.state).toBe('finished');
  });
});

describe('checkoutToken', () => {
  it("mints a token for the spec's target repo without leaking the run token", async () => {
    const { store, orchestrator, now } = fixture();
    const runId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-checkout-token'),
      now: NOW,
    });
    const runToken = mintRunToken();
    await store.claimQueuedRun({
      pipelines: ['claude'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(runToken),
    });
    const expiresAt = '2026-08-26T10:53:21.000Z';
    const expiringTokenFor = vi.fn(async (repo: string) => ({
      token: `ghs_secret-for-${repo}`,
      expiresAt,
    }));
    const expiringTokenForRepositories = vi.fn(
      async (owner: string, names: string[]) => ({
        token: `ghs_secret-for-${owner}:${names.join(',')}`,
        expiresAt,
      }),
    );
    const r = await call(
      {
        store,
        orchestrator,
        now,
        tokens: context.tokens,
        checkoutTokens: {
          tokenFor: async (repo) => (await expiringTokenFor(repo)).token,
          expiringTokenFor,
          expiringTokenForRepositories,
        },
        codexAuth: context.codexAuth,
        bearerToken: runToken,
      },
      'GET',
      runPath(runId, '/checkout-token'),
    );
    expect(r.status).toBe(200);
    expect(expiringTokenFor).toHaveBeenCalledWith('jlapenna/agent-lcars');
    expect(expiringTokenFor).toHaveBeenCalledTimes(1);
    // No agent-option:cross-repo on this run: the multi-repo mint path is
    // never reached at all.
    expect(expiringTokenForRepositories).not.toHaveBeenCalled();

    const body = r.json as {
      token: string;
      expiresAt: string;
      repository: string;
      grants?: unknown;
    };
    expect(body.repository).toBe('jlapenna/agent-lcars');
    expect(body.token).toBe('ghs_secret-for-jlapenna/agent-lcars');
    expect(body.expiresAt).toBe(expiresAt);
    expect(body.grants).toBeUndefined();
    // The run's own bearer credential must never surface here -- a mix-up
    // would hand the caller the wrong secret entirely.
    expect(body.token).not.toBe(runToken);
    expect(JSON.stringify(body)).not.toContain(runToken);
  });

  // #1993: `agent-option:cross-repo` -- one grant per fleet owner among
  // `getWatchedRepos()`, minted through `expiringTokenForRepositories`.
  describe('agent-option:cross-repo (#1993)', () => {
    afterEach(() => {
      delete process.env['AGENT_LCARS_WATCHED_REPOS'];
    });

    it("mints one grant per owner, each scoped to that owner's watched repos, and reuses the anchor owner's grant as the singular token", async () => {
      process.env['AGENT_LCARS_WATCHED_REPOS'] = JSON.stringify([
        { owner: 'jlapenna', name: 'agent-lcars' },
        { owner: 'jlapenna', name: 'homelab' },
        { owner: 'supersprinklesracing', name: 'sprinkles' },
      ]);
      const { store, orchestrator, now } = fixture();
      const runId = await seedQueuedRun(store, orchestrator, {
        workId: wid('work-cross-repo-checkout-token'),
        now: NOW,
        params: { mode: 'implement', crossRepo: 'true' },
      });
      const runToken = mintRunToken();
      await store.claimQueuedRun({
        pipelines: ['claude'],
        now: NOW,
        claimedBy: 'runner-1',
        tokenHash: hashRunToken(runToken),
      });
      const expiresAt = '2026-08-26T10:53:21.000Z';
      const expiringTokenFor = vi.fn(async () => ({
        token: 'unused-single-repo-token',
        expiresAt,
      }));
      const expiringTokenForRepositories = vi.fn(
        async (owner: string, _names: string[]) => ({
          token: `ghs_grant-for-${owner}`,
          expiresAt,
        }),
      );

      const r = await call(
        {
          store,
          orchestrator,
          now,
          tokens: context.tokens,
          checkoutTokens: {
            tokenFor: async (repo) => (await expiringTokenFor(repo)).token,
            expiringTokenFor,
            expiringTokenForRepositories,
          },
          codexAuth: context.codexAuth,
          bearerToken: runToken,
        },
        'GET',
        runPath(runId, '/checkout-token'),
      );
      expect(r.status).toBe(200);

      // The single-repo path is never used once cross-repo grants apply.
      expect(expiringTokenFor).not.toHaveBeenCalled();
      expect(expiringTokenForRepositories).toHaveBeenCalledTimes(2);
      expect(expiringTokenForRepositories).toHaveBeenCalledWith('jlapenna', [
        'agent-lcars',
        'homelab',
      ]);
      expect(expiringTokenForRepositories).toHaveBeenCalledWith(
        'supersprinklesracing',
        ['sprinkles'],
      );

      const body = r.json as {
        token: string;
        expiresAt: string;
        repository: string;
        grants: { owner: string; repositories: string[]; token: string }[];
      };
      expect(body.repository).toBe('jlapenna/agent-lcars');
      // The singular token is simply the anchor owner's own grant.
      expect(body.token).toBe('ghs_grant-for-jlapenna');
      expect(body.grants).toHaveLength(2);
      expect(body.grants).toContainEqual({
        owner: 'jlapenna',
        repositories: ['agent-lcars', 'homelab'],
        token: 'ghs_grant-for-jlapenna',
        expiresAt,
      });
      expect(body.grants).toContainEqual({
        owner: 'supersprinklesracing',
        repositories: ['sprinkles'],
        token: 'ghs_grant-for-supersprinklesracing',
        expiresAt,
      });
    });
  });
});

describe('codexAuth', () => {
  function ownedCodexAuth(
    runId: string,
    claimFingerprint: string,
    overrides: Partial<RunsContext['codexAuth']> = {},
  ): RunsContext['codexAuth'] {
    return {
      ...context.codexAuth,
      readLease: async () => ({
        runId,
        repository: 'jlapenna/agent-lcars',
        expiresAt: '2026-08-28T12:00:00.000Z',
        generation: '11',
        claimFingerprint,
      }),
      ...overrides,
    };
  }

  async function claimedCodexRun(targetRepo?: string) {
    const { store, orchestrator, now } = fixture();
    const runId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-codex-auth'),
      pipeline: 'codex',
      now: NOW,
      targetRepo,
    });
    const token = mintRunToken();
    await store.claimQueuedRun({
      pipelines: ['codex'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(token),
    });
    return { store, orchestrator, now, runId, token };
  }

  it('authorizes the target repository but restores the one central credential lineage', async () => {
    const { store, orchestrator, now, runId, token } =
      await claimedCodexRun('jlapenna/sync-padd');
    const read = vi.fn(context.codexAuth.read);
    const createLease = vi.fn(context.codexAuth.createLease);
    const r = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        codexAuth: { ...context.codexAuth, read, createLease },
        bearerToken: token,
      },
      'GET',
      runPath(runId, '/codex-auth'),
    );
    expect(r.status).toBe(200);
    expect(read).toHaveBeenCalledWith();
    expect(createLease).toHaveBeenCalledWith({
      runId,
      repository: 'jlapenna/sync-padd',
      expiresAt: (await store.readRun(runId))!.leaseExpiresAt,
      claimFingerprint: hashRunToken(token),
      operationId: expect.any(String),
    });
  });

  it('releases a newly claimed subscription lease when credential restore fails', async () => {
    const { store, orchestrator, now, runId, token } = await claimedCodexRun();
    const releaseLease = vi.fn(async () => undefined);
    const r = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        codexAuth: {
          ...context.codexAuth,
          read: async () => {
            throw new CodexAuthStoreError('not-found', 'not seeded');
          },
          releaseLease,
        },
        bearerToken: token,
      },
      'GET',
      runPath(runId, '/codex-auth'),
    );

    expect(r.status).toBe(404);
    expect(releaseLease).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        claimFingerprint: hashRunToken(token),
        generation: expect.any(String),
      }),
      expect.any(String),
    );
  });

  it('refuses the broker routes to a non-Codex run token', async () => {
    const { store, orchestrator, now } = fixture();
    const runId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-claude-auth-refusal'),
      pipeline: 'claude',
      now: NOW,
    });
    const token = mintRunToken();
    await store.claimQueuedRun({
      pipelines: ['claude'],
      now: NOW,
      claimedBy: 'runner-1',
      tokenHash: hashRunToken(token),
    });
    const r = await call(
      { store, orchestrator, now, ...context, bearerToken: token },
      'GET',
      runPath(runId, '/codex-auth'),
    );
    expect(r.status).toBe(401);
  });

  it('records worker control failure as unsuccessful infrastructure, not PARK', async () => {
    const { store, orchestrator, now, runId, token } = await claimedCodexRun();
    const r = await call(
      { store, orchestrator, now, ...context, bearerToken: token },
      'POST',
      runPath(runId, '/complete'),
      {
        outcome: 'worker-control-failed',
        outcomeReference: null,
        message: 'Infrastructure failure. No human decision is requested.',
      },
    );
    expect(r.status).toBe(200);
    const settled = await store.readRun(runId);
    expect(settled?.state).toBe('finished');
    expect(settled?.result).toMatchObject({
      ok: false,
      summary: 'worker-control-failed',
    });
    const workId = wid('work-codex-auth');
    const task = await store.readTask({ workId });
    const runs = await store.listRuns({ workId });
    expect(task).toBeDefined();
    expect(deriveItemState(task!.task, runs)).toBe('failed');
  });

  it('releases an owned subscription lease when a Codex run completes early', async () => {
    const { store, orchestrator, now, runId, token } = await claimedCodexRun();
    const releaseLease = vi.fn(async () => undefined);
    const r = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        codexAuth: ownedCodexAuth(runId, hashRunToken(token), { releaseLease }),
        bearerToken: token,
      },
      'POST',
      runPath(runId, '/complete'),
      { outcome: 'no-deliverable', outcomeReference: null },
    );

    expect(r.status).toBe(200);
    expect(releaseLease).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        claimFingerprint: hashRunToken(token),
        generation: expect.any(String),
      }),
      expect.any(String),
    );
  });

  it('does not write back a byte-identical or positively burned credential', async () => {
    const { store, orchestrator, now, runId, token } = await claimedCodexRun();
    const authBase64 = Buffer.from('{"tokens":{"access":"x"}}').toString(
      'base64',
    );
    const restoredSha256 = crypto
      .createHash('sha256')
      .update(Buffer.from(authBase64, 'base64'))
      .digest('hex');
    const replace = vi.fn(async () => undefined);
    const ctx = {
      store,
      orchestrator,
      now,
      ...context,
      codexAuth: ownedCodexAuth(runId, hashRunToken(token), { replace }),
      bearerToken: token,
    };
    const unchanged = await call(ctx, 'PUT', runPath(runId, '/codex-auth'), {
      generation: '7',
      restoredSha256,
      authBase64,
    });
    expect(unchanged.json).toEqual({ status: 'unchanged' });

    const burned = await call(ctx, 'PUT', runPath(runId, '/codex-auth'), {
      generation: '7',
      restoredSha256,
      authBase64,
      authFailure: 'refresh-token-reused',
    });
    expect(burned.json).toEqual({ status: 'skipped-burned' });
    expect(replace).not.toHaveBeenCalled();
  });

  it('persists a changed credential with the restored generation as its CAS', async () => {
    const { store, orchestrator, now, runId, token } = await claimedCodexRun();
    const replace = vi.fn(async () => undefined);
    const authBase64 = Buffer.from('{"tokens":{"access":"new"}}').toString(
      'base64',
    );
    const r = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        codexAuth: ownedCodexAuth(runId, hashRunToken(token), { replace }),
        bearerToken: token,
      },
      'PUT',
      runPath(runId, '/codex-auth'),
      {
        generation: '1844674407370955161',
        restoredSha256: '0'.repeat(64),
        authBase64,
      },
    );
    expect(r.json).toEqual({ status: 'updated' });
    expect(replace).toHaveBeenCalledWith({
      expectedGeneration: '1844674407370955161',
      authBase64,
      receipt: expect.objectContaining({
        claimFingerprint: hashRunToken(token),
        expectedGeneration: '1844674407370955161',
        operationId: expect.any(String),
        sha256: expect.any(String),
      }),
    });
  });

  it('refuses persistence when the central lease names a different target repository', async () => {
    const { store, orchestrator, now, runId, token } =
      await claimedCodexRun('jlapenna/sync-padd');
    const replace = vi.fn(async () => undefined);
    const r = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        codexAuth: ownedCodexAuth(runId, hashRunToken(token), { replace }),
        bearerToken: token,
      },
      'PUT',
      runPath(runId, '/codex-auth'),
      {
        generation: '7',
        restoredSha256: '0'.repeat(64),
        authBase64: Buffer.from('{"tokens":{"access":"new"}}').toString(
          'base64',
        ),
      },
    );

    expect(r.status).toBe(409);
    expect(replace).not.toHaveBeenCalled();
  });

  it('keeps a durable credential rotation successful when lease cleanup fails', async () => {
    const { store, orchestrator, now, runId, token } = await claimedCodexRun();
    const replace = vi.fn(async () => undefined);
    const cleanupError = new CodexAuthStoreError('unavailable', 'bucket blip');
    const releaseLease = vi.fn(async () => {
      throw cleanupError;
    });
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const r = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        codexAuth: ownedCodexAuth(runId, hashRunToken(token), {
          replace,
          releaseLease,
        }),
        bearerToken: token,
      },
      'PUT',
      runPath(runId, '/codex-auth'),
      {
        generation: '7',
        restoredSha256: '0'.repeat(64),
        authBase64: Buffer.from('{"tokens":{"access":"new"}}').toString(
          'base64',
        ),
      },
    );

    expect(r).toMatchObject({ status: 200, json: { status: 'updated' } });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(releaseLease).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        claimFingerprint: hashRunToken(token),
        generation: expect.any(String),
      }),
      expect.any(String),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      'agent-lcars: credential operation for %s remains reserved pending generation fencing',
      runId,
    );
    errorSpy.mockRestore();
  });

  it('surfaces a generation conflict without retrying the write', async () => {
    const { store, orchestrator, now, runId, token } = await claimedCodexRun();
    const replace = vi.fn(async () => {
      throw new CodexAuthStoreError('conflict', 'already rotated');
    });
    const r = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        codexAuth: ownedCodexAuth(runId, hashRunToken(token), { replace }),
        bearerToken: token,
      },
      'PUT',
      runPath(runId, '/codex-auth'),
      {
        generation: '7',
        restoredSha256: '0'.repeat(64),
        authBase64: Buffer.from('{"tokens":{}}').toString('base64'),
      },
    );
    expect(r.status).toBe(409);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('blocks a second Codex QueueExecutor run while another run holds the shared lease', async () => {
    const { store, orchestrator, now } = fixture();
    const secondRunId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-codex-lease-second'),
      pipeline: 'codex',
      now: NOW,
    });
    const secondToken = mintRunToken();
    await store.claimQueuedRun({
      pipelines: ['codex'],
      now: NOW,
      claimedBy: 'runner-2',
      tokenHash: hashRunToken(secondToken),
    });
    const read = vi.fn(context.codexAuth.read);
    const takeLease = vi.fn(context.codexAuth.takeLease);
    const r = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        bearerToken: secondToken,
        codexAuth: {
          ...context.codexAuth,
          readLease: async () => ({
            runId: 'github:jlapenna/agent-lcars:12345:1',
            repository: 'jlapenna/agent-lcars',
            expiresAt: '2026-08-28T12:00:00.000Z',
            generation: '21',
          }),
          read,
          takeLease,
        },
      },
      'GET',
      runPath(secondRunId, '/codex-auth'),
    );

    expect(r.status).toBe(409);
    expect(read).not.toHaveBeenCalled();
    expect(takeLease).not.toHaveBeenCalled();
  });

  it('takes over the shared subscription lease only after its recorded expiry', async () => {
    const { store, orchestrator, now } = fixture();
    const secondRunId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-codex-stale-second'),
      pipeline: 'codex',
      now: NOW,
    });
    const secondToken = mintRunToken();
    await store.claimQueuedRun({
      pipelines: ['codex'],
      now: NOW,
      claimedBy: 'runner-2',
      tokenHash: hashRunToken(secondToken),
    });
    const takeLease = vi.fn(context.codexAuth.takeLease);
    const r = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        bearerToken: secondToken,
        codexAuth: {
          ...context.codexAuth,
          readLease: async () => ({
            runId: 'github:jlapenna/agent-lcars:12345:1',
            repository: 'jlapenna/agent-lcars',
            expiresAt: '2026-08-26T09:00:00.000Z',
            generation: '22',
          }),
          takeLease,
        },
      },
      'GET',
      runPath(secondRunId, '/codex-auth'),
    );

    expect(r.status).toBe(200);
    expect(takeLease).toHaveBeenCalledWith({
      runId: secondRunId,
      repository: 'jlapenna/agent-lcars',
      expiresAt: expect.any(String),
      expectedGeneration: '22',
      claimFingerprint: hashRunToken(secondToken),
      operationId: expect.any(String),
    });
  });
});

describe('startup deadline run-token fence', () => {
  it.each([false, true])(
    'rejects late bootstrap, heartbeat and completion (swept=%s)',
    async (swept) => {
      const { store, orchestrator, now, setNow } = fixture();
      const runId = await seedQueuedRun(store, orchestrator, {
        workId: wid('launch-no-callback'),
        now: NOW,
      });
      const token = mintRunToken();
      await store.claimQueuedRun({
        pipelines: ['claude'],
        now: NOW,
        claimedBy: 'runner-1',
        tokenHash: hashRunToken(token),
      });
      const ctx = { store, orchestrator, now, ...context, bearerToken: token };
      setNow('2026-08-26T10:14:59.999Z');
      expect((await call(ctx, 'GET', runPath(runId, '/brief'))).status).toBe(
        200,
      );
      setNow('2026-08-26T10:15:00.000Z');
      if (swept) await orchestrator.sweepExpired();
      expect((await call(ctx, 'GET', runPath(runId, '/brief'))).status).toBe(
        401,
      );
      expect(
        (await call(ctx, 'POST', runPath(runId, '/heartbeat'))).status,
      ).toBe(401);
      expect(
        (
          await call(ctx, 'POST', runPath(runId, '/complete'), {
            outcome: 'pull-request',
            outcomeReference: { kind: 'pull-request', number: 1 },
          })
        ).status,
      ).toBe(401);
    },
  );
});

describe('exact outcome links cross the authenticated completion boundary', () => {
  const repo = 'jlapenna/agent-lcars';
  const comment = {
    kind: 'comment',
    number: 42,
    id: 99,
    url: `https://github.com/${repo}/issues/42#issuecomment-99`,
  };
  const review = {
    kind: 'review',
    number: 42,
    id: 100,
    url: `https://github.com/${repo}/pull/42#pullrequestreview-100`,
  };
  it.each([
    {
      outcome: 'pull-request',
      reference: { kind: 'pull-request', number: 12 },
      ref: `https://github.com/${repo}/pull/12`,
      state: 'done',
    },
    { outcome: 'comment', reference: comment, ref: comment.url, state: 'done' },
    { outcome: 'review', reference: review, ref: review.url, state: 'done' },
    { outcome: 'park', reference: comment, ref: comment.url, state: 'parked' },
    { outcome: 'no-op', reference: comment, ref: comment.url, state: 'done' },
    {
      outcome: 'park',
      reference: { kind: 'pull-request', number: 12, related: [comment] },
      ref: `https://github.com/${repo}/pull/12`,
      state: 'parked',
      relatedRefs: [comment.url],
    },
    {
      outcome: 'verification-failed',
      reference: comment,
      ref: undefined,
      state: 'failed',
    },
  ])(
    'stores $outcome without losing its artifact or lifecycle semantics',
    async ({ outcome, reference, ref, state, ...rest }) => {
      const { store, orchestrator, now } = fixture();
      const runId = await seedQueuedGithubRun(
        store,
        orchestrator,
        42,
        outcome === 'review' ? 'review' : 'reply',
      );
      const claimed = await call(
        {
          store,
          orchestrator,
          now,
          ...context,
          principal: executorPrincipal(['claude']),
        },
        'POST',
        '/runs/claim',
        { runner: 'runner-1' },
      );
      expect(claimed.status).toBe(200);
      const { token } = claimed.json as { token: string };
      const complete = await call(
        { store, orchestrator, now, ...context, bearerToken: token },
        'POST',
        runPath(runId, '/complete'),
        { outcome, outcomeReference: reference },
      );
      expect(complete.status).toBe(200);
      const settled = await store.readRun(runId);
      expect(settled?.state).toBe('finished');
      expect(settled?.result).toEqual({
        ok: outcome !== 'verification-failed',
        summary: outcome,
        ...(ref === undefined ? {} : { ref }),
        ...rest,
      });
      const taskId = { repo, issue: 42 };
      const task = await store.readTask(taskId);
      expect(deriveItemState(task!.task, await store.listRuns(taskId))).toBe(
        state,
      );
    },
  );
});

it.each([
  {
    outcome: 'comment',
    reference: {
      kind: 'comment',
      number: 43,
      id: 99,
      url: 'https://github.com/jlapenna/agent-lcars/issues/43#issuecomment-99',
    },
  },
  {
    outcome: 'review',
    reference: {
      kind: 'review',
      number: 42,
      id: 100,
      url: 'https://github.com/jlapenna/agent-lcars/pull/42#pullrequestreview-100',
    },
  },
])(
  'does not attach unverified $outcome metadata outside the immutable run anchor/mode',
  async ({ outcome, reference }) => {
    const { store, orchestrator, now } = fixture();
    const runId = await seedQueuedGithubRun(store, orchestrator, 42);
    const claimed = await call(
      {
        store,
        orchestrator,
        now,
        ...context,
        principal: executorPrincipal(['claude']),
      },
      'POST',
      '/runs/claim',
      { runner: 'runner-1' },
    );
    expect(claimed.status).toBe(200);
    const { token } = claimed.json as { token: string };
    const complete = await call(
      { store, orchestrator, now, ...context, bearerToken: token },
      'POST',
      runPath(runId, '/complete'),
      { outcome, outcomeReference: reference },
    );
    expect(complete.status).toBe(200);
    expect((await store.readRun(runId))?.result?.ref).toBeUndefined();
  },
);

describe('startup liveness and exact completion metadata compose', () => {
  it.each([false, true])(
    'accepts an exact comment after the startup deadline only with a timely first heartbeat (started=%s)',
    async (started) => {
      const { store, orchestrator, now, setNow } = fixture();
      const runId = await seedQueuedGithubRun(store, orchestrator, 42, 'reply');
      const claimed = await call(
        {
          store,
          orchestrator,
          now,
          ...context,
          principal: executorPrincipal(['claude']),
        },
        'POST',
        '/runs/claim',
        { runner: 'runner-1' },
      );
      expect(claimed.status).toBe(200);
      const { token } = claimed.json as { token: string };
      const ctx = { store, orchestrator, now, ...context, bearerToken: token };
      setNow('2026-08-26T10:14:59.999Z');
      const heartbeat = started
        ? await call(ctx, 'POST', runPath(runId, '/heartbeat'))
        : undefined;
      expect(heartbeat?.status).toBe(started ? 200 : undefined);
      const before = await store.readRun(runId);
      setNow('2026-08-26T10:15:00.000Z');
      const ref =
        'https://github.com/jlapenna/agent-lcars/issues/42#issuecomment-99';
      const completed = await call(ctx, 'POST', runPath(runId, '/complete'), {
        outcome: 'comment',
        outcomeReference: { kind: 'comment', number: 42, id: 99, url: ref },
      });
      expect(completed.status).toBe(started ? 200 : 401);
      const after = await store.readRun(runId);
      const finished = expect.objectContaining({ state: 'finished' });
      expect(after).toEqual(started ? finished : before);
      expect(after?.result).toEqual(
        started ? { ok: true, summary: 'comment', ref } : undefined,
      );
    },
  );
});

for (const backend of ['MemoryStore', 'FirestoreStore'] as const) {
  describe.skipIf(
    backend === 'FirestoreStore' &&
      process.env.FIRESTORE_EMULATOR_HOST === undefined,
  )(`${backend}: authenticated claim at callback transaction`, () => {
    it.each([
      { pipeline: 'claude', route: 'heartbeat' },
      { pipeline: 'claude', route: 'complete' },
      { pipeline: 'codex', route: 'heartbeat' },
      { pipeline: 'codex', route: 'complete' },
    ])(
      'refuses old $pipeline token on $route after same-run release/reclaim',
      async ({ pipeline, route }) => {
        const store: OrchestratorStore =
          backend === 'MemoryStore'
            ? new MemoryStore()
            : new FirestoreStore({
                projectId: 'demo-orchestrator',
                databaseId: '(default)',
                collectionPrefix: `callback-claim-${crypto.randomUUID()}-`,
                emulatorHost: process.env.FIRESTORE_EMULATOR_HOST!,
              });
        const orchestrator = new Orchestrator(store, { now: () => NOW });
        const now = () => new Date(NOW);
        const runId = await seedQueuedGithubRun(
          store,
          orchestrator,
          42,
          'reply',
          pipeline,
        );
        const principal = executorPrincipal([pipeline]);
        const claimed = await call(
          { store, orchestrator, now, ...context, principal },
          'POST',
          '/runs/claim',
          { runner: 'same-runner' },
        );
        expect(claimed.status).toBe(200);
        const oldToken = (claimed.json as { token: string }).token;
        const freshToken = mintRunToken();
        const freshFingerprint = hashRunToken(freshToken);
        const transactRun = store.transactRun.bind(store);
        let interleaved = false;
        let freshRun: Awaited<ReturnType<OrchestratorStore['readRun']>>;
        let freshTask: Awaited<ReturnType<OrchestratorStore['readTask']>>;
        store.transactRun = async (input) => {
          if (!interleaved) {
            interleaved = true;
            const released = await store.releaseQueuedRunClaim({
              runId,
              claimedBy: 'same-runner',
              tokenHash: hashRunToken(oldToken),
              now: NOW,
            });
            if (!released)
              throw new Error('failed to release original callback claim');
            const reclaimed = await store.claimQueuedRun({
              pipelines: [pipeline],
              now: NOW,
              claimedBy: 'same-runner',
              claimedBySubject: principal.subject.toLowerCase(),
              tokenHash: freshFingerprint,
            });
            if (reclaimed?.runId !== runId)
              throw new Error('failed to reclaim callback run');
            freshRun = await store.readRun(runId);
            freshTask = await store.readTask({
              repo: 'jlapenna/agent-lcars',
              issue: 42,
            });
          }
          return transactRun(input);
        };
        const drain = vi.fn(context.drain);
        const releaseLease = vi.fn(context.codexAuth.releaseLease);
        const takeLease = vi.fn(context.codexAuth.takeLease);
        const readLease = vi.fn(async () => ({
          runId,
          repository: 'jlapenna/agent-lcars',
          expiresAt: '2026-08-26T12:00:00.000Z',
          generation: '7',
        }));
        try {
          const callback = await call(
            {
              store,
              orchestrator,
              now,
              ...context,
              bearerToken: oldToken,
              drain,
              codexAuth: {
                ...context.codexAuth,
                readLease,
                takeLease,
                releaseLease,
              },
            },
            'POST',
            runPath(runId, '/' + route),
            route === 'complete'
              ? {
                  outcome: 'comment',
                  outcomeReference: {
                    kind: 'comment',
                    number: 42,
                    id: 99,
                    url: 'https://github.com/jlapenna/agent-lcars/issues/42#issuecomment-99',
                  },
                }
              : undefined,
          );
          expect(interleaved).toBe(true);
          expect(callback.status).toBe(401);
          expect(await store.readRun(runId)).toEqual(freshRun);
          expect(
            await store.readTask({ repo: 'jlapenna/agent-lcars', issue: 42 }),
          ).toEqual(freshTask);
          expect(freshRun?.queue?.tokenHash).toBe(freshFingerprint);
          expect(freshRun?.queue?.firstHeartbeatAt).toBeUndefined();
          expect(freshRun?.result).toBeUndefined();
          expect(drain).not.toHaveBeenCalled();
          expect(readLease).not.toHaveBeenCalled();
          expect(takeLease).not.toHaveBeenCalled();
          expect(releaseLease).not.toHaveBeenCalled();
        } finally {
          store.transactRun = transactRun;
        }
      },
    );
    it.each(['finished', 'canceled'] as const)(
      'releases its own Codex lease after concurrent %s settlement without draining again',
      async (state) => {
        const store: OrchestratorStore =
          backend === 'MemoryStore'
            ? new MemoryStore()
            : new FirestoreStore({
                projectId: 'demo-orchestrator',
                databaseId: '(default)',
                collectionPrefix: `callback-terminal-${crypto.randomUUID()}-`,
                emulatorHost: process.env.FIRESTORE_EMULATOR_HOST!,
              });
        const orchestrator = new Orchestrator(store, { now: () => NOW });
        const now = () => new Date(NOW);
        const runId = await seedQueuedGithubRun(
          store,
          orchestrator,
          42,
          'reply',
          'codex',
        );
        const claimed = await call(
          {
            store,
            orchestrator,
            now,
            ...context,
            principal: executorPrincipal(['codex']),
          },
          'POST',
          '/runs/claim',
          { runner: 'runner-1' },
        );
        expect(claimed.status).toBe(200);
        const token = (claimed.json as { token: string }).token;
        const transactRun = store.transactRun.bind(store);
        let interleaved = false;
        let terminalRun: Awaited<ReturnType<OrchestratorStore['readRun']>>;
        store.transactRun = async (input) => {
          if (!interleaved) {
            interleaved = true;
            const settled =
              state === 'finished'
                ? await orchestrator.report(runId, { ok: true })
                : await orchestrator.cancel(runId);
            if ('refused' in settled)
              throw new Error('terminal interleaving failed');
            terminalRun = await store.readRun(runId);
          }
          return transactRun(input);
        };
        const releaseLease = vi.fn(context.codexAuth.releaseLease);
        const drain = vi.fn(context.drain);
        try {
          const callback = await call(
            {
              store,
              orchestrator,
              now,
              ...context,
              bearerToken: token,
              drain,
              codexAuth: {
                ...context.codexAuth,
                releaseLease,
                readLease: async () => ({
                  runId,
                  repository: 'jlapenna/agent-lcars',
                  expiresAt: '2026-08-28T12:00:00.000Z',
                  generation: '11',
                  claimFingerprint: hashRunToken(token),
                }),
              },
            },
            'POST',
            runPath(runId, '/complete'),
            { outcome: 'no-op' },
          );
          expect(interleaved).toBe(true);
          expect(callback).toEqual({
            status: 200,
            json: { runId, state: 'run-not-live' },
          });
          const { credentialOperation: _cleanup, ...immutableTerminal } =
            terminalRun!;
          expect(await store.readRun(runId)).toEqual(immutableTerminal);
          expect(
            (await store.readRun(runId))?.credentialOperation,
          ).toBeUndefined();
          expect(drain).not.toHaveBeenCalled();
          expect(releaseLease).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              runId,
              claimFingerprint: hashRunToken(token),
              generation: '11',
            }),
            expect.any(String),
          );
        } finally {
          store.transactRun = transactRun;
        }
      },
    );
    it.each(['claude', 'codex'])(
      'fences old %s Job exit after same-subject/same-runner reclaim at the transaction boundary',
      async (pipeline) => {
        const store: OrchestratorStore =
          backend === 'MemoryStore'
            ? new MemoryStore()
            : new FirestoreStore({
                projectId: 'demo-orchestrator',
                databaseId: '(default)',
                collectionPrefix: `exit-claim-${crypto.randomUUID()}-`,
                emulatorHost: process.env.FIRESTORE_EMULATOR_HOST!,
              });
        const orchestrator = new Orchestrator(store, { now: () => NOW });
        const now = () => new Date(NOW);
        const principal = executorPrincipal([pipeline]);
        const runId = await seedQueuedGithubRun(
          store,
          orchestrator,
          42,
          'reply',
          pipeline,
        );
        const claimed = await call(
          { store, orchestrator, now, ...context, principal },
          'POST',
          '/runs/claim',
          { runner: 'same-runner' },
        );
        expect(claimed.status).toBe(200);
        const oldFingerprint = hashRunToken(
          (claimed.json as { token: string }).token,
        );
        const freshFingerprint = hashRunToken(mintRunToken());
        const original = store.transactRun.bind(store);
        let interleaved = false;
        let freshRun: Awaited<ReturnType<OrchestratorStore['readRun']>>;
        let freshTask: Awaited<ReturnType<OrchestratorStore['readTask']>>;
        store.transactRun = async (input) => {
          if (!interleaved) {
            interleaved = true;
            const released = await store.releaseQueuedRunClaim({
              runId,
              claimedBy: 'same-runner',
              tokenHash: oldFingerprint,
              now: NOW,
            });
            if (!released)
              throw new Error('original exit claim was not released');
            const reclaimed = await store.claimQueuedRun({
              pipelines: [pipeline],
              now: NOW,
              claimedBy: 'same-runner',
              claimedBySubject: principal.subject.toLowerCase(),
              tokenHash: freshFingerprint,
            });
            if (reclaimed?.runId !== runId)
              throw new Error('exit run was not reclaimed');
            freshRun = await store.readRun(runId);
            freshTask = await store.readTask({
              repo: 'jlapenna/agent-lcars',
              issue: 42,
            });
          }
          return original(input);
        };
        const drain = vi.fn(context.drain);
        const releaseLease = vi.fn(context.codexAuth.releaseLease);
        const ctx = {
          store,
          orchestrator,
          now,
          ...context,
          principal,
          drain,
          codexAuth: {
            ...context.codexAuth,
            releaseLease,
            readLease: async () => ({
              runId,
              repository: 'jlapenna/agent-lcars',
              expiresAt: '2026-08-28T12:00:00.000Z',
              generation: '11',
              claimFingerprint: freshFingerprint,
            }),
          },
        };
        try {
          const stale = await call(ctx, 'POST', runPath(runId, '/exit'), {
            runner: 'same-runner',
            claimFingerprint: oldFingerprint,
          });
          expect(interleaved).toBe(true);
          expect(stale.status).toBe(403);
          expect(await store.readRun(runId)).toEqual(freshRun);
          expect(
            await store.readTask({ repo: 'jlapenna/agent-lcars', issue: 42 }),
          ).toEqual(freshTask);
          expect(drain).not.toHaveBeenCalled();
          expect(releaseLease).not.toHaveBeenCalled();
          const missing = await call(ctx, 'POST', runPath(runId, '/exit'), {
            runner: 'same-runner',
          });
          expect(missing.status).toBe(403);
          expect(await store.readRun(runId)).toEqual(freshRun);
          const matching = await call(ctx, 'POST', runPath(runId, '/exit'), {
            runner: 'same-runner',
            claimFingerprint: freshFingerprint,
          });
          expect(matching).toEqual({
            status: 200,
            json: { runId, state: 'lost' },
          });
          expect(drain).toHaveBeenCalledOnce();
          expect(releaseLease).toHaveBeenCalledTimes(
            pipeline === 'codex' ? 1 : 0,
          );
          expect(
            await store.listRuns({ repo: 'jlapenna/agent-lcars', issue: 42 }),
          ).toHaveLength(2);
          const terminal = await call(ctx, 'POST', runPath(runId, '/exit'), {
            runner: 'same-runner',
          });
          expect(terminal).toEqual({
            status: 200,
            json: { runId, state: 'lost' },
          });
          expect(drain).toHaveBeenCalledOnce();
        } finally {
          store.transactRun = original;
        }
      },
    );
  });
}

for (const backend of ['MemoryStore', 'FirestoreStore'] as const) {
  describe.skipIf(
    backend === 'FirestoreStore' &&
      process.env.FIRESTORE_EMULATOR_HOST === undefined,
  )(`${backend}: Codex external generation boundary`, () => {
    async function brokerFixture(ownedLease = true, fallback = false) {
      const store: OrchestratorStore =
        backend === 'MemoryStore'
          ? new MemoryStore()
          : new FirestoreStore({
              projectId: 'demo-orchestrator',
              databaseId: '(default)',
              collectionPrefix: `broker-${crypto.randomUUID()}-`,
              emulatorHost: process.env.FIRESTORE_EMULATOR_HOST!,
            });
      let instant = NOW;
      const now = () => new Date(instant);
      let fallbackGrants = ['codex', 'claude'];
      const orchestrator = new Orchestrator(
        store,
        { now: () => instant },
        fallback
          ? {
              pipelines: ['codex', 'claude'],
              allowedPipelines: () => fallbackGrants,
            }
          : undefined,
      );
      const runId = await seedQueuedGithubRun(
        store,
        orchestrator,
        42,
        'implement',
        'codex',
        fallback,
      );
      const principal = executorPrincipal(['codex']);
      const claimed = await call(
        { ...context, store, orchestrator, now, principal },
        'POST',
        '/runs/claim',
        { runner: 'same-runner' },
      );
      expect(claimed.status).toBe(200);
      const token = (claimed.json as { token: string }).token;
      const fingerprint = hashRunToken(token);
      const fake = new ConditionalCodexBucket();
      const auth = fake.seed(
        codexCentralAuthObject(),
        Buffer.from('{"tokens":{"access":"original"}}'),
      );
      if (ownedLease)
        fake.seed(
          CODEX_GLOBAL_LEASE_OBJECT,
          Buffer.from(
            JSON.stringify({
              runId,
              repository: 'jlapenna/agent-lcars',
              expiresAt: '2026-08-26T12:00:00.000Z',
              claimFingerprint: fingerprint,
              operationId: 'restored:1',
            }),
          ),
        );
      const codexAuth = new GcsCodexAuthStore(fake.bucket);
      const ctx = {
        ...context,
        store,
        orchestrator,
        now,
        principal,
        bearerToken: token,
        codexAuth,
      };
      const payload = {
        generation: auth.generation,
        restoredSha256: '0'.repeat(64),
        authBase64: Buffer.from('{"tokens":{"access":"rotated"}}').toString(
          'base64',
        ),
      };
      return {
        store,
        orchestrator,
        now,
        runId,
        token,
        fingerprint,
        fake,
        codexAuth,
        ctx,
        payload,
        revokeFallback: () => {
          fallbackGrants = ['codex'];
        },
        setNow: (value: string) => {
          instant = value;
        },
      };
    }
    const request = (
      f: Awaited<ReturnType<typeof brokerFixture>>,
      route: string,
    ) =>
      route === 'persist'
        ? call(f.ctx, 'PUT', runPath(f.runId, '/codex-auth'), f.payload)
        : route === 'restore'
          ? call(f.ctx, 'GET', runPath(f.runId, '/codex-auth'))
          : call(f.ctx, 'POST', runPath(f.runId, '/heartbeat'));

    it.each(['restore', 'persist', 'heartbeat'])(
      'refuses old %s authority reclaimed before the atomic reservation without broker IO',
      async (route) => {
        const f = await brokerFixture();
        const original = f.store.transactRun.bind(f.store);
        let changed = false;
        let released: boolean | undefined;
        let fresh: Awaited<ReturnType<OrchestratorStore['readRun']>>;
        f.store.transactRun = async (input) => {
          if (!changed) {
            changed = true;
            released = await f.store.releaseQueuedRunClaim({
              runId: f.runId,
              claimedBy: 'same-runner',
              tokenHash: f.fingerprint,
              now: NOW,
            });
            await f.store.claimQueuedRun({
              pipelines: ['codex'],
              now: NOW,
              claimedBy: 'same-runner',
              claimedBySubject: f.ctx.principal.subject.toLowerCase(),
              tokenHash: 'f'.repeat(64),
            });
            fresh = await f.store.readRun(f.runId);
          }
          return original(input);
        };
        const readLease = vi.spyOn(f.codexAuth, 'readLease');
        const response = await request(f, route);
        expect(response.status).toBe(401);
        expect(released).toBe(true);
        expect(await f.store.readRun(f.runId)).toEqual(fresh);
        expect(readLease).not.toHaveBeenCalled();
        expect(f.fake.attempts).toHaveLength(0);
      },
    );

    it.each(['restore', 'persist', 'heartbeat'])(
      'serializes %s IO with a real release/reclaim attempt at the lease-read boundary',
      async (route) => {
        const f = await brokerFixture();
        const original = f.codexAuth.readLease.bind(f.codexAuth);
        let interleaved = false;
        let released: boolean | undefined;
        let reclaimed: Run | undefined;
        let exitStatus: number | undefined;
        f.codexAuth.readLease = async () => {
          if (!interleaved) {
            interleaved = true;
            released = await f.store.releaseQueuedRunClaim({
              runId: f.runId,
              claimedBy: 'same-runner',
              tokenHash: f.fingerprint,
              now: NOW,
            });
            reclaimed = await f.store.claimQueuedRun({
              pipelines: ['codex'],
              now: NOW,
              claimedBy: 'same-runner',
              tokenHash: 'f'.repeat(64),
            });
            const exit = await call(f.ctx, 'POST', runPath(f.runId, '/exit'), {
              runner: 'same-runner',
              claimFingerprint: f.fingerprint,
            });
            exitStatus = exit.status;
          }
          return original();
        };
        const response = await request(f, route);
        expect(response.status).toBe(200);
        expect(interleaved).toBe(true);
        expect(released).toBe(false);
        expect(reclaimed).toBeUndefined();
        expect(exitStatus).toBe(409);
        expect(
          (await f.store.readRun(f.runId))?.credentialOperation,
        ).toBeUndefined();
        expect(
          await f.store.releaseQueuedRunClaim({
            runId: f.runId,
            claimedBy: 'same-runner',
            tokenHash: f.fingerprint,
            now: NOW,
          }),
        ).toBe(true);
        expect(
          (
            await f.store.claimQueuedRun({
              pipelines: ['codex'],
              now: NOW,
              claimedBy: 'same-runner',
              claimedBySubject: f.ctx.principal.subject.toLowerCase(),
              tokenHash: 'f'.repeat(64),
            })
          )?.queue?.tokenHash,
        ).toBe('f'.repeat(64));
      },
    );

    it('keeps a one-shot exact completion durable through lost cleanup response and recovery after its deadline', async () => {
      const f = await brokerFixture();
      let lost = false;
      f.fake.afterSave = async (attempt) => {
        if (
          !lost &&
          attempt.name === CODEX_GLOBAL_LEASE_OBJECT &&
          JSON.parse(attempt.bytes.toString()).expiresAt ===
            '1970-01-01T00:00:00.000Z'
        ) {
          lost = true;
          throw Object.assign(new Error('lost response'), { code: 503 });
        }
      };
      expect(await request(f, 'persist')).toEqual({
        status: 200,
        json: { status: 'updated' },
      });
      expect(
        (await f.store.readRun(f.runId))?.credentialOperation?.mutation?.kind,
      ).toBe('lease-write');
      const intended = {
        outcome: 'pull-request',
        outcomeReference: {
          kind: 'pull-request',
          number: 99,
          related: [
            {
              kind: 'comment',
              number: 42,
              id: 123,
              url: 'https://github.com/jlapenna/agent-lcars/issues/42#issuecomment-123',
            },
          ],
        },
        message: 'Exact durable deliverable',
      };
      expect(
        await call(f.ctx, 'POST', runPath(f.runId, '/complete'), intended),
      ).toEqual({
        status: 200,
        json: { runId: f.runId, state: 'completion-pending' },
      });
      const first = (await f.store.readRun(f.runId))?.credentialPendingResult;
      expect(first?.result).toMatchObject({
        ok: true,
        ref: 'https://github.com/jlapenna/agent-lcars/pull/99',
        relatedRefs: [
          'https://github.com/jlapenna/agent-lcars/issues/42#issuecomment-123',
        ],
        message: intended.message,
      });
      expect(
        (
          await call(f.ctx, 'POST', runPath(f.runId, '/complete'), {
            outcome: 'no-deliverable',
            outcomeReference: null,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await call(f.ctx, 'POST', runPath(f.runId, '/exit'), {
            runner: 'same-runner',
            claimFingerprint: f.fingerprint,
          })
        ).status,
      ).toBe(409);
      f.setNow('2026-08-26T13:00:00.000Z');
      expect(await f.orchestrator.sweepExpired()).toEqual({
        lost: [],
        retried: [],
      });
      const [a, b] = await Promise.all([
        recoverCodexCredentialOperations(f.ctx),
        recoverCodexCredentialOperations(f.ctx),
      ]);
      expect([...a.recovered, ...b.recovered]).toEqual([f.runId]);
      const settled = await f.store.readRun(f.runId);
      expect(settled?.state).toBe('finished');
      expect(settled?.result).toEqual(first?.result);
      expect(settled?.credentialOperation).toBeUndefined();
      expect(settled?.credentialPendingResult).toBeUndefined();
      expect(
        (await f.store.readTask(settled!.task))?.task.activeRunId,
      ).toBeUndefined();
      const entries = await f.store.claimPendingOutbox({
        limit: 30,
        now: f.now().toISOString(),
        leaseExpiresAt: '2026-08-26T13:05:00.000Z',
      });
      expect(
        entries.filter((entry) => entry.kind === 'report-outcome'),
      ).toHaveLength(1);
      expect(await f.orchestrator.sweepExpired()).toEqual({
        lost: [],
        retried: [],
      });
      expect(await recoverCodexCredentialOperations(f.ctx)).toEqual({
        recovered: [],
        unresolved: [],
      });
      expect((await f.codexAuth.readLease())?.expiresAt).toBe(
        '1970-01-01T00:00:00.000Z',
      );
    });

    it.each(['write-wins', 'fence-wins'])(
      'resolves an unknown auth RPC without admitting a late overwrite (%s)',
      async (ordering) => {
        const f = await brokerFixture();
        const entered = deferred(),
          delay = deferred();
        if (ordering === 'fence-wins')
          f.fake.beforeSave = async (attempt) => {
            if (
              attempt.name === codexCentralAuthObject() &&
              attempt.metadata.lcarsClaimFingerprint === f.fingerprint
            ) {
              entered.resolve();
              await delay.promise;
            }
          };
        else
          f.fake.afterSave = async (attempt) => {
            if (attempt.name === codexCentralAuthObject())
              throw Object.assign(new Error('lost response'), { code: 503 });
          };
        const old = request(f, 'persist');
        const initialStatus =
          ordering === 'write-wins' ? (await old).status : undefined;
        if (ordering === 'fence-wins') await entered.promise;
        expect(initialStatus).toBe(ordering === 'write-wins' ? 500 : undefined);
        expect(
          await f.store.releaseQueuedRunClaim({
            runId: f.runId,
            claimedBy: 'same-runner',
            tokenHash: f.fingerprint,
            now: NOW,
          }),
        ).toBe(false);
        f.setNow('2026-08-26T10:06:00.000Z');
        expect(await recoverCodexCredentialOperations(f.ctx)).toEqual({
          recovered: [f.runId],
          unresolved: [],
        });
        let retry: Awaited<ReturnType<typeof call>> | undefined;
        let released: boolean | undefined;
        let lateStatus: number | undefined;
        let preserved: boolean | undefined;
        const count = f.fake.commits.filter(
          (c) => c.name === codexCentralAuthObject(),
        ).length;
        if (ordering === 'write-wins') {
          f.fake.afterSave = undefined;
          retry = await request(f, 'persist');
        } else {
          released = await f.store.releaseQueuedRunClaim({
            runId: f.runId,
            claimedBy: 'same-runner',
            tokenHash: f.fingerprint,
            now: f.now().toISOString(),
          });
          const nextToken = mintRunToken();
          await f.store.claimQueuedRun({
            pipelines: ['codex'],
            now: f.now().toISOString(),
            claimedBy: 'same-runner',
            claimedBySubject: f.ctx.principal.subject.toLowerCase(),
            tokenHash: hashRunToken(nextToken),
          });
          const fresh = await f.store.readRun(f.runId);
          const credential = await f.codexAuth.read();
          delay.resolve();
          lateStatus = (await old).status;
          preserved =
            JSON.stringify(await f.store.readRun(f.runId)) ===
              JSON.stringify(fresh) &&
            JSON.stringify(await f.codexAuth.read()) ===
              JSON.stringify(credential);
        }
        expect(retry).toEqual(
          ordering === 'write-wins'
            ? { status: 200, json: { status: 'updated' } }
            : undefined,
        );
        expect(
          f.fake.commits.filter((c) => c.name === codexCentralAuthObject()),
        ).toHaveLength(count);
        expect(released).toBe(ordering === 'fence-wins' ? true : undefined);
        expect(lateStatus).toBe(ordering === 'fence-wins' ? 401 : undefined);
        expect(preserved).toBe(ordering === 'fence-wins' ? true : undefined);
      },
    );

    it('fences a lost-response cleanup before completing and permits a full successor cycle without late release', async () => {
      const f = await brokerFixture();
      const delayed = deferred();
      let captured = false;
      f.fake.delayAndLoseResponse = (attempt) => {
        if (
          !captured &&
          attempt.name === CODEX_GLOBAL_LEASE_OBJECT &&
          JSON.parse(attempt.bytes.toString()).expiresAt ===
            '1970-01-01T00:00:00.000Z'
        ) {
          captured = true;
          return delayed.promise;
        }
        return undefined;
      };
      expect(await request(f, 'persist')).toEqual({
        status: 200,
        json: { status: 'updated' },
      });
      expect(
        (
          await call(f.ctx, 'POST', runPath(f.runId, '/complete'), {
            outcome: 'pull-request',
            outcomeReference: { kind: 'pull-request', number: 99 },
          })
        ).json,
      ).toEqual({ runId: f.runId, state: 'completion-pending' });
      f.setNow('2026-08-26T10:06:00.000Z');
      expect(await recoverCodexCredentialOperations(f.ctx)).toEqual({
        recovered: [f.runId],
        unresolved: [],
      });
      expect((await f.store.readRun(f.runId))?.state).toBe('finished');
      expect((await f.codexAuth.readLease())?.expiresAt).toBe(
        '1970-01-01T00:00:00.000Z',
      );
      const next = await f.orchestrator.request({
        taskId: { repo: 'jlapenna/agent-lcars', issue: 42 },
        requestId: 'successor',
        pipeline: 'codex',
      });
      if ('refused' in next || next.run === undefined)
        throw new Error('successor was not admitted');
      await f.store.enqueueRun({
        runId: next.run.runId,
        now: f.now().toISOString(),
      });
      await f.orchestrator.confirmDispatch(next.run.runId);
      const claim = await call(f.ctx, 'POST', '/runs/claim', {
        runner: 'same-runner',
      });
      const nextCtx = {
        ...f.ctx,
        bearerToken: (claim.json as { token: string }).token,
      };
      const restored = await call(
        nextCtx,
        'GET',
        runPath(next.run.runId, '/codex-auth'),
      );
      expect(restored.status).toBe(200);
      const snapshot = restored.json as {
        generation: string;
        authBase64: string;
        sha256: string;
      };
      expect(
        (
          await call(nextCtx, 'PUT', runPath(next.run.runId, '/codex-auth'), {
            generation: snapshot.generation,
            authBase64: snapshot.authBase64,
            restoredSha256: snapshot.sha256,
          })
        ).json,
      ).toEqual({ status: 'unchanged' });
      const successorLease = await f.codexAuth.readLease();
      delayed.resolve();
      expect(await f.fake.delayedResults[0]).toMatchObject({ code: 412 });
      expect(await f.codexAuth.readLease()).toEqual(successorLease);
      expect(
        (await f.store.readRun(next.run.runId))?.credentialOperation,
      ).toBeUndefined();
    });

    it('retires a failed first restore without a ghost reservation or credential lease', async () => {
      const f = await brokerFixture(false);
      f.fake.objects.delete(codexCentralAuthObject());
      expect((await request(f, 'restore')).status).toBe(404);
      expect(
        (await f.store.readRun(f.runId))?.credentialOperation,
      ).toBeUndefined();
      expect((await f.codexAuth.readLease())?.expiresAt).toBe(
        '1970-01-01T00:00:00.000Z',
      );
    });

    it.each(['live-historical', 'expired-historical'])(
      'preserves readable historical lease authority while restoring: %s',
      async (kind) => {
        const f = await brokerFixture(false);
        f.fake.seed(
          CODEX_GLOBAL_LEASE_OBJECT,
          Buffer.from(
            JSON.stringify({
              runId: f.runId,
              repository: 'jlapenna/agent-lcars',
              expiresAt:
                kind === 'live-historical'
                  ? '2026-08-26T12:00:00.000Z'
                  : '1970-01-01T00:00:00.000Z',
            }),
          ),
        );
        const response = await request(f, 'restore');
        expect(response.status).toBe(kind === 'live-historical' ? 409 : 200);
        expect(f.fake.commits).toHaveLength(kind === 'live-historical' ? 0 : 1);
        expect(
          (await f.store.readRun(f.runId))?.credentialOperation,
        ).toBeUndefined();
      },
    );

    it.each(['absent', 'expired-foreign', 'historical'])(
      'allows bootstrap heartbeat with %s lease without foreign mutation',
      async (kind) => {
        const f = await brokerFixture(false);
        if (kind !== 'absent')
          f.fake.seed(
            CODEX_GLOBAL_LEASE_OBJECT,
            Buffer.from(
              JSON.stringify({
                runId: kind === 'historical' ? f.runId : 'other-run',
                repository: 'jlapenna/agent-lcars',
                expiresAt:
                  kind === 'historical'
                    ? '2026-08-26T12:00:00.000Z'
                    : '1970-01-01T00:00:00.000Z',
              }),
            ),
          );
        expect((await request(f, 'heartbeat')).status).toBe(200);
        expect(f.fake.commits).toHaveLength(0);
        expect(
          (await f.store.readRun(f.runId))?.credentialOperation,
        ).toBeUndefined();
      },
    );

    it('retires the original credential lease when completion arrives between renewal recovery snapshot and finish', async () => {
      const f = await brokerFixture();
      let lost = false;
      f.fake.afterSave = async (attempt) => {
        if (!lost && attempt.name === CODEX_GLOBAL_LEASE_OBJECT) {
          lost = true;
          throw Object.assign(new Error('lost renewal response'), {
            code: 503,
          });
        }
      };
      expect((await request(f, 'heartbeat')).status).toBe(500);
      expect((await f.store.readRun(f.runId))?.credentialOperation?.kind).toBe(
        'renew',
      );
      f.fake.afterSave = undefined;
      f.setNow('2026-08-26T10:06:00.000Z');
      const originalRead = f.store.readRun.bind(f.store);
      let injected = false;
      let pendingResponse: Awaited<ReturnType<typeof call>> | undefined;
      f.store.readRun = async (runId) => {
        const snapshot = await originalRead(runId);
        if (
          !injected &&
          runId === f.runId &&
          snapshot?.credentialOperation?.kind === 'renew' &&
          snapshot.credentialOperation.mutation === undefined
        ) {
          injected = true;
          pendingResponse = await call(
            f.ctx,
            'POST',
            runPath(f.runId, '/complete'),
            {
              outcome: 'pull-request',
              outcomeReference: { kind: 'pull-request', number: 99 },
              message: 'Accepted during recovery snapshot gap',
            },
          );
        }
        return snapshot;
      };
      const recovery = await recoverCodexCredentialOperations(f.ctx);
      expect(injected).toBe(true);
      expect(pendingResponse).toEqual({
        status: 200,
        json: { runId: f.runId, state: 'completion-pending' },
      });
      expect(recovery).toEqual({ recovered: [f.runId], unresolved: [] });
      expect((await originalRead(f.runId))?.state).toBe('finished');
      const lease = await f.codexAuth.readLease();
      const next = await f.orchestrator.request({
        taskId: { repo: 'jlapenna/agent-lcars', issue: 42 },
        requestId: 'after-renew-completion',
        pipeline: 'codex',
      });
      if ('refused' in next || next.run === undefined)
        throw new Error('successor admission failed');
      await f.store.enqueueRun({
        runId: next.run.runId,
        now: f.now().toISOString(),
      });
      await f.orchestrator.confirmDispatch(next.run.runId);
      const claim = await call(f.ctx, 'POST', '/runs/claim', {
        runner: 'same-runner',
      });
      expect(claim.status).toBe(200);
      const successorCtx = {
        ...f.ctx,
        bearerToken: (claim.json as { token: string }).token,
      };
      const restore = await call(
        successorCtx,
        'GET',
        runPath(next.run.runId, '/codex-auth'),
      );
      expect(restore.status).toBe(200);
      expect(lease?.expiresAt).toBe('1970-01-01T00:00:00.000Z');
    });

    it.each(['restore', 'heartbeat', 'persist'])(
      'retires a live exact lease when completion arrives before normal %s finish',
      async (route) => {
        const f = await brokerFixture();
        const transact = f.store.transactRun.bind(f.store);
        const read = f.store.readRun.bind(f.store);
        let injected = false;
        let pendingResponse: Awaited<ReturnType<typeof call>> | undefined;
        f.store.transactRun = async (input) => {
          const snapshot = await read(input.runId);
          if (
            !injected &&
            input.runId === f.runId &&
            snapshot?.credentialOperation?.kind ===
              (route === 'heartbeat' ? 'renew' : route) &&
            snapshot.credentialOperation.mutation === undefined &&
            (route === 'restore' ||
              snapshot.credentialOperation.mutationSequence > 0)
          ) {
            injected = true;
            pendingResponse = await call(
              f.ctx,
              'POST',
              runPath(f.runId, '/complete'),
              {
                outcome: 'pull-request',
                outcomeReference: { kind: 'pull-request', number: 99 },
                message: 'Accepted before normal finish',
              },
            );
          }
          return transact(input);
        };
        const response = await request(f, route);
        expect(response.status).toBe(route === 'restore' ? 401 : 200);
        expect(response.json).not.toHaveProperty('authBase64');
        expect(injected).toBe(true);
        expect(pendingResponse).toEqual({
          status: 200,
          json: { runId: f.runId, state: 'completion-pending' },
        });
        const finished = await read(f.runId);
        expect(finished?.state).toBe('finished');
        expect(finished?.result).toMatchObject({
          ref: 'https://github.com/jlapenna/agent-lcars/pull/99',
          message: 'Accepted before normal finish',
        });
        expect(finished?.credentialPendingResult).toBeUndefined();
        expect(finished?.credentialOperation).toBeUndefined();
        expect((await f.codexAuth.readLease())?.expiresAt).toBe(
          '1970-01-01T00:00:00.000Z',
        );
        const entries = await f.store.claimPendingOutbox({
          limit: 30,
          now: f.now().toISOString(),
          leaseExpiresAt: '2026-08-26T10:05:00.000Z',
        });
        expect(
          entries.filter((entry) => entry.kind === 'report-outcome'),
        ).toHaveLength(1);
        const next = await f.orchestrator.request({
          taskId: { repo: 'jlapenna/agent-lcars', issue: 42 },
          requestId: `after-normal-${route}-completion`,
          pipeline: 'codex',
        });
        if ('refused' in next || next.run === undefined)
          throw new Error('successor admission failed');
        await f.store.enqueueRun({
          runId: next.run.runId,
          now: f.now().toISOString(),
        });
        await f.orchestrator.confirmDispatch(next.run.runId);
        const claim = await call(f.ctx, 'POST', '/runs/claim', {
          runner: 'same-runner',
        });
        expect(claim.status).toBe(200);
        const successorCtx = {
          ...f.ctx,
          bearerToken: (claim.json as { token: string }).token,
        };
        expect(
          (
            await call(
              successorCtx,
              'GET',
              runPath(next.run.runId, '/codex-auth'),
            )
          ).status,
        ).toBe(200);
      },
    );

    it('keeps a healthy renewal lease live through recovery when no completion was accepted', async () => {
      const f = await brokerFixture();
      let lost = false;
      f.fake.afterSave = async (attempt) => {
        if (!lost && attempt.name === CODEX_GLOBAL_LEASE_OBJECT) {
          lost = true;
          throw Object.assign(new Error('lost renewal response'), {
            code: 503,
          });
        }
      };
      expect((await request(f, 'heartbeat')).status).toBe(500);
      f.fake.afterSave = undefined;
      f.setNow('2026-08-26T10:06:00.000Z');
      expect(await recoverCodexCredentialOperations(f.ctx)).toEqual({
        recovered: [f.runId],
        unresolved: [],
      });
      const run = await f.store.readRun(f.runId);
      expect(run?.state).toBe('running');
      expect(run?.credentialPendingResult).toBeUndefined();
      expect(run?.credentialOperation).toBeUndefined();
      const lease = await f.codexAuth.readLease();
      expect(lease?.claimFingerprint).toBe(f.fingerprint);
      expect(Date.parse(lease?.expiresAt ?? '')).toBeGreaterThan(
        f.now().getTime(),
      );
      expect(
        f.fake.commits.filter(
          (commit) =>
            commit.name === CODEX_GLOBAL_LEASE_OBJECT &&
            JSON.parse(commit.bytes.toString()).expiresAt ===
              '1970-01-01T00:00:00.000Z',
        ),
      ).toHaveLength(0);
      expect((await request(f, 'heartbeat')).status).toBe(200);
    });

    it('refuses a stale recovery acknowledgement when the original actor has prepared its next action', async () => {
      const f = await brokerFixture();
      f.fake.afterSave = async (attempt) => {
        if (attempt.name === codexCentralAuthObject())
          throw Object.assign(new Error('lost response'), { code: 503 });
      };
      expect((await request(f, 'persist')).status).toBe(500);
      f.fake.afterSave = undefined;
      const originalFence = f.codexAuth.fenceMutation.bind(f.codexAuth);
      let advanced = false;
      let acknowledger: unknown;
      let preparer: unknown;
      let nextAction: CredentialMutation | undefined;
      f.codexAuth.fenceMutation = async (input) => {
        const fenced = await originalFence(input);
        if (!advanced) {
          advanced = true;
          acknowledger = await f.store.transactRun({
            runId: f.runId,
            decide: ({ task, run }) => {
              if (task === undefined || run === undefined)
                throw new Error('missing acknowledgement fixture');
              return changeCredentialOperation({
                now: f.now().toISOString(),
                task: task.task,
                run,
                id: input.operation.id,
                claimFingerprint: f.fingerprint,
                change: {
                  kind: 'acknowledge',
                  mutationId: input.mutation.id,
                  receipt: fenced.receipt,
                },
              });
            },
          });
          const lease = await f.codexAuth.readLease();
          if (lease === undefined) throw new Error('missing lease fixture');
          nextAction = {
            kind: 'lease-write',
            id: `${input.operation.id}:2`,
            expectedGeneration: lease.generation,
            repository: lease.repository,
            expiresAt: '1970-01-01T00:00:00.000Z',
          };
          preparer = await f.store.transactRun({
            runId: f.runId,
            decide: ({ task, run }) => {
              if (task === undefined || run === undefined)
                throw new Error('missing prepare fixture');
              return changeCredentialOperation({
                now: f.now().toISOString(),
                task: task.task,
                run,
                id: input.operation.id,
                claimFingerprint: f.fingerprint,
                change: {
                  kind: 'prepare',
                  mutation: nextAction as CredentialMutation,
                },
              });
            },
          });
        }
        return fenced;
      };
      f.setNow('2026-08-26T10:06:00.000Z');
      expect(await recoverCodexCredentialOperations(f.ctx)).toEqual({
        recovered: [],
        unresolved: [],
      });
      expect(acknowledger).not.toHaveProperty('refused');
      expect(preparer).not.toHaveProperty('refused');
      expect(
        (await f.store.readRun(f.runId))?.credentialOperation?.mutation,
      ).toEqual(nextAction);
      expect(
        await f.store.releaseQueuedRunClaim({
          runId: f.runId,
          claimedBy: 'same-runner',
          tokenHash: f.fingerprint,
          now: f.now().toISOString(),
        }),
      ).toBe(false);
      f.setNow('2026-08-26T10:12:00.000Z');
      expect(await recoverCodexCredentialOperations(f.ctx)).toEqual({
        recovered: [f.runId],
        unresolved: [],
      });
      expect(
        (await f.store.readRun(f.runId))?.credentialOperation,
      ).toBeUndefined();
      expect((await f.codexAuth.readLease())?.expiresAt).toBe(
        '1970-01-01T00:00:00.000Z',
      );
    });

    it.each(['restore', 'heartbeat'])(
      'fences an unknown %s lease RPC and permits original matching-claim progress before it resumes',
      async (route) => {
        const f = await brokerFixture(route !== 'restore');
        const delayed = deferred();
        let captured = false;
        f.fake.delayAndLoseResponse = (attempt) => {
          if (
            !captured &&
            attempt.name === CODEX_GLOBAL_LEASE_OBJECT &&
            JSON.parse(attempt.bytes.toString()).expiresAt !==
              '1970-01-01T00:00:00.000Z'
          ) {
            captured = true;
            return delayed.promise;
          }
          return undefined;
        };
        expect((await request(f, route)).status).toBe(500);
        expect(
          (await f.store.readRun(f.runId))?.credentialOperation?.mutation?.kind,
        ).toBe('lease-write');
        expect(
          await f.store.releaseQueuedRunClaim({
            runId: f.runId,
            claimedBy: 'same-runner',
            tokenHash: f.fingerprint,
            now: NOW,
          }),
        ).toBe(false);
        f.setNow('2026-08-26T10:06:00.000Z');
        expect(await recoverCodexCredentialOperations(f.ctx)).toEqual({
          recovered: [f.runId],
          unresolved: [],
        });
        expect((await request(f, route)).status).toBe(200);
        const current = await f.codexAuth.readLease();
        delayed.resolve();
        expect(await f.fake.delayedResults[0]).toMatchObject({ code: 412 });
        expect(await f.codexAuth.readLease()).toEqual(current);
        expect(
          (await f.store.readRun(f.runId))?.credentialOperation,
        ).toBeUndefined();
      },
    );

    it('rotates beyond thirty unresolved recovery candidates without unlocking any unknown action', async () => {
      const f = await brokerFixture();
      const runIds: string[] = [];
      for (let index = 0; index < 31; index++) {
        const runId =
          index === 0
            ? f.runId
            : await seedQueuedGithubRun(
                f.store,
                f.orchestrator,
                100 + index,
                'implement',
                'codex',
              );
        if (index !== 0)
          await f.store.claimQueuedRun({
            pipelines: ['codex'],
            now: NOW,
            claimedBy: 'same-runner',
            tokenHash: f.fingerprint,
          });
        await f.orchestrator.cancel(runId);
        const cleanup = (await f.store.readRun(runId))?.credentialOperation;
        expect(cleanup?.kind).toBe('cleanup');
        const operationId = cleanup!.id;
        const prepare = await f.store.transactRun({
          runId,
          decide: ({ task, run }) => {
            if (task === undefined || run === undefined)
              throw new Error('missing recovery fixture');
            return changeCredentialOperation({
              now: NOW,
              task: task.task,
              run,
              claimFingerprint: f.fingerprint,
              id: operationId,
              change: {
                kind: 'prepare',
                mutation: {
                  kind: 'lease-write',
                  id: `${operationId}:1`,
                  expectedGeneration: '7',
                  repository: 'jlapenna/agent-lcars',
                  expiresAt: '1970-01-01T00:00:00.000Z',
                },
              },
            });
          },
        });
        expect(prepare).not.toHaveProperty('refused');
        runIds.push(runId);
      }
      const fence = vi
        .spyOn(f.codexAuth, 'fenceMutation')
        .mockRejectedValue(
          new CodexAuthStoreError(
            'unavailable',
            'isolated unknown storage outcome',
          ),
        );
      f.setNow('2026-08-26T10:06:00.000Z');
      const first = await recoverCodexCredentialOperations(f.ctx);
      const next = await recoverCodexCredentialOperations(f.ctx);
      expect(first.recovered).toEqual([]);
      expect(first.unresolved).toHaveLength(30);
      expect(next.recovered).toEqual([]);
      expect(next.unresolved).toHaveLength(1);
      expect(new Set([...first.unresolved, ...next.unresolved])).toEqual(
        new Set(runIds),
      );
      expect(fence).toHaveBeenCalledTimes(31);
      for (const runId of runIds) {
        const run = await f.store.readRun(runId);
        expect(run?.credentialOperation?.mutation).toBeDefined();
        expect(run?.credentialOperation?.recoverAfter).toBe(
          '2026-08-26T10:11:00.000Z',
        );
      }
      expect(await recoverCodexCredentialOperations(f.ctx)).toEqual({
        recovered: [],
        unresolved: [],
      });
      fence.mockRestore();
    }, 30_000);

    it.each(['direct', 'deferred', 'revoked', 'ordinary'] as const)(
      'canonical authenticated %s completion preserves cleanup and current fallback authority',
      async (mode) => {
        const f = await brokerFixture(true, true);
        const deferredResult = mode === 'deferred' || mode === 'revoked';
        let reservation: unknown;
        if (deferredResult) {
          reservation = await f.store.transactRun({
            runId: f.runId,
            decide: ({ task, run }) => {
              if (task === undefined || run === undefined)
                throw new Error('Missing claimed HTTP fixture');
              return reserveCredentialOperation({
                now: NOW,
                task: task.task,
                run,
                id: 'http-pending-operation',
                kind: 'persist',
                claimFingerprint: f.fingerprint,
              });
            },
          });
        }
        expect(reservation).not.toEqual(
          expect.objectContaining({ refused: true }),
        );
        const outcome =
          mode === 'ordinary' ? 'worker-control-failed' : 'provider-limit';
        expect(
          await call(f.ctx, 'POST', runPath(f.runId, '/complete'), {
            outcome,
            outcomeReference: null,
            message: 'immutable accepted HTTP result',
          }),
        ).toEqual({
          status: 200,
          json: {
            runId: f.runId,
            state: deferredResult ? 'completion-pending' : 'finished',
          },
        });
        const accepted = (await f.store.readRun(f.runId))
          ?.credentialPendingResult;
        expect(accepted?.requestedAt).toBe(deferredResult ? NOW : undefined);
        let recovery:
          | Awaited<ReturnType<typeof recoverCodexCredentialOperations>>
          | undefined;
        if (deferredResult) {
          if (mode === 'revoked') f.revokeFallback();
          f.setNow('2026-08-26T14:00:00.000Z');
          recovery = await recoverCodexCredentialOperations(f.ctx);
        }
        expect(recovery).toEqual(
          deferredResult ? { recovered: [f.runId], unresolved: [] } : undefined,
        );
        const settled = await f.store.readRun(f.runId);
        expect(settled).toMatchObject({
          state: 'finished',
          result: {
            ok: false,
            summary: outcome,
            message: 'immutable accepted HTTP result',
          },
        });
        expect(settled?.result).toEqual(
          accepted?.result ?? {
            ok: false,
            summary: outcome,
            message: 'immutable accepted HTTP result',
          },
        );
        expect(settled?.credentialOperation).toBeUndefined();
        expect(settled?.credentialPendingResult).toBeUndefined();
        const successor = await f.store.readActiveRun({
          repo: 'jlapenna/agent-lcars',
          issue: 42,
        });
        const hasSuccessor = mode === 'direct' || mode === 'deferred';
        expect(successor?.pipeline).toBe(hasSuccessor ? 'claude' : undefined);
        expect(successor?.requestId).toBe(
          hasSuccessor ? `fallback:${f.runId}` : undefined,
        );
        const lease = await f.codexAuth.readLease();
        expect(
          lease === undefined ||
            Date.parse(lease.expiresAt) <= f.now().getTime(),
        ).toBe(true);
      },
    );

    it('refuses zero credential generation at actual HTTP before any external mutation', async () => {
      const f = await brokerFixture();
      expect(
        (
          await call(f.ctx, 'PUT', runPath(f.runId, '/codex-auth'), {
            ...f.payload,
            generation: '0',
          })
        ).status,
      ).toBe(400);
      expect(f.fake.attempts).toHaveLength(0);
      expect(
        (await f.store.readRun(f.runId))?.credentialOperation,
      ).toBeUndefined();
    });
  });
}
