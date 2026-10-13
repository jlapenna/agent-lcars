import { describe, expect, it } from 'vitest';

import { decidedRun, isRefusal } from './decide';
import { MemoryStore } from './memory-store';
import { Orchestrator } from './orchestrator';

const taskId = { repo: 'octo/example', issue: 7 };
const T0 = '2026-08-15T12:00:00.000Z';
const T1 = '2026-08-15T12:01:00.000Z';
const work = { spec: { title: 'immutable' } };
async function fixture() {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, { now: () => T0 });
  const first = await orchestrator.request({
    taskId,
    requestId: 'first',
    pipeline: 'codex',
    work,
    labelProviderRequest: {
      requestedAt: T0,
      actor: 'maintainer',
      allowProviderChange: true,
    },
  });
  if (isRefusal(first)) throw new Error(first.reason);
  const run = decidedRun(first);
  await store.enqueueRun({ runId: run.runId, now: T0 });
  await orchestrator.confirmDispatch(run.runId);
  const switchProvider = () =>
    orchestrator.request({
      taskId,
      requestId: 'switch',
      pipeline: 'opencode',
      labelProviderRequest: {
        requestedAt: T1,
        actor: 'maintainer',
        allowProviderChange: true,
      },
    });
  return { store, orchestrator, run, switchProvider };
}

