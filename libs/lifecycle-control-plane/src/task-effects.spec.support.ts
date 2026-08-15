import type {
  ActivationRecord,
  ControlPlaneSignalEnvelope,
  PolicyDecision,
} from '@agent-lcars/dispatch-contracts';
import { runtimeObservationPayloadSha256 } from '@agent-lcars/dispatch-contracts';
import { describe, expect, it, vi } from 'vitest';

import type { AttemptHistoryInspection } from './attempt-history-test-support';
import { readAttemptHistoryForTest } from './attempt-history-test-support';
import type { AttemptState } from './attempt-reducer';
import {
  type AuthorityClock,
  AuthorityConflict,
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
import {
  PresentationDeliveryBoundary,
  PresentationDeliveryCoordinator,
} from './presentation-delivery';
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
  } as ActivationRecord;
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
  create(
    clock: AuthorityClock,
  ): LifecycleAuthorityStorage | Promise<LifecycleAuthorityStorage>;
}

/** Reusable async contract for the inactive parked-task presentation outbox. */
export function runTaskPresentationStorageContract(
  factory: TaskEffectStorageFactory,
): void {
  describe('task presentation storage contract', () => {
    it('atomically derives a policy-rejected no-Attempt park plan and replays it', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
      await storage.registerActivation(activation());
      const lease = await storage.acquireTaskLease({
        scope: task,
        ownerId: 'presentation',
        leaseDurationMs: 60_000,
      });
      const rejected = mintTaskEffectTransition(
        {
          expectedRevision: 0,
          envelope: envelope('fact-policy-park'),
          policyDecision: {
            ...policy('fact-policy-park'),
            decision: 'rejected',
          },
          activation: activation(),
          candidate: {
            intentId: 'intent-policy-park',
            semanticKey: 'policy-park',
            semanticDigest: SHA,
            orderingKey: { occurredAt: T0, tieBreaker: 'policy-park' },
          },
        },
        clock,
      );
      const first = await storage.applyTaskEffectTransition({
        lease,
        transition: rejected,
      });
      expect(first).toMatchObject({
        effects: [
          {
            payload: { kind: 'park-projection', reason: 'policy-rejected' },
            deliveryState: 'complete',
          },
        ],
        plans: [
          {
            deliveryState: 'pending',
            plan: {
              taskRevision: 1,
              presentation: {
                reason: 'policy-rejected',
                disposition: 'parked',
              },
            },
          },
        ],
      });
      const plannedOperation = first.plans[0]?.plan.operationId;
      if (plannedOperation === undefined) throw new Error('missing park plan');
      expect(
        await storage.readPresentationDelivery({
          source: 'task',
          tenantId: tenant.tenantId,
          task,
          operationId: plannedOperation,
        }),
      ).toMatchObject({ state: 'pending' });
      expect(
        await storage.applyTaskEffectTransition({
          lease,
          transition: rejected,
        }),
      ).toEqual({ ...first, status: 'replay' });
      expect('enqueueProjection' in storage).toBe(false);
      expect('claimProjection' in storage).toBe(false);
      expect('acknowledgeProjection' in storage).toBe(false);
      const retry = transition(clock, 'fact-retry-after-park', 1);
      const resumed = await storage.applyTaskEffectTransition({
        lease,
        transition: retry,
      });
      expect(resumed).toMatchObject({
        task: { attempt: { kind: 'unlaunched' } },
        obsoletedPlans: [
          {
            deliveryState: 'obsolete',
            obsoleteAtTaskRevision: 2,
            obsoleteReason: 'task-resumed',
          },
        ],
      });
      expect(
        await storage.applyTaskEffectTransition({ lease, transition: retry }),
      ).toEqual({ ...resumed, status: 'replay' });
      expect(
        await storage.applyTaskEffectTransition({
          lease,
          transition: rejected,
        }),
      ).toEqual({ ...first, status: 'replay' });
      const originalOperation = first.plans[0]?.plan.operationId;
      if (originalOperation === undefined) throw new Error('missing park plan');
      expect(
        await storage.readTaskPresentation({
          tenantId: tenant.tenantId,
          task,
          operationId: originalOperation,
        }),
      ).toMatchObject({
        deliveryState: 'obsolete',
        obsoleteReason: 'task-resumed',
      });
      expect(
        await storage.readPresentationDelivery({
          source: 'task',
          tenantId: tenant.tenantId,
          task,
          operationId: originalOperation,
        }),
      ).toMatchObject({ state: 'obsolete' });
    });

    it('preserves an in-flight parked presentation when the Task resumes', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
      await storage.registerActivation(activation());
      const lease = await storage.acquireTaskLease({
        scope: task,
        ownerId: 'presentation-in-flight',
        leaseDurationMs: 60_000,
      });
      const parked = await storage.applyTaskEffectTransition({
        lease,
        transition: mintTaskEffectTransition(
          {
            expectedRevision: 0,
            envelope: envelope('fact-policy-park-in-flight'),
            policyDecision: {
              ...policy('fact-policy-park-in-flight'),
              decision: 'rejected',
            },
            activation: activation(),
            candidate: {
              intentId: 'intent-policy-park-in-flight',
              semanticKey: 'policy-park-in-flight',
              semanticDigest: SHA,
              orderingKey: {
                occurredAt: T0,
                tieBreaker: 'policy-park-in-flight',
              },
            },
          },
          clock,
        ),
      });
      const operationId = parked.plans[0]?.plan.operationId;
      if (operationId === undefined) throw new Error('missing park plan');
      await storage.claimPresentationDelivery({
        lease,
        target: {
          source: 'task',
          tenantId: tenant.tenantId,
          task,
          operationId,
        },
      });

      const resumed = await storage.applyTaskEffectTransition({
        lease,
        transition: transition(clock, 'fact-resume-in-flight', 1),
      });
      expect(resumed.obsoletedPlans).toEqual([]);
      expect(
        await storage.readTaskPresentation({
          tenantId: tenant.tenantId,
          task,
          operationId,
        }),
      ).toMatchObject({ deliveryState: 'pending' });
      expect(
        await storage.readPresentationDelivery({
          source: 'task',
          tenantId: tenant.tenantId,
          task,
          operationId,
        }),
      ).toMatchObject({ state: 'in-flight' });
    });

    it('keeps shadow transitions effect-free and isolates task-presentation reads', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
      const shadow = activation('shadow');
      await storage.registerActivation(shadow);
      const lease = await storage.acquireTaskLease({
        scope: task,
        ownerId: 'shadow-presentation',
        leaseDurationMs: 60_000,
      });
      const result = await storage.applyTaskEffectTransition({
        lease,
        transition: transition(clock, 'fact-shadow-presentation', 0, shadow),
      });
      expect(result).toMatchObject({
        effects: [],
        plans: [],
        obsoletedPlans: [],
      });
      expect(
        await storage.listTaskPresentations({
          tenantId: tenant.tenantId,
          task,
        }),
      ).toEqual([]);
      await expect(
        storage.readTaskPresentation({
          tenantId: 'foreign',
          task,
          operationId: 'task-park:foreign',
        }),
      ).rejects.toThrow(AuthorityConflict);
    });
  });
}

