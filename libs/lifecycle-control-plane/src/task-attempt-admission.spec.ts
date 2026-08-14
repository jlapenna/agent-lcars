import type { ActivationRecord } from '@agent-lcars/dispatch-contracts';
import { describe, expect, it, vi } from 'vitest';

import type { VerifiedAttemptAdmission } from './admission-capability';
import { mintAttemptAdmission } from './admission-capability';
import {
  type AttemptIdFactory,
  type AuthorityClock,
  AuthorityConflict,
  InMemoryLifecycleAuthorityStorage,
  type LifecycleAuthorityStorage,
  type TaskAuthorityScope,
} from './authority-storage';
import { seedTaskForTest } from './authority-storage-test-support';
import {
  type AdmissionPlanResolver,
  TaskAttemptAdmissionCoordinator,
} from './task-attempt-admission';
import type { TaskIntentState } from './task-intent-reducer';

const TIME = '2026-08-20T00:00:00.000Z';
const SHA = 'a'.repeat(64);
const tenant = {
  tenantId: 'tenant-1',
  repositoryId: 123,
  repository: 'octo/repo',
  installationId: 456,
};
const task = { tenantId: tenant.tenantId, repositoryId: 123, issueNumber: 9 };
const scope = task satisfies TaskAuthorityScope;
const activation: ActivationRecord = {
  schema: 'agent-lcars.control-plane-activation/v1',
  version: 1,
  tenant,
  taskClassId: 'github-issue',
  activationId: 'activation-1',
  authorityEpoch: 1,
  effectiveBoundary: 1,
  mode: 'central-authoritative',
  effectMode: 'enabled',
  recordedAt: TIME,
};

function state(): TaskIntentState {
  const decision = {
    schema: 'agent-lcars.policy-decision/v1' as const,
    version: 1 as const,
    policy: { policyId: 'policy-1', policyVersion: 1, contentSha256: SHA },
    decision: 'accepted' as const,
    ruleId: 'rule-1',
    sourceFactId: 'fact-1',
    principal: { kind: 'system' as const, systemId: 'scheduler-1' },
    evidenceRef: 'evidence-1',
    decidedAt: TIME,
  };
  return {
    schema: 'agent-lcars.task-intent-state/v1',
    version: 1,
    tenant,
    task,
    revision: 1,
    activation: {
      activationId: activation.activationId,
      taskClassId: activation.taskClassId,
      authorityEpoch: activation.authorityEpoch,
      mode: 'central-authoritative',
    },
    facts: [
      {
        factId: 'fact-1',
        requestId: 'request-1',
        sourceKey: 'scheduler:scheduler-1:scan-1',
        canonicalDigest: SHA,
        policyDecision: decision,
        resolution: {
          kind: 'desired',
          taskRevision: 1,
          intentId: 'intent-1',
          intentRevision: 1,
        },
        acceptedAt: TIME,
      },
    ],
    intents: [
      {
        schema: 'agent-lcars.intent/v1',
        version: 1,
        task,
        intentId: 'intent-1',
        revision: 1,
        status: 'desired',
        sourceFactId: 'fact-1',
        policyDecision: decision,
        activation: {
          activationId: activation.activationId,
          taskClassId: activation.taskClassId,
          authorityEpoch: activation.authorityEpoch,
          mode: 'central-authoritative',
        },
        createdAt: TIME,
        semanticKey: 'semantic-1',
        semanticDigest: SHA,
        orderingKey: { occurredAt: TIME, tieBreaker: 'tie-1' },
      },
    ],
    desired: {
      task,
      intentId: 'intent-1',
      intentRevision: 1,
      selectedAt: TIME,
    },
    attempt: { kind: 'unlaunched', intentId: 'intent-1' },
    updatedAt: TIME,
  };
}

const plan = {
  workflowPath: '.github/workflows/worker.yml',
  workflowRef: 'refs/heads/main',
  workflowSha: SHA,
  mode: 'implement' as const,
  executorId: 'executor-1',
  credentialProfileId: 'profile-1',
  renewalDeadline: '2026-08-20T01:00:00.000Z',
};

