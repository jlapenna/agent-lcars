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
          requestedAt: T1,
          actor: 'maintainer',
          allowProviderChange: true,
        },
      }),
    ).toMatchObject({ run: { pipeline: 'codex' } });
    expect(await store.listRuns(taskId)).toHaveLength(2);
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
