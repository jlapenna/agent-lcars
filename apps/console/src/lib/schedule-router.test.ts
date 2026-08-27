import {
  MemoryScheduleStore,
  MemoryStore,
  Orchestrator,
} from '@agent-lcars/orchestrator';
import { latestDueSlot, parseCron, slotItemId } from '@agent-lcars/work';
import { describe, expect, it } from 'vitest';

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
const GRANTS = [
  {
    principal: 'user:jlapenna',
    subjects: ['github:jlapenna'],
    pipelines: ['claude'],
  },
];
const NOW = new Date('2026-08-27T10:22:00.000Z');

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
    ...over,
  };
}

function withPrincipal(
  ctx: WorkContext,
  principal: WorkContext['principal'],
): WorkContext {
  return { ...ctx, principal };
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
    });
  });

  it('mints the latest due slot, advances lastSlotAt, and a re-tick in the same minute is a no-op', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/schedules/${ID}`, {
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
    });
    const gotAfterSecond = await call(ctx, 'GET', `/schedules/${ID}`);
    expect(gotAfterSecond.json.lastSlotAt).toBe(gotAfterFirst.json.lastSlotAt);
    expect(gotAfterSecond.json.lastItemId).toBe(itemId);
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
    await call(ctx, 'PUT', `/schedules/${ID}`, { cron: '* * * * *', spec });
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
    expect(
      (await call(ctx, 'GET', `/schedules/${ID}`)).json.lastSlotAt,
    ).toBeUndefined();
  });

  it("disables a schedule whose creator's grant no longer covers its pipeline", async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/schedules/${ID}`, { cron: '* * * * *', spec });
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
});
