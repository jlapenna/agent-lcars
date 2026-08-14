import type {
  ActivationRecord,
  ControlPlaneSignalEnvelope,
  PolicyDecision,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  type AuthorityClock,
  InMemoryLifecycleAuthorityStorage,
  type TaskAuthorityScope,
} from './authority-storage';
import { TaskAdmissionEffectComposition } from './task-admission-effect-composition';
import { TaskAttemptAdmissionCoordinator } from './task-attempt-admission';
import { mintTaskEffectTransition } from './task-effect-capability';

const T0 = '2026-08-21T00:00:00.000Z';
const SHA = 'a'.repeat(64);
const tenant = {
  tenantId: 'tenant-admission',
  repositoryId: 111,
  repository: 'octo/admission',
  installationId: 222,
};
const task: TaskAuthorityScope = {
  tenantId: tenant.tenantId,
  repositoryId: tenant.repositoryId,
  issueNumber: 3,
};
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
const envelope: ControlPlaneSignalEnvelope = {
  schema: 'agent-lcars.control-plane-signal/v1',
  version: 1,
  requestId: 'request-1',
  factId: 'fact-1',
  tenant,
  task,
  signal: {
    kind: 'requested-work',
    mode: 'implement',
    requestKey: 'request-1',
  },
  receivedAt: T0,
  source: {
    kind: 'github-webhook',
    deliveryId: 'delivery-1',
    repositoryId: tenant.repositoryId,
    installationId: tenant.installationId,
    bodySha256: SHA,
    event: 'issues',
    action: 'opened',
    actorId: 7,
    actorLogin: 'octocat',
    occurredAt: T0,
    hmacKeyVersion: 'key-v1',
  },
};
const policy: PolicyDecision = {
  schema: 'agent-lcars.policy-decision/v1',
  version: 1,
  policy: { policyId: 'policy-1', policyVersion: 1, contentSha256: SHA },
  decision: 'accepted',
  ruleId: 'rule-1',
  sourceFactId: envelope.factId,
  principal: { kind: 'github-actor', actorId: 7, login: 'octocat' },
  evidenceRef: 'evidence-1',
  decidedAt: T0,
};
const candidate = {
  intentId: 'intent-1',
  semanticKey: 'issue:3',
  semanticDigest: SHA,
  orderingKey: { occurredAt: T0, tieBreaker: 'delivery-1' },
};
const plan = {
  workflowPath: '.github/workflows/worker.yml',
  workflowRef: 'refs/heads/main',
  workflowSha: 'c'.repeat(40),
  mode: 'implement' as const,
  executorId: 'executor-1',
  credentialProfileId: 'profile-1',
  renewalDeadline: '2026-08-21T01:00:00.000Z',
};

class Clock implements AuthorityClock {
  now(): string {
    return T0;
  }
}

async function setup() {
  const clock = new Clock();
  const storage = new InMemoryLifecycleAuthorityStorage(clock, {
    mint: () => 'A'.repeat(22),
  });
  await storage.registerActivation(activation);
  const lease = await storage.acquireTaskLease({
    scope: task,
    ownerId: 'setup',
    leaseDurationMs: 60_000,
  });
  const transition = await storage.applyTaskEffectTransition({
    lease,
    transition: mintTaskEffectTransition(
      {
        expectedRevision: 0,
        envelope,
        policyDecision: policy,
        activation,
        candidate,
      },
      clock,
    ),
  });
  await storage.releaseTaskLease(lease);
  const releases = vi.spyOn(storage, 'releaseTaskLease');
  const effect = transition.effects[0];
  if (effect === undefined || effect.payload.kind !== 'admit-attempt') {
    throw new Error('setup did not create admission effect');
  }
  let serial = Promise.resolve();
  const leases = vi.fn((_scope, operation) => {
    const run = serial.then(async () => {
      const held = await storage.acquireTaskLease({
        scope: task,
        ownerId: 'admission-worker',
        leaseDurationMs: 60_000,
      });
      try {
        return await operation(held);
      } finally {
        await storage.releaseTaskLease(held);
      }
    });
    serial = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  });
  const plans = { resolve: vi.fn(async () => plan) };
  const composition = new TaskAdmissionEffectComposition({
    storage,
    plans,
    leases: { run: leases },
  });
  return { storage, effect, composition, plans, leases, releases };
}

