import type {
  AcceptedAttemptSpec,
  ActivationRecord,
  RuntimeObservationEnvelope,
} from '@agent-lcars/dispatch-contracts';
import { runtimeObservationPayloadSha256 } from '@agent-lcars/dispatch-contracts';
import { describe, expect, it, vi } from 'vitest';

import type { AttemptState } from './attempt-reducer';
import { attemptSpecDigest } from './attempt-reducer';
import {
  type AuthorityClock,
  AuthorityConflict,
  InMemoryLifecycleAuthorityStorage,
  type LifecycleAuthorityStorage,
  type TaskAuthorityLease,
} from './authority-storage';
import {
  finalizationCommandId,
  mintFinalizationTransition,
  type VerifiedFinalizationTransition,
} from './finalization-capability';
import {
  ingestVerifiedRunBinding,
  RunBindingIngressVerifier,
} from './launch-binding';
import type { TaskIntentState } from './task-intent-reducer';
import {
  AttemptFinalizer,
  ClaimObservationBoundary,
  isVerifiedClaimObservation,
  isVerifiedTerminalObservation,
  TerminalFinalizerConflict,
  TerminalObservationBoundary,
} from './terminal-finalizer';

const SHA = 'a'.repeat(64);
const tenant = {
  tenantId: 'tenant-1',
  repositoryId: 123,
  repository: 'octo/example',
  installationId: 456,
};
const task = { tenantId: tenant.tenantId, repositoryId: 123, issueNumber: 9 };
const binding = {
  runId: 10,
  runAttempt: 1,
  checkRunId: 11,
  workflowPath: '.github/workflows/worker.yml',
  workflowRef: 'refs/heads/main',
  workflowSha: SHA,
};

async function envelope(
  payload: RuntimeObservationEnvelope['payload'],
  overrides: Partial<RuntimeObservationEnvelope> = {},
): Promise<RuntimeObservationEnvelope> {
  return {
    schema: 'agent-lcars.runtime-observation/v1',
    version: 1,
    requestId: 'request-1',
    factId: 'fact-1',
    attemptId: 'A'.repeat(22),
    tenant,
    task,
    source: { kind: 'github-provider', sourceId: 'source-1' },
    observedAt: '2026-08-16T00:00:00.000Z',
    payloadSha256: await runtimeObservationPayloadSha256(payload),
    payload,
    ...overrides,
  };
}

describe('terminal finalizer trust boundaries', () => {
  it('requires provider terminal attestation and returns a recursively immutable capability', async () => {
    const verifier = {
      verifyTerminal: vi.fn(async () => ({
        observedAt: '2026-08-16T00:00:00.000Z',
        finalizationDeadline: DEADLINE,
      })),
      verifyClaim: vi.fn(async () => ({
        observedAt: '2026-08-16T00:00:00.000Z',
      })),
    };
    const boundary = new TerminalObservationBoundary(verifier);
    const terminal = await boundary.verify({
      envelope: await envelope({
        kind: 'run-terminal',
        binding,
        conclusion: 'success',
        observedAt: '2026-08-16T00:00:00.000Z',
      }),
    });

    expect(isVerifiedTerminalObservation(terminal)).toBe(true);
    expect(verifier.verifyTerminal).toHaveBeenCalledOnce();
    expect(Object.isFrozen(terminal.envelope.tenant)).toBe(true);
    expect(() => {
      (terminal.envelope.tenant as { tenantId: string }).tenantId = 'other';
    }).toThrow(TypeError);
  });

  it('authenticates claim transport without treating the deliverable as attested', async () => {
    const verifier = {
      verifyTerminal: vi.fn(async () => ({
        observedAt: '2026-08-16T00:00:00.000Z',
        finalizationDeadline: DEADLINE,
      })),
      verifyClaim: vi.fn(async () => ({
        observedAt: '2026-08-16T00:00:00.000Z',
      })),
    };
    const boundary = new ClaimObservationBoundary(verifier);
    const claim = await boundary.parse({
      envelope: await envelope({
        kind: 'agent-result-claim',
        claim: {
          kind: 'comment',
          commentId: 'comment-1',
          localAttemptMarker: 'g1:intent-1',
        },
      }),
    });
    expect(isVerifiedClaimObservation(claim)).toBe(true);
    expect(verifier.verifyClaim).toHaveBeenCalledWith(claim);
    await expect(
      boundary.parse({
        envelope: { ...claim.envelope, payloadSha256: 'b'.repeat(64) },
      }),
    ).rejects.toBeInstanceOf(TerminalFinalizerConflict);
  });

  it('uses only attested deadline and receipt time, ignoring backdated caller metadata', async () => {
    const verifier = {
      verifyTerminal: vi.fn(async () => ({
        observedAt: '2026-08-16T00:00:00.000Z',
        finalizationDeadline: DEADLINE,
      })),
      verifyClaim: vi.fn(async () => ({ observedAt: FINAL_TIME })),
    };
    const terminalBoundary = new TerminalObservationBoundary(verifier);
    const terminal = await terminalBoundary.verify({
      envelope: await envelope({
        kind: 'run-terminal',
        binding,
        conclusion: 'success',
        observedAt: '2026-08-15T00:00:00.000Z',
      }),
      // An untrusted extra property cannot shorten the policy-owned window.
      finalizationDeadline: '2026-08-16T00:00:01.000Z',
    } as { envelope: unknown });
    expect(terminal.finalizationDeadline).toBe(DEADLINE);
    expect(terminal.envelope.payload).toMatchObject({
      observedAt: '2026-08-16T00:00:00.000Z',
    });

    const claim = await new ClaimObservationBoundary(verifier).parse({
      envelope: await envelope(
        {
          kind: 'agent-result-claim',
          claim: {
            kind: 'comment',
            commentId: 'comment-backdated',
            localAttemptMarker: 'g1:intent-1',
          },
        },
        { observedAt: '2026-08-15T00:00:00.000Z' },
      ),
    });
    expect(claim.envelope.observedAt).toBe(FINAL_TIME);
  });
});

