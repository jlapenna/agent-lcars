import { createHash } from 'node:crypto';

import {
  type AcceptedAttemptSpec,
  type ActivationRecord,
  runtimeObservationPayloadSha256,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  type AuthorityClock,
  AuthorityConflict,
  InMemoryLifecycleAuthorityStorage,
  type TaskAuthorityLease,
  type TaskAuthorityScope,
} from './authority-storage';
import { admitAcceptedSpecForTest } from './authority-storage-test-support';
import {
  ingestVerifiedRunBinding,
  RunBindingIngressVerifier,
} from './launch-binding';
import {
  LaunchOutboxComposition,
  LaunchOutboxCompositionConflict,
  type LaunchOutboxCompositionInput,
} from './launch-outbox-composition';
import { LaunchResponseBoundary } from './launch-resolution-capability';

const T0 = '2026-08-22T00:00:00.000Z';
const T1 = '2026-08-22T01:00:00.000Z';
const SHA = 'a'.repeat(64);
const tenant = {
  tenantId: 'tenant-launch-composition',
  repositoryId: 818,
  repository: 'octo/launch-composition',
  installationId: 919,
};
const task: TaskAuthorityScope = {
  tenantId: tenant.tenantId,
  repositoryId: tenant.repositoryId,
  issueNumber: 6,
};

class Clock implements AuthorityClock {
  constructor(private value = T0) {}
  now(): string {
    return this.value;
  }
  set(value: string): void {
    this.value = value;
  }
}

function fixture(): {
  activation: ActivationRecord;
  spec: AcceptedAttemptSpec;
} {
  const activation: ActivationRecord = {
    schema: 'agent-lcars.control-plane-activation/v1',
    version: 1,
    tenant,
    taskClassId: 'github-issue',
    activationId: 'central-1',
    authorityEpoch: 1,
    effectiveBoundary: 1,
    mode: 'central-authoritative',
    effectMode: 'enabled',
    recordedAt: T0,
  };
  return {
    activation,
    spec: {
      schema: 'agent-lcars.attempt-spec/v1',
      version: 1,
      requestId: 'request-1',
      attemptId: 'A'.repeat(22),
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
        renewalDeadline: '2026-08-22T06:00:00.000Z',
      },
      authorization: {
        schema: 'agent-lcars.policy-decision/v1',
        version: 1,
        policy: { policyId: 'policy-1', policyVersion: 1, contentSha256: SHA },
        decision: 'accepted',
        ruleId: 'rule-1',
        sourceFactId: 'fact-1',
        principal: { kind: 'system', systemId: 'system-1' },
        evidenceRef: 'evidence-1',
        decidedAt: T0,
      },
    },
  };
}

