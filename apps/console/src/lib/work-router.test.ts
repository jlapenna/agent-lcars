import {
  MemoryScheduleStore,
  MemoryStore,
  Orchestrator,
} from '@agent-lcars/orchestrator';
import type { SessionDoc } from '@agent-lcars/telemetry';
import { describe, expect, it } from 'vitest';

import { controlPlaneRepository } from './deployment';
import { createWorkHandler, type WorkContext } from './work-router';

const ID = '01J5Z3K9QX8F0N2B4V6C8D1E3G';
const OTHER_ID = '01J5Z3K9QX8F0N2B4V6C8D1E3H';
const spec = {
  title: 't',
  description: 'd',
  pipeline: 'claude',
  target: { repo: 'jlapenna/agent-lcars' },
};
const operator = {
  principal: 'user:jlapenna',
  subject: 'github:jlapenna',
  scopes: new Set(['work.operator'] as const),
  pipelines: ['claude'],
  via: 'session' as const,
};
const cronTick = {
  principal: 'cron:tick',
  subject: 'cron:tick',
  scopes: new Set(['work.cron'] as const),
  pipelines: [],
  via: 'oidc' as const,
};
const executorOnly = {
  principal: 'svc:autoscaler',
  subject: 'google:autoscaler@example.iam.gserviceaccount.com',
  scopes: new Set(['work.executor'] as const),
  pipelines: ['claude'],
  via: 'google' as const,
};

function context(over: Partial<WorkContext> = {}): WorkContext {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, {
    now: () => '2026-08-26T10:00:00.000Z',
  });
  return {
    principal: operator,
    runtime: {
      store,
      orchestrator,
      drain: async () => ({ dispatched: [], failed: [] }),
      settleTerminal: async () => ({}),
    } as unknown as WorkContext['runtime'],
    sessionsFor: async () => [],
    getSessionDoc: async () => undefined,
    maxLiveRuns: 4,
    scheduleStore: new MemoryScheduleStore(),
    grants: () => [],
    now: () => new Date('2026-08-26T10:00:00.000Z'),
    queuePipelines: [],
    ...over,
  };
}

/** A minimal, valid `IssueAgentSessionDoc` for `getSessionDoc` stubs below --
 *  every field the type requires, none of the ones it doesn't. */
function sessionDoc(over: Partial<SessionDoc> = {}): SessionDoc {
  return {
    source: 'issue-agent',
    sessionId: 'sess_1',
    agent: 'claude-code',
    liveness: 'ended',
    startedAt: 't0',
    lastActivityAt: 't0',
    turns: 1,
    toolCallCounts: {},
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    deliverables: { prNumbers: [], commitShas: [] },
    ...over,
  };
}

async function call(
  ctx: WorkContext,
  method: string,
  path: string,
  body?: unknown,
) {
  const handler = createWorkHandler();
  const { response } = await handler.handle(
    new Request(`https://lcars.test/api/work/v1${path}`, {
      method,
      // Only set a content type when there IS a body: a POST carrying
      // `content-type: application/json` with an empty body is a malformed
      // JSON request, and oRPC (correctly) answers 400 rather than reaching
      // the procedure at all.
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    }),
    { prefix: '/api/work/v1', context: ctx },
  );
  return {
    status: response?.status,
    headers: response?.headers,
    json: response ? await response.json() : undefined,
  };
}