const DEADLINE = '2026-08-16T00:05:00.000Z';
const FINAL_TIME = '2026-08-16T00:06:00.000Z';

class ManualClock implements AuthorityClock {
  constructor(private value = '2026-08-16T00:00:00.000Z') {}
  now(): string {
    return this.value;
  }
  set(value: string): void {
    this.value = value;
  }
}

function finalizerFixture(): {
  activation: ActivationRecord;
  spec: AcceptedAttemptSpec;
  attempt: AttemptState;
  taskState: TaskIntentState;
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
    recordedAt: '2026-08-16T00:00:00.000Z',
  };
  const spec: AcceptedAttemptSpec = {
    schema: 'agent-lcars.attempt-spec/v1',
    version: 1,
    requestId: 'request-admit-1',
    attemptId: 'A'.repeat(22),
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
      decidedAt: '2026-08-16T00:00:00.000Z',
    },
  };
  const attempt: AttemptState = {
    schema: 'agent-lcars.attempt-state/v1',
    version: 1,
    spec,
    specDigest: attemptSpecDigest(spec),
    revision: 1,
    phase: 'launch-pending',
    launch: {
      operationId: spec.attemptId,
      executionEpoch: 1,
      state: 'recorded',
    },
    executionEpoch: 1,
    facts: [],
    commands: [],
    pendingClaims: [],
    futureGrantsDenied: false,
    updatedAt: '2026-08-16T00:00:00.000Z',
  };
  const taskState: TaskIntentState = {
    schema: 'agent-lcars.task-intent-state/v1',
    version: 1,
    tenant,
    task,
    revision: 1,
    activation: spec.activation,
    facts: [],
    intents: [],
    attempt: { kind: 'unlaunched', intentId: 'intent-1' },
    updatedAt: '2026-08-16T00:00:00.000Z',
  };
  return { activation, spec, attempt, taskState };
}

async function activeFixture(storage: LifecycleAuthorityStorage): Promise<{
  lease: TaskAuthorityLease;
  spec: AcceptedAttemptSpec;
}> {
  const value = finalizerFixture();
  await storage.registerActivation(value.activation);
  const lease = await storage.acquireTaskLease({
    scope: task,
    ownerId: 'owner-1',
    leaseDurationMs: 60 * 60 * 1000,
  });
  await storage.admitAttemptAndRecordLaunch({
    lease,
    expectedTaskRevision: 0,
    nextTask: value.taskState,
    attempt: value.attempt,
    spec: value.spec,
    specDigest: value.attempt.specDigest,
  });
  const runBindingVerifier = new RunBindingIngressVerifier({
    verifyExactRunBinding(): Promise<void> {
      return Promise.resolve();
    },
  });
  const payload = { kind: 'run-bound' as const, binding };
  const verified = await runBindingVerifier.verify({
    envelope: await envelope(payload, {
      requestId: 'request-binding-1',
      factId: 'fact-binding-1',
    }),
    localAttemptMarker: value.spec.local.attemptMarker,
  });
  await ingestVerifiedRunBinding(storage, lease, verified);
  return { lease, spec: value.spec };
}

function evidenceVerifier() {
  return {
    verifyTerminal(): Promise<{
      observedAt: string;
      finalizationDeadline: string;
    }> {
      return Promise.resolve({
        observedAt: '2026-08-16T00:00:00.000Z',
        finalizationDeadline: DEADLINE,
      });
    },
    verifyClaim(): Promise<{ observedAt: string }> {
      return Promise.resolve({ observedAt: '2026-08-16T00:04:00.000Z' });
    },
  };
}

