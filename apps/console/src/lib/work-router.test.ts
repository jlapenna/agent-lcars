import { MemoryStore, Orchestrator } from '@agent-lcars/orchestrator';
import { describe, expect, it } from 'vitest';

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
    maxLiveRuns: 4,
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
    const r = await call(context(), 'PUT', `/items/${ID}`, {
      spec: { ...spec, target: { repo: 'octo/example' } },
    });
    expect(r.status).toBe(403);
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
  });

  it('refuses to redispatch an item whose repo left the control plane, with 403', async () => {
    const ctx = context();
    // Seeded straight through the orchestrator, because `create` would
    // refuse this repo today -- and that is precisely the situation under
    // test: the item was created while its repo WAS a control-plane
    // repository, and AGENT_LCARS_CONTROL_PLANE_REPOSITORIES has since
    // changed. Redispatch must re-check against the list as it stands now,
    // not inherit the permission the item was created with.
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
