import type {
  AcceptedAttemptSpec,
  ActivationRecord,
  RuntimeObservationEnvelope,
} from '@agent-lcars/dispatch-contracts';
import { runtimeObservationPayloadSha256 } from '@agent-lcars/dispatch-contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  AuthorityConflict,
  InMemoryLifecycleAuthorityStorage,
  type TaskAuthorityScope,
} from './authority-storage';
import { admitAcceptedSpecForTest } from './authority-storage-test-support';
import { resolveLaunchForTest } from './launch-resolution-test-support';
import { RunBindingIngressVerifier } from './run-binding-ingress';
import {
  RunBindingIngressComposition,
  type RunBindingIngressCompositionInput,
} from './run-binding-ingress-composition';
import type { TaskLeaseRunner } from './signal-task-composition';

const TIME = '2026-08-16T00:00:00.000Z';
const SHA = 'a'.repeat(64);
const ATTEMPT_ID = 'A'.repeat(22);
const tenant = {
  tenantId: 'tenant-run-binding-composition',
  repositoryId: 123,
  repository: 'octo/repo',
  installationId: 456,
};
const task: TaskAuthorityScope = {
  tenantId: tenant.tenantId,
  repositoryId: tenant.repositoryId,
  issueNumber: 9,
};

function fixture(): {
  activation: ActivationRecord;
  spec: AcceptedAttemptSpec;
} {
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
  return {
    activation,
    spec: {
      schema: 'agent-lcars.attempt-spec/v1',
      version: 1,
      requestId: 'request-1',
      attemptId: ATTEMPT_ID,
      tenant,
      task,
      activation: {
        activationId: activation.activationId,
        taskClassId: activation.taskClassId,
        authorityEpoch: activation.authorityEpoch,
        mode: activation.mode,
      },
      local: {
        intentId: 'intent-1',
        generation: 1,
        attemptMarker: 'g1:intent-1',
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
        renewalDeadline: '2026-08-16T06:00:00.000Z',
      },
      authorization: {
        schema: 'agent-lcars.policy-decision/v1',
        version: 1,
        policy: { policyId: 'policy-1', policyVersion: 1, contentSha256: SHA },
        decision: 'accepted',
        ruleId: 'rule-1',
        sourceFactId: 'source-1',
        principal: { kind: 'system', systemId: 'system-1' },
        evidenceRef: 'evidence-1',
        decidedAt: TIME,
      },
    },
  };
}

async function makeEnvelope(
  spec: AcceptedAttemptSpec,
  overrides: Partial<RuntimeObservationEnvelope> = {},
): Promise<RuntimeObservationEnvelope> {
  const payload = {
    kind: 'run-bound' as const,
    binding: {
      runId: 10,
      runAttempt: 1,
      checkRunId: 11,
      workflowPath: spec.execution.workflowPath,
      workflowRef: spec.execution.workflowRef,
      workflowSha: spec.execution.workflowSha,
    },
  };
  return {
    schema: 'agent-lcars.runtime-observation/v1',
    version: 1,
    requestId: 'request-bound-1',
    factId: 'fact-bound-1',
    attemptId: spec.attemptId,
    tenant: spec.tenant,
    task: spec.task,
    source: { kind: 'github-provider', sourceId: 'github-1' },
    observedAt: TIME,
    payloadSha256: await runtimeObservationPayloadSha256(payload),
    payload,
    ...overrides,
  };
}

