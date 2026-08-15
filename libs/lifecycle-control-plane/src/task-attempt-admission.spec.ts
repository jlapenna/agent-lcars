import {
  type ActivationRecord,
  runtimeObservationPayloadSha256,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it, vi } from 'vitest';

import { readAttemptHistoryForTest } from './attempt-history-test-support';
import {
  InMemoryLifecycleAuthorityStorage,
  type TaskAuthorityScope,
} from './authority-storage';
import {
  readTaskHistoryForTest,
  seedTaskForTest,
} from './authority-storage-test-support';
import {
  ingestVerifiedRunBinding,
  RunBindingIngressVerifier,
} from './launch-binding';
import { LaunchResponseBoundary } from './launch-resolution-capability';
import {
  type AdmissionPlanResolver,
  TaskAttemptAdmissionCoordinator,
} from './task-attempt-admission';
import {
  type AttemptAdmissionHistoryStorageHooks,
  runTaskAttemptAdmissionStorageContract,
} from './task-attempt-admission.spec.support';
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

  it('replays the admission receipt after launch progress without requiring mutable Attempt parity', async () => {
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
    if (first.attempt === undefined) throw new Error('missing Attempt');
    const claimed = await storage.claimLaunchWork({
      lease,
      tenantId: tenant.tenantId,
      attemptId: first.attempt.spec.attemptId,
    });
    if (claimed.work === undefined) throw new Error('missing launch work');
    const resolution = await new LaunchResponseBoundary(
      {
        resolve: async () => ({
          kind: 'accepted' as const,
          responseSha256: SHA,
        }),
      },
      { now: () => TIME },
    ).resolve(claimed.work);
    await storage.resolveVerifiedLaunch({ lease, resolution });
    const binding = {
      runId: 10,
      runAttempt: 1,
      checkRunId: 11,
      workflowPath: plan.workflowPath,
      workflowRef: plan.workflowRef,
      workflowSha: plan.workflowSha,
    };
    const bindingEnvelope = {
      schema: 'agent-lcars.runtime-observation/v1' as const,
      version: 1 as const,
      requestId: 'binding-request-1',
      factId: 'binding-fact-1',
      attemptId: first.attempt.spec.attemptId,
      tenant: first.attempt.spec.tenant,
      task: first.attempt.spec.task,
      source: { kind: 'github-provider' as const, sourceId: 'provider-1' },
      observedAt: TIME,
      payload: { kind: 'run-bound' as const, binding },
      payloadSha256: await runtimeObservationPayloadSha256({
        kind: 'run-bound' as const,
        binding,
      }),
    };
    const verifiedBinding = await new RunBindingIngressVerifier({
      verifyExactRunBinding: async () => undefined,
    }).verify({
      envelope: bindingEnvelope,
      localAttemptMarker: first.attempt.spec.local.attemptMarker,
    });
    await ingestVerifiedRunBinding(storage, lease, verifiedBinding);
    const replay = await coordinator.admit(input);
    expect(replay.replay).toBe(true);
    expect(replay.attempt).toMatchObject({
      revision: 3,
      phase: 'active',
      binding,
    });
    expect(replay.launch).toMatchObject({
      attemptId: first.attempt.spec.attemptId,
      state: 'accepted',
    });
  });
});

const historyHooks: AttemptAdmissionHistoryStorageHooks = {
  readAttemptHistory: readAttemptHistoryForTest,
  readTaskHistory: readTaskHistoryForTest,
  corruptAttemptHistory: (storage) => {
    const histories = (
      storage as unknown as {
        attemptHistories: Map<string, { head: { aggregateRevision: number } }>;
      }
    ).attemptHistories;
    const history = histories.values().next().value;
    if (history === undefined) throw new Error('missing Attempt history');
    history.head.aggregateRevision = 99;
  },
  corruptAttemptHistoryLaunch: (storage, kind) => {
    const histories = (
      storage as unknown as {
        attemptHistories: Map<
          string,
          {
            head: {
              attemptId: string;
              launch: { operationId: string; executionEpoch: number };
            };
          }
        >;
      }
    ).attemptHistories;
    const history = histories.values().next().value;
    if (history === undefined) throw new Error('missing Attempt history');
    if (kind === 'operation') history.head.launch.operationId = 'B'.repeat(22);
    else history.head.launch.executionEpoch = 2;
  },
  corruptLaunch: (storage, kind) => {
    const launches = (
      storage as unknown as {
        launches: Map<string, { repositoryId: number; executionEpoch: number }>;
      }
    ).launches;
    const launch = launches.values().next().value;
    if (launch === undefined) throw new Error('missing launch');
    if (kind === 'repository') launch.repositoryId = 999;
    else launch.executionEpoch = 2;
  },
  corruptAcceptanceSpecDigest: (storage) => {
    const acceptances = (
      storage as unknown as {
        acceptances: Map<string, { specDigest: string }>;
      }
    ).acceptances;
    const acceptance = acceptances.values().next().value;
    if (acceptance === undefined) throw new Error('missing acceptance');
    acceptance.specDigest = 'b'.repeat(64);
  },
  corruptAcceptanceTaskSnapshot: (storage) => {
    const acceptances = (
      storage as unknown as {
        acceptances: Map<string, { task: { updatedAt: string } }>;
      }
    ).acceptances;
    const acceptance = acceptances.values().next().value;
    if (acceptance === undefined) throw new Error('missing acceptance');
    acceptance.task.updatedAt = '2026-08-20T00:00:01.000Z';
  },
  corruptTaskAdmissionHistory: (storage) => {
    const histories = (
      storage as unknown as {
        taskHistories: Map<
          string,
          { workRecords: Array<{ payload: { inputDigest: string } }> }
        >;
      }
    ).taskHistories;
    const history = histories.values().next().value;
    const record = history?.workRecords[0];
    if (record === undefined) throw new Error('missing Task admission history');
    record.payload.inputDigest = 'b'.repeat(64);
  },
  failAttemptHistoryCommit: (storage) => {
    const histories = (
      storage as unknown as { attemptHistories: Map<string, unknown> }
    ).attemptHistories;
    const originalSet = histories.set;
    histories.set = (() => {
      throw new Error('injected Attempt history commit failure');
    }) as typeof originalSet;
    return () => {
      histories.set = originalSet;
    };
  },
};

runTaskAttemptAdmissionStorageContract(
  (clock, attemptIds) =>
    new InMemoryLifecycleAuthorityStorage(clock, attemptIds),
  historyHooks,
);
