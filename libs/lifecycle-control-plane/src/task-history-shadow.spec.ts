import type {
  AcceptedAttemptSpec,
  ActivationRecord,
  PolicyDecision,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it } from 'vitest';

import {
  type AuthorityClock,
  InMemoryLifecycleAuthorityStorage,
} from './authority-storage';
import {
  admitAcceptedSpecForTest,
  readTaskHistoryForTest,
  seedTaskForTest,
} from './authority-storage-test-support';
import { mintTaskEffectTransition } from './task-effect-capability';
import { runTaskHistoryShadowStorageContract } from './task-history-shadow.spec.support';
import { reduceTaskIntent } from './task-intent-reducer';

const T0 = '2026-08-21T00:00:00.000Z';
const SHA = 'a'.repeat(64);
const tenant = {
  tenantId: 'history-shadow',
  repositoryId: 901,
  repository: 'octo/history-shadow',
  installationId: 902,
};
const task = { tenantId: tenant.tenantId, repositoryId: 901, issueNumber: 1 };

class Clock implements AuthorityClock {
  now(): string {
    return T0;
  }
}

const active: ActivationRecord = {
  schema: 'agent-lcars.control-plane-activation/v1',
  version: 1,
  tenant,
  taskClassId: 'github-issue',
  activationId: 'history-central',
  authorityEpoch: 1,
  effectiveBoundary: 1,
  mode: 'central-authoritative',
  effectMode: 'enabled',
  recordedAt: T0,
};

function command(
  clock: Clock,
  factId: string,
  expectedRevision: number,
  activation: ActivationRecord = active,
  taskOverride = task,
  decision: PolicyDecision['decision'] = 'accepted',
) {
  const envelope = {
    schema: 'agent-lcars.control-plane-signal/v1' as const,
    version: 1 as const,
    requestId: `request-${factId}`,
    factId,
    tenant,
    task: taskOverride,
    signal: {
      kind: 'requested-work' as const,
      mode: 'implement' as const,
      requestKey: `key-${factId}`,
    },
    receivedAt: T0,
    source: {
      kind: 'github-webhook' as const,
      deliveryId: `delivery-${factId}`,
      repositoryId: tenant.repositoryId,
      installationId: tenant.installationId,
      bodySha256: SHA,
      event: 'issues' as const,
      action: 'labeled' as const,
      actorId: 8,
      actorLogin: 'octo',
      occurredAt: T0,
      hmacKeyVersion: 'key-v1',
    },
  };
  const policy: PolicyDecision = {
    schema: 'agent-lcars.policy-decision/v1',
    version: 1,
    policy: {
      policyId: 'history-policy',
      policyVersion: 1,
      contentSha256: SHA,
    },
    decision,
    ruleId: 'maintainer',
    sourceFactId: factId,
    principal: { kind: 'github-actor', actorId: 8, login: 'octo' },
    evidenceRef: `evidence-${factId}`,
    decidedAt: T0,
  };
  return mintTaskEffectTransition(
    {
      expectedRevision,
      envelope,
      policyDecision: policy,
      activation,
      candidate: {
        intentId: `intent-${factId}`,
        semanticKey: `semantic-${factId}`,
        semanticDigest: SHA,
        orderingKey: { occurredAt: T0, tieBreaker: `tie-${factId}` },
      },
    },
    clock,
  );
}

function admissionSpec(): AcceptedAttemptSpec {
  return {
    schema: 'agent-lcars.attempt-spec/v1',
    version: 1,
    requestId: 'request-admit-1',
    attemptId: 'A'.repeat(22),
    tenant,
    task,
    activation: {
      activationId: active.activationId,
      taskClassId: active.taskClassId,
      authorityEpoch: active.authorityEpoch,
      mode: 'central-authoritative',
    },
    local: {
      intentId: 'intent-admit-1',
      generation: 1,
      attemptMarker: 'g1:intent-admit-1',
      admissionRevision: 1,
      idempotencyKey: 'admit-1',
    },
    execution: {
      workflowPath: '.github/workflows/worker.yml',
      workflowRef: 'refs/heads/main',
      workflowSha: 'c'.repeat(40),
      mode: 'implement',
      executorId: 'executor-1',
      credentialProfileId: 'profile-1',
      renewalDeadline: '2026-08-21T06:00:00.000Z',
    },
    authorization: {
      schema: 'agent-lcars.policy-decision/v1',
      version: 1,
      policy: {
        policyId: 'history-policy',
        policyVersion: 1,
        contentSha256: SHA,
      },
      decision: 'accepted',
      ruleId: 'maintainer',
      sourceFactId: 'admit-1',
      principal: { kind: 'github-actor', actorId: 8, login: 'octo' },
      evidenceRef: 'evidence-admit-1',
      decidedAt: T0,
    },
  };
}

