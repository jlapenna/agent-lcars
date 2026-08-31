import {
  MemoryScheduleStore,
  MemoryStore,
  Orchestrator,
  taskSchema,
  WORK_PAYLOAD_MAX_BYTES,
} from '@agent-lcars/orchestrator';
import type { SessionDoc } from '@agent-lcars/telemetry';
import { WORK_DESCRIPTION_MAX } from '@agent-lcars/work';
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
  principal: 'svc:telemetry-writer',
  subject: 'telemetry-writer@agent-lcars.iam.gserviceaccount.com',
  scopes: new Set(['work.cron'] as const),
  pipelines: ['claude', 'codex', 'opencode'],
  via: 'google' as const,
};
const executorOnly = {
  principal: 'svc:autoscaler',
  subject: 'google:autoscaler@example.iam.gserviceaccount.com',
  scopes: new Set(['work.executor'] as const),
  pipelines: ['claude'],
  via: 'google' as const,
};
const reaperOnly = {
  principal: 'pin:tick',
  subject: 'pin:tick',
  scopes: new Set(['work.reaper'] as const),
  pipelines: [],
  via: 'oidc' as const,
};
const githubActionsOperator = {
  principal: 'workflow:member-automation',
  subject: 'github-actions:jlapenna/agent-lcars',
  sourceRepository: 'jlapenna/agent-lcars',
  scopes: new Set(['work.operator'] as const),
  pipelines: ['claude', 'codex', 'opencode'],
  via: 'oidc' as const,
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
    } as unknown as WorkContext['runtime'],
    sessionsFor: async () => [],
    getSessionDoc: async () => undefined,
    maxLiveRuns: 4,
    scheduleStore: new MemoryScheduleStore(),
    grants: () => [],
    now: () => new Date('2026-08-26T10:00:00.000Z'),
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

  describe('a work.reaper-only principal (sub-project 6 session-pin tick)', () => {
    it('refuses create/cancel/redispatch -- reaper is read-only', async () => {
      const ctx = context({ principal: reaperOnly });
      for (const [m, p, b] of [
        ['PUT', `/items/${ID}`, { spec }],
        ['POST', `/items/${ID}/cancel`],
        ['POST', `/items/${ID}/redispatch`],
      ] as const) {
        const r = await call(ctx, m, p, b);
        expect(r.status, `${m} ${p}`).toBe(401);
      }
    });

    it('accepts list and get, same as an operator', async () => {
      const ctx = context();
      await call(ctx, 'PUT', `/items/${ID}`, { spec });
      const reaperCtx = { ...ctx, principal: reaperOnly };

      expect((await call(reaperCtx, 'GET', '/items')).status).toBe(200);
      expect((await call(reaperCtx, 'GET', `/items/${ID}`)).status).toBe(200);
    });
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

  it('refuses a repository that is not admitted at all, with 403', async () => {
    const ctx = context();
    const r = await call(ctx, 'PUT', `/items/${ID}`, {
      spec: { ...spec, target: { repo: 'octo/example' } },
    });
    expect(r.status).toBe(403);
    // Exact wording: `forbiddenReason` (work-mint.ts) refuses at creation
    // rather than let the dispatch itself 422 later. `octo/example` is not
    // in `AGENT_LCARS_CONTROL_PLANE_REPOSITORIES` (unset here, so it
    // defaults to just `controlPlaneRepository()`) -- #1544 wave 2.
    expect(r.json).toMatchObject({
      message:
        'native work items can only target a control-plane repository ' +
        '(octo/example is not admitted)',
    });
    // No task minted for the refused create -- same context/store.
    expect((await call(ctx, 'GET', `/items/${ID}`)).status).toBe(404);
  });

  it('allows an admitted repository that is not the control-plane repo (#1544 wave 2)', async () => {
    // Wave 1 of #1544 landed a `work` `workflow_dispatch` input on every
    // consumer repo declared in `AGENT_LCARS_CONTROL_PLANE_REPOSITORIES` --
    // once a repo is on that allow-list, minting a native item against it
    // is no longer refused just for not being `controlPlaneRepository()`
    // itself.
    const otherRepo = 'other-org/other-repo';
    process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'] =
      `${controlPlaneRepository()},${otherRepo}`;
    process.env['AGENT_LCARS_WATCHED_REPOS'] = JSON.stringify([
      { owner: 'jlapenna', name: 'agent-lcars' },
      { owner: 'other-org', name: 'other-repo' },
    ]);
    try {
      const ctx = context();
      const r = await call(ctx, 'PUT', `/items/${ID}`, {
        spec: { ...spec, target: { repo: otherRepo } },
      });
      expect(r.status).toBe(201);
      expect(r.json).toMatchObject({ state: 'running' });
    } finally {
      delete process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'];
      delete process.env['AGENT_LCARS_WATCHED_REPOS'];
    }
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

  it('redispatch creates a fresh run', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/items/${ID}`, { spec });
    await ctx.runtime.orchestrator.report(`work:${ID}/r1`, {
      ok: false,
      summary: 'blocked',
    });
    const r = await call(ctx, 'POST', `/items/${ID}/redispatch`);
    expect(r.status).toBe(200);
    expect(await ctx.runtime.store.readRun(`work:${ID}/r2`)).toMatchObject({
      state: 'pending',
    });
  });

  it('refuses to redispatch an item whose repo is not admitted, with 403', async () => {
    const ctx = context();
    // Seeded straight through the orchestrator, because `create` would
    // refuse this repo today -- and that is precisely the situation under
    // test: an item somehow exists (e.g. minted before this check existed,
    // or hand-written) targeting a repo that is not (or is no longer)
    // admitted. Redispatch must re-check `forbiddenReason` as it stands
    // now, not inherit the permission the item was created with.
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
      message:
        'native work items can only target a control-plane repository ' +
        '(octo/example is not admitted)',
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

  it('fails the list when a persisted task violates the current Work shape', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/items/${ID}`, { spec });
    // A corrupted Work record lacks its spec. Current records must not be
    // silently omitted from the control-plane response.
    await ctx.runtime.orchestrator.request({
      taskId: { workId: OTHER_ID },
      requestId: OTHER_ID,
      pipeline: 'claude',
      work: { origin: { principal: 'user:x', channel: 'api' } },
    });

    const r = await call(ctx, 'GET', '/items');
    expect(r.status).toBe(500);
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

  // Issue #1546: `list` reads a `limit`-bounded page of native tasks
  // (newest-first by workId) and filters by state AFTERWARD, so an item
  // that is still running but was created before a run of newer,
  // already-settled ones is entirely absent from a page sized smaller
  // than the fleet's native-task history -- no matter what `state` asks
  // for. `nextCursor` is the fix: a caller who keeps paging with it
  // reaches every native task, not just the newest `limit` of them.
  it('reaches a running item beyond the first page only via nextCursor', async () => {
    const ctx = context();
    const OLDEST = '01J5Z3K9QX8F0N2B4V6C8D1E3A';
    const NEWER1 = '01J5Z3K9QX8F0N2B4V6C8D1E3B';
    const NEWER2 = '01J5Z3K9QX8F0N2B4V6C8D1E3C';

    // OLDEST is created first and stays running. NEWER1/NEWER2 are
    // created after it (greater workId = newer in creation order) and
    // then settled -- so the two newest native tasks are both canceled,
    // and OLDEST, the only running one, sits on the page behind them.
    await call(ctx, 'PUT', `/items/${OLDEST}`, { spec });
    await call(ctx, 'PUT', `/items/${NEWER1}`, { spec });
    await call(ctx, 'POST', `/items/${NEWER1}/cancel`);
    await call(ctx, 'PUT', `/items/${NEWER2}`, { spec });
    await call(ctx, 'POST', `/items/${NEWER2}/cancel`);

    // A page of the 2 newest native tasks (NEWER2, NEWER1) is entirely
    // canceled, so filtering it by state=running finds nothing on this
    // page -- even though a running item (OLDEST) exists in the store.
    const firstPage = await call(ctx, 'GET', '/items?state=running&limit=2');
    expect(firstPage.json.items).toEqual([]);
    // The raw page was full (2 native tasks read for a limit of 2), so
    // more may exist behind it -- a caller must keep paging, not treat
    // an empty `items` array as "nothing left to find".
    expect(firstPage.json.nextCursor).toBe(NEWER1);

    const secondPage = await call(
      ctx,
      'GET',
      `/items?state=running&limit=2&cursor=${firstPage.json.nextCursor}`,
    );
    expect(secondPage.json.items.map((i: { id: string }) => i.id)).toEqual([
      OLDEST,
    ]);
    // The store is exhausted: no more native tasks behind OLDEST.
    expect(secondPage.json.nextCursor).toBeUndefined();
  });
});

describe('GitHub-anchor dispatch route', () => {
  const anchor = { repo: 'jlapenna/agent-lcars', issue: 1633 };
  const input = {
    anchor,
    spec: {
      title: 'Migrate automation dispatch',
      description: 'Use the Work API route.',
      pipeline: 'codex',
      target: { repo: anchor.repo },
    },
    mode: 'implement' as const,
    reply: 'Please handle this.',
    runbook: 'automation-dispatch',
    context: 'phase-1',
    requestId: 'workflow-run:123:dispatch:1633',
  };

  it('requires work.operator before it parses or admits an anchor', async () => {
    const r = await call(
      context({ principal: undefined }),
      'POST',
      '/dispatches/github',
      input,
    );
    expect(r.status).toBe(401);
  });

  it('stores the explicit Work payload, parameters, and idempotency key through the normal orchestrator path', async () => {
    const ctx = context({ principal: githubActionsOperator });
    const first = await call(ctx, 'POST', '/dispatches/github', input);
    expect(first.status).toBe(200);
    expect(first.json).toEqual({
      outcome: 'accepted',
      runId: 'jlapenna/agent-lcars#1633/r1',
      dispatched: false,
    });

    const task = await ctx.runtime.store.readTask(anchor);
    expect(task?.task.work).toEqual({
      origin: { principal: 'workflow:member-automation', channel: 'api' },
      spec: input.spec,
    });
    const run = await ctx.runtime.store.readRun('jlapenna/agent-lcars#1633/r1');
    expect(run).toMatchObject({
      requestId: input.requestId,
      pipeline: 'codex',
      params: {
        mode: 'implement',
        reply: 'Please handle this.',
        runbook: 'automation-dispatch',
        context: 'phase-1',
      },
    });

    const retry = await call(ctx, 'POST', '/dispatches/github', input);
    expect(retry.status).toBe(200);
    expect(retry.json).toEqual({
      outcome: 'duplicate',
      runId: 'jlapenna/agent-lcars#1633/r1',
    });
  });

  it('preserves an under-bound GitHub body in the stored Work spec', async () => {
    const ctx = context({ principal: githubActionsOperator });
    const description = '  Preserve this exact GitHub body.\n';
    const r = await call(ctx, 'POST', '/dispatches/github', {
      ...input,
      spec: { ...input.spec, description },
      requestId: 'workflow-run:under-bound:1633',
    });

    expect(r.status).toBe(200);
    expect((await ctx.runtime.store.readTask(anchor))?.task.work).toMatchObject(
      {
        spec: { description },
      },
    );
  });

  it('accepts an overlong GitHub body and stores the shared visible clamp', async () => {
    const ctx = context({ principal: githubActionsOperator });
    const description = 'x'.repeat(WORK_DESCRIPTION_MAX + 3_616);
    const r = await call(ctx, 'POST', '/dispatches/github', {
      ...input,
      spec: { ...input.spec, description },
      requestId: 'workflow-run:overlong:1633',
    });

    expect(r.status).toBe(200);
    expect((await ctx.runtime.store.readTask(anchor))?.task.work).toMatchObject(
      {
        spec: {
          description: expect.stringContaining(
            `truncated to ${WORK_DESCRIPTION_MAX} of ${description.length} characters`,
          ),
        },
      },
    );
  });

  it('normalizes an empty body and keeps a multibyte body within the storage byte budget', async () => {
    const emptyCtx = context({ principal: githubActionsOperator });
    const empty = await call(emptyCtx, 'POST', '/dispatches/github', {
      ...input,
      spec: { ...input.spec, description: '' },
      requestId: 'workflow-run:empty:1633',
    });
    expect(empty.status).toBe(200);
    expect(
      (await emptyCtx.runtime.store.readTask(anchor))?.task.work,
    ).toMatchObject({
      spec: { description: '(no description)' },
    });

    const multibyteCtx = context({ principal: githubActionsOperator });
    const multibyte = await call(multibyteCtx, 'POST', '/dispatches/github', {
      ...input,
      spec: { ...input.spec, description: '漢'.repeat(12_000) },
      requestId: 'workflow-run:multibyte:1633',
    });
    expect(multibyte.status).toBe(200);
    const stored = await multibyteCtx.runtime.store.readTask(anchor);
    const storedDescription = (
      stored?.task.work as { spec?: { description?: string } } | undefined
    )?.spec?.description;
    expect(storedDescription).toContain('12000 characters');
    expect(
      new TextEncoder().encode(JSON.stringify(stored?.task.work)).length,
    ).toBeLessThanOrEqual(WORK_PAYLOAD_MAX_BYTES);
  });

  it('clamps JSON-escaped GitHub text before storage and reads the schema back', async () => {
    const ctx = context({ principal: githubActionsOperator });
    // `JSON.stringify` doubles each newline. The raw 16,384-byte body is
    // valid GitHub input and character-bounded Work text, but the complete
    // serialized payload is too large without route-side normalization.
    const body = '\n'.repeat(WORK_DESCRIPTION_MAX);
    const r = await call(ctx, 'POST', '/dispatches/github', {
      ...input,
      spec: { ...input.spec, description: body },
      requestId: 'workflow-run:escaped:1633',
    });

    expect(r.status).toBe(200);
    const stored = await ctx.runtime.store.readTask(anchor);
    expect(stored).toBeDefined();
    expect(taskSchema.parse(stored?.task)).toEqual(stored?.task);
    const storedDescription = (
      stored?.task.work as { spec?: { description?: string } } | undefined
    )?.spec?.description;
    expect(storedDescription).toContain('serialized work payload');
    expect(
      new TextEncoder().encode(JSON.stringify(stored?.task.work)).length,
    ).toBeLessThanOrEqual(WORK_PAYLOAD_MAX_BYTES);
  });

  it.each([true, false])(
    'returns the original run when a request is replayed after it settles (%s)',
    async (ok) => {
      const ctx = context({ principal: githubActionsOperator });
      const first = await call(ctx, 'POST', '/dispatches/github', input);
      expect(first.json).toMatchObject({ outcome: 'accepted' });

      await ctx.runtime.orchestrator.report('jlapenna/agent-lcars#1633/r1', {
        ok,
      });

      const replay = await call(ctx, 'POST', '/dispatches/github', input);
      expect(replay.status).toBe(200);
      expect(replay.json).toEqual({
        outcome: 'duplicate',
        runId: 'jlapenna/agent-lcars#1633/r1',
      });
      expect(await ctx.runtime.store.listRuns(anchor)).toHaveLength(1);
    },
  );

  it('allows a different request ID after a prior request settles', async () => {
    const ctx = context({ principal: githubActionsOperator });
    await call(ctx, 'POST', '/dispatches/github', input);
    await ctx.runtime.orchestrator.report('jlapenna/agent-lcars#1633/r1', {
      ok: true,
    });

    const next = await call(ctx, 'POST', '/dispatches/github', {
      ...input,
      requestId: 'workflow-run:124:dispatch:1633',
    });
    expect(next.status).toBe(200);
    expect(next.json).toMatchObject({
      outcome: 'accepted',
      runId: 'jlapenna/agent-lcars#1633/r2',
    });
  });

  it('preserves the signed caller-repository boundary and requires the Work target to equal the anchor', async () => {
    const ctx = context({ principal: githubActionsOperator });
    const foreign = await call(ctx, 'POST', '/dispatches/github', {
      ...input,
      anchor: { repo: 'other-org/other-repo', issue: 1 },
      spec: { ...input.spec, target: { repo: 'other-org/other-repo' } },
    });
    expect(foreign.status).toBe(403);

    const mismatched = await call(ctx, 'POST', '/dispatches/github', {
      ...input,
      spec: { ...input.spec, target: { repo: 'other-org/other-repo' } },
    });
    expect(mismatched.status).toBe(400);
  });

  it('uses the same pipeline grant check as other Work API admissions', async () => {
    const r = await call(
      context({
        principal: { ...githubActionsOperator, pipelines: ['claude'] },
      }),
      'POST',
      '/dispatches/github',
      input,
    );
    expect(r.status).toBe(403);
  });

  it.each(['claude', 'codex', 'opencode'] as const)(
    'admits %s through the same Work API and QueueExecutor request path',
    async (pipeline) => {
      const ctx = context({ principal: githubActionsOperator });
      const r = await call(ctx, 'POST', '/dispatches/github', {
        ...input,
        spec: { ...input.spec, pipeline },
        requestId: `workflow-run:123:${pipeline}:1633`,
      });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({
        outcome: 'accepted',
        runId: 'jlapenna/agent-lcars#1633/r1',
      });
      expect(
        await ctx.runtime.store.readRun('jlapenna/agent-lcars#1633/r1'),
      ).toMatchObject({
        pipeline,
        task: anchor,
      });
    },
  );
});
