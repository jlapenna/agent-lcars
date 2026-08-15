import type {
  ActivationRecord,
  ControlPlaneSignalEnvelope,
  PolicyDecision,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it, vi } from 'vitest';

import type { AttemptState } from './attempt-reducer';
import {
  type AuthorityClock,
  AuthorityConflict,
  InMemoryLifecycleAuthorityStorage,
  type LaunchOutboxRecord,
  type TaskEffectRecord,
} from './authority-storage';
import { CancellationTaskEffectCoordinator } from './cancellation-effects';
import { inMemoryCancellationHistoryStorageHooks } from './cancellation-history.in-memory.spec.support';
import { writeAttemptForTest } from './launch-resolution-test-support';
import { TaskAttemptAdmissionCoordinator } from './task-attempt-admission';
import { mintTaskEffectTransition } from './task-effect-capability';
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

import {
  launchedCancellationEffect,
  runCancellationEffectStorageContract,
  runCancellationHistoryStorageContract,
  runTaskEffectStorageContract,
  runTaskPresentationStorageContract,
} from './task-effects.spec.support';

runTaskEffectStorageContract({
  create: (clock) => new InMemoryLifecycleAuthorityStorage(clock),
});
runTaskPresentationStorageContract({
  create: (clock) => new InMemoryLifecycleAuthorityStorage(clock),
});
runCancellationEffectStorageContract({
  create: (clock) => new InMemoryLifecycleAuthorityStorage(clock),
  hydrateAttempt: writeAttemptForTest,
});
runCancellationHistoryStorageContract({
  create: (clock) => new InMemoryLifecycleAuthorityStorage(clock),
  hydrateAttempt: writeAttemptForTest,
  historyHooks: inMemoryCancellationHistoryStorageHooks(),
});

describe('cancelled Attempt presentation replay integrity', () => {
  it.each([
    'missing Attempt',
    'changed Attempt',
    'unsuppressed launch',
    'missing presentation',
  ] as const)('rejects replay with a %s', async (corruption) => {
    const clock = new Clock();
    const storage = new InMemoryLifecycleAuthorityStorage(clock);
    const value = await launchedCancellationEffect(storage, clock);
    const coordinator = new CancellationTaskEffectCoordinator(storage, clock);
    const input = {
      lease: value.lease,
      tenantId: tenant.tenantId,
      task,
      sourceFactId: value.effect.sourceFactId,
      effectKey: value.effect.effectKey,
    };
    const committed = await coordinator.reconcile(input);
    if (committed.attempt === undefined)
      throw new Error('missing committed Attempt');

    const internals = storage as unknown as {
      attempts: Map<string, AttemptState>;
      launches: Map<string, LaunchOutboxRecord>;
      attemptPresentations: Map<string, unknown>;
    };
    if (corruption === 'missing Attempt') {
      internals.attempts.delete(value.attemptId);
    } else if (corruption === 'changed Attempt') {
      internals.attempts.set(value.attemptId, {
        ...committed.attempt,
        revision: committed.attempt.revision + 1,
      });
    } else if (corruption === 'unsuppressed launch') {
      const launch = internals.launches.get(value.attemptId);
      if (launch === undefined) throw new Error('missing committed launch');
      internals.launches.set(value.attemptId, { ...launch, state: 'pending' });
    } else {
      internals.attemptPresentations.clear();
    }

    await expect(coordinator.reconcile(input)).rejects.toThrow(
      AuthorityConflict,
    );
  });

  it('replays a later no-op cancellation against an already suppressed terminal Attempt', async () => {
    const clock = new Clock();
    const storage = new InMemoryLifecycleAuthorityStorage(clock);
    const value = await launchedCancellationEffect(storage, clock);
    const coordinator = new CancellationTaskEffectCoordinator(storage, clock);
    await coordinator.reconcile({
      lease: value.lease,
      tenantId: tenant.tenantId,
      task,
      sourceFactId: value.effect.sourceFactId,
      effectKey: value.effect.effectKey,
    });

    const laterFactId = 'fact-later-cancel-noop';
    const laterEffectKey = 'effect-later-cancel-noop';
    const laterEffect: TaskEffectRecord = {
      ...value.effect,
      sourceFactId: laterFactId,
      effectKey: laterEffectKey,
      canonicalDigest: 'b'.repeat(64),
      deliveryState: 'pending',
    };
    const internals = storage as unknown as {
      taskEffects: Map<string, TaskEffectRecord>;
    };
    internals.taskEffects.set(
      JSON.stringify([
        tenant.tenantId,
        task.repositoryId,
        task.issueNumber,
        'task-effect',
        laterFactId,
        laterEffectKey,
      ]),
      laterEffect,
    );
    const input = {
      lease: value.lease,
      tenantId: tenant.tenantId,
      task,
      sourceFactId: laterFactId,
      effectKey: laterEffectKey,
    };

    const first = await coordinator.reconcile(input);
    expect(first).toMatchObject({
      effect: { deliveryState: 'complete' },
      attempt: { phase: 'terminal' },
    });
    expect(first.presentation).toBeUndefined();
    expect(await coordinator.reconcile(input)).toEqual(first);
    expect(
      await storage.listAttemptPresentations({
        tenantId: tenant.tenantId,
        attemptId: value.attemptId,
      }),
    ).toHaveLength(1);
  });
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
    expect(parked).toMatchObject({
      plans: [
        {
          deliveryState: 'pending',
          plan: {
            taskRevision: 2,
            presentation: {
              disposition: 'parked',
              humanAttention: 'required',
              notice: { kind: 'task-parked' },
              reason: 'operator-parked',
              intentId: 'intent-fact-1',
              intentRevision: 2,
            },
          },
        },
      ],
    });
    expect(
      parked.effects.find(
        (effect) => effect.payload.kind === 'park-projection',
      ),
    ).toMatchObject({
      deliveryState: 'complete',
      completion: { kind: 'task-presentation-receipt' },
    });
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
        effect: {},
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
        workflowSha: 'c'.repeat(40),
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
        workflowSha: 'c'.repeat(40),
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
