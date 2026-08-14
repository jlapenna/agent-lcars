import type {
  AcceptedAttemptSpec,
  ActivationRecord,
  RuntimeObservationEnvelope,
} from '@agent-lcars/dispatch-contracts';
import { runtimeObservationPayloadSha256 } from '@agent-lcars/dispatch-contracts';
import { describe, expect, it } from 'vitest';

import type { AttemptState } from './attempt-reducer';
import {
  attemptSpecDigest,
  attemptTransitionDigest,
  reduceAttempt,
} from './attempt-reducer';
import {
  AuthorityConflict,
  InMemoryLifecycleAuthorityStorage,
  type LifecycleAuthorityStorage,
  type TaskAuthorityLease,
} from './authority-storage';
import {
  ingestVerifiedRunBinding,
  RunBindingIngressConflict,
  RunBindingIngressVerifier,
} from './launch-binding';
import type { TaskIntentState } from './task-intent-reducer';

const TIME = '2026-08-16T00:00:00.000Z';
const SHA = 'a'.repeat(64);
const ATTEMPT_ID = 'A'.repeat(22);
const tenant = {
  tenantId: 'tenant-1',
  repositoryId: 123,
  repository: 'octo/repo',
  installationId: 456,
};
const task = {
  tenantId: tenant.tenantId,
  repositoryId: tenant.repositoryId,
  issueNumber: 9,
};