async function setup() {
  const clock = new Clock();
  const storage = new InMemoryLifecycleAuthorityStorage(clock, {
    mint: () => 'A'.repeat(22),
  });
  const value = fixture();
  const admitted = await admitAcceptedSpecForTest({
    storage,
    activation: value.activation,
    spec: value.spec,
  });
  await storage.releaseTaskLease(admitted.lease);
  let serial = Promise.resolve();
  const run = vi.fn(
    async <T>(
      scope: TaskAuthorityScope,
      operation: (lease: TaskAuthorityLease) => Promise<T>,
    ): Promise<T> => {
      const current = serial.then(async () => {
        const lease = await storage.acquireTaskLease({
          scope,
          ownerId: 'launch-composition',
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
    },
  );
  const verifier = {
    resolve: vi.fn(async () => ({
      kind: 'accepted' as const,
      responseSha256: digest('accepted'),
    })),
  };
  const composition = new LaunchOutboxComposition({
    storage,
    responses: new LaunchResponseBoundary(verifier, clock),
    leases: { run },
    clock,
  });
  return {
    clock,
    storage,
    activation: value.activation,
    spec: admitted.spec,
    composition,
    verifier,
    run,
    attemptId: admitted.spec.attemptId,
    input: {
      tenantId: tenant.tenantId,
      task,
      attemptId: admitted.spec.attemptId,
    } satisfies LaunchOutboxCompositionInput,
  };
}

async function binding(spec: AcceptedAttemptSpec) {
  const payload = {
    kind: 'run-bound' as const,
    binding: {
      runId: 70,
      runAttempt: 1,
      checkRunId: 71,
      workflowPath: spec.execution.workflowPath,
      workflowRef: spec.execution.workflowRef,
      workflowSha: spec.execution.workflowSha,
    },
  };
  return new RunBindingIngressVerifier({
    async verifyExactRunBinding() {
      // The test verifier accepts this schema-checked exact binding.
    },
  }).verify({
    localAttemptMarker: spec.local.attemptMarker,
    envelope: {
      schema: 'agent-lcars.runtime-observation/v1',
      version: 1,
      requestId: 'request-bound',
      factId: 'fact-bound',
      attemptId: spec.attemptId,
      tenant: spec.tenant,
      task: spec.task,
      source: { kind: 'github-provider', sourceId: 'provider' },
      observedAt: T0,
      payloadSha256: await runtimeObservationPayloadSha256(payload),
      payload,
    },
  });
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('inactive launch-outbox composition', () => {
  it('claims and atomically accepts a pending launch, then safely replays', async () => {
    const test = await setup();
    const first = await test.composition.reconcile(test.input);
    const replay = await test.composition.reconcile(test.input);

    expect(first).toMatchObject({
      status: 'resolved',
      launch: { state: 'accepted' },
      write: 'applied',
    });
    expect(replay).toMatchObject({
      status: 'terminal',
      launch: { state: 'accepted' },
    });
    expect(test.verifier.resolve).toHaveBeenCalledOnce();
    expect(test.run).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(first)).not.toContain('claimToken');
    expect(JSON.stringify(first)).not.toContain('claimedFence');
    expect(
      await test.storage.readLaunch({
        tenantId: tenant.tenantId,
        attemptId: test.attemptId,
      }),
    ).toMatchObject({ state: 'accepted' });
    expect(
      await test.storage.readAttempt({
        tenantId: tenant.tenantId,
        attemptId: test.attemptId,
      }),
    ).toMatchObject({
      phase: 'launch-accepted',
      launch: { state: 'accepted' },
    });
  });

  it('converges a failed fresh response to unknown at the next lease fence', async () => {
    const test = await setup();
    test.verifier.resolve.mockRejectedValueOnce(new Error('response lost'));
    await expect(test.composition.reconcile(test.input)).rejects.toThrow(
      'response lost',
    );
    expect(test.verifier.resolve).toHaveBeenCalledOnce();
    expect(
      await test.storage.readLaunch({
        tenantId: tenant.tenantId,
        attemptId: test.attemptId,
      }),
    ).toMatchObject({ state: 'dispatching' });
    test.clock.set(T1);

    const recovered = await test.composition.reconcile(test.input);
    expect(recovered).toMatchObject({
      status: 'resolved',
      launch: { state: 'unknown' },
      write: 'applied',
    });
    expect(test.verifier.resolve).toHaveBeenCalledOnce();
  });

  it('serializes identical concurrent reconciliation into one provider call and one replay', async () => {
    const test = await setup();
    const [first, second] = await Promise.all([
      test.composition.reconcile(test.input),
      test.composition.reconcile(test.input),
    ]);
    expect([first.status, second.status].sort()).toEqual([
      'resolved',
      'terminal',
    ]);
    expect(test.verifier.resolve).toHaveBeenCalledOnce();
  });

  it.each(['accepted', 'unknown'] as const)(
    'does not call the response verifier for %s terminal launches',
    async (kind) => {
      const test = await setup();
      test.verifier.resolve.mockResolvedValueOnce({
        kind,
        responseSha256: digest(kind),
      });
      await test.composition.reconcile(test.input);
      const calls = test.verifier.resolve.mock.calls.length;
      expect(await test.composition.reconcile(test.input)).toMatchObject({
        status: 'terminal',
      });
      expect(test.verifier.resolve).toHaveBeenCalledTimes(calls);
    },
  );

  it('recovers centrally pinned work after prospective shadow registration', async () => {
    const test = await setup();
    await test.storage.registerActivation({
      ...test.activation,
      activationId: 'shadow-2',
      authorityEpoch: 2,
      effectiveBoundary: 2,
      mode: 'shadow',
      effectMode: 'none',
      recordedAt: T1,
    });

    expect(await test.composition.reconcile(test.input)).toMatchObject({
      status: 'resolved',
      launch: { state: 'accepted' },
    });
    expect(test.verifier.resolve).toHaveBeenCalledOnce();
  });

  it('does not invoke the verifier when binding already made the launch terminal', async () => {
    const test = await setup();
    const lease = await test.storage.acquireTaskLease({
      scope: task,
      ownerId: 'binding-before-composition',
      leaseDurationMs: 60_000,
    });
    await ingestVerifiedRunBinding(
      test.storage,
      lease,
      await binding(test.spec),
    );
    await test.storage.releaseTaskLease(lease);

    expect(await test.composition.reconcile(test.input)).toMatchObject({
      status: 'terminal',
      launch: { state: 'accepted' },
    });
    expect(test.verifier.resolve).not.toHaveBeenCalled();
  });

  it('lets exact run-binding authority win over a delayed response resolution', async () => {
    const test = await setup();
    let activeLease: TaskAuthorityLease | undefined;
    const responseVerifier = {
      resolve: vi.fn(async () => {
        if (activeLease === undefined) throw new Error('missing lease');
        await ingestVerifiedRunBinding(
          test.storage,
          activeLease,
          await binding(test.spec),
        );
        return { kind: 'accepted' as const, responseSha256: digest('late') };
      }),
    };
    const composition = new LaunchOutboxComposition({
      storage: test.storage,
      responses: new LaunchResponseBoundary(responseVerifier, test.clock),
      leases: {
        run: async (scope, operation) => {
          const lease = await test.storage.acquireTaskLease({
            scope,
            ownerId: 'binding-composition',
            leaseDurationMs: 60_000,
          });
          activeLease = lease;
          try {
            return await operation(lease);
          } finally {
            activeLease = undefined;
            await test.storage.releaseTaskLease(lease);
          }
        },
      },
      clock: test.clock,
    });

    await expect(composition.reconcile(test.input)).rejects.toThrow(
      AuthorityConflict,
    );
    expect(responseVerifier.resolve).toHaveBeenCalledOnce();
    expect(
      await test.storage.readLaunch({
        tenantId: tenant.tenantId,
        attemptId: test.attemptId,
      }),
    ).toMatchObject({ state: 'accepted' });
  });

  it('fails closed on identity mismatch and unknown attempts before provider work', async () => {
    const test = await setup();
    await expect(
      test.composition.reconcile({ ...test.input, tenantId: 'other' }),
    ).rejects.toThrow(LaunchOutboxCompositionConflict);
    await expect(
      test.composition.reconcile({
        ...test.input,
        task: { ...task, issueNumber: 7 },
      }),
    ).rejects.toThrow(LaunchOutboxCompositionConflict);
    await expect(
      test.composition.reconcile({ ...test.input, attemptId: 'B'.repeat(22) }),
    ).rejects.toThrow(LaunchOutboxCompositionConflict);
    expect(test.verifier.resolve).not.toHaveBeenCalled();
    expect(test.run).not.toHaveBeenCalled();
  });

  it('releases the owned lease after a provider failure', async () => {
    const test = await setup();
    test.verifier.resolve.mockRejectedValueOnce(new Error('provider failed'));
    await expect(test.composition.reconcile(test.input)).rejects.toThrow(
      'provider failed',
    );
    expect(test.run).toHaveBeenCalledOnce();
    await expect(
      test.storage.acquireTaskLease({
        scope: task,
        ownerId: 'after-failure',
        leaseDurationMs: 60_000,
      }),
    ).resolves.toMatchObject({ fence: 3 });
  });
});
