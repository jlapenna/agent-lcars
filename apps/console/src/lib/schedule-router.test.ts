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
const reaperOnly = {
  principal: 'pin:tick',
  subject: 'pin:tick',
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
      settleTerminal: async () => ({}),
    } as unknown as WorkContext['runtime'],
    sessionsFor: async () => [],
    maxLiveRuns: 4,
    scheduleStore: new MemoryScheduleStore(),
    grants: () => GRANTS,
    now: () => NOW,
    queuePipelines: [],
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

  it('refuses schedule CRUD for a cron:tick principal, which carries no work.operator scope', async () => {
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
    try {
      const ctx = context();
      const r = await call(ctx, 'PUT', `/schedules/${ID}`, {
        cron: '0 * * * *',
        spec: { ...spec, target: { repo: otherRepo } },
      });
      expect(r.status).toBe(201);
    } finally {
      delete process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'];
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

  it("honours AGENT_LCARS_QUEUE_PIPELINES on a minted tick run, same as items.create: executor 'queue' for a configured pipeline", async () => {
    // Both `items.create` and the schedule tick route through `mintItem`
    // (`work-mint.ts`), which is where `executorFor(spec.pipeline,
    // context.queuePipelines)` is called -- proving it here proves the
    // cron path gets the same executor selection as `items.create`
    // without duplicating it.
    const ctx = context({ queuePipelines: ['claude'] });
    await call(withNow(ctx, CREATE_NOW), 'PUT', `/schedules/${ID}`, {
      cron: '* * * * *',
      spec,
    });
    const tickCtx = withPrincipal(ctx, cronTick);

    const r = await call(tickCtx, 'POST', '/schedules/tick', {});
    expect(r.status).toBe(200);
    expect(r.json.minted).toHaveLength(1);
    const itemId = r.json.minted[0].itemId;

    const run = await ctx.runtime.store.readRun(`work:${itemId}/r1`);
    expect(run?.executor).toBe('queue');
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

  it('skips a schedule at the live-run cap and does not advance lastSlotAt', async () => {
    const ctx = context({ maxLiveRuns: 0 });
    await call(withNow(ctx, CREATE_NOW), 'PUT', `/schedules/${ID}`, {
      cron: '* * * * *',
      spec,
    });
    const r = await call(
      withPrincipal(ctx, cronTick),
      'POST',
      '/schedules/tick',
      {},
    );
    expect(r.json).toMatchObject({
      minted: [],
      skippedCap: [ID],
      disabled: [],
    });
    // Unmoved from its create-time seed (Task 2), not undefined: the cap
    // skip must not advance the watermark past where creation left it.
    expect((await call(ctx, 'GET', `/schedules/${ID}`)).json.lastSlotAt).toBe(
      CREATE_NOW.toISOString(),
    );
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

  it('mints the same deterministic slot id on a later tick once under the live-run cap', async () => {
    const cronExpr = '* * * * *';
    const slot = latestDueSlot(parseCron(cronExpr), NOW);
    if (slot === undefined) throw new Error('expected a due slot at NOW');
    const expectedItemId = await slotItemId(ID, slot);

    const capped = context({ maxLiveRuns: 0 });
    await call(withNow(capped, CREATE_NOW), 'PUT', `/schedules/${ID}`, {
      cron: cronExpr,
      spec,
    });
    const first = await call(
      withPrincipal(capped, cronTick),
      'POST',
      '/schedules/tick',
      {},
    );
    expect(first.json).toMatchObject({ minted: [], skippedCap: [ID] });

    // Same clock and store, but no longer at the live-run cap: the
    // schedule's `lastSlotAt` never advanced while skipped, so
    // `latestDueSlot` still resolves to the identical slot, and
    // `slotItemId` is deterministic per (scheduleId, slot) -- the retried
    // tick mints the exact same item id the capped tick could not.
    const uncapped = { ...capped, maxLiveRuns: 4 };
    const second = await call(
      withPrincipal(uncapped, cronTick),
      'POST',
      '/schedules/tick',
      {},
    );
    expect(second.json.minted).toEqual([
      { scheduleId: ID, itemId: expectedItemId },
    ]);
    expect(second.json.skippedCap).toEqual([]);
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

  it('a tick write-back loses a race to an operator disable: re-reads and skips the write, recording nothing', async () => {
    const ctx = context();
    await call(withNow(ctx, CREATE_NOW), 'PUT', `/schedules/${ID}`, {
      cron: '* * * * *',
      spec,
    });

    // Simulate an operator's `disable` landing between the tick's
    // `listEnabledSchedules()` snapshot and its write-back: every
    // `readSchedule` from here on reports the schedule disabled, exactly
    // as a concurrent `POST /schedules/{id}/disable` would leave it.
    vi.spyOn(ctx.scheduleStore, 'readSchedule').mockImplementation(
      async () => ({
        scheduleId: ID,
        cron: '* * * * *',
        spec,
        enabled: false,
        disabledReason: 'operator',
        createdBy: 'user:jlapenna',
        createdAt: CREATE_NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      }),
    );
    const writeSpy = vi.spyOn(ctx.scheduleStore, 'writeSchedule');

    const r = await call(
      withPrincipal(ctx, cronTick),
      'POST',
      '/schedules/tick',
      {},
    );
    expect(r.json.minted).toEqual([]);
    expect(r.json.disabled).toEqual([]);
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
