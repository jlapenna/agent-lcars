import type {
  AcceptedAttemptSpec,
  ActivationRecord,
  RuntimeObservationEnvelope,
} from '@agent-lcars/dispatch-contracts';
import { runtimeObservationPayloadSha256 } from '@agent-lcars/dispatch-contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  AttemptFinalizationComposition,
  AttemptFinalizationCompositionConflict,
} from './attempt-finalization-composition';
import {
  type AuthorityClock,
  InMemoryLifecycleAuthorityStorage,
  type TaskAuthorityScope,
} from './authority-storage';
import { admitAcceptedSpecForTest } from './authority-storage-test-support';
import {
  ingestVerifiedRunBinding,
  RunBindingIngressVerifier,
} from './launch-binding';
import type { TaskLeaseRunner } from './signal-task-composition';

const NOW = '2026-08-16T00:00:00.000Z';
const DEADLINE = '2026-08-16T00:05:00.000Z';
const FINAL = '2026-08-16T00:06:00.000Z';
const SHA = 'a'.repeat(64);
const ATTEMPT_ID = 'A'.repeat(22);
const tenant = {
  tenantId: 'tenant-finalization-composition',
  repositoryId: 123,
  repository: 'octo/example',
  installationId: 456,
};
const task: TaskAuthorityScope = {
  tenantId: tenant.tenantId,
  repositoryId: tenant.repositoryId,
  issueNumber: 9,
};
const binding = {
  runId: 10,
  runAttempt: 1,
  checkRunId: 11,
  workflowPath: '.github/workflows/worker.yml',
  workflowRef: 'refs/heads/main',
  workflowSha: 'c'.repeat(40),
};

class ManualClock implements AuthorityClock {
  constructor(private value = NOW) {}
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
    activationId: 'activation-1',
    authorityEpoch: 1,
    effectiveBoundary: 1,
    mode: 'central-authoritative',
    effectMode: 'enabled',
    recordedAt: NOW,
  };
  return {
    activation,
    spec: {
      schema: 'agent-lcars.attempt-spec/v1',
      version: 1,
      requestId: 'request-admit-1',
      attemptId: ATTEMPT_ID,
      tenant,
      task,
      activation: {
        activationId: activation.activationId,
        taskClassId: activation.taskClassId,
        authorityEpoch: activation.authorityEpoch,
        mode: 'central-authoritative',
      },
      local: {
        intentId: 'intent-1',
        generation: 1,
        attemptMarker: 'g1:intent-1',
        admissionRevision: 1,
        idempotencyKey: 'admit-1',
      },
      execution: {
        workflowPath: binding.workflowPath,
        workflowRef: binding.workflowRef,
        workflowSha: binding.workflowSha,
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
        sourceFactId: 'source-fact-1',
        principal: { kind: 'system', systemId: 'system-1' },
        evidenceRef: 'policy-evidence-1',
        decidedAt: NOW,
      },
    },
  };
}

async function envelope(
  spec: AcceptedAttemptSpec,
  payload: RuntimeObservationEnvelope['payload'],
  overrides: Partial<RuntimeObservationEnvelope> = {},
): Promise<RuntimeObservationEnvelope> {
  return {
    schema: 'agent-lcars.runtime-observation/v1',
    version: 1,
    requestId: 'request-observation-1',
    factId: 'fact-observation-1',
    attemptId: spec.attemptId,
    tenant: spec.tenant,
    task: spec.task,
    source: { kind: 'github-provider', sourceId: 'provider-1' },
    observedAt: NOW,
    payloadSha256: await runtimeObservationPayloadSha256(payload),
    payload,
    ...overrides,
  };
}

function evidenceVerifier() {
  return {
    verifyTerminal: vi.fn(async () => ({
      observedAt: NOW,
      finalizationDeadline: DEADLINE,
    })),
    verifyClaim: vi.fn(async () => ({
      observedAt: '2026-08-16T00:04:00.000Z',
    })),
  };
}