async function setup() {
  const storage = new InMemoryLifecycleAuthorityStorage({ now: () => TIME });
  const value = fixture();
  const admitted = await admitAcceptedSpecForTest({
    storage,
    activation: value.activation,
    spec: value.spec,
    ownerId: 'admission-owner',
  });
  await storage.releaseTaskLease(admitted.lease);

  let serial = Promise.resolve();
  const run = vi.fn<TaskLeaseRunner['run']>(async (scope, operation) => {
    const current = serial.then(async () => {
      const lease = await storage.acquireTaskLease({
        scope,
        ownerId: 'run-binding-composition',
        leaseDurationMs: 60_000,
      });
      try {
        return await operation(lease);
      } finally {
        await storage.releaseTaskLease(lease);
      }
    });
    serial = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  });
  const exactVerifier = vi.fn(async () => undefined);
  const verifier = new RunBindingIngressVerifier({
    verifyExactRunBinding: exactVerifier,
  });
  const composition = new RunBindingIngressComposition({
    storage,
    verifier,
    leases: { run },
  });
  const input: RunBindingIngressCompositionInput = {
    envelope: await makeEnvelope(admitted.spec),
    localAttemptMarker: admitted.spec.local.attemptMarker,
  };
  return {
    storage,
    spec: admitted.spec,
    composition,
    input,
    run,
    exactVerifier,
  };
}

