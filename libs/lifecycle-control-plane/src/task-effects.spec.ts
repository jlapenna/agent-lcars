import type {
  ActivationRecord,
  ControlPlaneSignalEnvelope,
  PolicyDecision,
} from '@agent-lcars/dispatch-contracts';
import { runtimeObservationPayloadSha256 } from '@agent-lcars/dispatch-contracts';
import { describe, expect, it, vi } from 'vitest';

import type { AttemptState } from './attempt-reducer';
import {
  type AuthorityClock,
  AuthorityConflict,
  InMemoryLifecycleAuthorityStorage,
  type LifecycleAuthorityStorage,
  type TaskAuthorityLease,
  type WriteResult,
} from './authority-storage';
import { CancellationTaskEffectCoordinator } from './cancellation-effects';
import {
  ingestVerifiedRunBinding,
  RunBindingIngressVerifier,
} from './launch-binding';
import { LaunchResponseBoundary } from './launch-resolution-capability';
import { writeAttemptForTest } from './launch-resolution-test-support';
import { TaskAttemptAdmissionCoordinator } from './task-attempt-admission';
import {
  mintAdmissionEffectCompletion,
  mintTaskEffectTransition,
} from './task-effect-capability';
import { AdmissionTaskEffectCoordinator } from './task-effects';

