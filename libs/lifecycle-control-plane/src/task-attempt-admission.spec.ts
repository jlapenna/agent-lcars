import type { ActivationRecord } from '@agent-lcars/dispatch-contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  InMemoryLifecycleAuthorityStorage,
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
  workflowSha: 'c'.repeat(40),
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

import { runTaskAttemptAdmissionStorageContract } from './task-attempt-admission.spec.support';

runTaskAttemptAdmissionStorageContract(
  (clock, attemptIds) =>
    new InMemoryLifecycleAuthorityStorage(clock, attemptIds),
);