describe('source-ordered label provider handoff', () => {
  it('does not adopt a historical provider as routing without an accepted handoff', async () => {
    const store = new MemoryStore();
    const controller = new Orchestrator(store, { now: () => T0 });
    const first = await controller.request({
      taskId,
      requestId: 'legacy-first',
      pipeline: 'claude',
      work,
    });
    if (isRefusal(first)) throw new Error(first.reason);
    const run = decidedRun(first);
    await controller.report(run.runId, { ok: true });
    const task = (await store.readTask(taskId))!;
    await store.apply({
      expectedRevision: task.revision,
      decision: {
        task: task.task,
        run: { ...(await store.readRun(run.runId))!, pipeline: 'opencode' },
        outbox: [],
      },
    });
    expect(
      await controller.request({
        taskId,
        requestId: 'legacy-reply',
        pipeline: 'claude',
        pipelineForStoredTask: () => 'claude',
        useEffectivePipeline: true,
      }),
    ).toMatchObject({ run: { pipeline: 'claude' }, task: { work } });
    expect(await store.readRun(run.runId)).toMatchObject({
      pipeline: 'opencode',
    });
  });

  it('retains the accepted admission provider after another provider ran and a later handoff was refused', async () => {
    const { store, orchestrator, run } = await fixture();
    await orchestrator.report(run.runId, { ok: true });
    const task = (await store.readTask(taskId))!;
    await store.apply({
      expectedRevision: task.revision,
      decision: {
        task: task.task,
        run: { ...(await store.readRun(run.runId))!, pipeline: 'opencode' },
        outbox: [],
      },
    });
    expect(
      await orchestrator.request({
        taskId,
        requestId: 'refused-route',
        pipeline: 'claude',
        pipelineForStoredTask: () => 'claude',
        labelProviderRequest: {
          requestedAt: T1,
          actor: 'ordinary',
          allowProviderChange: false,
        },
      }),
    ).toMatchObject({
      task: {
        providerRouting: {
          status: 'refused',
          acceptedGeneration: { pipeline: 'codex' },
        },
      },
    });
    expect(
      await orchestrator.request({
        taskId,
        requestId: 'accepted-route-reply',
        pipeline: 'claude',
        pipelineForStoredTask: () => 'claude',
        useEffectivePipeline: true,
      }),
    ).toMatchObject({ run: { pipeline: 'codex' }, task: { work } });
    expect(await store.readRun(run.runId)).toMatchObject({
      pipeline: 'opencode',
    });
  });

  it('atomically replaces queued work and fences the original claim and delivery replay', async () => {
    const { store, run, switchProvider } = await fixture();
    const result = await switchProvider();
    expect(result).toMatchObject({
      task: {
        runCount: 2,
        work,
        providerRouting: {
          requestedPipeline: 'opencode',
          effectivePipeline: 'opencode',
          status: 'accepted',
          fromRunId: run.runId,
        },
      },
      run: { pipeline: 'opencode' },
      additionalRuns: [{ pipeline: 'codex', state: 'canceled' }],
    });
    expect(
      await store.claimQueuedRun({
        pipelines: ['codex'],
        now: T1,
        claimedBy: 'executor',
        tokenHash: 'a'.repeat(64),
      }),
    ).toBeUndefined();
    expect(await switchProvider()).toMatchObject({
      reason: 'duplicate-request',
    });
    expect(await store.listRuns(taskId)).toHaveLength(2);
  });

  it('a concurrent claim wins without a competing executor and exposes refusal', async () => {
    const { store, switchProvider } = await fixture();
    const [claimed, result] = await Promise.all([
      store.claimQueuedRun({
        pipelines: ['codex'],
        now: T1,
        claimedBy: 'executor',
        tokenHash: 'a'.repeat(64),
      }),
      switchProvider(),
    ]);
    expect(claimed?.pipeline).toBe('codex');
    expect(result).toMatchObject({
      task: {
        providerRouting: {
          requestedPipeline: 'opencode',
          effectivePipeline: 'codex',
          status: 'refused',
          reason: 'run-already-claimed',
        },
      },
      outbox: [],
    });
    expect(await store.listRuns(taskId)).toHaveLength(1);
  });

  it('a handoff that wins the race makes the old provider unclaimable', async () => {
    const { store, switchProvider } = await fixture();
    const [result, claimed] = await Promise.all([
      switchProvider(),
      store.claimQueuedRun({
        pipelines: ['codex'],
        now: T1,
        claimedBy: 'executor',
        tokenHash: 'a'.repeat(64),
      }),
    ]);
    expect(result).toMatchObject({ run: { pipeline: 'opencode' } });
    expect(claimed).toBeUndefined();
  });

  it('same-provider requests retain normal redispatch and busy behavior', async () => {
    const { store, orchestrator, run } = await fixture();
    expect(
      await orchestrator.request({
        taskId,
        requestId: 'same-live',
        pipeline: 'codex',
        labelProviderRequest: {
          requestedAt: T1,
          actor: 'maintainer',
          allowProviderChange: true,
        },
      }),
    ).toMatchObject({
      task: { providerRouting: { status: 'refused', reason: 'task-busy' } },
      outbox: [],
    });
    await orchestrator.report(run.runId, { ok: true });
    expect(
      await orchestrator.request({
        taskId,
        requestId: 'same-terminal',
        pipeline: 'codex',
        labelProviderRequest: {
          requestedAt: '2026-08-15T12:02:00.000Z',
          actor: 'maintainer',
          allowProviderChange: true,
        },
      }),
    ).toMatchObject({ run: { pipeline: 'codex' } });
    expect(await store.listRuns(taskId)).toHaveLength(2);
  });

  it.each([false, true])(
    'preserves an explicit queued provider when the admitted label is unchanged (administrator=%s)',
    async (allowProviderChange) => {
      const { store, orchestrator, run } = await fixture();
      await orchestrator.report(run.runId, { ok: true });
      const explicit = await orchestrator.request({
        taskId,
        requestId: 'explicit-other-provider',
        pipeline: 'opencode',
      });
      if (isRefusal(explicit)) throw new Error(explicit.reason);
      const queued = decidedRun(explicit);
      await store.enqueueRun({ runId: queued.runId, now: T0 });
      const before = await store.readRun(queued.runId);
      expect(
        await orchestrator.request({
          taskId,
          requestId: 'reapply-admitted-label',
          pipeline: 'codex',
          labelProviderRequest: {
            requestedAt: T1,
            actor: allowProviderChange ? 'maintainer' : 'ordinary',
            allowProviderChange,
          },
        }),
      ).toMatchObject({
        task: {
          activeRunId: queued.runId,
          runCount: 2,
          providerRouting: {
            effectivePipeline: 'codex',
            status: 'refused',
            reason: 'task-busy',
            acceptedGeneration: { runId: run.runId, pipeline: 'codex' },
          },
        },
        outbox: [],
      });
      expect(await store.readRun(queued.runId)).toEqual(before);
      expect(await store.listRuns(taskId)).toHaveLength(2);
      expect(
        await store.claimQueuedRun({
          pipelines: ['opencode'],
          now: T1,
          claimedBy: 'executor',
          tokenHash: 'a'.repeat(64),
        }),
      ).toMatchObject({ runId: queued.runId, pipeline: 'opencode' });
    },
  );

  it('changes routing intent when queued execution already uses the requested provider (administrator=false)', async () => {
    const { store, orchestrator, run } = await fixture();
    await orchestrator.report(run.runId, { ok: true });
    const explicit = await orchestrator.request({
      taskId,
      requestId: 'explicit-other-provider',
      pipeline: 'opencode',
    });
    if (isRefusal(explicit)) throw new Error(explicit.reason);
    const queued = decidedRun(explicit);
    await store.enqueueRun({ runId: queued.runId, now: T0 });
    const before = await store.readRun(queued.runId);
    const outcome = await orchestrator.request({
      taskId,
      requestId: 'adopt-queued-provider',
      pipeline: 'opencode',
      labelProviderRequest: {
        requestedAt: T1,
        actor: 'ordinary',
        allowProviderChange: false,
      },
    });
    expect(outcome).toMatchObject({
      task: {
        activeRunId: queued.runId,
        runCount: 2,
        providerRouting: {
          status: 'refused',
          reason: 'unauthorized-provider-switch',
          acceptedGeneration: { pipeline: 'codex' },
        },
      },
      outbox: [],
    });
    expect(await store.readRun(queued.runId)).toEqual(before);
    expect(await store.listRuns(taskId)).toHaveLength(2);
  });

  it('changes routing intent when queued execution already uses the requested provider (administrator=true)', async () => {
    const { store, orchestrator, run } = await fixture();
    await orchestrator.report(run.runId, { ok: true });
    const explicit = await orchestrator.request({
      taskId,
      requestId: 'explicit-other-provider',
      pipeline: 'opencode',
    });
    if (isRefusal(explicit)) throw new Error(explicit.reason);
    const queued = decidedRun(explicit);
    await store.enqueueRun({ runId: queued.runId, now: T0 });
    const outcome = await orchestrator.request({
      taskId,
      requestId: 'adopt-queued-provider',
      pipeline: 'opencode',
      labelProviderRequest: {
        requestedAt: T1,
        actor: 'maintainer',
        allowProviderChange: true,
      },
    });
    if (isRefusal(outcome)) throw new Error(outcome.reason);
    const successor = decidedRun(outcome);
    expect(successor.runId).not.toBe(queued.runId);
    expect(successor.pipeline).toBe('opencode');
    expect(outcome).toMatchObject({
      task: {
        work,
        activeRunId: successor.runId,
        runCount: 3,
        providerRouting: {
          status: 'accepted',
          effectivePipeline: 'opencode',
          acceptedGeneration: {
            runId: successor.runId,
            pipeline: 'opencode',
          },
        },
      },
    });
    expect(await store.readRun(queued.runId)).toMatchObject({
      state: 'canceled',
    });
    expect(
      await orchestrator.request({
        taskId,
        requestId: 'adopt-queued-provider',
        pipeline: 'opencode',
        labelProviderRequest: {
          requestedAt: T1,
          actor: 'maintainer',
          allowProviderChange: true,
        },
      }),
    ).toMatchObject({ refused: true, reason: 'duplicate-request' });
    expect(await store.listRuns(taskId)).toHaveLength(3);
    expect(
      await store.claimQueuedRun({
        pipelines: ['opencode'],
        now: T1,
        claimedBy: 'old-queue-claim',
        tokenHash: 'a'.repeat(64),
      }),
    ).toBeUndefined();
    await store.enqueueRun({ runId: successor.runId, now: T1 });
    expect(
      await store.claimQueuedRun({
        pipelines: ['opencode'],
        now: T1,
        claimedBy: 'new-intent-claim',
        tokenHash: 'b'.repeat(64),
      }),
    ).toMatchObject({ runId: successor.runId, pipeline: 'opencode' });
  });

  it('equal-clock requests cannot erase a busy refusal and admit it on replay', async () => {
    const { store, orchestrator, run } = await fixture();
    const request = (requestId: string) =>
      orchestrator.request({
        taskId,
        requestId,
        pipeline: 'codex',
        labelProviderRequest: {
          requestedAt: T1,
          actor: 'maintainer',
          allowProviderChange: true,
        },
      });
    expect(await request('busy-a')).toMatchObject({
      task: { providerRouting: { requestId: 'busy-a', status: 'refused' } },
    });
    expect(await request('busy-b')).toMatchObject({
      reason: 'stale-provider-request',
    });
    await orchestrator.report(run.runId, { ok: true });
    expect(await request('busy-a')).toMatchObject({
      task: { providerRouting: { requestId: 'busy-a', status: 'refused' } },
      outbox: [],
    });
    expect(await store.listRuns(taskId)).toHaveLength(1);
  });

  it('stale and equal-clock deliveries cannot switch back', async () => {
    const { store, orchestrator, switchProvider } = await fixture();
    await switchProvider();
    for (const requestedAt of [T0, T1]) {
      expect(
        await orchestrator.request({
          taskId,
          requestId: `old-${requestedAt}`,
          pipeline: 'codex',
          labelProviderRequest: {
            requestedAt,
            actor: 'maintainer',
            allowProviderChange: true,
          },
        }),
      ).toMatchObject({ reason: 'stale-provider-request' });
    }
    expect(
      (await store.readTask(taskId))?.task.providerRouting?.requestedPipeline,
    ).toBe('opencode');
    expect(await store.listRuns(taskId)).toHaveLength(2);
  });

  it('a refusal retains the accepted generation source clock when delivery was delayed', async () => {
    const store = new MemoryStore();
    const controller = new Orchestrator(store, {
      now: () => '2026-08-15T12:10:00.000Z',
    });
    const first = await controller.request({
      taskId,
      requestId: 'delayed-first',
      pipeline: 'codex',
      work,
      labelProviderRequest: {
        requestedAt: T0,
        actor: 'maintainer',
        allowProviderChange: true,
      },
    });
    if (isRefusal(first)) throw new Error(first.reason);
    const original = decidedRun(first);
    await store.enqueueRun({
      runId: original.runId,
      now: '2026-08-15T12:10:00.000Z',
    });
    expect(
      await controller.request({
        taskId,
        requestId: 'busy-label',
        pipeline: 'codex',
        labelProviderRequest: {
          requestedAt: T1,
          actor: 'maintainer',
          allowProviderChange: true,
        },
      }),
    ).toMatchObject({
      task: {
        providerRouting: {
          status: 'refused',
          acceptedGeneration: { runId: original.runId, requestedAt: T0 },
        },
      },
    });
    expect(
      await controller.request({
        taskId,
        requestId: 'later-label',
        pipeline: 'opencode',
        labelProviderRequest: {
          requestedAt: '2026-08-15T12:02:00.000Z',
          actor: 'maintainer',
          allowProviderChange: true,
        },
      }),
    ).toMatchObject({
      run: { pipeline: 'opencode' },
      task: { providerRouting: { status: 'accepted' } },
    });
    expect(await store.readRun(original.runId)).toMatchObject({
      state: 'canceled',
      pipeline: 'codex',
    });
  });

  it('a delayed label cannot replace a newer non-label generation', async () => {
    const { store, orchestrator, run } = await fixture();
    await orchestrator.report(run.runId, { ok: true });
    const controller = new Orchestrator(store, {
      now: () => '2026-08-15T12:03:00.000Z',
    });
    const newer = await controller.request({
      taskId,
      requestId: 'newer-reply',
      pipeline: 'codex',
    });
    if (isRefusal(newer)) throw new Error(newer.reason);
    const next = decidedRun(newer);
    await store.enqueueRun({
      runId: next.runId,
      now: '2026-08-15T12:03:00.000Z',
    });
    expect(
      await controller.request({
        taskId,
        requestId: 'delayed-switch',
        pipeline: 'opencode',
        labelProviderRequest: {
          requestedAt: T1,
          actor: 'maintainer',
          allowProviderChange: true,
        },
      }),
    ).toMatchObject({
      task: {
        activeRunId: next.runId,
        providerRouting: {
          status: 'refused',
          reason: 'run-newer-than-label',
          requestedPipeline: 'opencode',
          effectivePipeline: 'codex',
        },
      },
      outbox: [],
    });
    expect(
      await store.claimQueuedRun({
        pipelines: ['codex', 'opencode'],
        now: '2026-08-15T12:03:00.000Z',
        claimedBy: 'executor',
        tokenHash: 'a'.repeat(64),
      }),
    ).toMatchObject({ runId: next.runId, pipeline: 'codex' });
    expect(await store.listRuns(taskId)).toHaveLength(2);
  });

  it('refuses a settled attempt until the physical claim is retired', async () => {
    const { store, orchestrator, run, switchProvider } = await fixture();
    await store.claimQueuedRun({
      pipelines: ['codex'],
      now: T0,
      claimedBy: 'executor',
      tokenHash: 'a'.repeat(64),
    });
    await orchestrator.report(run.runId, { ok: true, summary: 'park' });
    expect(await switchProvider()).toMatchObject({
      task: {
        providerRouting: {
          status: 'refused',
          reason: 'physical-retirement-required',
          effectivePipeline: 'codex',
        },
      },
    });
    expect(await store.listRuns(taskId)).toHaveLength(1);
  });

  it('starts a fresh provider on a settled unclaimed terminal task without rewriting history', async () => {
    const { store, orchestrator, run, switchProvider } = await fixture();
    await orchestrator.report(run.runId, { ok: true, summary: 'park' });
    expect(await switchProvider()).toMatchObject({
      run: { pipeline: 'opencode' },
      task: { work },
    });
    expect(await store.readRun(run.runId)).toMatchObject({
      state: 'finished',
      pipeline: 'codex',
      result: { summary: 'park' },
    });
  });
});