describe('inactive run-binding ingress composition', () => {
  it('verifies, derives scope, binds, and exactly replays', async () => {
    const test = await setup();
    await expect(test.composition.ingest(test.input)).resolves.toBe('applied');
    await expect(test.composition.ingest(test.input)).resolves.toBe('replay');

    expect(test.run).toHaveBeenCalledTimes(2);
    expect(test.run.mock.calls[0]?.[0]).toEqual(task);
    expect(test.exactVerifier).toHaveBeenCalledTimes(2);
    expect(
      await test.storage.readAttempt({
        tenantId: tenant.tenantId,
        attemptId: test.spec.attemptId,
      }),
    ).toMatchObject({ phase: 'active', binding: { runId: 10 } });
    expect(
      await test.storage.readLaunch({
        tenantId: tenant.tenantId,
        attemptId: test.spec.attemptId,
      }),
    ).toMatchObject({ state: 'accepted' });
  });

  it('serializes concurrent identical ingress into one apply and one replay', async () => {
    const test = await setup();
    const results = await Promise.all([
      test.composition.ingest(test.input),
      test.composition.ingest(test.input),
    ]);
    expect(results.sort()).toEqual(['applied', 'replay']);
    expect(test.run).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: 'malformed envelope', envelope: { nope: true } },
    {
      name: 'wrong observation kind',
      envelope: { payload: { kind: 'not-run-bound' } },
    },
    {
      name: 'stale payload digest',
      envelope: { payloadSha256: 'b'.repeat(64) },
    },
  ])('$name acquires no lease', async ({ envelope }) => {
    const test = await setup();
    await expect(
      test.composition.ingest({
        envelope:
          envelope === undefined
            ? test.input.envelope
            : { ...test.input.envelope, ...envelope },
        localAttemptMarker: test.input.localAttemptMarker,
      }),
    ).rejects.toThrow();
    expect(test.run).not.toHaveBeenCalled();
  });

  it('rejects trusted verifier failure before acquiring a lease', async () => {
    const test = await setup();
    const verifier = new RunBindingIngressVerifier({
      verifyExactRunBinding: vi.fn(async () => {
        throw new Error('attestation rejected');
      }),
    });
    const composition = new RunBindingIngressComposition({
      storage: test.storage,
      verifier,
      leases: { run: test.run },
    });
    await expect(composition.ingest(test.input)).rejects.toThrow(
      'attestation rejected',
    );
    expect(test.run).not.toHaveBeenCalled();
  });

  it('rejects invalid markers and tenant/task mismatches before acquiring a lease', async () => {
    const test = await setup();
    await expect(
      test.composition.ingest({
        envelope: test.input.envelope,
        localAttemptMarker: 'not-a-local-marker',
      }),
    ).rejects.toThrow();
    await expect(
      test.composition.ingest({
        envelope: {
          ...(test.input.envelope as RuntimeObservationEnvelope),
          task: { ...task, repositoryId: task.repositoryId + 1 },
        },
        localAttemptMarker: test.input.localAttemptMarker,
      }),
    ).rejects.toThrow();
    expect(test.run).not.toHaveBeenCalled();
  });

  it('rejects a valid non-run-bound observation before acquiring a lease', async () => {
    const test = await setup();
    const payload = {
      kind: 'heartbeat' as const,
      grantId: 'grant-1',
      at: TIME,
      phase: 'bootstrap' as const,
    };
    const envelope = {
      ...(test.input.envelope as RuntimeObservationEnvelope),
      payload,
      payloadSha256: await runtimeObservationPayloadSha256(payload),
    };
    await expect(
      test.composition.ingest({
        envelope,
        localAttemptMarker: test.input.localAttemptMarker,
      }),
    ).rejects.toThrow();
    expect(test.run).not.toHaveBeenCalled();
  });

  it('fails closed for unknown attempts and marker mismatches, releasing leases', async () => {
    const test = await setup();
    const unknown = await makeEnvelope({
      ...test.spec,
      attemptId: 'B'.repeat(22),
    });
    await expect(
      test.composition.ingest({
        envelope: unknown,
        localAttemptMarker: test.input.localAttemptMarker,
      }),
    ).rejects.toThrow('Unknown tenant-scoped attempt');
    await expect(
      test.composition.ingest({
        envelope: test.input.envelope,
        localAttemptMarker: 'g1:wrong-intent',
      }),
    ).rejects.toThrow('Run-binding local marker does not match attempt');
    expect(test.run).toHaveBeenCalledTimes(2);
    await expect(
      test.storage.acquireTaskLease({
        scope: task,
        ownerId: 'after-failure',
        leaseDurationMs: 60_000,
      }),
    ).resolves.toMatchObject({ fence: 4 });
  });

  it('converges a dispatching launch and leaves exact binding authoritative', async () => {
    const test = await setup();
    const lease = await test.storage.acquireTaskLease({
      scope: task,
      ownerId: 'launch-state-test',
      leaseDurationMs: 60_000,
    });
    const claim = await test.storage.claimLaunchWork({
      lease,
      tenantId: tenant.tenantId,
      attemptId: test.spec.attemptId,
    });
    expect(claim.status).toBe('claimed');
    await test.storage.releaseTaskLease(lease);
    await expect(test.composition.ingest(test.input)).resolves.toBe('applied');
    expect(
      await test.storage.readLaunch({
        tenantId: tenant.tenantId,
        attemptId: test.spec.attemptId,
      }),
    ).toMatchObject({ state: 'accepted' });
    await expect(test.composition.ingest(test.input)).resolves.toBe('replay');
  });

  it('converges an unknown launch and leaves exact binding authoritative', async () => {
    const test = await setup();
    const lease = await test.storage.acquireTaskLease({
      scope: task,
      ownerId: 'launch-state-test',
      leaseDurationMs: 60_000,
    });
    const claim = await test.storage.claimLaunchWork({
      lease,
      tenantId: tenant.tenantId,
      attemptId: test.spec.attemptId,
    });
    expect(claim.status).toBe('claimed');
    await resolveLaunchForTest({
      storage: test.storage,
      lease,
      tenantId: tenant.tenantId,
      attemptId: test.spec.attemptId,
      kind: 'unknown',
      at: TIME,
      work: claim.work,
    });
    await test.storage.releaseTaskLease(lease);
    expect(
      await test.storage.readLaunch({
        tenantId: tenant.tenantId,
        attemptId: test.spec.attemptId,
      }),
    ).toMatchObject({ state: 'unknown' });
    await expect(test.composition.ingest(test.input)).resolves.toBe('applied');
    expect(
      await test.storage.readLaunch({
        tenantId: tenant.tenantId,
        attemptId: test.spec.attemptId,
      }),
    ).toMatchObject({ state: 'accepted' });
  });

  it('propagates lease conflicts without writing', async () => {
    const test = await setup();
    const held = await test.storage.acquireTaskLease({
      scope: task,
      ownerId: 'other-owner',
      leaseDurationMs: 60_000,
    });
    await expect(test.composition.ingest(test.input)).rejects.toBeInstanceOf(
      AuthorityConflict,
    );
    expect(
      await test.storage.readLaunch({
        tenantId: tenant.tenantId,
        attemptId: test.spec.attemptId,
      }),
    ).toMatchObject({ state: 'pending' });
    await test.storage.releaseTaskLease(held);
  });
});