function fixture() {
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
  const spec: AcceptedAttemptSpec = {
    schema: 'agent-lcars.attempt-spec/v1',
    version: 1,
    requestId: 'request-1',
    attemptId: ATTEMPT_ID,
    tenant,
    task,
    activation: {
      activationId: 'activation-1',
      taskClassId: 'github-issue',
      authorityEpoch: 1,
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
      workflowPath: '.github/workflows/worker.yml',
      workflowRef: 'refs/heads/main',
      workflowSha: SHA,
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
  };
  const attempt: AttemptState = {
    schema: 'agent-lcars.attempt-state/v1',
    version: 1,
    spec,
    specDigest: attemptSpecDigest(spec),
    revision: 1,
    phase: 'launch-pending',
    launch: { operationId: ATTEMPT_ID, executionEpoch: 1, state: 'recorded' },
    executionEpoch: 1,
    facts: [],
    commands: [],
    pendingClaims: [],
    futureGrantsDenied: false,
    updatedAt: TIME,
  };
  const nextTask: TaskIntentState = {
    schema: 'agent-lcars.task-intent-state/v1',
    version: 1,
    tenant,
    task,
    revision: 1,
    activation: spec.activation,
    facts: [],
    intents: [],
    attempt: { kind: 'unlaunched', intentId: 'intent-1' },
    updatedAt: TIME,
  };
  return { activation, spec, attempt, nextTask };
}

async function admittedInto(storage: LifecycleAuthorityStorage): Promise<{
  storage: LifecycleAuthorityStorage;
  lease: TaskAuthorityLease;
  spec: AcceptedAttemptSpec;
}> {
  const value = fixture();
  await storage.registerActivation(value.activation);
  const lease = await storage.acquireTaskLease({
    scope: task,
    ownerId: 'owner-1',
    leaseDurationMs: 60 * 60 * 1000,
  });
  await storage.admitAttemptAndRecordLaunch({
    lease,
    expectedTaskRevision: 0,
    nextTask: value.nextTask,
    attempt: value.attempt,
    spec: value.spec,
    specDigest: value.attempt.specDigest,
  });
  return { storage, lease, spec: value.spec };
}

async function envelope(
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

const verifier = new RunBindingIngressVerifier({
  async verifyExactRunBinding(): Promise<void> {
    // A real server composition injects the provider's exact-run verifier.
  },
});

/** Every asynchronous authority adapter must pass this binding transaction suite. */
export function runVerifiedRunBindingStorageContract(
  makeStorage: () =>
    LifecycleAuthorityStorage | Promise<LifecycleAuthorityStorage>,
): void {
  describe('verified run-binding storage contract', () => {
    it('rejects structural capabilities, marker mismatches, and stale payload digests', async () => {
      const { storage, lease, spec } = await admittedInto(await makeStorage());
      const value = await envelope(spec);
      await expect(
        ingestVerifiedRunBinding(storage, lease, {
          envelope: value,
          localAttemptMarker: spec.local.attemptMarker,
        }),
      ).rejects.toBeInstanceOf(RunBindingIngressConflict);
      const wrongMarker = await verifier.verify({
        envelope: value,
        localAttemptMarker: 'g1:other-intent',
      });
      await expect(
        ingestVerifiedRunBinding(storage, lease, wrongMarker),
      ).rejects.toBeInstanceOf(RunBindingIngressConflict);
      expect(
        await storage.readAttempt({
          tenantId: spec.tenant.tenantId,
          attemptId: spec.attemptId,
        }),
      ).toMatchObject({ revision: 1, phase: 'launch-pending' });
      expect(
        (
          await storage.readLaunch({
            tenantId: spec.tenant.tenantId,
            attemptId: spec.attemptId,
          })
        )?.state,
      ).toBe('pending');
      await expect(
        verifier.verify({
          envelope: { ...value, payloadSha256: 'b'.repeat(64) },
          localAttemptMarker: spec.local.attemptMarker,
        }),
      ).rejects.toBeInstanceOf(RunBindingIngressConflict);
    });

    it('atomically binds a verified run and converges a pending launch to accepted', async () => {
      const { storage, lease, spec } = await admittedInto(await makeStorage());
      const verified = await verifier.verify({
        envelope: await envelope(spec),
        localAttemptMarker: spec.local.attemptMarker,
      });
      expect(await ingestVerifiedRunBinding(storage, lease, verified)).toBe(
        'applied',
      );
      expect(
        (
          await storage.readLaunch({
            tenantId: tenant.tenantId,
            attemptId: spec.attemptId,
          })
        )?.state,
      ).toBe('accepted');
      const bound = await storage.readAttempt({
        tenantId: tenant.tenantId,
        attemptId: spec.attemptId,
      });
      expect(bound?.phase).toBe('active');
      expect(bound?.launch.state).toBe('accepted');
      expect(bound?.binding).toEqual(verified.envelope.payload.binding);
      expect(await ingestVerifiedRunBinding(storage, lease, verified)).toBe(
        'replay',
      );
    });

    it('converges pending, dispatching, accepted, and unknown outboxes to one accepted bound run', async () => {
      for (const state of [
        'pending',
        'dispatching',
        'accepted',
        'unknown',
      ] as const) {
        const { storage, lease, spec } = await admittedInto(
          await makeStorage(),
        );
        if (state !== 'pending') {
          await storage.claimLaunch({ lease, attemptId: spec.attemptId });
        }
        if (state === 'accepted' || state === 'unknown') {
          const current = await storage.readAttempt({
            tenantId: spec.tenant.tenantId,
            attemptId: spec.attemptId,
          });
          if (current === undefined)
            throw new Error('admitted attempt disappeared');
          await storage.resolveLaunch({
            lease,
            attemptId: spec.attemptId,
            expectedState: 'dispatching',
            state,
            expectedAttemptRevision: current.revision,
            nextAttempt: {
              ...current,
              revision: current.revision + 1,
              phase:
                state === 'accepted'
                  ? 'launch-accepted'
                  : 'launch-response-unknown',
              launch: {
                ...current.launch,
                state: state === 'accepted' ? 'accepted' : 'response-unknown',
              },
            },
          });
        }
        const verified = await verifier.verify({
          envelope: await envelope(spec),
          localAttemptMarker: spec.local.attemptMarker,
        });
        expect(await ingestVerifiedRunBinding(storage, lease, verified)).toBe(
          'applied',
        );
        expect(
          (
            await storage.readLaunch({
              tenantId: spec.tenant.tenantId,
              attemptId: spec.attemptId,
            })
          )?.state,
        ).toBe('accepted');
        expect(
          (
            await storage.readAttempt({
              tenantId: spec.tenant.tenantId,
              attemptId: spec.attemptId,
            })
          )?.binding,
        ).toEqual(verified.envelope.payload.binding);
      }
    });

    it('does not let a delayed launch response regress an exact bound run', async () => {
      const { storage, lease, spec } = await admittedInto(await makeStorage());
      await storage.claimLaunch({ lease, attemptId: spec.attemptId });
      const verified = await verifier.verify({
        envelope: await envelope(spec),
        localAttemptMarker: spec.local.attemptMarker,
      });
      await ingestVerifiedRunBinding(storage, lease, verified);
      const bound = await storage.readAttempt({
        tenantId: spec.tenant.tenantId,
        attemptId: spec.attemptId,
      });
      if (bound === undefined) throw new Error('bound attempt disappeared');
      await expect(
        storage.resolveLaunch({
          lease,
          attemptId: spec.attemptId,
          expectedState: 'dispatching',
          state: 'unknown',
          expectedAttemptRevision: bound.revision,
          nextAttempt: {
            ...bound,
            revision: bound.revision + 1,
            phase: 'launch-response-unknown',
            launch: { ...bound.launch, state: 'response-unknown' },
          },
        }),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      expect(
        (
          await storage.readLaunch({
            tenantId: spec.tenant.tenantId,
            attemptId: spec.attemptId,
          })
        )?.state,
      ).toBe('accepted');
    });

    it('rejects a stale or foreign fence without mutating the pending attempt/outbox', async () => {
      const { storage, lease, spec } = await admittedInto(await makeStorage());
      const verified = await verifier.verify({
        envelope: await envelope(spec),
        localAttemptMarker: spec.local.attemptMarker,
      });
      await expect(
        ingestVerifiedRunBinding(
          storage,
          { ...lease, fence: lease.fence + 1 },
          verified,
        ),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      expect(
        await storage.readAttempt({
          tenantId: spec.tenant.tenantId,
          attemptId: spec.attemptId,
        }),
      ).toMatchObject({ revision: 1, phase: 'launch-pending' });
      expect(
        (
          await storage.readLaunch({
            tenantId: spec.tenant.tenantId,
            attemptId: spec.attemptId,
          })
        )?.state,
      ).toBe('pending');
    });

    it('keeps a terminal fact received before binding and opens its finalization window on exact binding', async () => {
      const { storage, lease, spec } = await admittedInto(await makeStorage());
      const runBinding = (await envelope(spec)).payload;
      if (runBinding.kind !== 'run-bound')
        throw new Error('test binding missing');
      const terminalPayload = {
        kind: 'run-terminal' as const,
        binding: runBinding.binding,
        conclusion: 'success' as const,
        observedAt: TIME,
      };
      const terminalEnvelope: RuntimeObservationEnvelope = {
        ...(await envelope(spec, {
          factId: 'fact-terminal-1',
          requestId: 'request-terminal-1',
        })),
        payload: terminalPayload,
        payloadSha256: await runtimeObservationPayloadSha256(terminalPayload),
      };
      const before = await storage.readAttempt({
        tenantId: spec.tenant.tenantId,
        attemptId: spec.attemptId,
      });
      if (before === undefined) throw new Error('admitted attempt disappeared');
      const terminalEvent = {
        kind: 'observation' as const,
        envelope: terminalEnvelope,
        finalizationDeadline: '2026-08-16T01:00:00.000Z',
      };
      const terminal = reduceAttempt(before, {
        kind: 'transition',
        expectedRevision: before.revision,
        transitionedAt: TIME,
        canonicalDigest: attemptTransitionDigest(terminalEvent),
        event: terminalEvent,
      });
      if (terminal.status !== 'applied')
        throw new Error('terminal should be pending');
      await storage.writeAttempt({
        lease,
        expectedRevision: before.revision,
        next: terminal.state,
      });
      const verified = await verifier.verify({
        envelope: await envelope(spec),
        localAttemptMarker: spec.local.attemptMarker,
      });
      await ingestVerifiedRunBinding(storage, lease, verified);
      const converged = await storage.readAttempt({
        tenantId: spec.tenant.tenantId,
        attemptId: spec.attemptId,
      });
      expect(converged).toMatchObject({
        phase: 'result-observed',
        launch: { state: 'accepted' },
        finalization: { terminalFactId: 'fact-terminal-1' },
      });
    });

    it('rejects a global exact-binding collision across attempts without partial second writes', async () => {
      const { storage, lease, spec } = await admittedInto(await makeStorage());
      const first = await verifier.verify({
        envelope: await envelope(spec),
        localAttemptMarker: spec.local.attemptMarker,
      });
      await ingestVerifiedRunBinding(storage, lease, first);
      const secondSpec: AcceptedAttemptSpec = {
        ...spec,
        requestId: 'request-2',
        attemptId: 'B'.repeat(22),
        task: { ...spec.task, issueNumber: 10 },
        local: {
          ...spec.local,
          intentId: 'intent-2',
          attemptMarker: 'g1:intent-2',
          idempotencyKey: 'admit-2',
        },
      };
      const secondAttempt: AttemptState = {
        ...fixture().attempt,
        spec: secondSpec,
        specDigest: attemptSpecDigest(secondSpec),
        launch: {
          operationId: secondSpec.attemptId,
          executionEpoch: 1,
          state: 'recorded',
        },
      };
      const secondTask: TaskIntentState = {
        ...fixture().nextTask,
        task: secondSpec.task,
        revision: 1,
        attempt: { kind: 'unlaunched', intentId: secondSpec.local.intentId },
        activation: secondSpec.activation,
      };
      const secondLease = await storage.acquireTaskLease({
        scope: secondSpec.task,
        ownerId: 'owner-2',
        leaseDurationMs: 60 * 60 * 1000,
      });
      await storage.admitAttemptAndRecordLaunch({
        lease: secondLease,
        expectedTaskRevision: 0,
        nextTask: secondTask,
        attempt: secondAttempt,
        spec: secondSpec,
        specDigest: secondAttempt.specDigest,
      });
      const colliding = await verifier.verify({
        envelope: await envelope(secondSpec),
        localAttemptMarker: secondSpec.local.attemptMarker,
      });
      await expect(
        ingestVerifiedRunBinding(storage, secondLease, colliding),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      expect(
        await storage.readAttempt({
          tenantId: secondSpec.tenant.tenantId,
          attemptId: secondSpec.attemptId,
        }),
      ).toMatchObject({ revision: 1, phase: 'launch-pending' });
      expect(
        (
          await storage.readLaunch({
            tenantId: secondSpec.tenant.tenantId,
            attemptId: secondSpec.attemptId,
          })
        )?.state,
      ).toBe('pending');
    });

    it('quarantines different bindings and fact/request replay conflicts without changing the accepted binding', async () => {
      const { storage, lease, spec } = await admittedInto(await makeStorage());
      const first = await verifier.verify({
        envelope: await envelope(spec),
        localAttemptMarker: spec.local.attemptMarker,
      });
      await ingestVerifiedRunBinding(storage, lease, first);
      const different = await verifier.verify({
        envelope: await envelope(spec, {
          factId: 'fact-bound-2',
          requestId: 'request-bound-2',
          payload: {
            kind: 'run-bound',
            binding: {
              ...first.envelope.payload.binding,
              runId: 99,
              checkRunId: 100,
            },
          },
          payloadSha256: await runtimeObservationPayloadSha256({
            kind: 'run-bound',
            binding: {
              ...first.envelope.payload.binding,
              runId: 99,
              checkRunId: 100,
            },
          }),
        }),
        localAttemptMarker: spec.local.attemptMarker,
      });
      await expect(
        ingestVerifiedRunBinding(storage, lease, different),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      const crossedRequest = await verifier.verify({
        envelope: await envelope(spec, { requestId: 'request-bound-crossed' }),
        localAttemptMarker: spec.local.attemptMarker,
      });
      await expect(
        ingestVerifiedRunBinding(storage, lease, crossedRequest),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      const changedDigest = await envelope(spec, {
        payloadSha256: 'c'.repeat(64),
      });
      await expect(
        verifier.verify({
          envelope: changedDigest,
          localAttemptMarker: spec.local.attemptMarker,
        }),
      ).rejects.toBeInstanceOf(RunBindingIngressConflict);
      expect(
        (
          await storage.readAttempt({
            tenantId: tenant.tenantId,
            attemptId: spec.attemptId,
          })
        )?.binding,
      ).toEqual(first.envelope.payload.binding);
    });
  });
}

runVerifiedRunBindingStorageContract(
  () => new InMemoryLifecycleAuthorityStorage({ now: () => TIME }),
);
