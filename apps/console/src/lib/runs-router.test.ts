import { MemoryStore, Orchestrator } from '@agent-lcars/orchestrator';
import { deriveItemState } from '@agent-lcars/work/derive';
import { describe, expect, it, vi } from 'vitest';

import { hashRunToken, mintRunToken } from './run-token';
import { createRunsHandler, type RunsContext } from './runs-router';

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

/** `claim`'s and `brief`'s output schemas both pin `workId` to
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
    /** Overrides the stored spec's shape entirely -- used only by the
     *  "corrupted spec" brief test below, which needs a stored spec that
     *  fails `workSpecSchema`, something a real request path (create,
     *  redispatch, the schedule tick) can never produce since they all
     *  validate through it first. */
    spec?: unknown;
  },
): Promise<string> {
  const pipeline = opts.pipeline ?? 'claude';
  const outcome = await orchestrator.request({
    taskId: { workId: opts.workId },
    requestId: opts.workId,
    pipeline,
    executor: 'queue',
    work: {
      origin: { principal: 'user:jlapenna', channel: 'api' },
      spec: opts.spec ?? {
        title: 't',
        description: 'd',
        pipeline,
        target: { repo: 'jlapenna/agent-lcars' },
      },
    },
  });
  if ('refused' in outcome) {
    throw new Error(`unexpected refusal seeding ${opts.workId}`);
  }
  const runId = outcome.run!.runId;
  await store.enqueueRun({ runId, now: opts.now });
  await orchestrator.confirmDispatch(runId);
  return runId;
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
  checkoutTokens: { tokenFor: async () => 'checkout-token' },
};

describe('claim', () => {
  it('refuses a request with no principal', async () => {
    const { store, orchestrator, now } = fixture();
    const r = await call(
      { store, orchestrator, now, ...context, principal: undefined },
      'POST',
      '/runs/claim',
      { runner: 'runner-1', pipelines: ['claude'] },
    );
    expect(r.status).toBe(401);
  });

  it('refuses an operator-scoped principal (no work.executor scope)', async () => {
    const { store, orchestrator, now } = fixture();
    const r = await call(
      { store, orchestrator, now, ...context, principal: operatorPrincipal() },
      'POST',
      '/runs/claim',
      { runner: 'runner-1', pipelines: ['claude'] },
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
      { runner: 'runner-1', pipelines: ['claude'] },
    );
    expect(r.status).toBe(200);
    expect(r.json).toBeUndefined();
  });

  // Critical fix (flagged in review of Task 7): the handler used to pass
  // `input.pipelines` straight to `store.claimQueuedRun` with no check
  // against the calling principal's own `pipelines` grant -- any
  // `work.executor` principal could claim (and then mint a real GitHub
  // write token for) a pipeline it was never granted. `claim` now
  // intersects `input.pipelines` with `context.principal.pipelines`
  // before ever touching the store.
  it('claims nothing for a pipeline outside the principal grant, without calling the store', async () => {
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
      { runner: 'runner-1', pipelines: ['codex'] },
    );
    expect(r.status).toBe(200);
    expect(r.json).toBeUndefined();
    expect(claimSpy).not.toHaveBeenCalled();
  });

  it('claims only the grant-allowed pipeline even when an older, ungranted pipeline is queued', async () => {
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
      { runner: 'runner-1', pipelines: ['claude', 'codex'] },
    );
    expect(r.status).toBe(200);
    const claimed = r.json as { runId: string; pipeline: string };
    expect(claimed.runId).toBe(claudeRunId);
    expect(claimed.pipeline).toBe('claude');
    // The codex run was never even a candidate -- still untouched.
    expect((await store.readRun(codexRunId))?.queue?.state).toBe('queued');
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
      { runner: 'runner-1', pipelines: ['claude'] },
    );
    expect(r.status).toBe(200);
    expect((r.json as { runId: string }).runId).toBe(liveRunId);
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
      pipelines: ['claude'],
    });
    const second = await call(ctx, 'POST', '/runs/claim', {
      runner: 'runner-2',
      pipelines: ['claude'],
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
      pipelines: ['claude'],
    });
    const second = await call(ctx, 'POST', '/runs/claim', {
      runner: 'runner-2',
      pipelines: ['claude'],
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
      { runner: 'runner-1', pipelines: ['claude'] },
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
});

describe('brief', () => {
  it('500s on a stored spec that no longer parses as workSpecSchema, without leaking it', async () => {
    // No real request path can produce this -- `mintItem` always validates
    // through `workSpecSchema` first (`work-mint.ts`) -- so this reaches
    // under the router the same way `forceLeaseExpired` does, to prove the
    // handler itself treats a corrupted stored spec as the server bug it
    // is: a 500 that never echoes the raw stored value back to the caller.
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const { store, orchestrator, now } = fixture();
    const runId = await seedQueuedRun(store, orchestrator, {
      workId: wid('work-corrupt-spec'),
      now: NOW,
      // Missing `pipeline` and `target` -- fails `workSpecSchema`.
      spec: { title: 't', description: 'd', secretField: 'do-not-leak-me' },
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
      'agent-lcars: claimed run has a stored spec that no longer parses',
      expect.objectContaining({ runId }),
    );
    errorSpy.mockRestore();
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
    const tokenFor = vi.fn(async (repo: string) => `ghs_secret-for-${repo}`);
    const r = await call(
      {
        store,
        orchestrator,
        now,
        tokens: context.tokens,
        checkoutTokens: { tokenFor },
        bearerToken: runToken,
      },
      'GET',
      runPath(runId, '/checkout-token'),
    );
    expect(r.status).toBe(200);
    expect(tokenFor).toHaveBeenCalledWith('jlapenna/agent-lcars');
    expect(tokenFor).toHaveBeenCalledTimes(1);

    const body = r.json as {
      token: string;
      expiresAt: string;
      repository: string;
    };
    expect(body.repository).toBe('jlapenna/agent-lcars');
    expect(body.token).toBe('ghs_secret-for-jlapenna/agent-lcars');
    expect(typeof body.expiresAt).toBe('string');
    // The run's own bearer credential must never surface here -- a mix-up
    // would hand the caller the wrong secret entirely.
    expect(body.token).not.toBe(runToken);
    expect(JSON.stringify(body)).not.toContain(runToken);
  });
});