async function storageFixture() {
  const clock = new Clock();
  const storage = new InMemoryLifecycleAuthorityStorage(clock);
  await storage.registerActivation(active);
  const lease = await storage.acquireTaskLease({
    scope: task,
    ownerId: 'history-test',
    leaseDurationMs: 60_000,
  });
  return { clock, storage, lease };
}

describe('Task history shadow storage', () => {
  it('records bounded fact/intent and output references and replays after advance', async () => {
    const { clock, storage, lease } = await storageFixture();
    const first = command(clock, 'fact-1', 0);
    await storage.applyTaskEffectTransition({ lease, transition: first });
    const second = command(clock, 'fact-2', 1);
    await storage.applyTaskEffectTransition({ lease, transition: second });
    await expect(
      storage.applyTaskEffectTransition({ lease, transition: first }),
    ).resolves.toMatchObject({ status: 'replay', task: { revision: 1 } });
    const history = await readTaskHistoryForTest(storage, {
      lease,
      tenantId: tenant.tenantId,
      task,
    });
    expect(history?.head).toMatchObject({
      aggregateRevision: 2,
      factHead: { count: 2 },
      intentHead: { count: 3 },
    });
    expect(history?.factRecords).toHaveLength(2);
    expect(history?.intentRecords).toHaveLength(3);
    expect(history?.effectRecords).toHaveLength(2);
    expect(history?.workRecords).toHaveLength(0);
    expect(history?.presentationRecords).toHaveLength(0);
    expect(history?.replayReceipts).toHaveLength(2);
    expect('writeTaskHistory' in storage).toBe(false);
  });

  it('upgrades a legacy Task on first history write and fails closed when the mirror is missing', async () => {
    const { clock, storage, lease } = await storageFixture();
    const first = command(clock, 'legacy-1', 0);
    const reduced = reduceTaskIntent(undefined, first.input);
    if (reduced.status !== 'applied') throw new Error('missing reduced state');
    await seedTaskForTest(storage, {
      lease,
      expectedRevision: 0,
      next: reduced.state,
    });
    await storage.applyTaskEffectTransition({
      lease,
      transition: command(clock, 'legacy-2', 1),
    });
    const upgraded = await readTaskHistoryForTest(storage, {
      lease,
      tenantId: tenant.tenantId,
      task,
    });
    expect(upgraded?.head.aggregateRevision).toBe(2);
    (
      storage as unknown as { taskHistories: Map<string, unknown> }
    ).taskHistories.clear();
    await expect(
      storage.applyTaskEffectTransition({
        lease,
        transition: command(clock, 'legacy-2', 1),
      }),
    ).rejects.toThrow('history');
  });

  it('fails closed on a corrupt head and rolls back when the history commit fails', async () => {
    const { clock, storage, lease } = await storageFixture();
    const first = command(clock, 'integrity-1', 0);
    const second = command(clock, 'integrity-2', 1);
    await storage.applyTaskEffectTransition({ lease, transition: first });
    const histories = (
      storage as unknown as {
        taskHistories: Map<string, { head: { aggregateRevision: number } }>;
      }
    ).taskHistories;
    const history = histories.values().next().value;
    if (history === undefined)
      throw new Error('missing private history fixture');
    history.head.aggregateRevision = 99;
    await expect(
      storage.applyTaskEffectTransition({ lease, transition: second }),
    ).rejects.toThrow('history');

    const cleanStorage = await storageFixture();
    await cleanStorage.storage.applyTaskEffectTransition({
      lease: cleanStorage.lease,
      transition: first,
    });
    const taskBefore = await cleanStorage.storage.readTask(task);
    const cleanHistories = (
      cleanStorage.storage as unknown as {
        taskHistories: Map<string, unknown>;
      }
    ).taskHistories;
    const originalSet = cleanHistories.set;
    cleanHistories.set = (() => {
      throw new Error('injected history commit failure');
    }) as typeof originalSet;
    await expect(
      cleanStorage.storage.applyTaskEffectTransition({
        lease: cleanStorage.lease,
        transition: second,
      }),
    ).rejects.toThrow('injected history commit failure');
    cleanHistories.set = originalSet;
    expect(await cleanStorage.storage.readTask(task)).toEqual(taskBefore);
    expect(
      await cleanStorage.storage.listTaskEffects({
        tenantId: tenant.tenantId,
        task,
      }),
    ).toHaveLength(1);
  });

  it('keeps shadow transitions effect-free while still recording the reducer decision', async () => {
    const { clock, storage } = await storageFixture();
    const shadow = {
      ...active,
      activationId: 'history-shadow',
      authorityEpoch: 2,
      mode: 'shadow' as const,
      effectMode: 'none' as const,
    };
    await storage.registerActivation(shadow);
    const shadowTask = { ...task, issueNumber: 2 };
    const shadowLease = await storage.acquireTaskLease({
      scope: shadowTask,
      ownerId: 'shadow-test',
      leaseDurationMs: 60_000,
    });
    const transition = command(clock, 'shadow-1', 0, shadow, shadowTask);
    const result = await storage.applyTaskEffectTransition({
      lease: shadowLease,
      transition,
    });
    expect(result.effects).toEqual([]);
    const history = await readTaskHistoryForTest(storage, {
      lease: shadowLease,
      tenantId: tenant.tenantId,
      task: shadowTask,
    });
    expect(history?.head.aggregateRevision).toBe(1);
    expect(history?.effectRecords).toEqual([]);
  });

  it('binds presentation refs to exact parked output records', async () => {
    const { clock, storage, lease } = await storageFixture();
    const parked = command(clock, 'parked-1', 0, active, task, 'rejected');
    const applied = await storage.applyTaskEffectTransition({
      lease,
      transition: parked,
    });
    expect(applied.plans).toHaveLength(1);
    const history = await readTaskHistoryForTest(storage, {
      lease,
      tenantId: tenant.tenantId,
      task,
    });
    expect(history?.presentationRecords).toHaveLength(1);
    expect(history?.replayReceipts[0]?.emittedPresentationRefs).toHaveLength(1);
    await expect(
      storage.applyTaskEffectTransition({ lease, transition: parked }),
    ).resolves.toMatchObject({ status: 'replay' });
  });

  it('keeps admission head sync across original replay and later Task advancement', async () => {
    const { clock, storage, lease } = await storageFixture();
    const first = command(clock, 'admit-1', 0);
    await storage.applyTaskEffectTransition({ lease, transition: first });
    const spec = admissionSpec();
    const admission = await admitAcceptedSpecForTest({
      storage,
      activation: active,
      spec,
      lease,
    });
    expect(admission.result.replay).toBe(false);
    await expect(
      storage.applyTaskEffectTransition({ lease, transition: first }),
    ).resolves.toMatchObject({ status: 'replay', task: { revision: 1 } });
    await storage.applyTaskEffectTransition({
      lease,
      transition: command(clock, 'admit-2', 2),
    });
    await expect(
      admitAcceptedSpecForTest({
        storage,
        activation: active,
        spec,
        lease,
      }),
    ).resolves.toMatchObject({ result: { replay: true } });
    const history = await readTaskHistoryForTest(storage, {
      lease,
      tenantId: tenant.tenantId,
      task,
    });
    expect(history?.head).toMatchObject({
      aggregateRevision: 3,
      attempt: {
        kind: 'launched',
        attemptId: admission.result.attempt?.spec.attemptId,
      },
    });
  });

  it('keeps each replay receipt bounded across a long legacy-authoritative stream', async () => {
    const { clock, storage, lease } = await storageFixture();
    for (let revision = 0; revision < 110; revision += 1) {
      await storage.applyTaskEffectTransition({
        lease,
        transition: command(clock, `bulk-${revision}`, revision),
      });
    }
    const history = await readTaskHistoryForTest(storage, {
      lease,
      tenantId: tenant.tenantId,
      task,
    });
    expect(history?.replayReceipts).toHaveLength(110);
    for (const receipt of history?.replayReceipts ?? []) {
      expect(receipt.responseRecordRefs?.length).toBeLessThanOrEqual(3);
      expect(JSON.stringify(receipt).length).toBeLessThan(128 * 1024);
    }
  }, 30_000);
});