const T0 = '2026-08-21T00:00:00.000Z';
const T1 = '2026-08-21T01:00:00.000Z';
const SHA = 'a'.repeat(64);
const tenant = {
  tenantId: 'tenant-effects',
  repositoryId: 111,
  repository: 'octo/effects',
  installationId: 222,
};
const task = {
  tenantId: tenant.tenantId,
  repositoryId: tenant.repositoryId,
  issueNumber: 3,
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

function activation(
  mode: ActivationRecord['mode'] = 'central-authoritative',
): ActivationRecord {
  return {
    schema: 'agent-lcars.control-plane-activation/v1',
    version: 1,
    tenant,
    taskClassId: 'github-issue',
    activationId: mode === 'shadow' ? 'shadow-2' : 'central-1',
    authorityEpoch: mode === 'shadow' ? 2 : 1,
    effectiveBoundary: 1,
    mode,
    effectMode: mode === 'central-authoritative' ? 'enabled' : 'none',
    recordedAt: T0,
  };
}

function envelope(factId = 'fact-1'): ControlPlaneSignalEnvelope {
  return {
    schema: 'agent-lcars.control-plane-signal/v1',
    version: 1,
    requestId: `request-${factId}`,
    factId,
    tenant,
    task,
    signal: {
      kind: 'requested-work',
      mode: 'implement',
      requestKey: `key-${factId}`,
    },
    receivedAt: T0,
    source: {
      kind: 'github-webhook',
      deliveryId: `delivery-${factId}`,
      repositoryId: tenant.repositoryId,
      installationId: tenant.installationId,
      bodySha256: SHA,
      event: 'issues',
      action: 'labeled',
      actorId: 8,
      actorLogin: 'octo',
      occurredAt: T0,
      hmacKeyVersion: 'key-v1',
    },
  };
}

function policy(factId: string): PolicyDecision {
  return {
    schema: 'agent-lcars.policy-decision/v1',
    version: 1,
    policy: { policyId: 'policy-1', policyVersion: 1, contentSha256: SHA },
    decision: 'accepted',
    ruleId: 'maintainer',
    sourceFactId: factId,
    principal: { kind: 'github-actor', actorId: 8, login: 'octo' },
    evidenceRef: `evidence-${factId}`,
    decidedAt: T0,
  };
}

function transition(
  clock: Clock,
  factId = 'fact-1',
  expectedRevision = 0,
  active = activation(),
) {
  const signal = envelope(factId);
  return mintTaskEffectTransition(
    {
      expectedRevision,
      envelope: signal,
      policyDecision: policy(factId),
      activation: active,
      candidate: {
        intentId: `intent-${factId}`,
        semanticKey: `semantic-${factId}`,
        semanticDigest: SHA,
        orderingKey: { occurredAt: T0, tieBreaker: `tie-${factId}` },
      },
    },
    clock,
  );
}

export interface TaskEffectStorageFactory {
  create(clock: AuthorityClock): LifecycleAuthorityStorage;
}

/** Reusable backend-agnostic contract for the #1051 durable work seam. */
export function runTaskEffectStorageContract(
  factory: TaskEffectStorageFactory,
): void {
  describe('task effect storage contract', () => {
    it('atomically records exact reducer effects and replays the original receipt', async () => {
      const clock = new Clock();
      const storage = factory.create(clock);
      await storage.registerActivation(activation());
      const lease = await storage.acquireTaskLease({
        scope: task,
        ownerId: 'one',
        leaseDurationMs: 60_000,
      });
      const command = transition(clock);
      const first = await storage.applyTaskEffectTransition({
        lease,
        transition: command,
      });
      const replay = await storage.applyTaskEffectTransition({
        lease,
        transition: command,
      });
      expect(first).toMatchObject({
        status: 'applied',
        effects: [
          { payload: { kind: 'admit-attempt' }, deliveryState: 'pending' },
        ],
      });
      expect(replay).toEqual({ ...first, status: 'replay' });
      await expect(
        storage.applyTaskEffectTransition({ lease, transition: {} as never }),
      ).rejects.toThrow(AuthorityConflict);
      const changed = mintTaskEffectTransition(
        {
          expectedRevision: 0,
          envelope: envelope(),
          policyDecision: policy('fact-1'),
          activation: activation(),
          candidate: {
            intentId: 'intent-fact-1',
            semanticKey: 'changed-semantic',
            semanticDigest: SHA,
            orderingKey: { occurredAt: T0, tieBreaker: 'tie-fact-1' },
          },
        },
        clock,
      );
      await expect(
        storage.applyTaskEffectTransition({ lease, transition: changed }),
      ).rejects.toThrow(AuthorityConflict);
    });

    it('fences work claims and rejects stale completion', async () => {
      const clock = new Clock();
      const storage = factory.create(clock);
      await storage.registerActivation(activation());
      const firstLease = await storage.acquireTaskLease({
        scope: task,
        ownerId: 'one',
        leaseDurationMs: 1,
      });
      const result = await storage.applyTaskEffectTransition({
        lease: firstLease,
        transition: transition(clock),
      });
      const effect = result.effects[0];
      if (effect === undefined) throw new Error('missing effect');
      const firstClaim = await storage.claimTaskEffect({
        lease: firstLease,
        tenantId: tenant.tenantId,
        task,
        sourceFactId: effect.sourceFactId,
        effectKey: effect.effectKey,
      });
      clock.set(T1);
      const laterLease = await storage.acquireTaskLease({
        scope: task,
        ownerId: 'two',
        leaseDurationMs: 60_000,
      });
      await storage.claimTaskEffect({
        lease: laterLease,
        tenantId: tenant.tenantId,
        task,
        sourceFactId: effect.sourceFactId,
        effectKey: effect.effectKey,
      });
      await expect(
        storage.completeTaskEffect({
          lease: firstLease,
          completion: mintAdmissionEffectCompletion({
            tenantId: tenant.tenantId,
            task,
            sourceFactId: effect.sourceFactId,
            effectKey: effect.effectKey,
            attemptId: 'A'.repeat(22),
            claimToken: firstClaim.effect.claimToken as string,
          }),
        }),
      ).rejects.toThrow(AuthorityConflict);
    });

    it('keeps a shadow transition as a durable zero-effect receipt and permits replay after cutover', async () => {
      const clock = new Clock();
      const storage = factory.create(clock);
      const central = activation();
      await storage.registerActivation(central);
      const lease = await storage.acquireTaskLease({
        scope: task,
        ownerId: 'one',
        leaseDurationMs: 60_000,
      });
      const command = transition(clock);
      const first = await storage.applyTaskEffectTransition({
        lease,
        transition: command,
      });
      await storage.registerActivation(activation('shadow'));
      expect(
        (
          await storage.applyTaskEffectTransition({
            lease,
            transition: command,
          })
        ).effects,
      ).toEqual(first.effects);
      const shadowTask = { ...task, issueNumber: 4 };
      const shadowEnvelope = { ...envelope('fact-shadow'), task: shadowTask };
      const shadow = mintTaskEffectTransition(
        {
          expectedRevision: 0,
          envelope: shadowEnvelope,
          policyDecision: policy('fact-shadow'),
          activation: { ...activation('shadow'), tenant: { ...tenant } },
          candidate: {
            intentId: 'intent-shadow',
            semanticKey: 'semantic-shadow',
            semanticDigest: SHA,
            orderingKey: { occurredAt: T0, tieBreaker: 'shadow' },
          },
        },
        clock,
      );
      // This activation is scoped by tenant/task class, so the distinct task shares it.
      const shadowLease = await storage.acquireTaskLease({
        scope: shadowTask,
        ownerId: 'shadow',
        leaseDurationMs: 60_000,
      });
      expect(
        (
          await storage.applyTaskEffectTransition({
            lease: shadowLease,
            transition: shadow,
          })
        ).effects,
      ).toEqual([]);
    });

    it('replays before later Task advancement but rejects foreign and expired authority', async () => {
      const clock = new Clock();
      const storage = factory.create(clock);
      await storage.registerActivation(activation());
      const lease = await storage.acquireTaskLease({
        scope: task,
        ownerId: 'one',
        leaseDurationMs: 1,
      });
      const command = transition(clock);
      const initial = await storage.applyTaskEffectTransition({
        lease,
        transition: command,
      });
      const advanced = transition(clock, 'fact-2', 1);
      await storage.applyTaskEffectTransition({ lease, transition: advanced });
      expect(
        await storage.applyTaskEffectTransition({ lease, transition: command }),
      ).toEqual({ ...initial, status: 'replay' });
      const foreign = await storage.acquireTaskLease({
        scope: { ...task, issueNumber: 99 },
        ownerId: 'foreign',
        leaseDurationMs: 60_000,
      });
      await expect(
        storage.applyTaskEffectTransition({
          lease: foreign,
          transition: transition(clock, 'fact-3', 2),
        }),
      ).rejects.toThrow(AuthorityConflict);
      clock.set(T1);
      await expect(
        storage.applyTaskEffectTransition({
          lease,
          transition: transition(clock, 'fact-3', 2),
        }),
      ).rejects.toThrow(AuthorityConflict);
    });
  });
}

runTaskEffectStorageContract({
  create: (clock) => new InMemoryLifecycleAuthorityStorage(clock),
});

export interface CancellationEffectStorageFactory {
  create(
    clock: AuthorityClock,
  ): LifecycleAuthorityStorage | Promise<LifecycleAuthorityStorage>;
  /** Test-only setup seam; production storage never exposes a raw writer. */
  hydrateAttempt(input: {
    storage: LifecycleAuthorityStorage;
    lease: TaskAuthorityLease;
    expectedRevision: number;
    next: AttemptState;
  }): Promise<WriteResult>;
}

async function launchedCancellationEffect(
  storage: LifecycleAuthorityStorage,
  clock: Clock,
) {
  await storage.registerActivation(activation());
  const lease = await storage.acquireTaskLease({
    scope: task,
    ownerId: 'cancel-owner',
    leaseDurationMs: 60_000,
  });
  const desired = await storage.applyTaskEffectTransition({
    lease,
    transition: transition(clock),
  });
  const admission = desired.effects.find(
    (effect) => effect.payload.kind === 'admit-attempt',
  );
  if (admission === undefined) throw new Error('missing admission effect');
  const plans = {
    resolve: vi.fn(async () => ({
      workflowPath: '.github/workflows/worker.yml',
      workflowRef: 'refs/heads/main',
      workflowSha: SHA,
      mode: 'implement' as const,
      executorId: 'executor-1',
      credentialProfileId: 'profile-1',
      renewalDeadline: T1,
    })),
  };
  const admissionWorker = new AdmissionTaskEffectCoordinator(
    storage,
    new TaskAttemptAdmissionCoordinator(storage, plans),
  );
  await admissionWorker.reconcile({
    lease,
    tenantId: tenant.tenantId,
    task,
    sourceFactId: admission.sourceFactId,
    effectKey: admission.effectKey,
  });
  const admitted = await storage.readTask(task);
  if (admitted === undefined || admitted.attempt.kind !== 'launched') {
    throw new Error('missing launched task');
  }
  const cancelled = await storage.applyTaskEffectTransition({
    lease,
    transition: mintTaskEffectTransition(
      {
        expectedRevision: admitted.revision,
        envelope: {
          ...envelope('fact-cancel-launched'),
          signal: { kind: 'cancel', commandKey: 'cancel-launched' },
        },
        policyDecision: policy('fact-cancel-launched'),
        activation: activation(),
      },
      clock,
    ),
  });
  const effect = cancelled.effects.find(
    (candidate) => candidate.payload.kind === 'cancel-or-drain',
  );
  if (effect === undefined) throw new Error('missing cancel-or-drain effect');
  return {
    lease,
    effect,
    attemptId: admitted.attempt.attemptId,
    storage,
  };
}

/** Reusable async backend contract for #1057 cancellation truth/work. */
export function runCancellationEffectStorageContract(
  factory: CancellationEffectStorageFactory,
): void {
  describe('cancellation effect storage contract', () => {
    it('suppresses a never-claimed launch and replays its exact receipt', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
      await storage.registerActivation(activation());
      const lease = await storage.acquireTaskLease({
        scope: task,
        ownerId: 'one',
        leaseDurationMs: 60_000,
      });
      await storage.applyTaskEffectTransition({
        lease,
        transition: transition(clock),
      });
      const cancelled = await storage.applyTaskEffectTransition({
        lease,
        transition: mintTaskEffectTransition(
          {
            expectedRevision: 1,
            envelope: {
              ...envelope('fact-suppress'),
              signal: { kind: 'cancel', commandKey: 'cancel-suppress' },
            },
            policyDecision: policy('fact-suppress'),
            activation: activation(),
          },
          clock,
        ),
      });
      const effect = cancelled.effects.find(
        (candidate) => candidate.payload.kind === 'cancel-unlaunched',
      );
      if (effect === undefined)
        throw new Error('missing targetless cancellation');
      const coordinator = new CancellationTaskEffectCoordinator(storage, clock);
      const input = {
        lease,
        tenantId: tenant.tenantId,
        task,
        sourceFactId: effect.sourceFactId,
        effectKey: effect.effectKey,
      };
      const first = await coordinator.reconcile(input);
      expect(await coordinator.reconcile(input)).toEqual(first);
      expect(first.effect.deliveryState).toBe('complete');
      expect(
        await storage.listCancellationWork({ tenantId: tenant.tenantId }),
      ).toEqual([]);
    });

    it('terminalizes an admitted but unclaimed launch and makes it non-dispatchable', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
      const value = await launchedCancellationEffect(storage, clock);
      const coordinator = new CancellationTaskEffectCoordinator(storage, clock);
      const cancelled = await coordinator.reconcile({
        lease: value.lease,
        tenantId: tenant.tenantId,
        task,
        sourceFactId: value.effect.sourceFactId,
        effectKey: value.effect.effectKey,
      });
      expect(cancelled).toMatchObject({
        effect: { deliveryState: 'complete' },
        attempt: {
          phase: 'terminal',
          outcome: { execution: 'not_started' },
        },
      });
      expect(
        await storage.readLaunch({
          tenantId: tenant.tenantId,
          attemptId: value.attemptId,
        }),
      ).toMatchObject({ state: 'suppressed' });
      expect(
        await storage.claimLaunchWork({
          lease: value.lease,
          tenantId: tenant.tenantId,
          attemptId: value.attemptId,
        }),
      ).toEqual({ status: 'terminal' });
      const terminal = await storage.readAttempt({
        tenantId: tenant.tenantId,
        attemptId: value.attemptId,
      });
      if (terminal === undefined) throw new Error('missing terminal attempt');
      const verifier = new RunBindingIngressVerifier({
        async verifyExactRunBinding() {
          return undefined;
        },
      });
      const payload = {
        kind: 'run-bound' as const,
        binding: {
          runId: 17,
          runAttempt: 1,
          checkRunId: 18,
          workflowPath: terminal.spec.execution.workflowPath,
          workflowRef: terminal.spec.execution.workflowRef,
          workflowSha: terminal.spec.execution.workflowSha,
        },
      };
      await expect(
        ingestVerifiedRunBinding(
          storage,
          value.lease,
          await verifier.verify({
            localAttemptMarker: terminal.spec.local.attemptMarker,
            envelope: {
              schema: 'agent-lcars.runtime-observation/v1',
              version: 1,
              requestId: 'request-suppressed-binding',
              factId: 'fact-suppressed-binding',
              attemptId: terminal.spec.attemptId,
              tenant: terminal.spec.tenant,
              task: terminal.spec.task,
              source: { kind: 'github-provider', sourceId: 'provider' },
              observedAt: T0,
              payloadSha256: await runtimeObservationPayloadSha256(payload),
              payload,
            },
          }),
        ),
      ).rejects.toThrow(AuthorityConflict);
      expect(
        await storage.readAttempt({
          tenantId: tenant.tenantId,
          attemptId: value.attemptId,
        }),
      ).toEqual(terminal);
      expect(
        await storage.listCancellationWork({ tenantId: tenant.tenantId }),
      ).toEqual([]);
    });

    it('records cancelling truth before a late accepted launch and promotes binding work atomically', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
      const value = await launchedCancellationEffect(storage, clock);
      const launch = await storage.claimLaunchWork({
        lease: value.lease,
        tenantId: tenant.tenantId,
        attemptId: value.attemptId,
      });
      if (launch.work === undefined) throw new Error('missing launch work');
      const worker = new CancellationTaskEffectCoordinator(storage, clock);
      const cancelled = await worker.reconcile({
        lease: value.lease,
        tenantId: tenant.tenantId,
        task,
        sourceFactId: value.effect.sourceFactId,
        effectKey: value.effect.effectKey,
      });
      expect(cancelled.work?.state).toBe('awaiting-binding');
      const before = await storage.readAttempt({
        tenantId: tenant.tenantId,
        attemptId: value.attemptId,
      });
      expect(before?.phase).toBe('cancelling');
      const resolution = await new LaunchResponseBoundary(
        {
          resolve: async () => ({
            kind: 'accepted' as const,
            responseSha256: SHA,
          }),
        },
        clock,
      ).resolve(launch.work);
      await storage.resolveVerifiedLaunch({ lease: value.lease, resolution });
      const accepted = await storage.readAttempt({
        tenantId: tenant.tenantId,
        attemptId: value.attemptId,
      });
      expect(accepted).toMatchObject({
        phase: 'cancelling',
        launch: { state: 'accepted' },
      });
      if (accepted === undefined) throw new Error('missing cancelled attempt');
      const verifier = new RunBindingIngressVerifier({
        async verifyExactRunBinding() {
          return undefined;
        },
      });
      const payload = {
        kind: 'run-bound' as const,
        binding: {
          runId: 1,
          runAttempt: 1,
          checkRunId: 2,
          workflowPath: accepted.spec.execution.workflowPath,
          workflowRef: accepted.spec.execution.workflowRef,
          workflowSha: accepted.spec.execution.workflowSha,
        },
      };
      await ingestVerifiedRunBinding(
        storage,
        value.lease,
        await verifier.verify({
          localAttemptMarker: accepted.spec.local.attemptMarker,
          envelope: {
            schema: 'agent-lcars.runtime-observation/v1',
            version: 1,
            requestId: 'request-binding-cancel',
            factId: 'fact-binding-cancel',
            attemptId: accepted.spec.attemptId,
            tenant: accepted.spec.tenant,
            task: accepted.spec.task,
            source: { kind: 'github-provider', sourceId: 'provider' },
            observedAt: T0,
            payloadSha256: await runtimeObservationPayloadSha256(payload),
            payload,
          },
        }),
      );
      expect(
        await storage.listCancellationWork({ tenantId: tenant.tenantId }),
      ).toMatchObject([{ attemptId: value.attemptId, state: 'pending' }]);
    });

    it('preserves cancelling truth when an in-flight launch resolves unknown', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
      const value = await launchedCancellationEffect(storage, clock);
      const launch = await storage.claimLaunchWork({
        lease: value.lease,
        tenantId: tenant.tenantId,
        attemptId: value.attemptId,
      });
      if (launch.work === undefined) throw new Error('missing launch work');
      const worker = new CancellationTaskEffectCoordinator(storage, clock);
      await worker.reconcile({
        lease: value.lease,
        tenantId: tenant.tenantId,
        task,
        sourceFactId: value.effect.sourceFactId,
        effectKey: value.effect.effectKey,
      });
      await storage.resolveVerifiedLaunch({
        lease: value.lease,
        resolution: await new LaunchResponseBoundary(
          {
            resolve: async () => ({
              kind: 'unknown' as const,
              responseSha256: SHA,
            }),
          },
          clock,
        ).resolve(launch.work),
      });
      expect(
        await storage.readAttempt({
          tenantId: tenant.tenantId,
          attemptId: value.attemptId,
        }),
      ).toMatchObject({
        phase: 'cancelling',
        launch: { state: 'response-unknown' },
        futureGrantsDenied: true,
      });
      expect(
        await storage.listCancellationWork({ tenantId: tenant.tenantId }),
      ).toMatchObject([
        { attemptId: value.attemptId, state: 'awaiting-binding' },
      ]);
    });

    it('records cancellation and denies grants during finalization without creating drain work', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
      const value = await launchedCancellationEffect(storage, clock);
      const attempt = await storage.readAttempt({
        tenantId: tenant.tenantId,
        attemptId: value.attemptId,
      });
      if (attempt === undefined) throw new Error('missing admitted attempt');
      await factory.hydrateAttempt({
        storage,
        lease: value.lease,
        expectedRevision: attempt.revision,
        next: {
          ...attempt,
          revision: attempt.revision + 1,
          phase: 'result-observed',
          finalization: {
            terminalFactId: 'terminal-finalizing',
            terminalConclusion: 'success',
            openedAt: T0,
            closesAt: T1,
            evidence: [],
          },
        },
      });
      const cancelled = await new CancellationTaskEffectCoordinator(
        storage,
        clock,
      ).reconcile({
        lease: value.lease,
        tenantId: tenant.tenantId,
        task,
        sourceFactId: value.effect.sourceFactId,
        effectKey: value.effect.effectKey,
      });
      expect(cancelled).toMatchObject({
        effect: { deliveryState: 'complete' },
        attempt: {
          phase: 'result-observed',
          cancellation: { eventId: expect.any(String) },
          futureGrantsDenied: true,
        },
      });
      expect(cancelled.work).toBeUndefined();
      expect(
        await storage.listCancellationWork({ tenantId: tenant.tenantId }),
      ).toEqual([]);
    });

    it('completes cancellation as a pure no-op when the pinned Attempt is already terminal', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
      const value = await launchedCancellationEffect(storage, clock);
      const attempt = await storage.readAttempt({
        tenantId: tenant.tenantId,
        attemptId: value.attemptId,
      });
      if (attempt === undefined) throw new Error('missing admitted attempt');
      await factory.hydrateAttempt({
        storage,
        lease: value.lease,
        expectedRevision: attempt.revision,
        next: {
          ...attempt,
          revision: attempt.revision + 1,
          phase: 'terminal',
          futureGrantsDenied: true,
          outcome: {
            schema: 'agent-lcars.attempt-outcome/v1',
            version: 1,
            attemptId: attempt.spec.attemptId,
            terminalState: 'cancelled',
            execution: 'not_started',
            result: 'none',
            evidence: {
              kind: 'lifecycle-decision',
              decisionFactId: 'prior-cancel',
            },
            evidenceValidation: { status: 'not-applicable' },
            finalizedAt: T0,
          },
        },
      });
      const completed = await new CancellationTaskEffectCoordinator(
        storage,
        clock,
      ).reconcile({
        lease: value.lease,
        tenantId: tenant.tenantId,
        task,
        sourceFactId: value.effect.sourceFactId,
        effectKey: value.effect.effectKey,
      });
      expect(completed).toMatchObject({
        effect: { deliveryState: 'complete' },
        attempt: { phase: 'terminal', outcome: { terminalState: 'cancelled' } },
      });
      expect(completed.work).toBeUndefined();
    });

    it('recovers a claimed cancellation after crash under a later fence despite a prospective shadow registration', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
      const value = await launchedCancellationEffect(storage, clock);
      await storage.claimTaskEffect({
        lease: value.lease,
        tenantId: tenant.tenantId,
        task,
        sourceFactId: value.effect.sourceFactId,
        effectKey: value.effect.effectKey,
      });
      await storage.registerActivation(activation('shadow'));
      clock.set(T1);
      const later = await storage.acquireTaskLease({
        scope: task,
        ownerId: 'later-cancel-owner',
        leaseDurationMs: 60_000,
      });
      const recovered = await new CancellationTaskEffectCoordinator(
        storage,
        clock,
      ).reconcile({
        lease: later,
        tenantId: tenant.tenantId,
        task,
        sourceFactId: value.effect.sourceFactId,
        effectKey: value.effect.effectKey,
      });
      expect(recovered).toMatchObject({
        effect: { deliveryState: 'complete' },
        attempt: { phase: 'terminal' },
      });
    });

    it('fails closed for forged, foreign, and expired cancellation authority', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
      const value = await launchedCancellationEffect(storage, clock);
      await expect(
        storage.applyVerifiedCancellationEffect({
          lease: value.lease,
          cancellation: {} as never,
        }),
      ).rejects.toThrow(AuthorityConflict);
      const worker = new CancellationTaskEffectCoordinator(storage, clock);
      await expect(
        worker.reconcile({
          lease: value.lease,
          tenantId: 'other-tenant',
          task,
          sourceFactId: value.effect.sourceFactId,
          effectKey: value.effect.effectKey,
        }),
      ).rejects.toThrow(AuthorityConflict);
      clock.set(T1);
      await expect(
        worker.reconcile({
          lease: value.lease,
          tenantId: tenant.tenantId,
          task,
          sourceFactId: value.effect.sourceFactId,
          effectKey: value.effect.effectKey,
        }),
      ).rejects.toThrow(AuthorityConflict);
    });
  });
}

