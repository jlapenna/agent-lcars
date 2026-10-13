import { describe, expect, it } from 'vitest';

import {
  decidedRun,
  isRefusal,
  MemoryStore,
  Orchestrator,
  type DeliveryBinding,
} from '@agent-lcars/orchestrator';
import { deriveItemState } from './derive';

const NOW = '2026-10-13T10:00:00.000Z';
const TASK = { repo: 'octo/example', issue: 7 };
const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const CLAIM = 'c'.repeat(64);

async function handedOff(
  runtimeGate: DeliveryBinding['runtimeGate'] = 'none',
  pipeline = 'claude',
) {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, { now: () => NOW });
  const first = decidedRun(
    await orchestrator.request({
      taskId: TASK,
      requestId: 'original',
      pipeline,
      work: { spec: { title: 'deliver' } },
      params: { mode: 'implement' },
    }),
  );
  await store.enqueueRun({ runId: first.runId, now: NOW });
  await orchestrator.confirmDispatch(first.runId);
  await store.claimQueuedRun({
    pipelines: [pipeline],
    now: NOW,
    claimedBy: 'runner',
    tokenHash: CLAIM,
  });
  const binding: DeliveryBinding = {
    runId: first.runId,
    repo: TASK.repo,
    number: 12,
    baseRef: 'main',
    head: HEAD,
    state: 'waiting',
    runtimeGate,
    observedAt: NOW,
  };
  const settled = await orchestrator.report(
    first.runId,
    {
      ok: true,
      summary: 'pull-request',
      ref: 'https://github.com/octo/example/pull/12',
    },
    CLAIM,
    undefined,
    undefined,
    binding,
  );
  expect(isRefusal(settled)).toBe(false);
  return { store, orchestrator, runId: first.runId };
}