describe('inactive task admission-effect composition', () => {
  it('atomically admits one Attempt and launch outbox, then replays without replanning', async () => {
    const test = await setup();
    const input = {
      tenantId: tenant.tenantId,
      task,
      sourceFactId: test.effect.sourceFactId,
      effectKey: test.effect.effectKey,
    };

    const first = await test.composition.reconcile(input);
    const replay = await test.composition.reconcile(input);

    expect(first.status).toBe('completed');
    expect(replay.status).toBe('deferred');
    expect(test.plans.resolve).toHaveBeenCalledTimes(1);
    expect(test.leases).toHaveBeenCalledTimes(2);
    if (first.status !== 'completed')
      throw new Error('admission did not complete');
    expect(first.admission.attempt?.spec.attemptId).toMatch(
      /^[A-Za-z0-9_-]{22,64}$/u,
    );
    const attempt = first.admission.attempt;
    if (attempt === undefined) throw new Error('missing Attempt receipt');
    const launch = await test.storage.readLaunch({
      tenantId: tenant.tenantId,
      attemptId: attempt.spec.attemptId,
    });
    expect(launch?.state).toBe('pending');
    const effects = await test.storage.listTaskEffects({
      tenantId: tenant.tenantId,
      task,
    });
    expect(effects).toHaveLength(1);
    expect(effects[0]?.deliveryState).toBe('complete');
  });

  it('rejects cross-tenant identities before acquiring a lease or resolving a plan', async () => {
    const test = await setup();

    await expect(
      test.composition.reconcile({
        tenantId: 'other-tenant',
        task,
        sourceFactId: test.effect.sourceFactId,
        effectKey: test.effect.effectKey,
      }),
    ).rejects.toThrow('crosses tenant scope');
    expect(test.leases).not.toHaveBeenCalled();
    expect(test.plans.resolve).not.toHaveBeenCalled();
  });

  it('does not execute a provider: composition stops at durable admission and outbox', async () => {
    const test = await setup();
    const result = await test.composition.reconcile({
      tenantId: tenant.tenantId,
      task,
      sourceFactId: test.effect.sourceFactId,
      effectKey: test.effect.effectKey,
    });

    expect(Object.keys(test)).not.toContain('provider');
    if (
      result.status !== 'completed' ||
      result.admission.attempt === undefined
    ) {
      throw new Error('admission did not complete');
    }
    const attempt = await test.storage.readAttempt({
      tenantId: tenant.tenantId,
      attemptId: result.admission.attempt.spec.attemptId,
    });
    expect(attempt?.binding).toBeUndefined();
    expect(
      await test.storage.readLaunch({
        tenantId: tenant.tenantId,
        attemptId: result.admission.attempt.spec.attemptId,
      }),
    ).toMatchObject({ state: 'pending' });
  });

  it('recovers a crash after admission commit on the next lease fence without replanning', async () => {
    const test = await setup();
    const crashedLease = await test.storage.acquireTaskLease({
      scope: task,
      ownerId: 'crashed-worker',
      leaseDurationMs: 60_000,
    });
    const input = {
      tenantId: tenant.tenantId,
      task,
      sourceFactId: test.effect.sourceFactId,
      effectKey: test.effect.effectKey,
    };
    await test.storage.claimTaskEffect({ lease: crashedLease, ...input });
    const admission = new TaskAttemptAdmissionCoordinator(
      test.storage,
      test.plans,
    );
    await admission.admit({
      lease: crashedLease,
      tenantId: tenant.tenantId,
      task,
      intentId: 'intent-1',
      intentRevision: 1,
    });
    await test.storage.releaseTaskLease(crashedLease);

    // The durable admission receipt is pinned to the original central
    // activation. A later activation change must not invalidate recovery or
    // cause a new plan to be resolved.
    await test.storage.registerActivation({
      ...activation,
      activationId: 'shadow-2',
      authorityEpoch: 2,
      effectiveBoundary: 2,
      mode: 'shadow',
      effectMode: 'none',
      recordedAt: '2026-08-21T00:01:00.000Z',
    });

    const recovered = await test.composition.reconcile(input);

    expect(recovered.status).toBe('completed');
    expect(test.plans.resolve).toHaveBeenCalledTimes(1);
    expect(test.releases).toHaveBeenCalledTimes(2);
  });

  it('concurrently reconciles one pending effect into one completion and one deferred replay', async () => {
    const test = await setup();
    const input = {
      tenantId: tenant.tenantId,
      task,
      sourceFactId: test.effect.sourceFactId,
      effectKey: test.effect.effectKey,
    };

    const results = await Promise.all([
      test.composition.reconcile(input),
      test.composition.reconcile(input),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      'completed',
      'deferred',
    ]);
    expect(test.plans.resolve).toHaveBeenCalledTimes(1);
    expect(test.releases).toHaveBeenCalledTimes(2);
  });

  it.each(['missing', 'mismatched'])(
    'does not resolve a plan for a %s effect identity',
    async (kind) => {
      const test = await setup();
      const input = {
        tenantId: tenant.tenantId,
        task,
        sourceFactId:
          kind === 'missing' ? 'missing-fact' : test.effect.sourceFactId,
        effectKey: kind === 'missing' ? test.effect.effectKey : 'other-effect',
      };

      await expect(test.composition.reconcile(input)).rejects.toThrow(
        'Task effect is unknown',
      );
      expect(test.plans.resolve).not.toHaveBeenCalled();
      expect(test.releases).toHaveBeenCalledTimes(1);
    },
  );

  it('leaves the effect recoverable when plan resolution fails', async () => {
    const test = await setup();
    test.plans.resolve
      .mockRejectedValueOnce(new Error('plan unavailable'))
      .mockResolvedValueOnce(plan);
    const input = {
      tenantId: tenant.tenantId,
      task,
      sourceFactId: test.effect.sourceFactId,
      effectKey: test.effect.effectKey,
    };

    await expect(test.composition.reconcile(input)).rejects.toThrow(
      'plan unavailable',
    );
    expect(test.releases).toHaveBeenCalledTimes(1);
    expect(
      await test.storage.readAttempt({
        tenantId: tenant.tenantId,
        attemptId: 'A'.repeat(22),
      }),
    ).toBeUndefined();
    expect(
      await test.storage.listTaskEffects({ tenantId: tenant.tenantId, task }),
    ).toMatchObject([{ deliveryState: 'working' }]);
    const recovered = await test.composition.reconcile(input);

    expect(recovered.status).toBe('completed');
    expect(test.plans.resolve).toHaveBeenCalledTimes(2);
    expect(
      recovered.status === 'completed' && recovered.admission.attempt,
    ).toBeDefined();
  });

  it('obsoletes a pending admission when activation switches to shadow', async () => {
    const test = await setup();
    await test.storage.registerActivation({
      ...activation,
      activationId: 'shadow-2',
      authorityEpoch: 2,
      mode: 'shadow',
      effectMode: 'none',
    });
    const input = {
      tenantId: tenant.tenantId,
      task,
      sourceFactId: test.effect.sourceFactId,
      effectKey: test.effect.effectKey,
    };

    const result = await test.composition.reconcile(input);

    expect(result.status).toBe('deferred');
    expect(test.plans.resolve).not.toHaveBeenCalled();
    const effect = await test.storage.readTaskEffect(input);
    expect(effect?.deliveryState).toBe('obsolete');
    expect(effect?.obsoleteReason).toBe('activation-no-longer-authoritative');
  });

  it('does not plan a complete effect', async () => {
    const test = await setup();
    const input = {
      tenantId: tenant.tenantId,
      task,
      sourceFactId: test.effect.sourceFactId,
      effectKey: test.effect.effectKey,
    };
    await test.composition.reconcile(input);
    const complete = await test.composition.reconcile(input);
    expect(complete.status).toBe('deferred');
    expect(test.plans.resolve).toHaveBeenCalledTimes(1);
  });

  it('does not plan a non-admission effect', async () => {
    const test = await setup();
    const nonAdmissionStorage = new Proxy(test.storage, {
      get(target, property, receiver) {
        if (property === 'readTaskEffect') {
          return async () => ({
            ...test.effect,
            payload: {
              kind: 'cancel-unlaunched',
              effectKey: test.effect.effectKey,
              task,
              intentId: 'intent-1',
              intentRevision: 1,
              activation: {
                activationId: activation.activationId,
                taskClassId: activation.taskClassId,
                authorityEpoch: activation.authorityEpoch,
                mode: activation.mode,
              },
            },
          });
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as LifecycleAuthorityStorage;
    const composition = new TaskAdmissionEffectComposition({
      storage: nonAdmissionStorage,
      plans: test.plans,
      leases: { run: test.leases },
    });

    const result = await composition.reconcile({
      tenantId: tenant.tenantId,
      task,
      sourceFactId: test.effect.sourceFactId,
      effectKey: test.effect.effectKey,
    });

    expect(result.effect.payload.kind).toBe('cancel-unlaunched');
    expect(test.plans.resolve).not.toHaveBeenCalled();
  });
});