async function setup(resolver: AdmissionPlanResolver) {
  const storage = new InMemoryLifecycleAuthorityStorage({ now: () => TIME });
  await storage.registerActivation(activation);
  const lease = await storage.acquireTaskLease({
    scope,
    ownerId: 'owner-1',
    leaseDurationMs: 60_000,
  });
  await seedTaskForTest(storage, { lease, expectedRevision: 0, next: state() });
  return {
    storage,
    lease,
    coordinator: new TaskAttemptAdmissionCoordinator(storage, resolver),
  };
}

describe('TaskAttemptAdmissionCoordinator', () => {
  it('atomically advances the task, records an opaque attempt, and replays before resolver work', async () => {
    const resolver = { resolve: vi.fn(async () => plan) };
    const { coordinator, storage, lease } = await setup(resolver);
    const input = {
      lease,
      tenantId: tenant.tenantId,
      task,
      intentId: 'intent-1',
      intentRevision: 1,
    };
    const first = await coordinator.admit(input);
    const replay = await coordinator.admit(input);

    expect(first.replay).toBe(false);
    expect(first.task?.attempt).toMatchObject({
      kind: 'launched',
      intentId: 'intent-1',
    });
    expect(first.attempt?.phase).toBe('launch-pending');
    expect(first.launch.state).toBe('pending');
    expect(replay).toEqual(
      expect.objectContaining({ replay: true, attempt: first.attempt }),
    );
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(
      await storage.listLaunches({
        tenantId: tenant.tenantId,
        state: 'pending',
      }),
    ).toHaveLength(1);
  });

  it('rejects a malformed resolved execution plan without advancing task or outbox', async () => {
    const resolver: AdmissionPlanResolver = {
      resolve: async () =>
        ({ ...plan, workflowSha: 'not-a-sha' }) as typeof plan,
    };
    const { coordinator, storage, lease } = await setup(resolver);
    await expect(
      coordinator.admit({
        lease,
        tenantId: tenant.tenantId,
        task,
        intentId: 'intent-1',
        intentRevision: 1,
      }),
    ).rejects.toThrow('Resolved admission execution plan is invalid');
    expect((await storage.readTask(scope))?.attempt).toEqual({
      kind: 'unlaunched',
      intentId: 'intent-1',
    });
    expect(
      await storage.listLaunches({
        tenantId: tenant.tenantId,
        state: 'pending',
      }),
    ).toEqual([]);
  });
});

export interface TaskAttemptAdmissionContractClock extends AuthorityClock {
  set(value: string): void;
}

interface CountingAttemptIds extends AttemptIdFactory {
  calls: number;
}

function admissionCapability(
  taskState: TaskIntentState,
  execution = plan,
): VerifiedAttemptAdmission {
  const desired = taskState.desired;
  if (desired === undefined) throw new Error('Fixture has no desired intent');
  return mintAttemptAdmission({
    tenant: taskState.tenant,
    task: taskState.task,
    expectedTaskRevision: taskState.revision,
    intentId: desired.intentId,
    intentRevision: desired.intentRevision,
    activation: taskState.activation,
    execution,
  });
}

async function prepareAdmissionTask(input: {
  storage: LifecycleAuthorityStorage;
  activation: ActivationRecord;
  taskState: TaskIntentState;
  ownerId?: string;
  leaseDurationMs?: number;
}) {
  await input.storage.registerActivation(input.activation);
  const lease = await input.storage.acquireTaskLease({
    scope: input.taskState.task,
    ownerId: input.ownerId ?? 'owner-1',
    leaseDurationMs: input.leaseDurationMs ?? 60_000,
  });
  await seedTaskForTest(input.storage, {
    lease,
    expectedRevision: 0,
    next: input.taskState,
  });
  return lease;
}

function stateForTask(identity: typeof task): TaskIntentState {
  const value = state();
  return {
    ...value,
    task: identity,
    tenant: { ...value.tenant, tenantId: identity.tenantId },
    intents: value.intents.map((intent) => ({
      ...intent,
      task: identity,
    })),
    desired:
      value.desired === undefined
        ? undefined
        : { ...value.desired, task: identity },
  };
}

