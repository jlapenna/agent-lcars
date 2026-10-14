import {
  cancelRun,
  decidedRun,
  type DeliveryBinding,
  isRefusal,
  MemoryStore,
  Orchestrator,
  reserveCredentialOperation,
  runSchema,
  type TaskId,
} from '@agent-lcars/orchestrator';
import { describe, expect, it } from 'vitest';

import { deriveItemState } from './derive';

const NOW = '2026-10-13T10:00:00.000Z';
const TASK = { repo: 'octo/example', issue: 7 };
const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const CLAIM = 'c'.repeat(64);

async function handedOff(
  runtimeGate: DeliveryBinding['runtimeGate'] = 'none',
  pipeline = 'claude',
  taskId: TaskId = TASK,
  state: 'waiting' | 'complete' = 'waiting',
  reportReady = true,
) {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, { now: () => NOW });
  const decision = await orchestrator.request({
    taskId,
    requestId: 'original',
    pipeline,
    work: { spec: { title: 'deliver' } },
    params: { mode: 'implement' },
  });
  if (isRefusal(decision)) throw new Error(decision.reason);
  const first = decidedRun(decision);
  await store.enqueueRun({ runId: first.runId, now: NOW });
  await orchestrator.confirmDispatch(first.runId);
  await store.claimQueuedRun({
    pipelines: [pipeline],
    now: NOW,
    claimedBy: 'runner',
    tokenHash: CLAIM,
  });
  if (!reportReady) return { store, orchestrator, runId: first.runId };
  const binding: DeliveryBinding = {
    runId: first.runId,
    repo: TASK.repo,
    number: 12,
    baseRef: 'main',
    head: HEAD,
    state,
    ...(state === 'complete' ? { mergeCommit: MERGE } : {}),
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

describe('native delivery terminal authority', () => {
  const native = { workId: '01J5Z3K9QX8F0N2B4V6C8D1E4H' };
  it('immediate native complete handoff retains execution and emits the distinct final event', async () => {
    const f = await handedOff('none', 'claude', native, 'complete');
    const entries = await f.store.claimPendingOutbox({
      now: '2026-10-13T10:01:00.000Z',
      leaseExpiresAt: '2026-10-13T10:02:00.000Z',
      limit: 20,
    });
    expect(entries.map((entry) => entry.entryId)).toContain(
      `outcome/${f.runId}`,
    );
    expect(entries.map((entry) => entry.entryId)).toContain(
      `delivery-outcome/${f.runId}`,
    );
    expect(entries.some((entry) => entry.kind === 'monitor-delivery')).toBe(
      false,
    );
    expect(
      deriveItemState(
        (await f.store.readTask(native))!.task,
        await f.store.listRuns(native),
      ),
    ).toBe('done');
    expect((await f.store.readRun(f.runId))!.result).toMatchObject({
      ok: true,
      summary: 'pull-request',
    });
  });
  it.each([
    { kind: 'protected-merge' as const, head: HEAD, mergeCommit: MERGE },
    { kind: 'revision' as const, head: HEAD, newHead: MERGE },
    { kind: 'correction' as const, head: HEAD, reason: 'red checks' },
  ])(
    'closed native delivery rejects $kind without changing history',
    async (observation) => {
      const f = await handedOff('none', 'claude', native);
      const original = (await f.store.readRun(f.runId))!;
      const binding = (await f.store.readTask(native))!.task.delivery;
      expect(isRefusal(await f.orchestrator.close(native))).toBe(false);
      expect(
        await f.orchestrator.observeDelivery(f.runId, observation, () => true),
      ).toMatchObject({ refused: true, reason: 'task-closed' });
      expect(
        await f.orchestrator.request({
          taskId: native,
          requestId: 'after-close',
          pipeline: 'claude',
        }),
      ).toMatchObject({ refused: true, reason: 'task-closed' });
      expect((await f.store.readTask(native))!.task.delivery).toEqual(binding);
      expect((await f.store.readTask(native))!.task.runCount).toBe(1);
      expect((await f.store.readRun(f.runId))!.result).toEqual(original.result);
      const entries = await f.store.claimPendingOutbox({
        now: '2026-10-13T10:01:00.000Z',
        leaseExpiresAt: '2026-10-13T10:02:00.000Z',
        limit: 20,
      });
      expect(
        entries.some(
          (entry) => entry.entryId === `delivery-outcome/${f.runId}`,
        ),
      ).toBe(false);
      expect(
        entries.some((entry) => entry.entryId === `outcome/${f.runId}`),
      ).toBe(true);
    },
  );
  it('closed native delivery refuses a later runtime receipt for its protected merge', async () => {
    const f = await handedOff('required', 'claude', native);
    await f.orchestrator.observeDelivery(
      f.runId,
      { kind: 'protected-merge', head: HEAD, mergeCommit: MERGE },
      () => true,
    );
    const binding = (await f.store.readTask(native))!.task.delivery;
    expect(binding?.state).toBe('runtime-required');
    expect(isRefusal(await f.orchestrator.close(native))).toBe(false);
    expect(
      await f.orchestrator.observeDelivery(
        f.runId,
        {
          kind: 'runtime-evidence',
          head: HEAD,
          mergeCommit: MERGE,
          principal: 'user:operator',
          ref: 'https://example.test/proof',
        },
        () => true,
      ),
    ).toMatchObject({ refused: true, reason: 'task-closed' });
    expect((await f.store.readTask(native))!.task.delivery).toEqual(binding);
  });
});

describe('native item cancellation intent preserves run-only semantics', () => {
  const native = { workId: '01J5Z3K9QX8F0N2B4V6C8D1E4H' };
  async function activeRecovery(kind: 'correction' | 'reply') {
    const f = await handedOff('none', 'claude', native);
    const correction = await f.orchestrator.observeDelivery(
      f.runId,
      { kind: 'correction', head: HEAD, reason: 'review change' },
      () => true,
    );
    if (isRefusal(correction)) throw Error(correction.reason);
    let recovery = correction.additionalRuns![0]!;
    if (kind === 'reply') {
      const parked = await f.orchestrator.report(recovery.runId, {
        ok: true,
        summary: 'park',
      });
      if (isRefusal(parked)) throw Error(parked.reason);
      const reply = await f.orchestrator.request({
        taskId: native,
        requestId: 'human-reply',
        pipeline: 'claude',
        params: { mode: 'reply', replyPrincipal: 'user:operator' },
      });
      if (isRefusal(reply)) throw Error(reply.reason);
      recovery = decidedRun(reply);
    }
    return { ...f, recovery };
  }
  it.each(['correction', 'reply'] as const)(
    'native item cancellation closes owned %s delivery recovery atomically',
    async (kind) => {
      const f = await activeRecovery(kind);
      const before = (await f.store.readTask(native))!.task;
      const original = (await f.store.readRun(f.runId))!;
      const canceled = await f.orchestrator.cancel(
        f.recovery.runId,
        'item canceled',
        native,
      );
      if (isRefusal(canceled)) throw Error(canceled.reason);
      expect(canceled.task.closedAt).toBe(NOW);
      expect(canceled.task.activeRunId).toBeUndefined();
      expect(canceled.run?.state).toBe('canceled');
      expect(canceled.task.delivery).toEqual(before.delivery);
      expect(
        await f.orchestrator.observeDelivery(
          f.runId,
          { kind: 'protected-merge', head: HEAD, mergeCommit: MERGE },
          () => true,
        ),
      ).toMatchObject({ refused: true, reason: 'task-closed' });
      expect((await f.store.readRun(f.runId))!.result).toEqual(original.result);
      expect(
        deriveItemState(
          (await f.store.readTask(native))!.task,
          await f.store.listRuns(native),
        ),
      ).toBe('canceled');
      expect(canceled.outbox.map((entry) => entry.entryId)).toContain(
        `outcome/${f.recovery.runId}`,
      );
      expect(
        canceled.outbox.some((entry) =>
          entry.entryId.startsWith('delivery-outcome/'),
        ),
      ).toBe(false);
    },
  );
  it('direct run cancellation remains run-only during incomplete native delivery', async () => {
    const f = await activeRecovery('correction');
    const before = (await f.store.readTask(native))!.task.delivery;
    expect(
      isRefusal(await f.orchestrator.cancel(f.recovery.runId, 'run only')),
    ).toBe(false);
    expect((await f.store.readTask(native))!.task.closedAt).toBeUndefined();
    expect((await f.store.readTask(native))!.task.delivery).toEqual(before);
    expect((await f.store.readRun(f.recovery.runId))!.state).toBe('canceled');
  });
  it('native cancellation credential operation remains blocked by the existing reservation', async () => {
    const f = await handedOff('none', 'codex', native, 'waiting', false);
    const reservation = await f.store.transactRun({
      runId: f.runId,
      decide: ({ task, run }) => {
        if (task === undefined || run === undefined)
          throw Error('missing live run');
        return reserveCredentialOperation({
          now: NOW,
          task: task.task,
          run,
          id: 'native-cancel-operation',
          kind: 'persist',
          claimFingerprint: CLAIM,
        });
      },
    });
    expect(isRefusal(reservation)).toBe(false);
    expect((await f.store.readRun(f.runId))!.credentialOperation?.kind).toBe(
      'persist',
    );
    expect(
      await f.orchestrator.cancel(f.runId, 'item canceled', native),
    ).toMatchObject({ refused: true, reason: 'credential-operation-pending' });
    expect((await f.store.readTask(native))!.task.closedAt).toBeUndefined();
  });
  it('refuses native item intent bound to another item without canceling the owned run', async () => {
    const f = await activeRecovery('correction');
    expect(
      await f.orchestrator.cancel(f.recovery.runId, 'wrong item', {
        workId: '01J5Z3K9QX8F0N2B4V6C8D1E4J',
      }),
    ).toMatchObject({ refused: true, reason: 'task-busy' });
    expect((await f.store.readTask(native))!.task.activeRunId).toBe(
      f.recovery.runId,
    );
    expect((await f.store.readTask(native))!.task.closedAt).toBeUndefined();
  });
  it('refuses native item intent against a historical non-owning live run', async () => {
    const f = await activeRecovery('correction');
    const task = (await f.store.readTask(native))!.task;
    const run = (await f.store.readRun(f.recovery.runId))!;
    expect(
      cancelRun({
        now: NOW,
        task: { ...task, activeRunId: `work:${native.workId}/r999` },
        run,
        nativeTask: native,
      }),
    ).toMatchObject({ refused: true, reason: 'task-busy' });
    expect((await f.store.readTask(native))!.task.closedAt).toBeUndefined();
  });
});

it('bounds generated correction context while preserving delivery identity and dispatchability', async () => {
  const f = await handedOff();
  const original = await f.store.readRun(f.runId);
  const decision = await f.orchestrator.observeDelivery(
    f.runId,
    {
      kind: 'correction',
      head: HEAD,
      reason:
        'Required checks failed: ' + 'long-required-check-name,'.repeat(2000),
    },
    () => true,
  );
  if (isRefusal(decision)) throw new Error(decision.reason);
  const correction = decision.additionalRuns![0]!;
  const parsed = runSchema.parse(await f.store.readRun(correction.runId));
  expect(parsed.params?.context).toHaveLength(16_384);
  expect(parsed.params?.context).toMatch(
    /^Correct delivery https:\/\/github\.com\/octo\/example\/pull\/12 at /,
  );
  expect(parsed.params?.context).toContain(HEAD);
  expect(parsed.params?.deliveryPredecessor).toBe(f.runId);
  expect((await f.store.readTask(TASK))?.task.delivery?.correctionRunId).toBe(
    correction.runId,
  );
  expect((await f.store.readRun(f.runId))?.result).toEqual(original?.result);
  await f.store.enqueueRun({ runId: correction.runId, now: NOW });
  await f.orchestrator.confirmDispatch(correction.runId);
  const claimed = await f.store.claimQueuedRun({
    pipelines: ['claude'],
    now: NOW,
    claimedBy: 'correction-runner',
    tokenHash: CLAIM,
  });
  expect(claimed?.runId).toBe(correction.runId);
  expect(
    runSchema.parse(await f.store.readRun(correction.runId)).queue?.state,
  ).toBe('claimed');
});
