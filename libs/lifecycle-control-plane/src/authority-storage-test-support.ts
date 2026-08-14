import type {
  AcceptedAttemptSpec,
  ActivationRecord,
} from '@agent-lcars/dispatch-contracts';

import { mintAttemptAdmission } from './admission-capability';
import type {
  AdmissionResult,
  LifecycleAuthorityStorage,
  TaskAuthorityLease,
  WriteResult,
} from './authority-storage';
import type { TaskIntentState } from './task-intent-reducer';
import { hydrateTaskForTest } from './task-test-hydration';

/** Test-only compatibility setup; production cannot call a structural writer. */
export async function seedTaskForTest(
  storage: LifecycleAuthorityStorage,
  input: {
    lease: TaskAuthorityLease;
    expectedRevision: number;
    next: TaskIntentState;
  },
): Promise<WriteResult> {
  return hydrateTaskForTest(storage, input);
}

/**
 * Test-only fixture support for already-approved Attempt specs. This module is
 * intentionally absent from the package barrel; production code must use the
 * TaskAttemptAdmissionCoordinator and its server-owned plan resolver.
 */
export function desiredTaskStateForTest(
  spec: AcceptedAttemptSpec,
): TaskIntentState {
  const at = spec.authorization.decidedAt;
  return {
    schema: 'agent-lcars.task-intent-state/v1',
    version: 1,
    tenant: structuredClone(spec.tenant),
    task: structuredClone(spec.task),
    revision: spec.local.admissionRevision,
    activation: structuredClone(spec.activation),
    facts: [
      {
        factId: spec.authorization.sourceFactId,
        requestId: spec.requestId,
        sourceKey: `test:${spec.requestId}`,
        canonicalDigest: spec.authorization.policy.contentSha256,
        policyDecision: structuredClone(spec.authorization),
        resolution: {
          kind: 'desired',
          taskRevision: spec.local.admissionRevision,
          intentId: spec.local.intentId,
          intentRevision: spec.local.generation,
        },
        acceptedAt: at,
      },
    ],
    intents: [
      {
        schema: 'agent-lcars.intent/v1',
        version: 1,
        task: structuredClone(spec.task),
        intentId: spec.local.intentId,
        revision: spec.local.generation,
        status: 'desired',
        sourceFactId: spec.authorization.sourceFactId,
        policyDecision: structuredClone(spec.authorization),
        activation: structuredClone(spec.activation),
        createdAt: at,
        semanticKey: `test-${spec.local.intentId}`,
        semanticDigest: spec.authorization.policy.contentSha256,
        orderingKey: {
          occurredAt: at,
          tieBreaker: `test-${spec.local.intentId}`,
        },
      },
    ],
    desired: {
      task: structuredClone(spec.task),
      intentId: spec.local.intentId,
      intentRevision: spec.local.generation,
      selectedAt: at,
    },
    attempt: { kind: 'unlaunched', intentId: spec.local.intentId },
    updatedAt: at,
  };
}

export async function admitAcceptedSpecForTest(input: {
  storage: LifecycleAuthorityStorage;
  activation: ActivationRecord;
  spec: AcceptedAttemptSpec;
  ownerId?: string;
  leaseDurationMs?: number;
  lease?: TaskAuthorityLease;
}): Promise<{
  lease: TaskAuthorityLease;
  result: AdmissionResult;
  spec: AcceptedAttemptSpec;
}> {
  await input.storage.registerActivation(input.activation);
  const lease =
    input.lease ??
    (await input.storage.acquireTaskLease({
      scope: input.spec.task,
      ownerId: input.ownerId ?? 'test-owner',
      leaseDurationMs: input.leaseDurationMs ?? 60 * 60 * 1000,
    }));
  if ((await input.storage.readTask(input.spec.task)) === undefined) {
    const desired = desiredTaskStateForTest(input.spec);
    for (let revision = 1; revision <= desired.revision; revision += 1) {
      await seedTaskForTest(input.storage, {
        lease,
        expectedRevision: revision - 1,
        next: { ...structuredClone(desired), revision },
      });
    }
  }
  const result = await input.storage.admitVerifiedAttemptAndRecordLaunch({
    lease,
    admission: mintAttemptAdmission({
      tenant: input.spec.tenant,
      task: input.spec.task,
      expectedTaskRevision: input.spec.local.admissionRevision,
      intentId: input.spec.local.intentId,
      intentRevision: input.spec.local.generation,
      activation: input.spec.activation,
      execution: input.spec.execution,
    }),
  });
  if (result.attempt === undefined) {
    throw new Error('Test admission did not return its Attempt');
  }
  return { lease, result, spec: result.attempt.spec };
}
