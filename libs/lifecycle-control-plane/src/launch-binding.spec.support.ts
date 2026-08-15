import type {
  AcceptedAttemptSpec,
  ActivationRecord,
  RuntimeObservationEnvelope,
} from '@agent-lcars/dispatch-contracts';
import { runtimeObservationPayloadSha256 } from '@agent-lcars/dispatch-contracts';
import { describe, expect, it } from 'vitest';

import { attemptTransitionDigest, reduceAttempt } from './attempt-reducer';
import {
  AuthorityConflict,
  type LifecycleAuthorityStorage,
  type TaskAuthorityLease,
} from './authority-storage';
import { admitAcceptedSpecForTest } from './authority-storage-test-support';
import {
  ingestVerifiedRunBinding,
  RunBindingIngressConflict,
  RunBindingIngressVerifier,
} from './launch-binding';
import type { BindingHistoryStorageHooks } from './launch-binding-history-test-support';
import {
  resolveLaunchForTest,
  writeAttemptForTest,
} from './launch-resolution-test-support';

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

function runBindingFromEnvelope(envelope: RuntimeObservationEnvelope) {
  if (envelope.payload.kind !== 'run-bound')
    throw new Error('expected a run-bound observation');
  return envelope.payload.binding;
}

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
  };
  return { activation, spec };
}

