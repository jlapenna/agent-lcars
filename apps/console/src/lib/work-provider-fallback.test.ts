import {
  MemoryScheduleStore,
  MemoryStore,
  Orchestrator,
  type Run,
} from '@agent-lcars/orchestrator';
import { describe, expect, it } from 'vitest';

import type { WorkGrant } from './work-grants';
import {
  authorizeProviderFallback,
  currentFallbackPipelines,
} from './work-provider-fallback';
import { createWorkHandler, type WorkContext } from './work-router';

const ID = '01J5Z3K9QX8F0N2B4V6C8D1E3G';
const REPO = 'jlapenna/agent-lcars';
const NOW = '2026-10-10T02:00:00.000Z';
const spec = {
  title: 'Explicit provider fallback',
  description: 'Fresh authorized attempts',
  pipeline: 'claude',
  target: { repo: REPO },
};

function fixture() {
  const store = new MemoryStore();
  let grants: WorkGrant[] = [
    {
      principal: 'user:operator',
      subjects: ['github:operator'],
      pipelines: ['claude', 'codex', 'opencode'],
      scopes: ['work.operator'],
    },
  ];
  const orchestrator = new Orchestrator(
    store,
    { now: () => NOW },
    {
      pipelines: ['claude', 'codex', 'opencode'],
      allowedPipelines: (task, run) =>
        currentFallbackPipelines(task, run, grants, (repo) => repo === REPO),
    },
  );
  const context: WorkContext = {
    principal: {
      principal: 'user:operator',
      subject: 'github:operator',
      via: 'session',
      pipelines: ['claude', 'codex', 'opencode'],
      scopes: new Set(['work.operator']),
    },
    runtime: {
      store,
      orchestrator,
      drain: async () => ({ dispatched: [], reported: [], failed: [] }),
    },
    sessionsFor: async () => [],
    getSessionDoc: async () => undefined,
    sessionDocsForRuns: async () => [],
    scheduleStore: new MemoryScheduleStore(),
    grants: () => grants,
    now: () => new Date(NOW),
  };
  return {
    store,
    orchestrator,
    context,
    revoke(next: WorkGrant[]) {
      grants = next;
    },
  };
}

