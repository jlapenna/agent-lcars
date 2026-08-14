import type {
  ActivationRecord,
  ControlPlaneSignalEnvelope,
  PolicyDecision,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  type AuthorityClock,
  AuthorityConflict,
  InMemoryLifecycleAuthorityStorage,
  type LifecycleAuthorityStorage,
} from './authority-storage';
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

describe('AdmissionTaskEffectCoordinator', () => {
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