async function admittedInto(storage: LifecycleAuthorityStorage): Promise<{
  storage: LifecycleAuthorityStorage;
  lease: TaskAuthorityLease;
  spec: AcceptedAttemptSpec;
}> {
  const value = fixture();
  const admitted = await admitAcceptedSpecForTest({
    storage,
    activation: value.activation,
    spec: value.spec,
    ownerId: 'owner-1',
  });
  return { storage, lease: admitted.lease, spec: admitted.spec };
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
export type { BindingHistoryStorageHooks } from './launch-binding-history-test-support';

export function runVerifiedRunBindingStorageContract(
  makeStorage: () =>
    LifecycleAuthorityStorage | Promise<LifecycleAuthorityStorage>,
  hooks: BindingHistoryStorageHooks,
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
      expect(bound?.binding).toEqual(runBindingFromEnvelope(verified.envelope));
      expect(await ingestVerifiedRunBinding(storage, lease, verified)).toBe(
        'replay',
      );
    });

    it('records the exact run-bound fact, digest, and binding head', async () => {
      const { storage, lease, spec } = await admittedInto(await makeStorage());
      const verified = await verifier.verify({
        envelope: await envelope(spec),
        localAttemptMarker: spec.local.attemptMarker,
      });
      await ingestVerifiedRunBinding(storage, lease, verified);
      const history = await hooks.readAttemptHistory(storage, {
        lease,
        tenantId: spec.tenant.tenantId,
        attemptId: spec.attemptId,
      });
      expect(history?.head).toMatchObject({
        aggregateRevision: 2,
        binding: runBindingFromEnvelope(verified.envelope),
      });
      const fact = history?.records.fact[0];
      expect(fact?.payload).toMatchObject({
        factId: verified.envelope.factId,
        requestId: verified.envelope.requestId,
        canonicalDigest: expect.any(String),
        payloadSha256: verified.envelope.payloadSha256,
        payload: {
          kind: 'run-bound',
          binding: runBindingFromEnvelope(verified.envelope),
        },
      });
      expect(fact?.record).toMatchObject({
        sequence: 1,
        appliedRevision: 2,
        streamKind: 'fact',
      });
    });

    it('fails closed when admission-backed history is missing', async () => {
      const { storage, lease, spec } = await admittedInto(await makeStorage());
      hooks.deleteAttemptHistory(storage);
      const verified = await verifier.verify({
        envelope: await envelope(spec),
        localAttemptMarker: spec.local.attemptMarker,
      });
      await expect(
        ingestVerifiedRunBinding(storage, lease, verified),
      ).rejects.toBeInstanceOf(AuthorityConflict);
    });

    it('rejects corrupt binding heads, records, references, and admission lineage on replay', async () => {
      for (const corruption of [
        'head',
        'payload',
        'digest',
        'reference',
        'receipt',
        'task-pointer',
      ] as const) {
        const { storage, lease, spec } = await admittedInto(
          await makeStorage(),
        );
        const verified = await verifier.verify({
          envelope: await envelope(spec),
          localAttemptMarker: spec.local.attemptMarker,
        });
        await ingestVerifiedRunBinding(storage, lease, verified);
        if (corruption === 'head') hooks.corruptAttemptHistoryHead(storage);
        else if (
          corruption === 'payload' ||
          corruption === 'digest' ||
          corruption === 'reference'
        )
          hooks.corruptAttemptHistoryRecord(storage, corruption);
        else if (corruption === 'receipt')
          hooks.corruptAdmissionReceipt(storage);
        else hooks.corruptAdmissionTaskPointer(storage);
        await expect(
          ingestVerifiedRunBinding(storage, lease, verified),
        ).rejects.toBeInstanceOf(AuthorityConflict);
      }
    });

    it('accepts accepted and unknown launch progress before binding at revision three', async () => {
      for (const state of ['accepted', 'unknown'] as const) {
        const { storage, lease, spec } = await admittedInto(
          await makeStorage(),
        );
        const claim = await storage.claimLaunchWork({
          lease,
          tenantId: spec.tenant.tenantId,
          attemptId: spec.attemptId,
        });
        await resolveLaunchForTest({
          storage,
          lease,
          tenantId: spec.tenant.tenantId,
          attemptId: spec.attemptId,
          kind: state,
          at: TIME,
          work: claim?.work,
        });
        const verified = await verifier.verify({
          envelope: await envelope(spec),
          localAttemptMarker: spec.local.attemptMarker,
        });
        await expect(
          ingestVerifiedRunBinding(storage, lease, verified),
        ).resolves.toBe('applied');
        const history = await hooks.readAttemptHistory(storage, {
          lease,
          tenantId: spec.tenant.tenantId,
          attemptId: spec.attemptId,
        });
        expect(history?.head.aggregateRevision).toBe(3);
        expect(history?.records.command).toHaveLength(1);
        expect(history?.records.fact).toHaveLength(1);
        expect(history?.records.claim).toHaveLength(0);
        expect(history?.records.validation).toHaveLength(0);
        expect(history?.records.evidence).toHaveLength(0);
        expect(history?.records.fact[0]?.record.appliedRevision).toBe(3);
      }
    });

    it('replays a binding after later Attempt progress without appending history', async () => {
      const { storage, lease, spec } = await admittedInto(await makeStorage());
      const verified = await verifier.verify({
        envelope: await envelope(spec),
        localAttemptMarker: spec.local.attemptMarker,
      });
      await ingestVerifiedRunBinding(storage, lease, verified);
      const before = await hooks.readAttemptHistory(storage, {
        lease,
        tenantId: spec.tenant.tenantId,
        attemptId: spec.attemptId,
      });
      if (before === undefined) throw new Error('binding history disappeared');
      const attempt = await storage.readAttempt({
        tenantId: spec.tenant.tenantId,
        attemptId: spec.attemptId,
      });
      if (attempt === undefined) throw new Error('bound attempt disappeared');
      const heartbeatPayload = {
        kind: 'heartbeat' as const,
        grantId: 'grant-later-progress',
        at: TIME,
        phase: 'agent-execution' as const,
      };
      const heartbeatEnvelope = await envelope(spec, {
        factId: 'fact-later-progress',
        requestId: 'request-later-progress',
        payload: heartbeatPayload,
        payloadSha256: await runtimeObservationPayloadSha256(heartbeatPayload),
      });
      const heartbeat = reduceAttempt(attempt, {
        kind: 'transition',
        expectedRevision: attempt.revision,
        transitionedAt: TIME,
        canonicalDigest: attemptTransitionDigest({
          kind: 'observation',
          envelope: heartbeatEnvelope,
        }),
        event: {
          kind: 'observation',
          envelope: heartbeatEnvelope,
        },
      });
      if (heartbeat.status !== 'applied')
        throw new Error('later progress was not applied');
      await writeAttemptForTest({
        storage,
        lease,
        expectedRevision: attempt.revision,
        next: heartbeat.state,
      });
      await expect(
        ingestVerifiedRunBinding(storage, lease, verified),
      ).resolves.toBe('replay');
      const after = await hooks.readAttemptHistory(storage, {
        lease,
        tenantId: spec.tenant.tenantId,
        attemptId: spec.attemptId,
      });
      expect(after?.head).toEqual(before.head);
      expect(after?.records.fact).toHaveLength(1);
      expect(after?.records.fact[0]?.record).toEqual(
        before.records.fact[0]?.record,
      );
    });

    it('supports true legacy binding and replay when no lineage or history exists', async () => {
      const { storage, lease, spec } = await admittedInto(await makeStorage());
      hooks.deleteAdmissionLineage(storage);
      const verified = await verifier.verify({
        envelope: await envelope(spec),
        localAttemptMarker: spec.local.attemptMarker,
      });
      await expect(
        ingestVerifiedRunBinding(storage, lease, verified),
      ).resolves.toBe('applied');
      await expect(
        ingestVerifiedRunBinding(storage, lease, verified),
      ).resolves.toBe('replay');
      await expect(
        hooks.readAttemptHistory(storage, {
          lease,
          tenantId: spec.tenant.tenantId,
          attemptId: spec.attemptId,
        }),
      ).resolves.toBeUndefined();
    });

    it('rolls back all binding state when the history commit fails', async () => {
      const { storage, lease, spec } = await admittedInto(await makeStorage());
      await hooks.prepareAwaitingBindingCancellation(storage, lease, spec);
      const beforeCancellation = await storage.listCancellationWork({
        tenantId: spec.tenant.tenantId,
        state: 'awaiting-binding',
      });
      expect(beforeCancellation).toHaveLength(1);
      const restore = hooks.failAttemptHistoryCommit(storage);
      const verified = await verifier.verify({
        envelope: await envelope(spec),
        localAttemptMarker: spec.local.attemptMarker,
      });
      await expect(
        ingestVerifiedRunBinding(storage, lease, verified),
      ).rejects.toThrow();
      restore();
      const rolledBack = await storage.readAttempt({
        tenantId: spec.tenant.tenantId,
        attemptId: spec.attemptId,
      });
      expect(rolledBack).toMatchObject({ revision: 2, phase: 'cancelling' });
      expect(rolledBack?.binding).toBeUndefined();
      expect(
        await storage.listCancellationWork({
          tenantId: spec.tenant.tenantId,
          state: 'awaiting-binding',
        }),
      ).toEqual(beforeCancellation);
      expect(
        await storage.listCancellationWork({
          tenantId: spec.tenant.tenantId,
          state: 'pending',
        }),
      ).toHaveLength(0);
      expect(await ingestVerifiedRunBinding(storage, lease, verified)).toBe(
        'applied',
      );
    });

    it('does not leak a global binding index when history commit fails', async () => {
      const { storage, lease, spec } = await admittedInto(await makeStorage());
      const restore = hooks.failAttemptHistoryCommit(storage);
      const verified = await verifier.verify({
        envelope: await envelope(spec),
        localAttemptMarker: spec.local.attemptMarker,
      });
      await expect(
        ingestVerifiedRunBinding(storage, lease, verified),
      ).rejects.toThrow();
      restore();
      const internals = hooks.inspectBindingInternals(storage);
      expect(internals.factKeys).toBe(0);
      expect(internals.requestKeys).toBe(0);
      expect(internals.bindings).toBe(0);
      const secondSpec: AcceptedAttemptSpec = {
        ...spec,
        requestId: 'request-second-after-failure',
        attemptId: 'B'.repeat(22),
        task: { ...spec.task, issueNumber: 10 },
        local: {
          ...spec.local,
          intentId: 'intent-second-after-failure',
          attemptMarker: 'g1:intent-second-after-failure',
          idempotencyKey: 'admit-second-after-failure',
        },
      };
      const second = await admitAcceptedSpecForTest({
        storage,
        activation: { ...fixture().activation, tenant: secondSpec.tenant },
        spec: secondSpec,
        ownerId: 'owner-second-after-failure',
      });
      const secondBinding = await verifier.verify({
        envelope: await envelope(second.spec),
        localAttemptMarker: second.spec.local.attemptMarker,
      });
      await expect(
        ingestVerifiedRunBinding(storage, second.lease, secondBinding),
      ).resolves.toBe('applied');
      await expect(
        ingestVerifiedRunBinding(storage, second.lease, secondBinding),
      ).resolves.toBe('replay');
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
        const claim =
          state === 'pending'
            ? undefined
            : await storage.claimLaunchWork({
                lease,
                tenantId: spec.tenant.tenantId,
                attemptId: spec.attemptId,
              });
        if (state === 'accepted' || state === 'unknown') {
          await resolveLaunchForTest({
            storage,
            lease,
            tenantId: spec.tenant.tenantId,
            attemptId: spec.attemptId,
            kind: state,
            at: TIME,
            work: claim?.work,
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
        ).toEqual(runBindingFromEnvelope(verified.envelope));
      }
    });

    it('does not let a delayed launch response regress an exact bound run', async () => {
      const { storage, lease, spec } = await admittedInto(await makeStorage());
      await storage.claimLaunchWork({
        lease,
        tenantId: spec.tenant.tenantId,
        attemptId: spec.attemptId,
      });
      const verified = await verifier.verify({
        envelope: await envelope(spec),
        localAttemptMarker: spec.local.attemptMarker,
      });
      await ingestVerifiedRunBinding(storage, lease, verified);
      await expect(
        storage.claimLaunchWork({
          lease,
          tenantId: spec.tenant.tenantId,
          attemptId: spec.attemptId,
        }),
      ).resolves.toEqual({ status: 'terminal' });
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
      await writeAttemptForTest({
        storage,
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
      const history = await hooks.readAttemptHistory(storage, {
        lease,
        tenantId: spec.tenant.tenantId,
        attemptId: spec.attemptId,
      });
      expect(history?.head.aggregateRevision).toBe(3);
      expect(history?.records.command).toHaveLength(1);
      expect(history?.records.fact).toHaveLength(1);
      expect(
        history?.records.fact.filter(
          ({ payload }) =>
            (payload as { payload?: { kind?: string } }).payload?.kind ===
            'run-bound',
        ),
      ).toHaveLength(1);
      expect(
        history?.records.fact.find(
          ({ payload }) =>
            (payload as { payload?: { kind?: string } }).payload?.kind ===
            'run-bound',
        )?.record.appliedRevision,
      ).toBe(3);
      expect(history?.head.phase).toBe('active');
      expect(history?.head.finalization).toBeUndefined();
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
      const secondAdmission = await admitAcceptedSpecForTest({
        storage,
        activation: { ...fixture().activation, tenant: secondSpec.tenant },
        spec: secondSpec,
        ownerId: 'owner-2',
      });
      const secondLease = secondAdmission.lease;
      const admittedSecondSpec = secondAdmission.spec;
      const colliding = await verifier.verify({
        envelope: await envelope(admittedSecondSpec),
        localAttemptMarker: admittedSecondSpec.local.attemptMarker,
      });
      await expect(
        ingestVerifiedRunBinding(storage, secondLease, colliding),
      ).rejects.toBeInstanceOf(AuthorityConflict);
      const secondHistory = await hooks.readAttemptHistory(storage, {
        lease: secondLease,
        tenantId: admittedSecondSpec.tenant.tenantId,
        attemptId: admittedSecondSpec.attemptId,
      });
      expect(secondHistory?.records.command).toHaveLength(1);
      expect(secondHistory?.records.fact).toHaveLength(0);
      expect(
        await storage.readAttempt({
          tenantId: admittedSecondSpec.tenant.tenantId,
          attemptId: admittedSecondSpec.attemptId,
        }),
      ).toMatchObject({ revision: 1, phase: 'launch-pending' });
      expect(
        (
          await storage.readLaunch({
            tenantId: admittedSecondSpec.tenant.tenantId,
            attemptId: admittedSecondSpec.attemptId,
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
              ...runBindingFromEnvelope(first.envelope),
              runId: 99,
              checkRunId: 100,
            },
          },
          payloadSha256: await runtimeObservationPayloadSha256({
            kind: 'run-bound',
            binding: {
              ...runBindingFromEnvelope(first.envelope),
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
      ).toEqual(runBindingFromEnvelope(first.envelope));
    });
  });
}