describe('ready deliverable logical ownership', () => {
  it('settles physical execution while own CI is queued, retains logical ownership, and enqueues monitoring', async () => {
    const f = await handedOff();
    const task = (await f.store.readTask(TASK))!.task;
    expect(task.activeRunId).toBeUndefined();
    expect(deriveItemState(task, await f.store.listRuns(TASK))).toBe('running');
    expect((await f.store.readRun(f.runId))?.state).toBe('finished');
    expect(
      (
        await f.store.claimPendingOutbox({
          now: '2026-10-13T10:01:00.000Z',
          leaseExpiresAt: '2026-10-13T10:02:00.000Z',
          limit: 10,
        })
      ).some((entry) => entry.kind === 'monitor-delivery'),
    ).toBe(true);
    expect(
      await f.orchestrator.observeDelivery(
        f.runId,
        { kind: 'waiting', head: HEAD },
        () => true,
      ),
    ).toMatchObject({ task: { delivery: { state: 'waiting' } } });
  });

  it('does not replace unresolved Codex cleanup debt with delivery state', async () => {
    const f = await handedOff('none', 'codex');
    expect((await f.store.readRun(f.runId))?.credentialOperation).toMatchObject(
      {
        kind: 'cleanup',
        claimFingerprint: CLAIM,
      },
    );
  });

  it('blocks same-task reuse during delivery while unrelated task admission remains possible', async () => {
    const f = await handedOff();
    expect(
      await f.orchestrator.request({
        taskId: TASK,
        requestId: 'other',
        pipeline: 'claude',
      }),
    ).toMatchObject({ refused: true, reason: 'task-busy' });
    expect((await f.store.readTask(TASK))?.task.delivery?.state).toBe(
      'waiting',
    );
    expect(
      isRefusal(
        await f.orchestrator.request({
          taskId: { ...TASK, issue: 8 },
          requestId: 'other',
          pipeline: 'claude',
          work: { spec: {} },
        }),
      ),
    ).toBe(false);
  });

  it('creates one fresh, same-provider correction for real failed checks or review, fenced against replay', async () => {
    const f = await handedOff();
    const observation = {
      kind: 'correction' as const,
      head: HEAD,
      reason: 'Verify failed',
    };
    const decision = await f.orchestrator.observeDelivery(
      f.runId,
      observation,
      () => true,
    );
    if (isRefusal(decision)) throw new Error(decision.reason);
    expect(decision.additionalRuns?.[0]).toMatchObject({
      runId: 'octo/example#7/r2',
      pipeline: 'claude',
      params: { deliveryPredecessor: f.runId },
    });
    expect(
      await f.orchestrator.observeDelivery(f.runId, observation, () => true),
    ).toMatchObject({ refused: true, reason: 'stale-lease' });
    expect((await f.store.listRuns(TASK)).length).toBe(2);
    expect((await f.store.readTask(TASK))?.task.delivery?.runId).toBe(f.runId);
    const correction = decision.additionalRuns![0]!;
    await f.orchestrator.report(correction.runId, {
      ok: true,
      summary: 'comment',
    });
    expect(
      deriveItemState(
        (await f.store.readTask(TASK))!.task,
        await f.store.listRuns(TASK),
      ),
    ).toBe('running');
  });

  it('rejects stale revisions and revoked correction grants without minting capacity work', async () => {
    const f = await handedOff();
    expect(
      await f.orchestrator.observeDelivery(
        f.runId,
        { kind: 'correction', head: MERGE, reason: 'stale' },
        () => true,
      ),
    ).toMatchObject({ refused: true, reason: 'stale-lease' });
    expect(
      await f.orchestrator.observeDelivery(
        f.runId,
        { kind: 'correction', head: HEAD, reason: 'failed' },
        () => false,
      ),
    ).toMatchObject({ refused: true, reason: 'not-claimant' });
    expect((await f.store.listRuns(TASK)).length).toBe(1);
  });

  it('finishes logical delivery only after exact protected landing and a trusted no-runtime intake', async () => {
    const f = await handedOff();
    await f.orchestrator.observeDelivery(
      f.runId,
      { kind: 'protected-merge', head: HEAD, mergeCommit: MERGE },
      () => false,
    );
    expect(
      deriveItemState(
        (await f.store.readTask(TASK))!.task,
        await f.store.listRuns(TASK),
      ),
    ).toBe('done');
  });

  it.each(['unknown', 'required'] as const)(
    'retains %s runtime ownership after protected merge until an authenticated receipt',
    async (runtimeGate) => {
      const f = await handedOff(runtimeGate);
      await f.orchestrator.observeDelivery(
        f.runId,
        { kind: 'protected-merge', head: HEAD, mergeCommit: MERGE },
        () => false,
      );
      expect(
        deriveItemState(
          (await f.store.readTask(TASK))!.task,
          await f.store.listRuns(TASK),
        ),
      ).toBe('running');
      const receipt = {
        kind: 'runtime-evidence' as const,
        head: HEAD,
        mergeCommit: MERGE,
        principal: 'user:operator',
        ref: 'https://example.com/runtime-receipt',
      };
      expect(
        await f.orchestrator.observeDelivery(f.runId, receipt, () => false),
      ).toMatchObject({ refused: true });
      await f.orchestrator.observeDelivery(f.runId, receipt, () => true);
      expect(
        deriveItemState(
          (await f.store.readTask(TASK))!.task,
          await f.store.listRuns(TASK),
        ),
      ).toBe('done');
    },
  );
});

it('retains a parked correction binding while the existing authenticated human reply path resumes it', async () => {
  const f = await handedOff();
  const correction = await f.orchestrator.observeDelivery(
    f.runId,
    { kind: 'correction', head: HEAD, reason: 'Review change' },
    () => true,
  );
  if (isRefusal(correction)) throw Error(correction.reason);
  const run = correction.additionalRuns![0]!;
  await f.orchestrator.report(run.runId, { ok: true, summary: 'park' });
  expect(
    deriveItemState(
      (await f.store.readTask(TASK))!.task,
      await f.store.listRuns(TASK),
    ),
  ).toBe('parked');
  expect(
    await f.orchestrator.request({
      taskId: TASK,
      requestId: 'blind-retry',
      pipeline: 'claude',
    }),
  ).toMatchObject({ refused: true, reason: 'task-busy' });
  const resumed = await f.orchestrator.request({
    taskId: TASK,
    requestId: 'human-decision',
    pipeline: 'claude',
    params: {
      mode: 'reply',
      replyPrincipal: 'user:operator',
      reply: 'Decision supplied',
    },
  });
  expect(isRefusal(resumed)).toBe(false);
  expect((await f.store.readTask(TASK))?.task.delivery?.runId).toBe(f.runId);
});