async function post(context: WorkContext, path: string, body: unknown) {
  const { response } = await createWorkHandler().handle(
    new Request(
      `https://lcars.test/api/work/v1${path === '/items' ? `/items/${ID}` : path}`,
      {
        method: path === '/items' ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
    { prefix: '/api/work/v1', context },
  );
  if (response === undefined) throw new Error('Work route was not handled');
  return response;
}

describe('provider fallback at the authenticated Work boundary', () => {
  it('allows a request-level opt-in without changing the immutable spec and allows explicit disable', async () => {
    const f = fixture();
    await post(f.context, '/items', { id: ID, spec });
    const initial = (await f.store.readActiveRun({ workId: ID }))!;
    await f.orchestrator.report(initial.runId, {
      ok: false,
      summary: 'verification-failed',
    });
    expect(
      (
        await post(f.context, `/items/${ID}/redispatch`, {
          fallbackPipelines: ['codex'],
        })
      ).status,
    ).toBe(200);
    const opted = (await f.store.readActiveRun({ workId: ID }))!;
    expect(opted.providerFallback?.allowedPipelines).toEqual(['codex']);
    expect((await f.store.readTask({ workId: ID }))!.task.work['spec']).toEqual(
      spec,
    );
    await f.orchestrator.report(opted.runId, {
      ok: false,
      summary: 'verification-failed',
    });
    await post(f.context, `/items/${ID}/redispatch`, { fallbackPipelines: [] });
    const disabled = (await f.store.readActiveRun({ workId: ID }))!;
    expect(disabled.providerFallback).toBeUndefined();
    await f.orchestrator.report(disabled.runId, {
      ok: false,
      summary: 'provider-limit',
    });
    expect(await f.store.listRuns({ workId: ID })).toHaveLength(3);
  });
  it('retains a human reply on a fresh alternate attempt', async () => {
    const f = fixture();
    await post(f.context, '/items', { id: ID, spec });
    const initial = (await f.store.readActiveRun({ workId: ID }))!;
    await f.orchestrator.report(initial.runId, { ok: true, summary: 'park' });
    expect(
      (
        await post(f.context, `/items/${ID}/reply`, {
          text: 'Use the durable API.',
          fallbackPipelines: ['opencode'],
        })
      ).status,
    ).toBe(200);
    const reply = (await f.store.readActiveRun({ workId: ID }))!;
    await f.orchestrator.report(reply.runId, {
      ok: false,
      summary: 'provider-limit',
    });
    expect(await f.store.readActiveRun({ workId: ID })).toMatchObject({
      pipeline: 'opencode',
      params: { mode: 'reply', reply: 'Use the durable API.' },
      providerFallback: { fromRunId: reply.runId },
    });
  });
  it('binds keyed API replies to the original ordered fallback selection without new admission or outbox', async () => {
    const f = fixture();
    await post(f.context, '/items', { id: ID, spec });
    const original = (await f.store.readActiveRun({ workId: ID }))!;
    await f.orchestrator.report(original.runId, { ok: true, summary: 'done' });
    const reply = {
      text: 'Preserve exactly this policy',
      requestId: 'fallback-reply-key',
      fallbackPipelines: ['codex', 'opencode'],
    };
    expect((await post(f.context, `/items/${ID}/reply`, reply)).status).toBe(
      200,
    );
    const admittedTask = await f.store.readTask({ workId: ID });
    const admittedRuns = await f.store.listRuns({ workId: ID });
    const entries = await f.store.claimPendingOutbox({
      limit: 30,
      now: NOW,
      leaseExpiresAt: '2026-10-10T02:05:00.000Z',
    });
    expect(
      entries.filter((entry) => entry.kind === 'dispatch-run'),
    ).toHaveLength(2);
    expect((await post(f.context, `/items/${ID}/reply`, reply)).status).toBe(
      200,
    );
    for (const fallbackPipelines of [
      [],
      ['opencode'],
      ['opencode', 'codex'],
      undefined,
    ])
      expect(
        (
          await post(f.context, `/items/${ID}/reply`, {
            ...reply,
            fallbackPipelines,
          })
        ).status,
      ).toBe(409);
    expect(await f.store.readTask({ workId: ID })).toEqual(admittedTask);
    expect(await f.store.listRuns({ workId: ID })).toEqual(admittedRuns);
    expect(admittedRuns).toHaveLength(2);
    expect(
      await f.store.claimPendingOutbox({
        limit: 30,
        now: NOW,
        leaseExpiresAt: '2026-10-10T02:05:00.000Z',
      }),
    ).toEqual([]);
    expect(await f.store.readActiveRun({ workId: ID })).toMatchObject({
      providerFallback: { allowedPipelines: ['codex', 'opencode'] },
    });
  });

  it('replays legacy omitted-policy receipts without inventing a historical explicit selection', async () => {
    const f = fixture();
    await post(f.context, '/items', {
      id: ID,
      spec: { ...spec, fallbackPipelines: ['codex'] },
    });
    const original = (await f.store.readActiveRun({ workId: ID }))!;
    await f.orchestrator.report(original.runId, { ok: true, summary: 'done' });
    const reply = {
      text: 'Legacy inherited policy',
      requestId: 'legacy-fallback-key',
    };
    expect((await post(f.context, `/items/${ID}/reply`, reply)).status).toBe(
      200,
    );
    const admitted = (await f.store.readActiveRun({ workId: ID }))!;
    await f.store.transactRun({
      runId: admitted.runId,
      decide: ({ task, run }) => {
        if (task === undefined || run?.params === undefined)
          throw new Error('missing fixture reply');
        const { replyFallbackPipelinesRequested: _selection, ...params } =
          run.params;
        return { task: task.task, run: { ...run, params }, outbox: [] };
      },
    });
    expect((await post(f.context, `/items/${ID}/reply`, reply)).status).toBe(
      200,
    );
    expect(
      (
        await post(f.context, `/items/${ID}/reply`, {
          ...reply,
          fallbackPipelines: ['codex'],
        })
      ).status,
    ).toBe(409);
    expect(await f.store.listRuns({ workId: ID })).toHaveLength(2);
  });

  it('keeps omission/empty opt-in disabled and narrows explicit ordered alternatives', () => {
    const principal = {
      principal: 'user:operator',
      pipelines: ['claude', 'opencode'],
    };
    expect(
      authorizeProviderFallback(principal, 'claude', undefined),
    ).toBeUndefined();
    expect(authorizeProviderFallback(principal, 'claude', [])).toBeUndefined();
    expect(
      authorizeProviderFallback(principal, 'claude', ['codex', 'opencode']),
    ).toEqual({ principal: 'user:operator', allowedPipelines: ['opencode'] });
  });
  it('admits an explicit spec and actually mints a fresh authorized attempt on provider limit', async () => {
    const f = fixture();
    expect(
      (
        await post(f.context, '/items', {
          id: ID,
          spec: { ...spec, fallbackPipelines: ['codex', 'opencode'] },
        })
      ).status,
    ).toBe(201);
    const original = (await f.store.readActiveRun({ workId: ID }))!;
    expect(original.providerFallback).toMatchObject({
      principal: 'user:operator',
      allowedPipelines: ['codex', 'opencode'],
    });
    await f.orchestrator.report(original.runId, {
      ok: false,
      summary: 'provider-limit',
    });
    expect(await f.store.readActiveRun({ workId: ID })).toMatchObject({
      pipeline: 'codex',
      providerFallback: { fromRunId: original.runId },
    });
  });
  it.each(['grant', 'scope', 'pipeline'])(
    'rechecks current %s authority after admission',
    async (removed) => {
      const f = fixture();
      await post(f.context, '/items', {
        id: ID,
        spec: { ...spec, fallbackPipelines: ['codex'] },
      });
      const original = (await f.store.readActiveRun({ workId: ID }))!;
      f.revoke(
        removed === 'grant'
          ? []
          : [
              {
                principal: 'user:operator',
                subjects: ['github:operator'],
                pipelines:
                  removed === 'pipeline' ? ['claude'] : ['claude', 'codex'],
                scopes:
                  removed === 'scope' ? ['work.executor'] : ['work.operator'],
              },
            ],
      );
      await f.orchestrator.report(original.runId, {
        ok: false,
        summary: 'provider-limit',
      });
      expect(await f.store.listRuns({ workId: ID })).toHaveLength(1);
      expect(await f.store.readActiveRun({ workId: ID })).toBeUndefined();
    },
  );
  it('refuses caller identities and duplicate alternatives before any run is minted', async () => {
    const f = fixture();
    for (const invalidSpec of [
      {
        ...spec,
        providerFallback: {
          principal: 'user:admin',
          allowedPipelines: ['codex'],
        },
      },
      { ...spec, fallbackPipelines: ['codex', 'codex'] },
      { ...spec, fallbackPipelines: ['claude'] },
    ])
      expect(
        (await post(f.context, '/items', { id: ID, spec: invalidSpec })).status,
      ).toBe(400);
    expect(await f.store.listRuns({ workId: ID })).toEqual([]);
    expect(
      (
        await post({ ...f.context, principal: undefined }, '/items', {
          id: ID,
          spec: { ...spec, fallbackPipelines: ['codex'] },
        })
      ).status,
    ).toBe(401);
  });
  it('preserves the signed repository fence and rechecks repository admission', async () => {
    const f = fixture();
    await post(f.context, '/items', {
      id: ID,
      spec: { ...spec, fallbackPipelines: ['codex'] },
    });
    const run = (await f.store.readActiveRun({ workId: ID }))!;
    const task = (await f.store.readTask({ workId: ID }))!.task;
    const grants = f.context.grants();
    expect(currentFallbackPipelines(task, run, grants, () => false)).toEqual(
      [],
    );
    const scoped: Run = {
      ...run,
      providerFallback: {
        ...run.providerFallback!,
        sourceRepository: 'other/repo',
      },
    };
    expect(currentFallbackPipelines(task, scoped, grants, () => true)).toEqual(
      [],
    );
  });
});