/** Every durable backend must pass this asynchronous admission transaction suite. */
export function runTaskAttemptAdmissionStorageContract(
  makeStorage: (
    clock: TaskAttemptAdmissionContractClock,
    attemptIds: AttemptIdFactory,
  ) => LifecycleAuthorityStorage | Promise<LifecycleAuthorityStorage>,
): void {
  const makeHarness = async (values = ['A'.repeat(22), 'B'.repeat(22)]) => {
    let current = TIME;
    const clock: TaskAttemptAdmissionContractClock = {
      now: () => current,
      set: (value) => {
        current = value;
      },
    };
    let index = 0;
    const attemptIds: CountingAttemptIds = {
      calls: 0,
      mint() {
        this.calls += 1;
        return values[Math.min(index++, values.length - 1)] as string;
      },
    };
    return {
      clock,
      attemptIds,
      storage: await makeStorage(clock, attemptIds),
    };
  };

  describe('Task Attempt admission storage contract', () => {
    it('rejects a structural capability without mutating task or launch state', async () => {
      const { storage } = await makeHarness();
      const taskState = state();
      const lease = await prepareAdmissionTask({
        storage,
        activation,
        taskState,
      });
      const forged = {
        tenant: taskState.tenant,
        task: taskState.task,
        expectedTaskRevision: 1,
        intentId: 'intent-1',
        intentRevision: 1,
        activation: taskState.activation,
        execution: plan,
      } as VerifiedAttemptAdmission;
      await expect(
        storage.admitVerifiedAttemptAndRecordLaunch({
          lease,
          admission: forged,
        }),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      expect((await storage.readTask(scope))?.attempt.kind).toBe('unlaunched');
      expect(
        await storage.listLaunches({
          tenantId: tenant.tenantId,
          state: 'pending',
        }),
      ).toEqual([]);
    });

    it('atomically admits once under concurrent exact calls and preserves every identity', async () => {
      const { storage, attemptIds } = await makeHarness();
      const taskState = state();
      const lease = await prepareAdmissionTask({
        storage,
        activation,
        taskState,
      });
      const calls = await Promise.all([
        storage.admitVerifiedAttemptAndRecordLaunch({
          lease,
          admission: admissionCapability(taskState),
        }),
        storage.admitVerifiedAttemptAndRecordLaunch({
          lease,
          admission: admissionCapability(taskState),
        }),
      ]);
      expect(calls.map((call) => call.replay).sort()).toEqual([false, true]);
      expect(attemptIds.calls).toBe(1);
      const applied = calls.find((call) => !call.replay);
      expect(applied?.task?.attempt).toMatchObject({
        kind: 'launched',
        attemptId: 'A'.repeat(22),
        intentId: 'intent-1',
        intentRevision: 1,
        admissionRevision: 1,
        admittedAt: TIME,
      });
      expect(applied?.attempt?.spec.local).toMatchObject({
        intentId: 'intent-1',
        generation: 1,
        attemptMarker: 'g1:intent-1',
        admissionRevision: 1,
      });
      expect(applied?.attempt?.spec.attemptId).toBe('A'.repeat(22));
      expect(applied?.launch).toMatchObject({
        attemptId: 'A'.repeat(22),
        operationId: 'A'.repeat(22),
        state: 'pending',
      });
    });

    it('replays the original snapshot after task advance without minting again', async () => {
      const { storage, attemptIds } = await makeHarness();
      const taskState = state();
      const lease = await prepareAdmissionTask({
        storage,
        activation,
        taskState,
      });
      const admission = admissionCapability(taskState);
      const first = await storage.admitVerifiedAttemptAndRecordLaunch({
        lease,
        admission,
      });
      const admittedTask = first.task;
      if (admittedTask === undefined) throw new Error('Admission omitted Task');
      await seedTaskForTest(storage, {
        lease,
        expectedRevision: 2,
        next: { ...admittedTask, revision: 3 },
      });
      const replay = await storage.admitVerifiedAttemptAndRecordLaunch({
        lease,
        admission: admissionCapability(taskState),
      });
      expect(replay).toMatchObject({ replay: true, attempt: first.attempt });
      expect(replay.task).toEqual(first.task);
      expect(attemptIds.calls).toBe(1);
    });

    it('rejects changed execution and expired or foreign leases without partial writes', async () => {
      const { storage, clock } = await makeHarness();
      const taskState = state();
      const lease = await prepareAdmissionTask({
        storage,
        activation,
        taskState,
        leaseDurationMs: 1_000,
      });
      await storage.admitVerifiedAttemptAndRecordLaunch({
        lease,
        admission: admissionCapability(taskState),
      });
      await expect(
        storage.admitVerifiedAttemptAndRecordLaunch({
          lease,
          admission: admissionCapability(taskState, {
            ...plan,
            credentialProfileId: 'profile-2',
          }),
        }),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      clock.set('2026-08-20T00:00:02.000Z');
      await expect(
        storage.readAttemptAdmission({
          lease,
          tenantId: tenant.tenantId,
          task,
          intentId: 'intent-1',
          intentRevision: 1,
        }),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      const otherTask = { ...task, issueNumber: 10 };
      const otherLease = await storage.acquireTaskLease({
        scope: otherTask,
        ownerId: 'owner-2',
        leaseDurationMs: 60_000,
      });
      await expect(
        storage.readAttemptAdmission({
          lease: otherLease,
          tenantId: tenant.tenantId,
          task,
          intentId: 'intent-1',
          intentRevision: 1,
        }),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      expect(
        await storage.listLaunches({
          tenantId: tenant.tenantId,
          state: 'pending',
        }),
      ).toHaveLength(1);
    });

    it('rejects shadow authority without creating an Attempt or launch', async () => {
      const { storage } = await makeHarness();
      const shadowActivation: ActivationRecord = {
        ...activation,
        activationId: 'shadow-1',
        mode: 'shadow',
        effectMode: 'none',
      };
      const shadowState = state();
      shadowState.activation = {
        activationId: shadowActivation.activationId,
        taskClassId: shadowActivation.taskClassId,
        authorityEpoch: shadowActivation.authorityEpoch,
        mode: 'shadow',
      };
      shadowState.intents[0] = {
        ...(shadowState.intents[0] as NonNullable<
          (typeof shadowState.intents)[number]
        >),
        activation: shadowState.activation,
      };
      const shadowLease = await prepareAdmissionTask({
        storage,
        activation: shadowActivation,
        taskState: shadowState,
      });
      await expect(
        storage.admitVerifiedAttemptAndRecordLaunch({
          lease: shadowLease,
          admission: admissionCapability(shadowState),
        }),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      expect((await storage.readTask(task))?.attempt.kind).toBe('unlaunched');
      expect(
        await storage.listLaunches({
          tenantId: tenant.tenantId,
          state: 'pending',
        }),
      ).toEqual([]);
    });

    it('rejects a global AttemptId collision atomically', async () => {
      const { storage } = await makeHarness(['A'.repeat(22)]);
      const firstState = state();
      const firstLease = await prepareAdmissionTask({
        storage,
        activation,
        taskState: firstState,
      });
      await storage.admitVerifiedAttemptAndRecordLaunch({
        lease: firstLease,
        admission: admissionCapability(firstState),
      });
      const secondTask = { ...task, issueNumber: 11 };
      const secondState = stateForTask(secondTask);
      const secondLease = await prepareAdmissionTask({
        storage,
        activation,
        taskState: secondState,
        ownerId: 'owner-3',
      });
      await expect(
        storage.admitVerifiedAttemptAndRecordLaunch({
          lease: secondLease,
          admission: admissionCapability(secondState),
        }),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      expect((await storage.readTask(secondTask))?.attempt.kind).toBe(
        'unlaunched',
      );
      expect(
        await storage.listLaunches({
          tenantId: tenant.tenantId,
          state: 'pending',
        }),
      ).toHaveLength(1);
    });
  });
}

runTaskAttemptAdmissionStorageContract(
  (clock, attemptIds) =>
    new InMemoryLifecycleAuthorityStorage(clock, attemptIds),
);