/** Reusable backend-agnostic contract for the #1051 durable work seam. */
export function runTaskEffectStorageContract(
  factory: TaskEffectStorageFactory,
): void {
  describe('task effect storage contract', () => {
    it('atomically records exact reducer effects and replays the original receipt', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
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
      const storage = await factory.create(clock);
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
      const storage = await factory.create(clock);
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
      const storage = await factory.create(clock);
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

/**
 * Test-only seams required by the provider-neutral cancellation-history
 * contract.  These are deliberately unbarreled: production adapters expose
 * no history writer or corruption API.
 */
export interface CancellationHistoryStorageHooks {
  readAttemptHistory: typeof readAttemptHistoryForTest;
  corruptCancellationReceipt(
    storage: LifecycleAuthorityStorage,
    kind: 'command-ref' | 'evidence-ref',
  ): void;
  corruptCancellationHistoryRecord(
    storage: LifecycleAuthorityStorage,
    kind: 'payload' | 'digest' | 'reference',
  ): void;
  corruptCancellationHistoryHead(storage: LifecycleAuthorityStorage): void;
  corruptCancellationAdmission(storage: LifecycleAuthorityStorage): void;
  deleteCancellationHistoryLineage(storage: LifecycleAuthorityStorage): void;
  failCancellationHistoryCommit(storage: LifecycleAuthorityStorage): () => void;
}

export interface CancellationHistoryStorageFactory extends CancellationEffectStorageFactory {
  historyHooks: CancellationHistoryStorageHooks;
}

export async function launchedCancellationEffect(
  storage: LifecycleAuthorityStorage,
  clock: Clock,
  options: { supersede?: boolean } = {},
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
      workflowSha: 'c'.repeat(40),
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
    transition: options.supersede
      ? transition(clock, 'fact-supersede-launched', admitted.revision)
      : mintTaskEffectTransition(
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
      expect(first.presentation).toBeUndefined();
      expect(
        await storage.listAttemptPresentations({
          tenantId: tenant.tenantId,
        }),
      ).toEqual([]);
      expect(
        await storage.listCancellationWork({ tenantId: tenant.tenantId }),
      ).toEqual([]);
    });

    it('terminalizes an admitted but unclaimed launch and makes it non-dispatchable', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
      const value = await launchedCancellationEffect(storage, clock);
      const coordinator = new CancellationTaskEffectCoordinator(storage, clock);
      const input = {
        lease: value.lease,
        tenantId: tenant.tenantId,
        task,
        sourceFactId: value.effect.sourceFactId,
        effectKey: value.effect.effectKey,
      };
      const cancelled = await coordinator.reconcile(input);
      expect(await coordinator.reconcile(input)).toEqual(cancelled);
      expect(cancelled).toMatchObject({
        effect: { deliveryState: 'complete' },
        attempt: {
          phase: 'terminal',
          outcome: {
            terminalState: 'cancelled',
            execution: 'not_started',
            result: 'none',
          },
        },
        presentation: {
          deliveryState: 'pending',
          plan: {
            terminal: {
              kind: 'lifecycle-decision',
              decision: 'cancel-unlaunched',
            },
            presentation: {
              terminalState: 'cancelled',
              execution: 'not_started',
              result: 'none',
              evidenceValidation: 'not-applicable',
            },
          },
        },
      });
      expect(cancelled.presentation?.plan.terminal.commandId).toBe(
        cancelled.attempt?.outcome?.evidence.kind === 'lifecycle-decision'
          ? cancelled.attempt.outcome.evidence.decisionFactId
          : undefined,
      );
      expect(
        await storage.listAttemptPresentations({
          tenantId: tenant.tenantId,
          attemptId: value.attemptId,
        }),
      ).toEqual([cancelled.presentation]);
      const presentationOperation = cancelled.presentation?.plan.operationId;
      if (presentationOperation === undefined)
        throw new Error('missing cancelled Attempt presentation');
      expect(
        await storage.readPresentationDelivery({
          source: 'attempt',
          tenantId: tenant.tenantId,
          task,
          attemptId: value.attemptId,
          operationId: presentationOperation,
        }),
      ).toMatchObject({ state: 'pending' });
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

      await storage.registerActivation(activation('shadow'));
      const receiver = vi.fn(async () => ({ receiptSha256: SHA }));
      const delivered = await new PresentationDeliveryCoordinator(
        storage,
        new PresentationDeliveryBoundary({ receive: receiver }, clock),
      ).deliver({
        lease: value.lease,
        target: {
          source: 'attempt',
          tenantId: tenant.tenantId,
          task,
          attemptId: value.attemptId,
          operationId: presentationOperation,
        },
      });
      expect(delivered).toMatchObject({
        source: 'attempt',
        state: 'converged',
        receiptSha256: SHA,
      });
      expect(receiver).toHaveBeenCalledOnce();
    });

    it('presents a superseded unclaimed Attempt with exact lifecycle provenance', async () => {
      const clock = new Clock();
      const storage = await factory.create(clock);
      const value = await launchedCancellationEffect(storage, clock, {
        supersede: true,
      });
      const result = await new CancellationTaskEffectCoordinator(
        storage,
        clock,
      ).reconcile({
        lease: value.lease,
        tenantId: tenant.tenantId,
        task,
        sourceFactId: value.effect.sourceFactId,
        effectKey: value.effect.effectKey,
      });

      expect(result).toMatchObject({
        attempt: {
          phase: 'terminal',
          outcome: {
            terminalState: 'superseded',
            execution: 'not_started',
            result: 'none',
          },
        },
        presentation: {
          plan: {
            terminal: {
              kind: 'lifecycle-decision',
              decision: 'cancel-unlaunched',
            },
            presentation: {
              terminalState: 'superseded',
              execution: 'not_started',
              result: 'none',
            },
          },
        },
      });
      expect(
        await storage.listAttemptPresentations({
          tenantId: tenant.tenantId,
          attemptId: value.attemptId,
        }),
      ).toEqual([result.presentation]);
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
      const cancellationInput = {
        lease: value.lease,
        tenantId: tenant.tenantId,
        task,
        sourceFactId: value.effect.sourceFactId,
        effectKey: value.effect.effectKey,
      };
      const cancelled = await worker.reconcile(cancellationInput);
      expect(cancelled.work?.state).toBe('awaiting-binding');
      expect(cancelled.presentation).toBeUndefined();
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
      expect(await worker.reconcile(cancellationInput)).toEqual(cancelled);
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
        await storage.listAttemptPresentations({
          tenantId: tenant.tenantId,
          attemptId: value.attemptId,
        }),
      ).toEqual([]);
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
      expect(cancelled.presentation).toBeUndefined();
      expect(
        await storage.listAttemptPresentations({
          tenantId: tenant.tenantId,
          attemptId: value.attemptId,
        }),
      ).toEqual([]);
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
      expect(completed.presentation).toBeUndefined();
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

async function cancellationHistoryFixture(
  factory: CancellationHistoryStorageFactory,
  options: { supersede?: boolean } = {},
) {
  const clock = new Clock();
  const storage = await factory.create(clock);
  const value = await launchedCancellationEffect(storage, clock, options);
  const input = {
    lease: value.lease,
    tenantId: tenant.tenantId,
    task,
    sourceFactId: value.effect.sourceFactId,
    effectKey: value.effect.effectKey,
  };
  const worker = new CancellationTaskEffectCoordinator(storage, clock);
  return { clock, storage, value, input, worker };
}

async function cancellationHistory(
  hooks: CancellationHistoryStorageHooks,
  storage: LifecycleAuthorityStorage,
  lease: TaskAuthorityLease,
  attemptId: string,
): Promise<AttemptHistoryInspection> {
  const history = await hooks.readAttemptHistory(storage, {
    lease,
    tenantId: tenant.tenantId,
    attemptId,
  });
  if (history === undefined) throw new Error('missing Attempt history');
  return history;
}

/** Reusable async backend contract for #1139 cancellation history shadowing. */
export function runCancellationHistoryStorageContract(
  factory: CancellationHistoryStorageFactory,
): void {
  const hooks = factory.historyHooks;

  describe('cancellation history storage contract', () => {
    it('appends direct cancellation command/evidence and replays exact receipt', async () => {
      const value = await cancellationHistoryFixture(factory);
      const committed = await value.worker.reconcile(value.input);
      const history = await cancellationHistory(
        hooks,
        value.storage,
        value.value.lease,
        value.value.attemptId,
      );
      expect(history.records.command).toHaveLength(2);
      expect(history.records.evidence).toHaveLength(1);
      expect(history.head.aggregateRevision).toBe(committed.attempt?.revision);
      expect(
        (history.records.command[1]?.payload as { payload?: { kind?: string } })
          .payload?.kind,
      ).toBe('cancel-unlaunched');
      expect(await value.worker.reconcile(value.input)).toEqual(committed);
      const replayed = await cancellationHistory(
        hooks,
        value.storage,
        value.value.lease,
        value.value.attemptId,
      );
      expect(replayed.records.command).toHaveLength(2);
      expect(replayed.records.evidence).toHaveLength(1);
    });

    it('preserves supersession across command, outcome, and presentation history', async () => {
      const value = await cancellationHistoryFixture(factory, {
        supersede: true,
      });
      const committed = await value.worker.reconcile(value.input);
      const history = await cancellationHistory(
        hooks,
        value.storage,
        value.value.lease,
        value.value.attemptId,
      );
      const command = history.records.command[1]?.payload as {
        payload?: { supersededByIntentId?: string };
      };
      expect(command.payload?.supersededByIntentId).toBe(
        committed.attempt?.cancellation?.supersededByIntentId,
      );
      expect(command.payload?.supersededByIntentId).toBeDefined();
      expect(committed.attempt?.outcome?.terminalState).toBe('superseded');
      expect(committed.presentation?.plan.presentation.terminalState).toBe(
        'superseded',
      );
      expect(history.records.evidence).toHaveLength(1);
    });

    it('records request-cancel without terminal evidence and preserves late binding', async () => {
      const value = await cancellationHistoryFixture(factory);
      const launch = await value.storage.claimLaunchWork({
        lease: value.value.lease,
        tenantId: tenant.tenantId,
        attemptId: value.value.attemptId,
      });
      if (launch.work === undefined) throw new Error('missing launch work');
      const committed = await value.worker.reconcile(value.input);
      expect(committed.attempt?.phase).toBe('cancelling');
      expect(committed.presentation).toBeUndefined();
      const before = await cancellationHistory(
        hooks,
        value.storage,
        value.value.lease,
        value.value.attemptId,
      );
      expect(before.records.command).toHaveLength(2);
      expect(before.records.evidence).toHaveLength(0);
      await value.storage.resolveVerifiedLaunch({
        lease: value.value.lease,
        resolution: await new LaunchResponseBoundary(
          {
            resolve: async () => ({
              kind: 'accepted' as const,
              responseSha256: SHA,
            }),
          },
          value.clock,
        ).resolve(launch.work),
      });
      const accepted = await value.storage.readAttempt({
        tenantId: tenant.tenantId,
        attemptId: value.value.attemptId,
      });
      if (accepted === undefined) throw new Error('missing accepted Attempt');
      const bindingPayload = {
        kind: 'run-bound' as const,
        binding: {
          runId: 901,
          runAttempt: 1,
          checkRunId: 902,
          workflowPath: accepted.spec.execution.workflowPath,
          workflowRef: accepted.spec.execution.workflowRef,
          workflowSha: accepted.spec.execution.workflowSha,
        },
      };
      const verifier = new RunBindingIngressVerifier({
        async verifyExactRunBinding() {
          return undefined;
        },
      });
      await ingestVerifiedRunBinding(
        value.storage,
        value.value.lease,
        await verifier.verify({
          localAttemptMarker: accepted.spec.local.attemptMarker,
          envelope: {
            schema: 'agent-lcars.runtime-observation/v1',
            version: 1,
            requestId: 'request-history-binding',
            factId: 'fact-history-binding',
            attemptId: accepted.spec.attemptId,
            tenant: accepted.spec.tenant,
            task: accepted.spec.task,
            source: { kind: 'github-provider', sourceId: 'history-provider' },
            observedAt: T0,
            payloadSha256:
              await runtimeObservationPayloadSha256(bindingPayload),
            payload: bindingPayload,
          },
        }),
      );
      expect(
        await value.storage.listCancellationWork({ tenantId: tenant.tenantId }),
      ).toMatchObject([{ attemptId: value.value.attemptId, state: 'pending' }]);
      const after = await cancellationHistory(
        hooks,
        value.storage,
        value.value.lease,
        value.value.attemptId,
      );
      expect(after.records.command).toHaveLength(2);
      expect(after.records.evidence).toHaveLength(0);
      expect(after.head.aggregateRevision).toBeGreaterThanOrEqual(
        before.head.aggregateRevision,
      );
      expect(await value.worker.reconcile(value.input)).toEqual(committed);
      const replayHistory = await cancellationHistory(
        hooks,
        value.storage,
        value.value.lease,
        value.value.attemptId,
      );
      expect(replayHistory.records.command.map(({ record }) => record)).toEqual(
        before.records.command.map(({ record }) => record),
      );
    });

    it('records cancellation during finalization without inventing evidence or drain work', async () => {
      const value = await cancellationHistoryFixture(factory);
      const attempt = await value.storage.readAttempt({
        tenantId: tenant.tenantId,
        attemptId: value.value.attemptId,
      });
      if (attempt === undefined) throw new Error('missing admitted attempt');
      await factory.hydrateAttempt({
        storage: value.storage,
        lease: value.value.lease,
        expectedRevision: attempt.revision,
        next: {
          ...attempt,
          revision: attempt.revision + 1,
          phase: 'result-observed',
          finalization: {
            terminalFactId: 'terminal-finalizing-history',
            terminalConclusion: 'success',
            openedAt: T0,
            closesAt: T1,
            evidence: [],
          },
        },
      });
      const result = await value.worker.reconcile(value.input);
      expect(result.work).toBeUndefined();
      const history = await cancellationHistory(
        hooks,
        value.storage,
        value.value.lease,
        value.value.attemptId,
      );
      expect(history.records.command).toHaveLength(2);
      expect(history.records.evidence).toHaveLength(0);
    });

    it('keeps an already-terminal cancellation as an exact no-op', async () => {
      const value = await cancellationHistoryFixture(factory);
      const first = await value.worker.reconcile(value.input);
      const before = await cancellationHistory(
        hooks,
        value.storage,
        value.value.lease,
        value.value.attemptId,
      );
      expect(await value.worker.reconcile(value.input)).toEqual(first);
      const after = await cancellationHistory(
        hooks,
        value.storage,
        value.value.lease,
        value.value.attemptId,
      );
      expect(after.records.command).toHaveLength(before.records.command.length);
      expect(after.records.evidence).toHaveLength(
        before.records.evidence.length,
      );
    });

    it.each([
      ['receipt command ref', 'receipt', 'command-ref'],
      ['receipt evidence ref', 'receipt', 'evidence-ref'],
      ['history payload', 'record', 'payload'],
      ['history digest', 'record', 'digest'],
      ['history reference', 'record', 'reference'],
      ['history head', 'head', undefined],
    ] as const)(
      'fails closed when %s is corrupted',
      async (_label, kind, detail) => {
        const value = await cancellationHistoryFixture(factory);
        await value.worker.reconcile(value.input);
        if (kind === 'receipt') {
          hooks.corruptCancellationReceipt(value.storage, detail);
        } else if (kind === 'record') {
          hooks.corruptCancellationHistoryRecord(value.storage, detail);
        } else {
          hooks.corruptCancellationHistoryHead(value.storage);
        }
        await expect(value.worker.reconcile(value.input)).rejects.toThrow(
          AuthorityConflict,
        );
      },
    );

    it('fails closed before mutation when admission lineage is corrupted', async () => {
      const value = await cancellationHistoryFixture(factory);
      hooks.corruptCancellationAdmission(value.storage);
      await value.storage.claimTaskEffect(value.input);
      const before = await value.storage.readAttempt({
        tenantId: tenant.tenantId,
        attemptId: value.value.attemptId,
      });
      await expect(value.worker.reconcile(value.input)).rejects.toThrow(
        AuthorityConflict,
      );
      expect(
        await value.storage.readAttempt({
          tenantId: tenant.tenantId,
          attemptId: value.value.attemptId,
        }),
      ).toEqual(before);
      expect(await value.storage.readTaskEffect(value.input)).toMatchObject({
        deliveryState: 'working',
      });
    });

    it('keeps pre-history Attempts legacy-only', async () => {
      const value = await cancellationHistoryFixture(factory);
      hooks.deleteCancellationHistoryLineage(value.storage);
      const result = await value.worker.reconcile(value.input);
      expect(result.attempt?.phase).toBe('terminal');
      await expect(
        hooks.readAttemptHistory(value.storage, {
          lease: value.value.lease,
          tenantId: tenant.tenantId,
          attemptId: value.value.attemptId,
        }),
      ).resolves.toBeUndefined();
    });

    it('rolls back legacy, cancellation, presentation, and history maps on commit failure', async () => {
      const value = await cancellationHistoryFixture(factory);
      await value.storage.claimTaskEffect(value.input);
      const before = await value.storage.readAttempt({
        tenantId: tenant.tenantId,
        attemptId: value.value.attemptId,
      });
      const beforeEffect = await value.storage.readTaskEffect(value.input);
      const beforeLaunch = await value.storage.readLaunch({
        tenantId: tenant.tenantId,
        attemptId: value.value.attemptId,
      });
      const beforeHistory = await cancellationHistory(
        hooks,
        value.storage,
        value.value.lease,
        value.value.attemptId,
      );
      const restore = hooks.failCancellationHistoryCommit(value.storage);
      await expect(value.worker.reconcile(value.input)).rejects.toThrow();
      restore();
      expect(
        await value.storage.readAttempt({
          tenantId: tenant.tenantId,
          attemptId: value.value.attemptId,
        }),
      ).toEqual(before);
      expect(
        await value.storage.listCancellationWork({ tenantId: tenant.tenantId }),
      ).toEqual([]);
      expect(await value.storage.readTaskEffect(value.input)).toEqual(
        beforeEffect,
      );
      expect(
        await value.storage.readLaunch({
          tenantId: tenant.tenantId,
          attemptId: value.value.attemptId,
        }),
      ).toEqual(beforeLaunch);
      expect(
        await value.storage.listAttemptPresentations({
          tenantId: tenant.tenantId,
          attemptId: value.value.attemptId,
        }),
      ).toEqual([]);
      expect(
        await value.storage.readCancellationReceipt(value.input),
      ).toBeUndefined();
      expect(
        await cancellationHistory(
          hooks,
          value.storage,
          value.value.lease,
          value.value.attemptId,
        ),
      ).toEqual(beforeHistory);
      await expect(
        hooks.readAttemptHistory(value.storage, {
          lease: value.value.lease,
          tenantId: tenant.tenantId,
          attemptId: value.value.attemptId,
        }),
      ).resolves.toEqual(beforeHistory);
      const retried = await value.worker.reconcile(value.input);
      expect(retried.attempt?.phase).toBe('terminal');
    });
  });
}