describe('items routes', () => {
  it('refuses every route without a principal', async () => {
    const ctx = context({ principal: undefined });
    for (const [m, p, b] of [
      ['PUT', `/items/${ID}`, { spec }],
      ['GET', `/items/${ID}`],
      ['GET', '/items'],
      ['POST', `/items/${ID}/cancel`],
      ['POST', `/items/${ID}/redispatch`],
    ] as const) {
      const r = await call(ctx, m, p, b);
      expect(r.status, `${m} ${p}`).toBe(401);
    }
  });

  it('refuses a principal without the work.operator scope with 401', async () => {
    const ctx = context({
      principal: { ...operator, scopes: new Set<never>() },
    });

    expect((await call(ctx, 'GET', '/items')).status).toBe(401);
  });

  it('refuses every items route for a work.cron-only principal, which carries no work.operator scope', async () => {
    const ctx = context({ principal: cronTick });
    for (const [m, p, b] of [
      ['PUT', `/items/${ID}`, { spec }],
      ['GET', `/items/${ID}`],
      ['GET', '/items'],
      ['POST', `/items/${ID}/cancel`],
      ['POST', `/items/${ID}/redispatch`],
    ] as const) {
      const r = await call(ctx, m, p, b);
      expect(r.status, `${m} ${p}`).toBe(401);
    }
  });

  it('refuses every items route for a work.executor-only principal, which carries no work.operator scope', async () => {
    const ctx = context({ principal: executorOnly });
    for (const [m, p, b] of [
      ['PUT', `/items/${ID}`, { spec }],
      ['GET', `/items/${ID}`],
      ['GET', '/items'],
      ['POST', `/items/${ID}/cancel`],
      ['POST', `/items/${ID}/redispatch`],
    ] as const) {
      const r = await call(ctx, m, p, b);
      expect(r.status, `${m} ${p}`).toBe(401);
    }
  });

  it('creates an item, replays it idempotently, and derives running', async () => {
    const ctx = context();
    const first = await call(ctx, 'PUT', `/items/${ID}`, { spec });
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({
      id: ID,
      state: 'running',
      origin: { principal: 'user:jlapenna', channel: 'console' },
      spec,
    });

    // Idempotency is the guarantee, not the status code: the contract
    // declares `successStatus: 201` for create, so a replay answers 201
    // with the *existing* item rather than starting a second run.
    const again = await call(ctx, 'PUT', `/items/${ID}`, { spec });
    expect(again.status).toBe(201);
    expect(again.json.runs).toHaveLength(1);
  });

  it('create sets executor: queue only for a configured pipeline', async () => {
    const ctx = context({ queuePipelines: ['claude'] });
    const r = await call(ctx, 'PUT', `/items/${ID}`, { spec });
    expect(r.status).toBe(201);
    const run = await ctx.runtime.store.readRun(`work:${ID}/r1`);
    expect(run?.executor).toBe('queue');
  });

  it('create leaves executor unset for a pipeline not in the queue list', async () => {
    const ctx = context({ queuePipelines: ['codex'] });
    const r = await call(ctx, 'PUT', `/items/${ID}`, { spec });
    expect(r.status).toBe(201);
    const run = await ctx.runtime.store.readRun(`work:${ID}/r1`);
    expect(run?.executor).toBeUndefined();
  });

  it('refuses a replay whose spec differs from the stored one with 409', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/items/${ID}`, { spec });

    const r = await call(ctx, 'PUT', `/items/${ID}`, {
      spec: { ...spec, title: 'something else' },
    });
    expect(r.status).toBe(409);
  });

  it('refuses a pipeline outside the grant with 403', async () => {
    const r = await call(context(), 'PUT', `/items/${ID}`, {
      spec: { ...spec, pipeline: 'codex' },
    });
    expect(r.status).toBe(403);
  });

  it('refuses a repository outside the control plane with 403', async () => {
    const ctx = context();
    const r = await call(ctx, 'PUT', `/items/${ID}`, {
      spec: { ...spec, target: { repo: 'octo/example' } },
    });
    expect(r.status).toBe(403);
    // Exact wording: `forbiddenReason` (work-mint.ts) refuses at creation
    // rather than let the dispatch itself 422 later (#1544 round 2).
    expect(r.json).toMatchObject({
      message: `native work items can only target ${controlPlaneRepository()} until every consumer declares the work input (#1544)`,
    });
    // No task minted for the refused create -- same context/store.
    expect((await call(ctx, 'GET', `/items/${ID}`)).status).toBe(404);
  });

  it('enforces the global live-run cap with 429', async () => {
    const ctx = context({ maxLiveRuns: 1 });
    await call(ctx, 'PUT', `/items/${ID}`, { spec });
    const r = await call(ctx, 'PUT', `/items/${OTHER_ID}`, { spec });
    expect(r.status).toBe(429);
    expect(r.json).toMatchObject({ data: { retryAfterSeconds: 60 } });
    // The same fact in the header generic HTTP clients already honour.
    expect(r.headers?.get('retry-after')).toBe('60');
  });

  it('answers 404 for an unknown item', async () => {
    expect((await call(context(), 'GET', `/items/${ID}`)).status).toBe(404);
    expect((await call(context(), 'POST', `/items/${ID}/cancel`)).status).toBe(
      404,
    );
    expect(
      (await call(context(), 'POST', `/items/${ID}/redispatch`)).status,
    ).toBe(404);
  });

  it('cancels a running item and then refuses a second cancel', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/items/${ID}`, { spec });
    const c1 = await call(ctx, 'POST', `/items/${ID}/cancel`);
    expect(c1.status).toBe(200);
    expect(c1.json.state).toBe('canceled');
    expect((await call(ctx, 'POST', `/items/${ID}/cancel`)).status).toBe(409);
  });

  it('redispatches only a parked item', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/items/${ID}`, { spec });
    expect((await call(ctx, 'POST', `/items/${ID}/redispatch`)).status).toBe(
      409,
    );
    await ctx.runtime.orchestrator.report(`work:${ID}/r1`, {
      ok: false,
      summary: 'blocked',
    });
    expect((await call(ctx, 'GET', `/items/${ID}`)).json.state).toBe('parked');
    const r = await call(ctx, 'POST', `/items/${ID}/redispatch`);
    expect(r.status).toBe(200);
    expect(r.json.runs).toHaveLength(2);
    expect(r.json.state).toBe('running');
    // No `resumeSessionId` in the request -- unchanged behaviour, no params
    // land on the fresh run.
    const fresh = await ctx.runtime.store.readRun(`work:${ID}/r2`);
    expect(fresh?.params).toBeUndefined();
  });

  it('redispatch under queuePipelines: [claude] mints executor: queue', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/items/${ID}`, { spec });
    await ctx.runtime.orchestrator.report(`work:${ID}/r1`, {
      ok: false,
      summary: 'blocked',
    });
    const before = await ctx.runtime.store.readRun(`work:${ID}/r1`);
    expect(before?.executor).toBeUndefined();

    // Only the redispatch call itself is under the queue config -- proves
    // `redispatch`'s own `executorFor(spec.pipeline, context.queuePipelines)`
    // call (work-router.ts), not just `create`'s (already covered above).
    ctx.queuePipelines = ['claude'];
    const r = await call(ctx, 'POST', `/items/${ID}/redispatch`);
    expect(r.status).toBe(200);
    const after = await ctx.runtime.store.readRun(`work:${ID}/r2`);
    expect(after?.executor).toBe('queue');
  });

  it('refuses to redispatch an item whose repo left the control plane, with 403', async () => {
    const ctx = context();
    // Seeded straight through the orchestrator, because `create` would
    // refuse this repo today -- and that is precisely the situation under
    // test: an item somehow exists (e.g. minted before this check existed,
    // or hand-written) targeting a repo that is not (or is no longer) the
    // control plane. Redispatch must re-check `forbiddenReason` as it
    // stands now, not inherit the permission the item was created with.
    await ctx.runtime.orchestrator.request({
      taskId: { workId: ID },
      requestId: ID,
      pipeline: 'claude',
      work: {
        origin: { principal: 'user:jlapenna', channel: 'console' },
        spec: { ...spec, target: { repo: 'octo/example' } },
      },
    });
    await ctx.runtime.orchestrator.report(`work:${ID}/r1`, { ok: false });
    expect((await call(ctx, 'GET', `/items/${ID}`)).json.state).toBe('parked');

    const r = await call(ctx, 'POST', `/items/${ID}/redispatch`);
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({
      message: `native work items can only target ${controlPlaneRepository()} until every consumer declares the work input (#1544)`,
    });
    // Still parked: the refusal must not have minted a run.
    expect((await call(ctx, 'GET', `/items/${ID}`)).json.runs).toHaveLength(1);
  });

  it('refuses to redispatch a pipeline outside the grant, with 403', async () => {
    const ctx = context({
      principal: { ...operator, pipelines: ['codex'] },
    });
    await ctx.runtime.orchestrator.request({
      taskId: { workId: ID },
      requestId: ID,
      pipeline: 'claude',
      work: {
        origin: { principal: 'user:jlapenna', channel: 'console' },
        spec,
      },
    });
    await ctx.runtime.orchestrator.report(`work:${ID}/r1`, { ok: false });

    expect((await call(ctx, 'POST', `/items/${ID}/redispatch`)).status).toBe(
      403,
    );
  });

  describe('redispatch with resumeSessionId', () => {
    /** Parks `ID` with exactly one finished, `ok: false` run -- the
     *  precondition every case below shares -- and returns its run id, the
     *  same way `redispatches only a parked item` above does. */
    async function parkedItem(ctx: WorkContext): Promise<string> {
      await call(ctx, 'PUT', `/items/${ID}`, { spec });
      await ctx.runtime.orchestrator.report(`work:${ID}/r1`, {
        ok: false,
        summary: 'blocked',
      });
      return `work:${ID}/r1`;
    }

    it('threads params.resumeSessionId/resumeTranscriptGcsUri onto the fresh run', async () => {
      const ctx = context({
        getSessionDoc: async (id) =>
          id === 'sess_1'
            ? sessionDoc({
                sessionId: 'sess_1',
                intentId: `work:${ID}/r1`,
                transcriptGcsUri: 'gs://bucket/runs/x/claude-code/sess_1.jsonl',
              })
            : undefined,
      });
      await parkedItem(ctx);

      const r = await call(ctx, 'POST', `/items/${ID}/redispatch`, {
        resumeSessionId: 'sess_1',
      });
      expect(r.status).toBe(200);
      const fresh = await ctx.runtime.store.readRun(`work:${ID}/r2`);
      expect(fresh?.params).toEqual({
        resumeSessionId: 'sess_1',
        resumeTranscriptGcsUri: 'gs://bucket/runs/x/claude-code/sess_1.jsonl',
      });
    });

    it('refuses BAD_REQUEST for an unknown session id', async () => {
      const ctx = context({ getSessionDoc: async () => undefined });
      await parkedItem(ctx);

      const r = await call(ctx, 'POST', `/items/${ID}/redispatch`, {
        resumeSessionId: 'sess_missing',
      });
      expect(r.status).toBe(400);
      // Still parked: the refusal must not have minted a run.
      expect((await call(ctx, 'GET', `/items/${ID}`)).json.runs).toHaveLength(
        1,
      );
    });

    it('refuses BAD_REQUEST for a session belonging to a different item', async () => {
      const ctx = context({
        getSessionDoc: async () =>
          sessionDoc({
            sessionId: 'sess_2',
            intentId: `work:${OTHER_ID}/r1`,
            transcriptGcsUri: 'gs://bucket/x.jsonl',
          }),
      });
      await parkedItem(ctx);

      const r = await call(ctx, 'POST', `/items/${ID}/redispatch`, {
        resumeSessionId: 'sess_2',
      });
      expect(r.status).toBe(400);
      expect((await call(ctx, 'GET', `/items/${ID}`)).json.runs).toHaveLength(
        1,
      );
    });

    it('refuses CONFLICT for a same-item session with no archived transcript', async () => {
      const ctx = context({
        getSessionDoc: async () =>
          sessionDoc({
            sessionId: 'sess_3',
            intentId: `work:${ID}/r1`,
            // No transcriptGcsUri.
          }),
      });
      await parkedItem(ctx);

      const r = await call(ctx, 'POST', `/items/${ID}/redispatch`, {
        resumeSessionId: 'sess_3',
      });
      expect(r.status).toBe(409);
      expect((await call(ctx, 'GET', `/items/${ID}`)).json.runs).toHaveLength(
        1,
      );
    });
  });

  it('joins the sessions the context resolves for the item runs', async () => {
    const ctx = context({
      sessionsFor: async (runIds) =>
        runIds.map((runId) => ({
          sessionId: `s-${runId}`,
          runId,
          startedAt: '2026-08-26T10:00:00.000Z',
          lastActivityAt: '2026-08-26T10:01:00.000Z',
        })),
    });

    const expected = [
      {
        sessionId: `s-work:${ID}/r1`,
        runId: `work:${ID}/r1`,
        startedAt: '2026-08-26T10:00:00.000Z',
        lastActivityAt: '2026-08-26T10:01:00.000Z',
      },
    ];

    const created = await call(ctx, 'PUT', `/items/${ID}`, { spec });
    expect(created.json.sessions).toEqual(expected);
    expect((await call(ctx, 'GET', `/items/${ID}`)).json.sessions).toEqual(
      expected,
    );
    // The listing joins sessions too -- it builds the page first and only
    // then reaches the telemetry database, so this is the case that would
    // regress if that second pass were ever dropped.
    const listed = await call(ctx, 'GET', '/items');
    expect(listed.json.items[0].sessions).toEqual(expected);
  });

  it('lists native items only', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/items/${ID}`, { spec });
    await ctx.runtime.orchestrator.request({
      taskId: { repo: 'octo/example', issue: 7 },
      requestId: 'x',
      pipeline: 'claude',
    });
    const r = await call(ctx, 'GET', '/items');
    expect(r.status).toBe(200);
    expect(r.json.items.map((i: { id: string }) => i.id)).toEqual([ID]);
  });

  it('degrades a native task with an invalid work payload instead of 500ing the whole list', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/items/${ID}`, { spec });
    // A legal persisted state per `Task.work`'s optional-loose-record type:
    // a native task whose stored `work` has no `spec`. `toItemView`'s
    // strict parse would throw on this and 500 the whole listing; the list
    // handler must skip just this item instead.
    await ctx.runtime.orchestrator.request({
      taskId: { workId: OTHER_ID },
      requestId: OTHER_ID,
      pipeline: 'claude',
      work: { origin: { principal: 'user:x', channel: 'api' } },
    });

    const r = await call(ctx, 'GET', '/items');
    expect(r.status).toBe(200);
    expect(r.json.items.map((i: { id: string }) => i.id)).toEqual([ID]);
  });

  it('narrows the listing by state, principal, and repo', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/items/${ID}`, { spec });
    await call(ctx, 'PUT', `/items/${OTHER_ID}`, { spec });
    await call(ctx, 'POST', `/items/${OTHER_ID}/cancel`);

    const running = await call(ctx, 'GET', '/items?state=running');
    expect(running.json.items.map((i: { id: string }) => i.id)).toEqual([ID]);

    const mine = await call(ctx, 'GET', '/items?principal=user%3Ajlapenna');
    expect(mine.json.items).toHaveLength(2);

    const elsewhere = await call(ctx, 'GET', '/items?repo=octo%2Fexample');
    expect(elsewhere.json.items).toEqual([]);

    const capped = await call(ctx, 'GET', '/items?limit=1');
    expect(capped.json.items).toHaveLength(1);
  });
});
