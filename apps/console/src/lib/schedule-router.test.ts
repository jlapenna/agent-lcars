import {
  MemoryScheduleStore,
  MemoryStore,
  Orchestrator,
} from '@agent-lcars/orchestrator';
import { latestDueSlot, parseCron, slotItemId } from '@agent-lcars/work';
import { describe, expect, it, vi } from 'vitest';

import { controlPlaneRepository } from './deployment';
import type { WorkContext } from './work-mint';
import { createWorkHandler } from './work-router';

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
  principal: 'session:expiry',
  subject: 'session:expiry',
  scopes: new Set(['work.reaper'] as const),
  pipelines: [],
  via: 'oidc' as const,
};
const GRANTS = [
  {
    principal: 'user:jlapenna',
    subjects: ['github:jlapenna'],
    pipelines: ['claude'],
  },
];
const NOW = new Date('2026-08-27T10:22:00.000Z');
// One minute before `NOW`: since `create` now seeds `lastSlotAt` to the
// creation instant (Task 2), a test that creates a schedule and ticks it
// in the same breath must create it slightly earlier than the tick's
// `now` -- otherwise `latestDueSlot` never finds a slot strictly after
// creation, and the tick is a no-op before it even reaches the behaviour
// under test.
const CREATE_NOW = new Date(NOW.getTime() - 60_000);

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

    scheduleStore: new MemoryScheduleStore(),
    grants: () => GRANTS,
    now: () => NOW,
    ...over,
  };
}

function withPrincipal(
  ctx: WorkContext,
  principal: WorkContext['principal'],
): WorkContext {
  return { ...ctx, principal };
}

function withNow(ctx: WorkContext, now: Date): WorkContext {
  return { ...ctx, now: () => now };
}