runCancellationEffectStorageContract({
  create: (clock) => new InMemoryLifecycleAuthorityStorage(clock),
  hydrateAttempt: writeAttemptForTest,
});

describe('AdmissionTaskEffectCoordinator', () => {
  it('returns the immutable cancellation receipt after commit/retry without new work', async () => {
    const clock = new Clock();
    const storage = new InMemoryLifecycleAuthorityStorage(clock);
    await storage.registerActivation(activation());
    const lease = await storage.acquireTaskLease({
      scope: task,
      ownerId: 'one',
      leaseDurationMs: 60_000,
    });
    await storage.applyTaskEffectTransition({
      lease,
      transition: transition(clock),
    });
    const parked = await storage.applyTaskEffectTransition({
      lease,
      transition: mintTaskEffectTransition(
        {
          expectedRevision: 1,
          envelope: {
            ...envelope('fact-cancel-retry'),
            signal: { kind: 'cancel', commandKey: 'cancel-retry' },
          },
          policyDecision: policy('fact-cancel-retry'),
          activation: activation(),
        },
        clock,
      ),
    });
    const effect = parked.effects.find(
      (candidate) => candidate.payload.kind === 'cancel-unlaunched',
    );
    if (effect === undefined) throw new Error('missing cancellation effect');
    const coordinator = new CancellationTaskEffectCoordinator(storage, clock);
    const input = {
      lease,
      tenantId: tenant.tenantId,
      task,
      sourceFactId: effect.sourceFactId,
      effectKey: effect.effectKey,
    };

    const committed = await coordinator.reconcile(input);
    const replay = await coordinator.reconcile(input);

    expect(replay).toEqual(committed);
    expect(replay.effect.deliveryState).toBe('complete');
    expect(
      await storage.listCancellationWork({ tenantId: tenant.tenantId }),
    ).toEqual([]);
  });

  it('leaves cancel and park work durably pending without claiming provider behavior', async () => {
    const clock = new Clock();
    const storage = new InMemoryLifecycleAuthorityStorage(clock);
    await storage.registerActivation(activation());
    const lease = await storage.acquireTaskLease({
      scope: task,
      ownerId: 'one',
      leaseDurationMs: 60_000,
    });
    await storage.applyTaskEffectTransition({
      lease,
      transition: transition(clock),
    });
    const parkEnvelope = {
      ...envelope('fact-park'),
      signal: { kind: 'park' as const, commandKey: 'park-1' },
    };
    const parked = await storage.applyTaskEffectTransition({
      lease,
      transition: mintTaskEffectTransition(
        {
          expectedRevision: 1,
          envelope: parkEnvelope,
          policyDecision: policy('fact-park'),
          activation: activation(),
        },
        clock,
      ),
    });
    expect(parked.effects.map((effect) => effect.payload.kind)).toEqual([
      'cancel-unlaunched',
      'park-projection',
    ]);
    const worker = new AdmissionTaskEffectCoordinator(
      storage,
      new TaskAttemptAdmissionCoordinator(storage, {
        resolve: vi.fn(),
      }),
    );
    for (const effect of parked.effects) {
      expect(
        await worker.reconcile({
          lease,
          tenantId: tenant.tenantId,
          task,
          sourceFactId: effect.sourceFactId,
          effectKey: effect.effectKey,
        }),
      ).toMatchObject({
        status: 'deferred',
        effect: { deliveryState: 'pending' },
      });
    }
  });

  it('completes admission only after its durable #1048 receipt and leaves other work pending', async () => {
    const clock = new Clock();
    const storage = new InMemoryLifecycleAuthorityStorage(clock);
    await storage.registerActivation(activation());
    const lease = await storage.acquireTaskLease({
      scope: task,
      ownerId: 'one',
      leaseDurationMs: 60_000,
    });
    const reduced = await storage.applyTaskEffectTransition({
      lease,
      transition: transition(clock),
    });
    const effect = reduced.effects[0];
    if (effect === undefined) throw new Error('missing effect');
    const plans = {
      resolve: vi.fn(async () => ({
        workflowPath: '.github/workflows/worker.yml',
        workflowRef: 'refs/heads/main',
        workflowSha: SHA,
        mode: 'implement' as const,
        executorId: 'executor-1',
        credentialProfileId: 'profile-1',
        renewalDeadline: T1,
      })),
    };
    const worker = new AdmissionTaskEffectCoordinator(
      storage,
      new TaskAttemptAdmissionCoordinator(storage, plans),
    );
    const completed = await worker.reconcile({
      lease,
      tenantId: tenant.tenantId,
      task,
      sourceFactId: effect.sourceFactId,
      effectKey: effect.effectKey,
    });
    expect(completed).toMatchObject({
      status: 'completed',
      effect: {
        deliveryState: 'complete',
        completion: { kind: 'admission-receipt' },
      },
    });
    expect(plans.resolve).toHaveBeenCalledTimes(1);
  });

  it('obsoletes a pending central admission after shadow cutover without resolving a plan', async () => {
    const clock = new Clock();
    const storage = new InMemoryLifecycleAuthorityStorage(clock);
    await storage.registerActivation(activation());
    const lease = await storage.acquireTaskLease({
      scope: task,
      ownerId: 'one',
      leaseDurationMs: 60_000,
    });
    const reduced = await storage.applyTaskEffectTransition({
      lease,
      transition: transition(clock),
    });
    const effect = reduced.effects[0];
    if (effect === undefined) throw new Error('missing effect');
    await storage.registerActivation(activation('shadow'));
    const plans = { resolve: vi.fn() };
    const worker = new AdmissionTaskEffectCoordinator(
      storage,
      new TaskAttemptAdmissionCoordinator(storage, plans),
    );
    expect(
      await worker.reconcile({
        lease,
        tenantId: tenant.tenantId,
        task,
        sourceFactId: effect.sourceFactId,
        effectKey: effect.effectKey,
      }),
    ).toMatchObject({
      status: 'deferred',
      effect: {
        deliveryState: 'obsolete',
        obsoleteReason: 'activation-no-longer-authoritative',
      },
    });
    expect(plans.resolve).not.toHaveBeenCalled();
  });

  it('obsoletes a superseded admission and keeps the replacement work pending', async () => {
    const clock = new Clock();
    const storage = new InMemoryLifecycleAuthorityStorage(clock);
    await storage.registerActivation(activation());
    const lease = await storage.acquireTaskLease({
      scope: task,
      ownerId: 'one',
      leaseDurationMs: 60_000,
    });
    const first = await storage.applyTaskEffectTransition({
      lease,
      transition: transition(clock),
    });
    const replaced = await storage.applyTaskEffectTransition({
      lease,
      transition: transition(clock, 'fact-2', 1),
    });
    const oldEffect = first.effects[0];
    const replacementEffect = replaced.effects.find(
      (effect) => effect.payload.kind === 'admit-attempt',
    );
    if (oldEffect === undefined || replacementEffect === undefined) {
      throw new Error('missing admission effect');
    }
    const plans = { resolve: vi.fn() };
    const worker = new AdmissionTaskEffectCoordinator(
      storage,
      new TaskAttemptAdmissionCoordinator(storage, plans),
    );
    const input = {
      lease,
      tenantId: tenant.tenantId,
      task,
      sourceFactId: oldEffect.sourceFactId,
      effectKey: oldEffect.effectKey,
    };

    await expect(worker.reconcile(input)).resolves.toMatchObject({
      status: 'deferred',
      effect: { deliveryState: 'obsolete', obsoleteReason: 'superseded' },
    });
    await expect(worker.reconcile(input)).resolves.toMatchObject({
      status: 'deferred',
      effect: { deliveryState: 'obsolete', obsoleteReason: 'superseded' },
    });
    expect(plans.resolve).not.toHaveBeenCalled();
    await expect(
      storage.readTaskEffect({
        tenantId: tenant.tenantId,
        task,
        sourceFactId: replacementEffect.sourceFactId,
        effectKey: replacementEffect.effectKey,
      }),
    ).resolves.toMatchObject({ deliveryState: 'pending' });
  });

  it('recovers after an admission receipt before completion without a second plan resolution', async () => {
    const clock = new Clock();
    const storage = new InMemoryLifecycleAuthorityStorage(clock);
    await storage.registerActivation(activation());
    const lease = await storage.acquireTaskLease({
      scope: task,
      ownerId: 'one',
      leaseDurationMs: 60_000,
    });
    const reduced = await storage.applyTaskEffectTransition({
      lease,
      transition: transition(clock),
    });
    const effect = reduced.effects[0];
    if (effect === undefined) throw new Error('missing effect');
    const plans = {
      resolve: vi.fn(async () => ({
        workflowPath: '.github/workflows/worker.yml',
        workflowRef: 'refs/heads/main',
        workflowSha: SHA,
        mode: 'implement' as const,
        executorId: 'executor-1',
        credentialProfileId: 'profile-1',
        renewalDeadline: T1,
      })),
    };
    const admission = new TaskAttemptAdmissionCoordinator(storage, plans);
    await storage.claimTaskEffect({
      lease,
      tenantId: tenant.tenantId,
      task,
      sourceFactId: effect.sourceFactId,
      effectKey: effect.effectKey,
    });
    await admission.admit({
      lease,
      tenantId: tenant.tenantId,
      task,
      intentId: 'intent-fact-1',
      intentRevision: 1,
    });
    const worker = new AdmissionTaskEffectCoordinator(storage, admission);
    const done = await worker.reconcile({
      lease,
      tenantId: tenant.tenantId,
      task,
      sourceFactId: effect.sourceFactId,
      effectKey: effect.effectKey,
    });
    expect(done).toMatchObject({
      status: 'completed',
      effect: { deliveryState: 'complete' },
    });
    expect(plans.resolve).toHaveBeenCalledTimes(1);
  });
});