runTaskHistoryShadowStorageContract({
  create: async (clock) => new InMemoryLifecycleAuthorityStorage(clock),
  read: readTaskHistoryForTest,
  hydrateLegacyTask: async ({ storage, lease, expectedRevision, state }) => {
    await seedTaskForTest(storage, { lease, expectedRevision, next: state });
  },
  corruptHead: (storage) => {
    const histories = (
      storage as unknown as {
        taskHistories: Map<string, { head: { aggregateRevision: number } }>;
      }
    ).taskHistories;
    const history = histories.values().next().value;
    if (history === undefined)
      throw new Error('missing private history fixture');
    history.head.aggregateRevision = 99;
  },
  deleteAuxHead: (storage, stream) => {
    const histories = (
      storage as unknown as {
        taskHistories: Map<
          string,
          {
            auxHeads: Map<'effect' | 'command' | 'presentation', unknown>;
          }
        >;
      }
    ).taskHistories;
    const history = histories.values().next().value;
    if (history === undefined)
      throw new Error('missing private history fixture');
    history.auxHeads.delete(stream);
  },
  failHistoryCommit: (storage) => {
    const histories = (
      storage as unknown as { taskHistories: Map<string, unknown> }
    ).taskHistories;
    const originalSet = histories.set;
    histories.set = (() => {
      throw new Error('injected history commit failure');
    }) as typeof originalSet;
    return () => {
      histories.set = originalSet;
    };
  },
});