async function call(
  ctx: WorkContext,
  method: string,
  path: string,
  body?: unknown,
) {
  // Existing toggle cases act as a version-aware client: read the API view
  // before submitting. Explicit bodies are never patched, so stale/missing
  // revision regressions exercise the actual validation boundary.
  if (
    body === undefined &&
    method === 'POST' &&
    /\/(enable|disable)$/u.test(path)
  ) {
    const current = await call(
      ctx,
      'GET',
      path.replace(/\/(enable|disable)$/u, ''),
    );
    body = { expectedRevision: current.json?.revision ?? 0 };
  }
  const handler = createWorkHandler();
  const { response } = await handler.handle(
    new Request(`https://lcars.test/api/work/v1${path}`, {
      method,
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
    json: response ? await response.json() : undefined,
  };
}

describe('schedules routes', () => {
  it('refuses schedule CRUD without the work.operator scope', async () => {
    const ctx = context({ principal: undefined });
    for (const [m, p, b] of [
      ['PUT', `/schedules/${ID}`, { cron: '0 * * * *', spec }],
      ['GET', `/schedules/${ID}`],
      ['GET', '/schedules'],
      ['POST', `/schedules/${ID}/enable`],
      ['POST', `/schedules/${ID}/disable`],
    ] as const) {
      expect((await call(ctx, m, p, b)).status, `${m} ${p}`).toBe(401);
    }
  });

  it('refuses tick without the work.cron scope, even for an operator', async () => {
    expect((await call(context(), 'POST', '/schedules/tick', {})).status).toBe(
      401,
    );
  });

  it('refuses schedule CRUD for a cron-scoped service principal, which carries no work.operator scope', async () => {
    const ctx = withPrincipal(context(), cronTick);
    for (const [m, p, b] of [
      ['PUT', `/schedules/${ID}`, { cron: '0 * * * *', spec }],
      ['GET', `/schedules/${ID}`],
      ['GET', '/schedules'],
      ['POST', `/schedules/${ID}/enable`],
      ['POST', `/schedules/${ID}/disable`],
    ] as const) {
      expect((await call(ctx, m, p, b)).status, `${m} ${p}`).toBe(401);
    }
  });

  it('refuses schedule CRUD for a work.executor-only principal, which carries no work.operator scope', async () => {
    const ctx = withPrincipal(context(), executorOnly);
    for (const [m, p, b] of [
      ['PUT', `/schedules/${ID}`, { cron: '0 * * * *', spec }],
      ['GET', `/schedules/${ID}`],
      ['GET', '/schedules'],
      ['POST', `/schedules/${ID}/enable`],
      ['POST', `/schedules/${ID}/disable`],
    ] as const) {
      expect((await call(ctx, m, p, b)).status, `${m} ${p}`).toBe(401);
    }
  });

  // Sub-project 6 (Task 8): `work.reaper` is items list/get-only -- the
  // schedule router carries no reader gate of its own, so a reaper-only
  // principal (carrying neither work.operator nor work.cron) must be
  // refused everywhere here, tick included.
  it('refuses every schedules route, including tick, for a work.reaper-only principal', async () => {
    const ctx = withPrincipal(context(), reaperOnly);
    for (const [m, p, b] of [
      ['PUT', `/schedules/${ID}`, { cron: '0 * * * *', spec }],
      ['GET', `/schedules/${ID}`],
      ['GET', '/schedules'],
      ['POST', `/schedules/${ID}/enable`],
      ['POST', `/schedules/${ID}/disable`],
      ['POST', '/schedules/tick', {}],
    ] as const) {
      expect((await call(ctx, m, p, b)).status, `${m} ${p}`).toBe(401);
    }
  });

  it('creates a schedule and replays it idempotently', async () => {
    const ctx = context();
    const body = { cron: '0 * * * *', spec, enabled: true };
    const first = await call(ctx, 'PUT', `/schedules/${ID}`, body);
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({
      id: ID,
      cron: '0 * * * *',
      enabled: true,
      spec,
    });

    const again = await call(ctx, 'PUT', `/schedules/${ID}`, body);
    expect(again.status).toBe(201);
    expect(again.json).toEqual(first.json);
  });

  it('rejects a malformed cron expression with 400', async () => {
    const r = await call(context(), 'PUT', `/schedules/${ID}`, {
      cron: 'not a cron',
      spec,
    });
    expect(r.status).toBe(400);
  });

  it('refuses a replay with a different cron or spec with 409', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/schedules/${ID}`, { cron: '0 * * * *', spec });
    const r = await call(ctx, 'PUT', `/schedules/${ID}`, {
      cron: '0 0 * * *',
      spec,
    });
    expect(r.status).toBe(409);
  });

  it('refuses a pipeline outside the grant with 403', async () => {
    const r = await call(context(), 'PUT', `/schedules/${ID}`, {
      cron: '0 * * * *',
      spec: { ...spec, pipeline: 'codex' },
    });
    expect(r.status).toBe(403);
  });

  it('refuses a repository that is not admitted at all, with 403, and creates nothing (#1544 wave 2)', async () => {
    const ctx = context();
    const r = await call(ctx, 'PUT', `/schedules/${ID}`, {
      cron: '0 * * * *',
      spec: { ...spec, target: { repo: 'octo/example' } },
    });
    expect(r.status).toBe(403);
    // Same `forbiddenReason` (work-mint.ts) wording `items.create` and
    // `redispatch` refuse with -- one ruling, one function. `octo/example`
    // is not in `AGENT_LCARS_CONTROL_PLANE_REPOSITORIES` (unset here, so
    // it defaults to just `controlPlaneRepository()`).
    expect(r.json).toMatchObject({
      message:
        'native work items can only target a control-plane repository ' +
        '(octo/example is not admitted)',
    });
    expect((await call(ctx, 'GET', `/schedules/${ID}`)).status).toBe(404);
  });

  it('allows an admitted repository that is not the control-plane repo (#1544 wave 2)', async () => {
    const otherRepo = 'other-org/other-repo';
    process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'] =
      `${controlPlaneRepository()},${otherRepo}`;
    process.env['AGENT_LCARS_WATCHED_REPOS'] = JSON.stringify([
      { owner: 'jlapenna', name: 'agent-lcars' },
      { owner: 'other-org', name: 'other-repo' },
    ]);
    try {
      const ctx = context();
      const r = await call(ctx, 'PUT', `/schedules/${ID}`, {
        cron: '0 * * * *',
        spec: { ...spec, target: { repo: otherRepo } },
      });
      expect(r.status).toBe(201);
    } finally {
      delete process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'];
      delete process.env['AGENT_LCARS_WATCHED_REPOS'];
    }
  });

  it('disables a schedule on tick whose spec targets a repo that is not admitted, and mints nothing (#1544 wave 2)', async () => {
    const ctx = context();
    // Written directly to the store, bypassing `create`'s own
    // `forbiddenReason` check -- the same "how did an already-stored
    // schedule end up bad" shape as the corrupt-spec/cron fixtures above.
    // A schedule that somehow exists with a non-admitted target must still
    // be caught by `tick`'s own `mintItem` -> `forbiddenReason` call, not
    // just at `create` time.
    await ctx.scheduleStore.writeSchedule({
      scheduleId: ID,
      cron: '* * * * *',
      spec: { ...spec, target: { repo: 'octo/example' } },
      enabled: true,
      createdBy: 'user:jlapenna',
      createdAt: CREATE_NOW.toISOString(),
      updatedAt: CREATE_NOW.toISOString(),
      lastSlotAt: CREATE_NOW.toISOString(),
    });

    const r = await call(
      withPrincipal(withNow(ctx, NOW), cronTick),
      'POST',
      '/schedules/tick',
      {},
    );
    expect(r.json).toMatchObject({
      minted: [],
      skippedCap: [],
      disabled: [ID],
    });
    expect(await call(ctx, 'GET', `/schedules/${ID}`)).toMatchObject({
      json: { enabled: false, disabledReason: 'grant-revoked' },
    });
  });

  it('lists newest first, enables, and disables', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/schedules/${ID}`, { cron: '0 * * * *', spec });
    await call(ctx, 'PUT', `/schedules/${OTHER_ID}`, {
      cron: '0 * * * *',
      spec,
    });

    const listed = await call(ctx, 'GET', '/schedules');
    expect(listed.json.schedules.map((s: { id: string }) => s.id)).toEqual([
      OTHER_ID,
      ID,
    ]);

    const disabled = await call(ctx, 'POST', `/schedules/${ID}/disable`);
    expect(disabled.status).toBe(200);
    expect(disabled.json).toMatchObject({
      enabled: false,
      disabledReason: 'operator',
    });

    const enabled = await call(ctx, 'POST', `/schedules/${ID}/enable`);
    expect(enabled.status).toBe(200);
    expect(enabled.json.enabled).toBe(true);
    expect(enabled.json.disabledReason).toBeUndefined();
  });

  it('answers 404 for an unknown schedule', async () => {
    expect((await call(context(), 'GET', `/schedules/${ID}`)).status).toBe(404);
    expect(
      (await call(context(), 'POST', `/schedules/${ID}/enable`)).status,
    ).toBe(404);
    expect(
      (await call(context(), 'POST', `/schedules/${ID}/disable`)).status,
    ).toBe(404);
  });

  it('a corrupt stored spec is omitted, not thrown, by list/get, and disable on it still succeeds', async () => {
    const ctx = context();
    // Written directly to the store, bypassing the `workSpecSchema`
    // validation `create`'s handler runs at the API boundary -- the same
    // "schema tightened out from under an already-stored schedule, or a
    // hand-edited document" case the tick handler already guards against
    // (see `viewSafe`, `schedule-router.ts`).
    await ctx.scheduleStore.writeSchedule({
      scheduleId: ID,
      cron: '0 * * * *',
      spec: { title: 't' },
      enabled: true,
      createdBy: 'user:jlapenna',
      createdAt: '2026-08-27T09:00:00.000Z',
      updatedAt: '2026-08-27T09:00:00.000Z',
    });
    await call(ctx, 'PUT', `/schedules/${OTHER_ID}`, {
      cron: '0 * * * *',
      spec,
    });

    const listed = await call(ctx, 'GET', '/schedules');
    expect(listed.status).toBe(200);
    const rows = listed.json.schedules as { id: string; spec?: unknown }[];
    expect(rows.map((s) => s.id).sort()).toEqual([ID, OTHER_ID].sort());
    expect(rows.find((s) => s.id === ID)?.spec).toBeUndefined();
    expect(rows.find((s) => s.id === OTHER_ID)?.spec).toEqual(spec);

    const got = await call(ctx, 'GET', `/schedules/${ID}`);
    expect(got.status).toBe(200);
    expect(got.json.spec).toBeUndefined();
    expect(got.json.cron).toBe('0 * * * *');

    const disabled = await call(ctx, 'POST', `/schedules/${ID}/disable`);
    expect(disabled.status).toBe(200);
    expect(disabled.json).toMatchObject({
      enabled: false,
      disabledReason: 'operator',
    });
    expect(disabled.json.spec).toBeUndefined();
  });

  it('seeds lastSlotAt at creation so the first tick only mints a boundary strictly after it', async () => {
    const createdAt = new Date('2026-08-27T10:22:00.000Z');
    const ctx = context({ now: () => createdAt });
    const created = await call(ctx, 'PUT', `/schedules/${ID}`, {
      cron: '0 0 * * *',
      spec,
    });
    expect(created.json.lastSlotAt).toBe(createdAt.toISOString());

    const tickTooSoon = withPrincipal(
      withNow(ctx, new Date('2026-08-27T10:23:00.000Z')),
      cronTick,
    );
    expect(
      (await call(tickTooSoon, 'POST', '/schedules/tick', {})).json,
    ).toMatchObject({ minted: [] });

    const tickNextDay = withPrincipal(
      withNow(ctx, new Date('2026-08-28T00:01:00.000Z')),
      cronTick,
    );
    const r = await call(tickNextDay, 'POST', '/schedules/tick', {});
    expect(r.json.minted).toHaveLength(1);
  });
});