async function setup(
  overrides: {
    resolver?: ReturnType<typeof vi.fn>;
    verifier?: ReturnType<typeof evidenceVerifier>;
  } = {},
) {
  const clock = new ManualClock();
  const storage = new InMemoryLifecycleAuthorityStorage(clock, {
    mint: () => ATTEMPT_ID,
  });
  const { activation, spec } = fixture();
  const admitted = await admitAcceptedSpecForTest({
    storage,
    activation,
    spec,
    ownerId: 'admission-owner',
  });
  const verifier = overrides.verifier ?? evidenceVerifier();
  const runBindingVerifier = new RunBindingIngressVerifier({
    verifyExactRunBinding: vi.fn(async () => undefined),
  });
  const runBound = await runBindingVerifier.verify({
    envelope: await envelope(spec, {
      kind: 'run-bound',
      binding,
    }),
    localAttemptMarker: spec.local.attemptMarker,
  });
  await ingestVerifiedRunBinding(storage, admitted.lease, runBound);
  await storage.releaseTaskLease(admitted.lease);

  let serial = Promise.resolve();
  const run = vi.fn<TaskLeaseRunner['run']>(async (scope, operation) => {
    const current = serial.then(async () => {
      const lease = await storage.acquireTaskLease({
        scope,
        ownerId: 'finalization-composition',
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
  const resolver =
    overrides.resolver ?? vi.fn(async () => ({ status: 'validated' as const }));
  const composition = new AttemptFinalizationComposition({
    storage,
    verifier,
    resolver: { resolve: resolver as never },
    clock,
    leases: { run },
  });
  return { clock, storage, spec, composition, run, resolver, verifier };
}

async function recordTerminalAndClaim(
  test: Awaited<ReturnType<typeof setup>>,
  includeClaim = true,
): Promise<void> {
  await test.composition.recordTerminal({
    envelope: await envelope(
      test.spec,
      {
        kind: 'run-terminal',
        binding,
        conclusion: 'success',
        observedAt: NOW,
      },
      { requestId: 'request-terminal-1', factId: 'fact-terminal-1' },
    ),
  });
  if (includeClaim) {
    await test.composition.recordClaim({
      envelope: await envelope(
        test.spec,
        {
          kind: 'agent-result-claim',
          claim: {
            kind: 'pull-request',
            number: 44,
            localAttemptMarker: test.spec.local.attemptMarker,
          },
        },
        { requestId: 'request-claim-1', factId: 'fact-claim-1' },
      ),
    });
  }
}

describe('inactive attempt finalization composition', () => {
  it('runs the complete flow and exactly replays durable writes', async () => {
    const test = await setup();
    await recordTerminalAndClaim(test);
    await expect(
      test.composition.beginValidation({
        tenantId: tenant.tenantId,
        attemptId: test.spec.attemptId,
      }),
    ).rejects.toThrow('still open');
    test.clock.set(DEADLINE);
    expect(
      await test.composition.beginValidation({
        tenantId: tenant.tenantId,
        attemptId: test.spec.attemptId,
      }),
    ).toBe('applied');
    expect(
      await test.composition.beginValidation({
        tenantId: tenant.tenantId,
        attemptId: test.spec.attemptId,
      }),
    ).toBe('replay');
    expect(
      await test.composition.resolveClaim({
        tenantId: tenant.tenantId,
        attemptId: test.spec.attemptId,
        claimFactId: 'fact-claim-1',
      }),
    ).toBe('applied');
    expect(
      await test.composition.resolveClaim({
        tenantId: tenant.tenantId,
        attemptId: test.spec.attemptId,
        claimFactId: 'fact-claim-1',
      }),
    ).toBe('replay');
    expect(test.resolver).toHaveBeenCalledOnce();
    test.clock.set(FINAL);
    expect(
      await test.composition.finalize({
        tenantId: tenant.tenantId,
        attemptId: test.spec.attemptId,
      }),
    ).toBe('applied');
    expect(
      await test.composition.finalize({
        tenantId: tenant.tenantId,
        attemptId: test.spec.attemptId,
      }),
    ).toBe('replay');
    expect(
      await test.storage.readAttempt({
        tenantId: tenant.tenantId,
        attemptId: test.spec.attemptId,
      }),
    ).toMatchObject({ phase: 'terminal', outcome: { result: 'pull-request' } });
  });

  it('plans terminal-only attempts as failed with no deliverable presentation', async () => {
    const test = await setup();
    await recordTerminalAndClaim(test, false);
    test.clock.set(DEADLINE);
    await test.composition.beginValidation({
      tenantId: tenant.tenantId,
      attemptId: test.spec.attemptId,
    });
    test.clock.set(FINAL);
    await test.composition.finalize({
      tenantId: tenant.tenantId,
      attemptId: test.spec.attemptId,
    });
    expect(
      await test.storage.readAttempt({
        tenantId: tenant.tenantId,
        attemptId: test.spec.attemptId,
      }),
    ).toMatchObject({
      phase: 'terminal',
      outcome: { terminalState: 'failed', result: 'none' },
    });
    expect(test.resolver).not.toHaveBeenCalled();
  });

  it('rejects malformed/verifier observations before taking a lease', async () => {
    const test = await setup();
    await expect(
      test.composition.recordTerminal({ envelope: { malformed: true } }),
    ).rejects.toThrow();
    test.verifier.verifyClaim.mockRejectedValueOnce(new Error('untrusted'));
    await expect(
      test.composition.recordClaim({
        envelope: await envelope(test.spec, {
          kind: 'agent-result-claim',
          claim: {
            kind: 'comment',
            commentId: 'comment-1',
            localAttemptMarker: test.spec.local.attemptMarker,
          },
        }),
      }),
    ).rejects.toThrow('untrusted');
    expect(test.run).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'wrong terminal kind',
      method: 'recordTerminal' as const,
      payload: {
        kind: 'agent-result-claim' as const,
        claim: {
          kind: 'comment' as const,
          commentId: 'wrong-terminal-kind',
          localAttemptMarker: 'g1:intent-1',
        },
      },
    },
    {
      name: 'wrong claim kind',
      method: 'recordClaim' as const,
      payload: {
        kind: 'run-terminal' as const,
        binding,
        conclusion: 'success' as const,
        observedAt: NOW,
      },
    },
  ])('$name does not acquire a lease', async ({ method, payload }) => {
    const test = await setup();
    await expect(
      test.composition[method]({
        envelope: await envelope(test.spec, payload),
      }),
    ).rejects.toThrow();
    expect(test.run).not.toHaveBeenCalled();
  });

  it('rejects a stale observation digest before taking a lease', async () => {
    const test = await setup();
    const valid = await envelope(test.spec, {
      kind: 'run-terminal',
      binding,
      conclusion: 'success',
      observedAt: NOW,
    });
    await expect(
      test.composition.recordTerminal({
        envelope: { ...valid, payloadSha256: 'b'.repeat(64) },
      }),
    ).rejects.toThrow();
    expect(test.run).not.toHaveBeenCalled();
  });

  it('rejects invalid trusted attestation time before taking a lease', async () => {
    const test = await setup();
    test.verifier.verifyTerminal.mockResolvedValueOnce({
      observedAt: 'not-a-time',
      finalizationDeadline: DEADLINE,
    });
    await expect(
      test.composition.recordTerminal({
        envelope: await envelope(test.spec, {
          kind: 'run-terminal',
          binding,
          conclusion: 'success',
          observedAt: NOW,
        }),
      }),
    ).rejects.toThrow();
    expect(test.run).not.toHaveBeenCalled();
  });

  it('derives observation lease scope from the verified envelope and writes nothing for an unknown task', async () => {
    const test = await setup();
    const observation = await envelope(test.spec, {
      kind: 'run-terminal',
      binding,
      conclusion: 'success',
      observedAt: NOW,
    });
    await expect(
      test.composition.recordTerminal({
        envelope: { ...observation, task: { ...task, issueNumber: 99 } },
      }),
    ).rejects.toThrow();
    expect(test.run).toHaveBeenCalledOnce();
    expect(test.run.mock.calls[0]?.[0]).toEqual({ ...task, issueNumber: 99 });
    expect(
      await test.storage.readAttempt({
        tenantId: tenant.tenantId,
        attemptId: test.spec.attemptId,
      }),
    ).toMatchObject({ phase: 'active' });
  });

  it('rejects a cross-tenant observation before taking a lease', async () => {
    const test = await setup();
    const observation = await envelope(test.spec, {
      kind: 'run-terminal',
      binding,
      conclusion: 'success',
      observedAt: NOW,
    });
    await expect(
      test.composition.recordTerminal({
        envelope: {
          ...observation,
          task: { ...task, tenantId: 'other-tenant' },
        },
      }),
    ).rejects.toThrow();
    expect(test.run).not.toHaveBeenCalled();
  });

  it('rejects unknown and cross-tenant identities before taking a lease', async () => {
    const test = await setup();
    for (const input of [
      { tenantId: tenant.tenantId, attemptId: 'B'.repeat(22) },
      { tenantId: 'other-tenant', attemptId: test.spec.attemptId },
    ]) {
      await expect(test.composition.finalize(input)).rejects.toBeInstanceOf(
        AttemptFinalizationCompositionConflict,
      );
    }
    expect(test.run).not.toHaveBeenCalled();
  });

  it('does not resolve an unknown claim or write a validation fact', async () => {
    const test = await setup();
    await recordTerminalAndClaim(test, false);
    test.clock.set(DEADLINE);
    await test.composition.beginValidation({
      tenantId: tenant.tenantId,
      attemptId: test.spec.attemptId,
    });
    await expect(
      test.composition.resolveClaim({
        tenantId: tenant.tenantId,
        attemptId: test.spec.attemptId,
        claimFactId: 'missing-claim',
      }),
    ).rejects.toThrow('not pending validation');
    expect(test.resolver).not.toHaveBeenCalled();
    expect(
      await test.storage.listValidationWork({
        tenantId: tenant.tenantId,
        state: 'pending',
      }),
    ).toHaveLength(0);
  });

  it('leaves resolving work fenced for recovery after a resolver failure', async () => {
    const resolver = vi
      .fn()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce({ status: 'validated' as const });
    const test = await setup({ resolver });
    await recordTerminalAndClaim(test);
    test.clock.set(DEADLINE);
    await test.composition.beginValidation({
      tenantId: tenant.tenantId,
      attemptId: test.spec.attemptId,
    });
    await expect(
      test.composition.resolveClaim({
        tenantId: tenant.tenantId,
        attemptId: test.spec.attemptId,
        claimFactId: 'fact-claim-1',
      }),
    ).rejects.toThrow('provider unavailable');
    expect(
      await test.storage.listValidationWork({
        tenantId: tenant.tenantId,
        state: 'resolving',
      }),
    ).toHaveLength(1);
    expect(
      await test.composition.resolveClaim({
        tenantId: tenant.tenantId,
        attemptId: test.spec.attemptId,
        claimFactId: 'fact-claim-1',
      }),
    ).toBe('applied');
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(
      await test.storage.listValidationWork({
        tenantId: tenant.tenantId,
        state: 'complete',
      }),
    ).toHaveLength(1);
    await expect(
      test.storage.acquireTaskLease({
        scope: task,
        ownerId: 'after-failure',
        leaseDurationMs: 60_000,
      }),
    ).resolves.toMatchObject({ fence: 7 });
  });

  it('serializes concurrent claim resolution and releases every lease', async () => {
    const test = await setup();
    await recordTerminalAndClaim(test);
    test.clock.set(DEADLINE);
    await test.composition.beginValidation({
      tenantId: tenant.tenantId,
      attemptId: test.spec.attemptId,
    });
    const results = await Promise.all([
      test.composition.resolveClaim({
        tenantId: tenant.tenantId,
        attemptId: test.spec.attemptId,
        claimFactId: 'fact-claim-1',
      }),
      test.composition.resolveClaim({
        tenantId: tenant.tenantId,
        attemptId: test.spec.attemptId,
        claimFactId: 'fact-claim-1',
      }),
    ]);
    expect(results.sort()).toEqual(['applied', 'replay']);
    expect(test.resolver).toHaveBeenCalledOnce();
    expect(test.run).toHaveBeenCalledTimes(5);
    await expect(
      test.storage.acquireTaskLease({
        scope: task,
        ownerId: 'after-concurrency',
        leaseDurationMs: 60_000,
      }),
    ).resolves.toMatchObject({ fence: 7 });
  });

  it('shares one resolver operation for same-fence concurrent claims', async () => {
    const test = await setup();
    const resolver = vi.fn(async () => ({ status: 'validated' as const }));
    const lease = await test.storage.acquireTaskLease({
      scope: task,
      ownerId: 'same-fence-owner',
      leaseDurationMs: 60 * 60 * 1000,
    });
    const composition = new AttemptFinalizationComposition({
      storage: test.storage,
      verifier: test.verifier,
      resolver: { resolve: resolver as never },
      clock: test.clock,
      leases: {
        run: (_scope, operation) => operation(lease),
      },
    });
    await composition.recordTerminal({
      envelope: await envelope(
        test.spec,
        {
          kind: 'run-terminal',
          binding,
          conclusion: 'success',
          observedAt: NOW,
        },
        {
          requestId: 'request-same-fence-terminal',
          factId: 'fact-same-fence-terminal',
        },
      ),
    });
    await composition.recordClaim({
      envelope: await envelope(
        test.spec,
        {
          kind: 'agent-result-claim',
          claim: {
            kind: 'comment',
            commentId: 'comment-same-fence',
            localAttemptMarker: test.spec.local.attemptMarker,
          },
        },
        {
          requestId: 'request-same-fence-claim',
          factId: 'fact-same-fence-claim',
        },
      ),
    });
    test.clock.set(DEADLINE);
    await composition.beginValidation({
      tenantId: tenant.tenantId,
      attemptId: test.spec.attemptId,
    });
    const results = await Promise.all([
      composition.resolveClaim({
        tenantId: tenant.tenantId,
        attemptId: test.spec.attemptId,
        claimFactId: 'fact-same-fence-claim',
      }),
      composition.resolveClaim({
        tenantId: tenant.tenantId,
        attemptId: test.spec.attemptId,
        claimFactId: 'fact-same-fence-claim',
      }),
    ]);
    expect(results).toEqual(['applied', 'applied']);
    expect(resolver).toHaveBeenCalledOnce();
    await test.storage.releaseTaskLease(lease);
  });
});