/** Every asynchronous authority adapter must pass this finalizer transaction suite. */
export function runAttemptFinalizerStorageContract(
  makeStorage: (
    clock: AuthorityClock,
  ) => LifecycleAuthorityStorage | Promise<LifecycleAuthorityStorage>,
): void {
  describe('attempt finalizer storage contract', () => {
    it('atomically validates one exact claim and commits one immutable outcome', async () => {
      const clock = new ManualClock();
      const storage = await makeStorage(clock);
      const { lease, spec } = await activeFixture(storage);
      const verifier = evidenceVerifier();
      const terminalBoundary = new TerminalObservationBoundary(verifier);
      const claimBoundary = new ClaimObservationBoundary(verifier);
      const resolver = vi.fn(async () => ({ status: 'validated' as const }));
      const finalizer = new AttemptFinalizer(storage, clock, {
        resolve: resolver,
      });
      const terminalPayload = {
        kind: 'run-terminal' as const,
        binding,
        conclusion: 'success' as const,
        observedAt: '2026-08-16T00:00:00.000Z',
      };
      const terminal = await terminalBoundary.verify({
        envelope: await envelope(terminalPayload, {
          requestId: 'request-terminal-1',
          factId: 'fact-terminal-1',
        }),
      });
      expect(await finalizer.recordObservation(lease, terminal)).toBe(
        'applied',
      );
      const claim = await claimBoundary.parse({
        envelope: await envelope(
          {
            kind: 'agent-result-claim',
            claim: {
              kind: 'pull-request',
              number: 44,
              localAttemptMarker: spec.local.attemptMarker,
            },
          },
          {
            requestId: 'request-claim-1',
            factId: 'fact-claim-1',
            observedAt: '2026-08-16T00:04:00.000Z',
          },
        ),
      });
      expect(await finalizer.recordObservation(lease, claim)).toBe('applied');

      clock.set(DEADLINE);
      expect(
        await finalizer.beginValidation(lease, tenant.tenantId, spec.attemptId),
      ).toBe('applied');
      expect(
        await finalizer.beginValidation(lease, tenant.tenantId, spec.attemptId),
      ).toBe('replay');
      await expect(
        storage.applyFinalizationTransition({
          lease,
          transition: mintFinalizationTransition({
            kind: 'start-validation',
            tenantId: tenant.tenantId,
            attemptId: spec.attemptId,
            at: FINAL_TIME,
          }),
        }),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      expect(
        await storage.listValidationWork({
          tenantId: tenant.tenantId,
          state: 'pending',
        }),
      ).toHaveLength(1);
      expect(
        await finalizer.resolveClaim(
          lease,
          tenant.tenantId,
          spec.attemptId,
          'fact-claim-1',
        ),
      ).toBe('applied');
      expect(
        await finalizer.resolveClaim(
          lease,
          tenant.tenantId,
          spec.attemptId,
          'fact-claim-1',
        ),
      ).toBe('replay');
      expect(resolver).toHaveBeenCalledOnce();
      await expect(
        storage.applyFinalizationTransition({
          lease,
          transition: mintFinalizationTransition({
            kind: 'validate-claim',
            tenantId: tenant.tenantId,
            attemptId: spec.attemptId,
            claimFactId: 'fact-claim-1',
            validationFactId: finalizationCommandId(
              'validate-claim',
              spec.attemptId,
              'fact-terminal-1',
              'fact-claim-1',
            ),
            at: FINAL_TIME,
            verdict: { status: 'validated' },
          }),
        }),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      expect(
        await storage.listValidationWork({
          tenantId: tenant.tenantId,
          state: 'complete',
        }),
      ).toMatchObject([{ claimFactId: 'fact-claim-1', state: 'complete' }]);

      clock.set(FINAL_TIME);
      expect(
        await finalizer.finalize(lease, tenant.tenantId, spec.attemptId),
      ).toBe('applied');
      expect(
        await finalizer.finalize(lease, tenant.tenantId, spec.attemptId),
      ).toBe('replay');
      await expect(
        storage.applyFinalizationTransition({
          lease,
          transition: mintFinalizationTransition({
            kind: 'finalize',
            tenantId: tenant.tenantId,
            attemptId: spec.attemptId,
            eventId: finalizationCommandId(
              'finalize',
              spec.attemptId,
              'fact-terminal-1',
            ),
            at: '2026-08-16T00:07:00.000Z',
          }),
        }),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      const finalized = await storage.readAttempt({
        tenantId: tenant.tenantId,
        attemptId: spec.attemptId,
      });
      expect(finalized).toMatchObject({
        phase: 'terminal',
        outcome: {
          terminalState: 'succeeded',
          result: 'pull-request',
          reference: { kind: 'pull-request', number: 44 },
        },
      });
    });

    it('rejects a structural storage command and preserves retryable lookup failure', async () => {
      const clock = new ManualClock();
      const storage = await makeStorage(clock);
      const { lease, spec } = await activeFixture(storage);
      await expect(
        storage.applyFinalizationTransition({
          lease,
          transition: {
            kind: 'start-validation',
            tenantId: tenant.tenantId,
            attemptId: spec.attemptId,
            at: DEADLINE,
          } as VerifiedFinalizationTransition,
        }),
      ).rejects.toBeInstanceOf(AuthorityConflict);

      const verifier = evidenceVerifier();
      const terminalBoundary = new TerminalObservationBoundary(verifier);
      const claimBoundary = new ClaimObservationBoundary(verifier);
      const terminal = await terminalBoundary.verify({
        envelope: await envelope(
          {
            kind: 'run-terminal',
            binding,
            conclusion: 'success',
            observedAt: '2026-08-16T00:00:00.000Z',
          },
          { requestId: 'request-terminal-2', factId: 'fact-terminal-2' },
        ),
      });
      const claim = await claimBoundary.parse({
        envelope: await envelope(
          {
            kind: 'agent-result-claim',
            claim: {
              kind: 'comment',
              commentId: 'comment-1',
              localAttemptMarker: spec.local.attemptMarker,
            },
          },
          { requestId: 'request-claim-2', factId: 'fact-claim-2' },
        ),
      });
      const failing = new AttemptFinalizer(storage, clock, {
        async resolve(): Promise<never> {
          throw new Error('provider unavailable');
        },
      });
      await failing.recordObservation(lease, terminal);
      await failing.recordObservation(lease, claim);
      clock.set(DEADLINE);
      await failing.beginValidation(lease, tenant.tenantId, spec.attemptId);
      await expect(
        failing.resolveClaim(
          lease,
          tenant.tenantId,
          spec.attemptId,
          'fact-claim-2',
        ),
      ).rejects.toThrow('provider unavailable');
      expect(
        (
          await storage.readAttempt({
            tenantId: tenant.tenantId,
            attemptId: spec.attemptId,
          })
        )?.outcome,
      ).toBeUndefined();
      expect(
        await storage.listValidationWork({
          tenantId: tenant.tenantId,
          state: 'resolving',
        }),
      ).toHaveLength(1);

      await storage.releaseTaskLease(lease);
      const takeoverLease = await storage.acquireTaskLease({
        scope: task,
        ownerId: 'owner-2',
        leaseDurationMs: 60 * 60 * 1000,
      });
      const recovered = new AttemptFinalizer(storage, clock, {
        async resolve() {
          return {
            status: 'rejected' as const,
            reason: 'marker-mismatch' as const,
          };
        },
      });
      expect(
        await recovered.resolveClaim(
          takeoverLease,
          tenant.tenantId,
          spec.attemptId,
          'fact-claim-2',
        ),
      ).toBe('applied');
      expect(
        await storage.listValidationWork({
          tenantId: tenant.tenantId,
          state: 'complete',
        }),
      ).toHaveLength(1);
    });

    it('rejects a late claim even when its untrusted envelope is backdated', async () => {
      const clock = new ManualClock();
      const storage = await makeStorage(clock);
      const { lease, spec } = await activeFixture(storage);
      const verifier = {
        verifyTerminal: evidenceVerifier().verifyTerminal,
        async verifyClaim(): Promise<{ observedAt: string }> {
          return { observedAt: FINAL_TIME };
        },
      };
      const finalizer = new AttemptFinalizer(storage, clock, {
        async resolve() {
          return { status: 'validated' as const };
        },
      });
      const terminal = await new TerminalObservationBoundary(verifier).verify({
        envelope: await envelope(
          {
            kind: 'run-terminal',
            binding,
            conclusion: 'success',
            observedAt: '2026-08-16T00:00:00.000Z',
          },
          { requestId: 'request-terminal-late', factId: 'fact-terminal-late' },
        ),
      });
      await finalizer.recordObservation(lease, terminal);
      const claim = await new ClaimObservationBoundary(verifier).parse({
        envelope: await envelope(
          {
            kind: 'agent-result-claim',
            claim: {
              kind: 'comment',
              commentId: 'comment-late',
              localAttemptMarker: spec.local.attemptMarker,
            },
          },
          {
            requestId: 'request-claim-late',
            factId: 'fact-claim-late',
            observedAt: '2026-08-15T00:00:00.000Z',
          },
        ),
      });
      await expect(
        finalizer.recordObservation(lease, claim),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      expect(
        (
          await storage.readAttempt({
            tenantId: tenant.tenantId,
            attemptId: spec.attemptId,
          })
        )?.finalization?.evidence,
      ).toEqual([]);
    });
  });
}

runAttemptFinalizerStorageContract(
  (clock) => new InMemoryLifecycleAuthorityStorage(clock),
);