describe('tick', () => {
  it('leaves a schedule alone once lastSlotAt already covers the latest due slot', async () => {
    const ctx = context();
    await ctx.scheduleStore.writeSchedule({
      scheduleId: ID,
      cron: '*/15 * * * *',
      spec,
      enabled: true,
      createdBy: 'user:jlapenna',
      createdAt: '2026-08-27T09:00:00.000Z',
      updatedAt: '2026-08-27T09:00:00.000Z',
      lastSlotAt: '2026-08-27T10:15:00.000Z',
    });
    const r = await call(
      withPrincipal(ctx, cronTick),
      'POST',
      '/schedules/tick',
      {},
    );
    expect(r.json).toEqual({
      ticked: 1,
      minted: [],
      skippedCap: [],
      disabled: [],
      errors: [],
    });
  });

  it('mints the latest due slot, advances lastSlotAt, and a re-tick in the same minute is a no-op', async () => {
    const ctx = context();
    // Created a minute before the tick's frozen `now`: `create` seeds
    // `lastSlotAt` to the creation instant (Task 2), so ticking at the
    // exact same instant would never find a slot strictly after it.
    await call(withNow(ctx, CREATE_NOW), 'PUT', `/schedules/${ID}`, {
      cron: '* * * * *',
      spec,
    });
    const tickCtx = withPrincipal(ctx, cronTick);

    const first = await call(tickCtx, 'POST', '/schedules/tick', {});
    expect(first.status).toBe(200);
    expect(first.json.ticked).toBe(1);
    expect(first.json.minted).toHaveLength(1);
    const itemId = first.json.minted[0].itemId;

    const gotAfterFirst = await call(ctx, 'GET', `/schedules/${ID}`);
    expect(gotAfterFirst.json.lastItemId).toBe(itemId);
    expect(gotAfterFirst.json.lastSlotAt).toBe(NOW.toISOString());

    // The clock is frozen at NOW: a second tick asks `latestDueSlot` for a
    // slot strictly AFTER `lastSlotAt`, which is also NOW -- there isn't
    // one yet, so nothing mints and the watermark does not move. (This is
    // a different case from idempotent replay -- see the next test for
    // that: a re-tick of an ALREADY-PASSED slot, where `mintItem` finds
    // the task `slotItemId` already names.)
    const second = await call(tickCtx, 'POST', '/schedules/tick', {});
    expect(second.json).toEqual({
      ticked: 1,
      minted: [],
      skippedCap: [],
      disabled: [],
      errors: [],
    });
    const gotAfterSecond = await call(ctx, 'GET', `/schedules/${ID}`);
    expect(gotAfterSecond.json.lastSlotAt).toBe(gotAfterFirst.json.lastSlotAt);
    expect(gotAfterSecond.json.lastItemId).toBe(itemId);
  });

  it('coalesces concurrent autoscaler ticks for one due slot into one durable item and run', async () => {
    const ctx = context();
    await call(withNow(ctx, CREATE_NOW), 'PUT', `/schedules/${ID}`, {
      cron: '* * * * *',
      spec,
    });
    const tickCtx = withPrincipal(ctx, cronTick);

    // Autoscaler replicas all own the same cadence. They may reach the Work
    // API together, but the deterministic item/request id makes the
    // orchestrator's compare-and-set the authority: exactly one task/run is
    // durable and the other call replays it.
    const [first, second] = await Promise.all([
      call(tickCtx, 'POST', '/schedules/tick', {}),
      call(tickCtx, 'POST', '/schedules/tick', {}),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const slot = latestDueSlot(parseCron('* * * * *'), NOW);
    if (slot === undefined) throw new Error('expected a due slot at NOW');
    const itemId = await slotItemId(ID, slot);
    expect(await ctx.runtime.store.readTask({ workId: itemId })).toBeDefined();
    expect(await ctx.runtime.store.listRuns({ workId: itemId })).toHaveLength(
      1,
    );
  });

  it('mints a run for a due tick item', async () => {
    const ctx = context();
    await call(withNow(ctx, CREATE_NOW), 'PUT', `/schedules/${ID}`, {
      cron: '* * * * *',
      spec,
    });
    const tickCtx = withPrincipal(ctx, cronTick);

    const r = await call(tickCtx, 'POST', '/schedules/tick', {});
    expect(r.status).toBe(200);
    expect(r.json.minted).toHaveLength(1);
    const itemId = r.json.minted[0].itemId;

    expect(await ctx.runtime.store.readRun(`work:${itemId}/r1`)).toMatchObject({
      state: 'pending',
    });
  });

  it("replays mintItem's idempotent-create path when the deterministic slot item already exists", async () => {
    const ctx = context();
    const cronExpr = '* * * * *';
    const slot = latestDueSlot(parseCron(cronExpr), NOW);
    if (slot === undefined) throw new Error('expected a due slot at NOW');
    const itemId = await slotItemId(ID, slot);

    // Pre-seed the task directly through the orchestrator, at the exact
    // id and spec a tick would mint -- proving a cron mint goes through
    // `mintItem`'s existing-item branch (idempotent-create), not a second
    // `requestRun`, when the deterministic id already names a task. This
    // is the actual re-tick-of-the-same-slot idempotency guarantee
    // `slotItemId` is designed around (see Task 1); a frozen-clock re-tick
    // in the same minute (previous test) never reaches this branch at all,
    // because `latestDueSlot` finds no new slot to try.
    await ctx.runtime.orchestrator.request({
      taskId: { workId: itemId },
      requestId: itemId,
      pipeline: spec.pipeline,
      work: { origin: { principal: `cron:${ID}`, channel: 'cron' }, spec },
    });
    await ctx.scheduleStore.writeSchedule({
      scheduleId: ID,
      cron: cronExpr,
      spec,
      enabled: true,
      createdBy: 'user:jlapenna',
      createdAt: '2026-08-27T09:00:00.000Z',
      updatedAt: '2026-08-27T09:00:00.000Z',
    });

    const r = await call(
      withPrincipal(ctx, cronTick),
      'POST',
      '/schedules/tick',
      {},
    );
    expect(r.json.minted).toEqual([{ scheduleId: ID, itemId }]);

    const item = await call(ctx, 'GET', `/items/${itemId}`);
    expect(item.json.runs).toHaveLength(1); // still just the pre-seeded run
    expect(item.json.origin).toEqual({
      principal: `cron:${ID}`,
      channel: 'cron',
    });
  });

  it("disables a schedule whose creator's grant no longer covers its pipeline", async () => {
    const ctx = context();
    await call(withNow(ctx, CREATE_NOW), 'PUT', `/schedules/${ID}`, {
      cron: '* * * * *',
      spec,
    });
    const tickCtx = withPrincipal({ ...ctx, grants: () => [] }, cronTick);
    const r = await call(tickCtx, 'POST', '/schedules/tick', {});
    expect(r.json).toMatchObject({
      minted: [],
      skippedCap: [],
      disabled: [ID],
    });
    expect(await call(ctx, 'GET', `/schedules/${ID}`)).toMatchObject({
      json: { enabled: false, disabledReason: 'grant-revoked' },
    });
  });

  it('mints a due slot despite a native backlog and does not duplicate it on another tick', async () => {
    const ctx = context();
    for (let i = 0; i < 5; i++) {
      expect(
        (await call(ctx, 'PUT', `/items/${ID.slice(0, -1) + i}`, { spec }))
          .status,
      ).toBe(201);
    }
    const cronExpr = '* * * * *';
    const slot = latestDueSlot(parseCron(cronExpr), NOW);
    if (slot === undefined) throw new Error('expected a due slot');
    const itemId = await slotItemId(ID, slot);
    await call(withNow(ctx, CREATE_NOW), 'PUT', `/schedules/${ID}`, {
      cron: cronExpr,
      spec,
    });
    const first = await call(
      withPrincipal(ctx, cronTick),
      'POST',
      '/schedules/tick',
      {},
    );
    expect(first.json).toMatchObject({
      minted: [{ scheduleId: ID, itemId }],
      skippedCap: [],
    });
    const second = await call(
      withPrincipal(ctx, cronTick),
      'POST',
      '/schedules/tick',
      {},
    );
    expect(second.json).toMatchObject({ minted: [], skippedCap: [] });
    expect((await call(ctx, 'GET', `/items/${itemId}`)).json.runs).toHaveLength(
      1,
    );
  });

  it('disables a schedule whose stored spec no longer parses (invalid) and a healthy schedule still mints in the same tick', async () => {
    const ctx = context();
    // Written directly to the store, bypassing the `workSpecSchema`
    // validation `create`'s handler runs at the API boundary -- simulates
    // a schema tightened out from under an already-stored schedule, or a
    // hand-edited document (the exact case the router's tick handler
    // guards against).
    await ctx.scheduleStore.writeSchedule({
      scheduleId: ID,
      cron: '* * * * *',
      spec: { title: 't' },
      enabled: true,
      createdBy: 'user:jlapenna',
      createdAt: '2026-08-27T09:00:00.000Z',
      updatedAt: '2026-08-27T09:00:00.000Z',
    });
    await call(withNow(ctx, CREATE_NOW), 'PUT', `/schedules/${OTHER_ID}`, {
      cron: '* * * * *',
      spec,
    });

    const r = await call(
      withPrincipal(ctx, cronTick),
      'POST',
      '/schedules/tick',
      {},
    );
    expect(r.json.disabled).toEqual([ID]);
    expect(r.json.errors).toEqual([]);
    expect(r.json.minted).toHaveLength(1);
    expect(r.json.minted[0].scheduleId).toBe(OTHER_ID);

    // Read the store directly rather than through `GET /schedules/{id}`:
    // simpler than re-deriving the same assertion through `viewSafe`'s
    // schema round-trip (Task 1's lenient view would succeed on this
    // corrupt document with `spec` omitted, not throw).
    const stored = await ctx.scheduleStore.readSchedule(ID);
    expect(stored).toMatchObject({
      enabled: false,
      disabledReason: 'invalid',
    });
  });

  it("lands a schedule's unexpected mintItem failure in errors and the next schedule still mints", async () => {
    const ctx = context();
    const cronExpr = '* * * * *';
    const slot = latestDueSlot(parseCron(cronExpr), NOW);
    if (slot === undefined) throw new Error('expected a due slot at NOW');
    const failingItemId = await slotItemId(ID, slot);

    const createCtx = withNow(ctx, CREATE_NOW);
    await call(createCtx, 'PUT', `/schedules/${ID}`, { cron: cronExpr, spec });
    await call(createCtx, 'PUT', `/schedules/${OTHER_ID}`, {
      cron: cronExpr,
      spec,
    });

    // `mintItem`'s first store call is `readTask` -- stubbed to throw once,
    // for exactly the failing schedule's deterministic item id, so the
    // other schedule's mint is unaffected.
    const realReadTask = ctx.runtime.store.readTask.bind(ctx.runtime.store);
    vi.spyOn(ctx.runtime.store, 'readTask').mockImplementation((id) => {
      if ('workId' in id && id.workId === failingItemId) {
        throw new Error('store unavailable');
      }
      return realReadTask(id);
    });

    const r = await call(
      withPrincipal(ctx, cronTick),
      'POST',
      '/schedules/tick',
      {},
    );
    expect(r.json.errors).toEqual([
      { scheduleId: ID, message: 'store unavailable' },
    ]);
    expect(r.json.disabled).toEqual([]);
    expect(r.json.skippedCap).toEqual([]);
    expect(r.json.minted).toHaveLength(1);
    expect(r.json.minted[0].scheduleId).toBe(OTHER_ID);
  });

  it('disables a schedule whose stored cron no longer parses (invalid)', async () => {
    const ctx = context();
    // Written directly to the store, bypassing the `cronExpressionSchema`
    // validation `create`'s input schema runs at the API boundary --
    // simulates a grammar tightened out from under an already-stored
    // schedule, or a hand-edited document.
    await ctx.scheduleStore.writeSchedule({
      scheduleId: ID,
      cron: 'not a cron',
      spec,
      enabled: true,
      createdBy: 'user:jlapenna',
      createdAt: '2026-08-27T09:00:00.000Z',
      updatedAt: '2026-08-27T09:00:00.000Z',
    });

    const r = await call(
      withPrincipal(ctx, cronTick),
      'POST',
      '/schedules/tick',
      {},
    );
    expect(r.json.disabled).toEqual([ID]);
    expect(r.json.errors).toEqual([]);
    expect(r.json.minted).toEqual([]);

    const stored = await ctx.scheduleStore.readSchedule(ID);
    expect(stored).toMatchObject({
      enabled: false,
      disabledReason: 'invalid',
    });
  });

  it('a stale tick snapshot loses admission to an operator disable', async () => {
    const ctx = context();
    await call(withNow(ctx, CREATE_NOW), 'PUT', `/schedules/${ID}`, {
      cron: '* * * * *',
      spec,
    });
    const real = ctx.scheduleStore.listTickSchedules.bind(ctx.scheduleStore);
    vi.spyOn(ctx.scheduleStore, 'listTickSchedules').mockImplementationOnce(
      async () => {
        const snapshot = await real();
        expect(
          (
            await call(ctx, 'POST', `/schedules/${ID}/disable`, {
              expectedRevision: 1,
            })
          ).status,
        ).toBe(200);
        return snapshot;
      },
    );
    const r = await call(
      withPrincipal(ctx, cronTick),
      'POST',
      '/schedules/tick',
      {},
    );
    expect(r.json.minted).toEqual([]);
    expect(r.json.disabled).toEqual([]);
    expect((await ctx.scheduleStore.readSchedule(ID))?.disabledReason).toBe(
      'operator',
    );
    expect(await ctx.runtime.store.listNativeTasks()).toHaveLength(0);
  });
  it('edits only the current revision and preserves successful tick watermarks', async () => {
    const ctx = context();
    await call(withNow(ctx, CREATE_NOW), 'PUT', `/schedules/${ID}`, {
      cron: '* * * * *',
      spec,
    });
    await call(withPrincipal(ctx, cronTick), 'POST', '/schedules/tick', {});
    const before = await ctx.scheduleStore.readSchedule(ID);
    const changed = await call(ctx, 'PATCH', `/schedules/${ID}`, {
      expectedRevision: 1,
      cron: '0 * * * *',
      spec: { ...spec, title: 'Edited' },
      enabled: false,
    });
    expect(changed.status).toBe(200);
    expect(changed.json).toMatchObject({
      revision: 2,
      cron: '0 * * * *',
      enabled: false,
      disabledReason: 'operator',
      lastSlotAt: before!.lastSlotAt,
      lastItemId: before!.lastItemId,
    });
    for (const [method, path, body] of [
      [
        'PATCH',
        `/schedules/${ID}`,
        { expectedRevision: 1, cron: '* * * * *', spec, enabled: true },
      ],
      ['DELETE', `/schedules/${ID}`, { expectedRevision: 1 }],
      ['POST', `/schedules/${ID}/enable`, { expectedRevision: 1 }],
      ['POST', `/schedules/${ID}/disable`, { expectedRevision: 1 }],
    ] as const)
      expect((await call(ctx, method, path, body)).status).toBe(409);
    expect((await ctx.scheduleStore.readSchedule(ID))?.spec.title).toBe(
      'Edited',
    );
  });

  it('requires revision checks for every destructive or configuration mutation', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/schedules/${ID}`, { cron: '0 * * * *', spec });
    for (const [method, path, body] of [
      ['PATCH', `/schedules/${ID}`, { cron: '0 * * * *', spec, enabled: true }],
      ['DELETE', `/schedules/${ID}`, {}],
      ['POST', `/schedules/${ID}/enable`, {}],
      ['POST', `/schedules/${ID}/disable`, {}],
    ] as const)
      expect((await call(ctx, method, path, body)).status).toBe(400);
    expect((await ctx.scheduleStore.readSchedule(ID))?.revision).toBe(1);
  });

  it('enforces scope and grants for edits/deletion while permitting a revoked creator to delete', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/schedules/${ID}`, { cron: '0 * * * *', spec });
    for (const principal of [undefined, cronTick, executorOnly, reaperOnly]) {
      for (const method of ['PATCH', 'DELETE']) {
        const body =
          method === 'PATCH'
            ? { expectedRevision: 1, cron: '0 * * * *', spec, enabled: false }
            : { expectedRevision: 1 };
        expect(
          (
            await call(
              withPrincipal(ctx, principal),
              method,
              `/schedules/${ID}`,
              body,
            )
          ).status,
        ).toBe(401);
      }
    }
    const stranger = { ...operator, principal: 'user:stranger', pipelines: [] };
    expect(
      (
        await call(withPrincipal(ctx, stranger), 'DELETE', `/schedules/${ID}`, {
          expectedRevision: 1,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(ctx, 'PATCH', `/schedules/${ID}`, {
          expectedRevision: 1,
          cron: '0 * * * *',
          spec: { ...spec, pipeline: 'codex' },
          enabled: true,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          { ...ctx, grants: () => [] },
          'POST',
          `/schedules/${ID}/enable`,
          { expectedRevision: 1 },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          {
            ...ctx,
            principal: { ...operator, pipelines: [] },
            grants: () => [],
          },
          'DELETE',
          `/schedules/${ID}`,
          { expectedRevision: 1 },
        )
      ).status,
    ).toBe(200);
  });

  it('rejects impossible edit cron and lets the creator repair an invalid configuration', async () => {
    const ctx = context();
    await ctx.scheduleStore.writeSchedule({
      scheduleId: ID,
      cron: 'not a cron',
      spec: { title: 'invalid' },
      enabled: false,
      disabledReason: 'invalid',
      createdBy: operator.principal,
      createdAt: CREATE_NOW.toISOString(),
      updatedAt: CREATE_NOW.toISOString(),
    });
    expect(
      (await call(ctx, 'GET', `/schedules/${ID}`)).json,
    ).not.toHaveProperty('spec');
    expect(
      (
        await call(ctx, 'POST', `/schedules/${ID}/enable`, {
          expectedRevision: 0,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(ctx, 'PATCH', `/schedules/${ID}`, {
          expectedRevision: 0,
          cron: '0 0 31 2 *',
          spec,
          enabled: true,
        })
      ).status,
    ).toBe(400);
    const repaired = await call(ctx, 'PATCH', `/schedules/${ID}`, {
      expectedRevision: 0,
      cron: '* * * * *',
      spec,
      enabled: true,
    });
    expect(repaired.status).toBe(200);
    expect(repaired.json).toMatchObject({ spec, revision: 1, enabled: true });
    expect(repaired.json).not.toHaveProperty('disabledReason');
  });

  it('hides a deleted schedule, prevents id resurrection, and blocks stale tick admission', async () => {
    const ctx = context();
    await call(withNow(ctx, CREATE_NOW), 'PUT', `/schedules/${ID}`, {
      cron: '* * * * *',
      spec,
    });
    const realList = ctx.scheduleStore.listTickSchedules.bind(
      ctx.scheduleStore,
    );
    vi.spyOn(ctx.scheduleStore, 'listTickSchedules').mockImplementationOnce(
      async () => {
        const snapshot = await realList();
        expect(
          (
            await call(ctx, 'DELETE', `/schedules/${ID}`, {
              expectedRevision: 1,
            })
          ).json,
        ).toEqual({ id: ID, deleted: true });
        return snapshot;
      },
    );
    expect(
      (await call(withPrincipal(ctx, cronTick), 'POST', '/schedules/tick', {}))
        .json.minted,
    ).toEqual([]);
    expect((await call(ctx, 'GET', `/schedules/${ID}`)).status).toBe(404);
    expect((await call(ctx, 'GET', '/schedules')).json.schedules).toEqual([]);
    expect(
      (await call(ctx, 'PUT', `/schedules/${ID}`, { cron: '* * * * *', spec }))
        .status,
    ).toBe(409);
    expect(await ctx.runtime.store.listNativeTasks()).toHaveLength(0);
  });

  it.each(['edit', 'delete'] as const)(
    'finishes the frozen occurrence admitted before %s, preserving new operator intent',
    async (action) => {
      const ctx = context();
      await call(withNow(ctx, CREATE_NOW), 'PUT', `/schedules/${ID}`, {
        cron: '* * * * *',
        spec,
      });
      const request = ctx.runtime.orchestrator.request.bind(
        ctx.runtime.orchestrator,
      );
      vi.spyOn(ctx.runtime.orchestrator, 'request').mockImplementationOnce(
        async (input) => {
          const pending = (await ctx.scheduleStore.readSchedule(ID))!
            .pendingTick!;
          const changed =
            action === 'delete'
              ? await call(ctx, 'DELETE', `/schedules/${ID}`, {
                  expectedRevision: 1,
                })
              : await call(ctx, 'PATCH', `/schedules/${ID}`, {
                  expectedRevision: 1,
                  cron: '0 * * * *',
                  spec: { ...spec, title: 'Future edited' },
                  enabled: false,
                });
          expect(changed.status).toBe(200);
          expect(changed.json).toMatchObject(
            action === 'delete'
              ? { id: ID, deleted: true, pendingItemId: pending.itemId }
              : {
                  revision: 2,
                  enabled: false,
                  spec: { title: 'Future edited' },
                },
          );
          return request(input);
        },
      );
      const result = await call(
        withPrincipal(ctx, cronTick),
        'POST',
        '/schedules/tick',
        {},
      );
      expect(result.json.minted).toHaveLength(1);
      const item = await call(
        ctx,
        'GET',
        `/items/${result.json.minted[0].itemId}`,
      );
      expect(item.json.spec).toEqual(spec);
      const after = (await ctx.scheduleStore.readSchedule(ID))!;
      expect(after).toMatchObject({
        revision: 2,
        enabled: false,
        disabledReason: 'operator',
        lastSlotAt: NOW.toISOString(),
      });
      expect(after.pendingTick).toBeUndefined();
      expect(after).toMatchObject(
        action === 'delete'
          ? { deletedAt: NOW.toISOString() }
          : { spec: { title: 'Future edited' } },
      );
    },
  );

  it('retries a transient admitted mint failure after deletion without consuming the watermark', async () => {
    const ctx = context();
    await call(withNow(ctx, CREATE_NOW), 'PUT', `/schedules/${ID}`, {
      cron: '* * * * *',
      spec,
    });
    vi.spyOn(ctx.runtime.store, 'readTask').mockRejectedValueOnce(
      new Error('temporary outage'),
    );
    const first = await call(
      withPrincipal(ctx, cronTick),
      'POST',
      '/schedules/tick',
      {},
    );
    expect(first.json.errors).toEqual([
      { scheduleId: ID, message: 'temporary outage' },
    ]);
    const failed = (await ctx.scheduleStore.readSchedule(ID))!;
    expect(failed.lastSlotAt).toBe(CREATE_NOW.toISOString());
    expect(failed.pendingTick).toBeDefined();
    await call(ctx, 'DELETE', `/schedules/${ID}`, { expectedRevision: 1 });
    const retry = await call(
      withPrincipal(ctx, cronTick),
      'POST',
      '/schedules/tick',
      {},
    );
    expect(retry.json.minted).toEqual([
      { scheduleId: ID, itemId: failed.pendingTick!.itemId },
    ]);
    expect(await ctx.runtime.store.listNativeTasks()).toHaveLength(1);
    expect(
      (await ctx.scheduleStore.readSchedule(ID))?.pendingTick,
    ).toBeUndefined();
  });

  it('reconciles work already minted by an overlapping tick with a revoked grant snapshot', async () => {
    const ctx = context();
    await call(withNow(ctx, CREATE_NOW), 'PUT', `/schedules/${ID}`, {
      cron: '* * * * *',
      spec,
    });
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    ctx.runtime.drain = async () => {
      enter();
      await barrier;
      return { dispatched: [], failed: [] };
    };
    const oldTick = call(
      withPrincipal(ctx, cronTick),
      'POST',
      '/schedules/tick',
      {},
    );
    await entered;
    const reconciled = await call(
      { ...ctx, principal: cronTick, grants: () => [] },
      'POST',
      '/schedules/tick',
      {},
    );
    expect(reconciled.json.errors).toEqual([]);
    expect(reconciled.json.minted).toHaveLength(1);
    expect((await ctx.scheduleStore.readSchedule(ID))?.lastSlotAt).toBe(
      NOW.toISOString(),
    );
    expect(
      (
        await call(ctx, 'PATCH', `/schedules/${ID}`, {
          expectedRevision: 1,
          cron: '* * * * *',
          spec: { ...spec, title: 'Future' },
          enabled: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (await call(withPrincipal(ctx, cronTick), 'POST', '/schedules/tick', {}))
        .json.minted,
    ).toEqual([]);
    release();
    expect((await oldTick).json.minted).toEqual([]);
    expect((await ctx.scheduleStore.readSchedule(ID))?.spec.title).toBe(
      'Future',
    );
    expect(await ctx.runtime.store.listNativeTasks()).toHaveLength(1);
  });

  it('closes a denied old slot before mint commits, admits a newly granted next slot, and fences late settlement', async () => {
    const ctx = context({
      principal: { ...operator, pipelines: ['claude', 'codex'] },
      grants: () => [{ ...GRANTS[0], pipelines: ['claude', 'codex'] }],
    });
    await call(withNow(ctx, CREATE_NOW), 'PUT', `/schedules/${ID}`, {
      cron: '* * * * *',
      spec,
    });
    let enterOld!: () => void, releaseOld!: () => void;
    const oldEntered = new Promise<void>((r) => {
      enterOld = r;
    });
    const oldBarrier = new Promise<void>((r) => {
      releaseOld = r;
    });
    const request = ctx.runtime.orchestrator.request.bind(
      ctx.runtime.orchestrator,
    );
    vi.spyOn(ctx.runtime.orchestrator, 'request').mockImplementationOnce(
      async (input) => {
        enterOld();
        await oldBarrier;
        return request(input);
      },
    );
    const oldTick = call(
      withPrincipal(ctx, cronTick),
      'POST',
      '/schedules/tick',
      {},
    );
    await oldEntered;
    expect(
      (
        await call(
          { ...ctx, principal: cronTick, grants: () => [] },
          'POST',
          '/schedules/tick',
          {},
        )
      ).json.disabled,
    ).toEqual([ID]);
    const closed = (await ctx.scheduleStore.readSchedule(ID))!;
    expect(closed).toMatchObject({
      revision: 2,
      lastClosedSlotAt: NOW.toISOString(),
      lastSlotAt: CREATE_NOW.toISOString(),
    });
    const repaired = {
      ...ctx,
      principal: { ...operator, pipelines: ['codex'] },
      grants: () => [{ ...GRANTS[0], pipelines: ['codex'] }],
    };
    expect(
      (
        await call(repaired, 'PATCH', `/schedules/${ID}`, {
          expectedRevision: 2,
          cron: '* * * * *',
          spec: { ...spec, pipeline: 'codex' },
          enabled: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          withPrincipal(repaired, cronTick),
          'POST',
          '/schedules/tick',
          {},
        )
      ).json.minted,
    ).toEqual([]);
    let enterNew!: () => void,
      releaseNew!: () => void,
      drains = 0;
    const newEntered = new Promise<void>((r) => {
      enterNew = r;
    });
    const newBarrier = new Promise<void>((r) => {
      releaseNew = r;
    });
    ctx.runtime.drain = async () => {
      if (++drains === 1) {
        enterNew();
        await newBarrier;
      }
      return { dispatched: [], failed: [] };
    };
    const later = new Date(NOW.getTime() + 60_000);
    const newTick = call(
      withNow(withPrincipal(repaired, cronTick), later),
      'POST',
      '/schedules/tick',
      {},
    );
    await newEntered;
    const newerPending = (await ctx.scheduleStore.readSchedule(ID))!
      .pendingTick;
    releaseOld();
    expect((await oldTick).json.minted).toEqual([]);
    expect((await ctx.scheduleStore.readSchedule(ID))!.pendingTick).toEqual(
      newerPending,
    );
    releaseNew();
    expect((await newTick).json.minted).toHaveLength(1);
    const after = (await ctx.scheduleStore.readSchedule(ID))!;
    expect(after).toMatchObject({
      revision: 3,
      enabled: true,
      lastClosedSlotAt: NOW.toISOString(),
      lastSlotAt: later.toISOString(),
    });
    expect(after.pendingTick).toBeUndefined();
    expect(after.spec.pipeline).toBe('codex');
    expect(await ctx.runtime.store.listNativeTasks()).toHaveLength(2);
    expect(
      (
        await call(
          withNow(withPrincipal(repaired, cronTick), later),
          'POST',
          '/schedules/tick',
          {},
        )
      ).json.minted,
    ).toEqual([]);
  });

  it.each([false, true])(
    'recovers invalid pending work without poisoning an operator repair (repair first: %s)',
    async (repairFirst) => {
      const ctx = context();
      const pending = {
        slotAt: NOW.toISOString(),
        itemId: OTHER_ID,
        revision: 1,
        spec: { title: 'invalid' },
        createdBy: operator.principal,
      };
      await ctx.scheduleStore.writeSchedule({
        scheduleId: ID,
        cron: '* * * * *',
        spec,
        enabled: true,
        createdBy: operator.principal,
        createdAt: CREATE_NOW.toISOString(),
        updatedAt: CREATE_NOW.toISOString(),
        lastSlotAt: CREATE_NOW.toISOString(),
        revision: 1,
        pendingTick: pending,
      });
      const patch = async (revision: number) =>
        call(ctx, 'PATCH', `/schedules/${ID}`, {
          expectedRevision: revision,
          cron: '* * * * *',
          spec: { ...spec, title: 'Repaired' },
          enabled: true,
        });
      const earlyRepair = repairFirst ? await patch(1) : undefined;
      expect(earlyRepair?.status).toBe(repairFirst ? 200 : undefined);
      const tick = await call(
        withPrincipal(ctx, cronTick),
        'POST',
        '/schedules/tick',
        {},
      );
      expect(tick.json.errors[0].message).toMatch(/Invalid admitted/);
      expect(tick.json.disabled).toEqual(repairFirst ? [] : [ID]);
      const closed = (await ctx.scheduleStore.readSchedule(ID))!;
      expect(closed.pendingTick).toBeUndefined();
      expect(closed.lastClosedSlotAt).toBe(NOW.toISOString());
      expect(closed.lastSlotAt).toBe(CREATE_NOW.toISOString());
      const lateRepair = !repairFirst ? await patch(2) : undefined;
      expect(lateRepair?.status).toBe(!repairFirst ? 200 : undefined);
      expect(
        (
          await call(
            withPrincipal(ctx, cronTick),
            'POST',
            '/schedules/tick',
            {},
          )
        ).json.minted,
      ).toEqual([]);
      const next = await call(
        withNow(withPrincipal(ctx, cronTick), new Date(NOW.getTime() + 60_000)),
        'POST',
        '/schedules/tick',
        {},
      );
      expect(next.json.minted).toHaveLength(1);
      expect((await ctx.scheduleStore.readSchedule(ID))!).toMatchObject({
        enabled: true,
        spec: { title: 'Repaired' },
      });
    },
  );

  it('computes UTC next occurrence strictly beyond both settled and closed slots', async () => {
    const ctx = context();
    await call(withNow(ctx, CREATE_NOW), 'PUT', `/schedules/${ID}`, {
      cron: '* * * * *',
      spec,
    });
    await call(withPrincipal(ctx, cronTick), 'POST', '/schedules/tick', {});
    expect((await call(ctx, 'GET', `/schedules/${ID}`)).json.nextDueAt).toBe(
      '2026-08-27T10:23:00.000Z',
    );
    await ctx.scheduleStore.mutateSchedule(ID, (current) => ({
      ...current!,
      lastClosedSlotAt: '2026-08-27T10:24:00.000Z',
    }));
    expect((await call(ctx, 'GET', `/schedules/${ID}`)).json.nextDueAt).toBe(
      '2026-08-27T10:25:00.000Z',
    );
    await call(ctx, 'POST', `/schedules/${ID}/disable`, {
      expectedRevision: 1,
    });
    expect(
      (await call(ctx, 'GET', `/schedules/${ID}`)).json,
    ).not.toHaveProperty('nextDueAt');
  });
});
