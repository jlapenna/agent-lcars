import type {
  ActivationRecord,
  ControlPlaneSignalEnvelope,
  PolicyDecision,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  type AuthorityClock,
  InMemoryLifecycleAuthorityStorage,
  type LifecycleAuthorityStorage,
  type TaskAuthorityScope,
  type TaskEffectRecord,
} from './authority-storage';
import {
  CancellationTaskEffectComposition,
  type CancellationTaskEffectInput,
} from './cancellation-effect-composition';
import { CancellationTaskEffectCoordinator } from './cancellation-effects';
import {
  PresentationDeliveryComposition,
  type PresentationDeliveryCompositionDependencies,
} from './presentation-delivery-composition';
import type { TaskLeaseRunner } from './signal-task-composition';
import { TaskAttemptAdmissionCoordinator } from './task-attempt-admission';
import {
  mintTaskEffectTransition,
  type TaskEffectClock,
} from './task-effect-capability';
import { AdmissionTaskEffectCoordinator } from './task-effects';

const T0 = '2026-08-21T00:00:00.000Z';
const T1 = '2026-08-21T01:00:00.000Z';
const SHA = 'a'.repeat(64);
const tenant = {
  tenantId: 'tenant-cancellation-composition',
  repositoryId: 111,
  repository: 'octo/cancellation-composition',
  installationId: 222,
};
const task: TaskAuthorityScope = {
  tenantId: tenant.tenantId,
  repositoryId: tenant.repositoryId,
  issueNumber: 3,
};

class Clock implements AuthorityClock, TaskEffectClock {
  constructor(private value = T0) {}

  now(): string {
    return this.value;
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

function envelope(
  factId = 'fact-1',
  signal: ControlPlaneSignalEnvelope['signal'] = {
    kind: 'requested-work',
    mode: 'implement',
    requestKey: `key-${factId}`,
  },
): ControlPlaneSignalEnvelope {
  return {
    schema: 'agent-lcars.control-plane-signal/v1',
    version: 1,
    requestId: `request-${factId}`,
    factId,
    tenant,
    task,
    signal,
    receivedAt: T0,
    source: {
      kind: 'github-webhook',
      deliveryId: `delivery-${factId}`,
      repositoryId: tenant.repositoryId,
      installationId: tenant.installationId,
      bodySha256: SHA,
      event: 'issues',
      action: 'opened',
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

function requestedTransition(
  clock: Clock,
  expectedRevision = 0,
  factId = 'fact-1',
) {
  return mintTaskEffectTransition(
    {
      expectedRevision,
      envelope: envelope(factId),
      policyDecision: policy(factId),
      activation: activation(),
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

async function cancellationTransition(
  clock: Clock,
  expectedRevision: number,
  factId = 'fact-cancel',
) {
  return mintTaskEffectTransition(
    {
      expectedRevision,
      envelope: envelope(factId, {
        kind: 'cancel',
        commandKey: `cancel-${factId}`,
      }),
      policyDecision: policy(factId),
      activation: activation(),
    },
    clock,
  );
}

function inputFor(effect: {
  sourceFactId: string;
  effectKey: string;
}): CancellationTaskEffectInput {
  return {
    tenantId: tenant.tenantId,
    task,
    sourceFactId: effect.sourceFactId,
    effectKey: effect.effectKey,
  };
}

async function fixture(
  kind: 'unlaunched' | 'terminal' | 'drain' | 'admission' = 'unlaunched',
) {
  const clock = new Clock();
  const storage = new InMemoryLifecycleAuthorityStorage(clock, {
    mint: () => 'A'.repeat(22),
  });
  await storage.registerActivation(activation());
  const setupLease = await storage.acquireTaskLease({
    scope: task,
    ownerId: 'setup',
    leaseDurationMs: 60_000,
  });
  const desired = await storage.applyTaskEffectTransition({
    lease: setupLease,
    transition: requestedTransition(clock),
  });
  let effect = desired.effects[0];
  if (effect === undefined) throw new Error('missing admission effect');

  if (kind === 'drain' || kind === 'terminal') {
    if (effect.payload.kind !== 'admit-attempt') {
      throw new Error('missing admission effect');
    }
    const admissions = new AdmissionTaskEffectCoordinator(
      storage,
      new TaskAttemptAdmissionCoordinator(storage, {
        resolve: vi.fn(async () => ({
          workflowPath: '.github/workflows/worker.yml',
          workflowRef: 'refs/heads/main',
          workflowSha: 'c'.repeat(40),
          mode: 'implement' as const,
          executorId: 'executor-1',
          credentialProfileId: 'profile-1',
          renewalDeadline: T1,
        })),
      }),
    );
    await admissions.reconcile({
      lease: setupLease,
      tenantId: tenant.tenantId,
      task,
      sourceFactId: effect.sourceFactId,
      effectKey: effect.effectKey,
    });
    const admitted = await storage.readTask(task);
    if (admitted === undefined || admitted.attempt.kind !== 'launched') {
      throw new Error('missing admitted attempt');
    }
    if (kind === 'drain') {
      const launch = await storage.claimLaunchWork({
        lease: setupLease,
        tenantId: tenant.tenantId,
        attemptId: admitted.attempt.attemptId,
      });
      if (launch.work === undefined) throw new Error('missing launch work');
    }
    const cancelled = await storage.applyTaskEffectTransition({
      lease: setupLease,
      transition: await cancellationTransition(clock, admitted.revision),
    });
    effect = cancelled.effects.find(
      (candidate) => candidate.payload.kind === 'cancel-or-drain',
    );
    if (effect === undefined) throw new Error('missing drain effect');
  } else if (kind === 'unlaunched') {
    const cancelled = await storage.applyTaskEffectTransition({
      lease: setupLease,
      transition: await cancellationTransition(clock, desired.task.revision),
    });
    effect = cancelled.effects.find(
      (candidate) => candidate.payload.kind === 'cancel-unlaunched',
    );
    if (effect === undefined) throw new Error('missing unlaunched effect');
  }

  await storage.releaseTaskLease(setupLease);
  const release = vi.spyOn(storage, 'releaseTaskLease');
  let owner = 0;
  let queue = Promise.resolve();
  const run = vi.fn<TaskLeaseRunner['run']>(async (scope, operation) => {
    const next = queue.then(async () => {
      const lease = await storage.acquireTaskLease({
        scope,
        ownerId: `worker-${++owner}`,
        leaseDurationMs: 60_000,
      });
      try {
        return await operation(lease);
      } finally {
        await storage.releaseTaskLease(lease);
      }
    });
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  });
  return {
    clock,
    storage,
    effect,
    input: inputFor(effect),
    run,
    release,
  };
}

function composition(fixtureValue: Awaited<ReturnType<typeof fixture>>) {
  return new CancellationTaskEffectComposition({
    storage: fixtureValue.storage,
    clock: fixtureValue.clock,
    leases: { run: fixtureValue.run },
  });
}

function expectSanitized(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    'sourceFactId',
    'effectKey',
    'eventId',
    'canonicalDigest',
    'claimToken',
    'claimedFence',
    'outcomeDigest',
    'planDigest',
    'facts',
    'commands',
    'spec',
  ]) {
    expect(serialized).not.toContain(forbidden);
  }
}

describe('CancellationTaskEffectComposition', () => {
  it('owns the unlaunched cancellation path and gives a sanitized replay', async () => {
    const test = await fixture('terminal');
    const worker = composition(test);

    const first = await worker.reconcile(test.input);
    const replay = await worker.reconcile(test.input);

    expect(first).toMatchObject({
      status: 'completed',
      attempt: { phase: 'terminal', futureGrantsDenied: true },
      presentation: {
        deliveryState: 'pending',
        terminalState: 'cancelled',
        execution: 'not_started',
        result: 'none',
        evidenceValidation: 'not-applicable',
      },
    });
    expect(replay).toEqual(first);
    expectSanitized(first);
    expect(test.run).toHaveBeenCalledTimes(2);
    expect(test.release).toHaveBeenCalledTimes(2);
  });

  it('owns the admitted cancel-or-drain path and replays its deferred work', async () => {
    const test = await fixture('drain');
    const worker = composition(test);

    const result = await worker.reconcile(test.input);
    const replay = await worker.reconcile(test.input);

    expect(result).toMatchObject({
      status: 'completed',
      attempt: { phase: 'cancelling', futureGrantsDenied: true },
      work: { state: 'awaiting-binding' },
    });
    expect(replay).toEqual(result);
    expectSanitized(result);
  });

  it('defers unrelated effects after the lease is owned', async () => {
    const test = await fixture('admission');
    const worker = composition(test);

    await expect(worker.reconcile(test.input)).resolves.toEqual({
      status: 'deferred',
      deliveryState: 'pending',
    });
    expect(test.run).toHaveBeenCalledTimes(1);
    expect(test.release).toHaveBeenCalledTimes(1);
  });

  it('reconciles an already-terminal cancellation as a no-op receipt', async () => {
    const test = await fixture('terminal');
    const lease = await test.storage.acquireTaskLease({
      scope: task,
      ownerId: 'pre-terminal',
      leaseDurationMs: 60_000,
    });
    await new CancellationTaskEffectCoordinator(
      test.storage,
      test.clock,
    ).reconcile({ lease, ...test.input });
    await test.storage.releaseTaskLease(lease);

    const result = await composition(test).reconcile(test.input);

    expect(result).toMatchObject({ status: 'completed' });
    expectSanitized(result);
    expect(test.run).toHaveBeenCalledOnce();
  });

  it('defers an obsolete cancellation effect without attempting a write', async () => {
    const test = await fixture('terminal');
    const internals = test.storage as unknown as {
      taskEffects: Map<string, TaskEffectRecord>;
    };
    const row = [...internals.taskEffects.values()].find(
      (candidate) => candidate.effectKey === test.input.effectKey,
    );
    if (row === undefined) throw new Error('missing cancellation effect row');
    row.deliveryState = 'obsolete';
    row.obsoleteReason = 'superseded';

    await expect(composition(test).reconcile(test.input)).resolves.toEqual({
      status: 'deferred',
      deliveryState: 'obsolete',
    });
    expect(test.run).toHaveBeenCalledOnce();
    expectSanitized({ status: 'deferred', deliveryState: 'obsolete' });
  });

  it('rejects malformed, unknown, and cross-tenant identities before a lease', async () => {
    const test = await fixture('terminal');
    const worker = composition(test);
    const read = vi.spyOn(test.storage, 'readTaskEffect');

    await expect(
      worker.reconcile({ ...test.input, sourceFactId: 'missing' }),
    ).rejects.toThrow('unknown');
    await expect(
      worker.reconcile({ ...test.input, tenantId: 'other-tenant' }),
    ).rejects.toThrow('invalid');
    await expect(
      worker.reconcile({
        ...test.input,
        task: { ...task, tenantId: 'other-tenant' },
      }),
    ).rejects.toThrow('invalid');
    await expect(
      worker.reconcile({ ...test.input, task: { ...task, issueNumber: 99 } }),
    ).rejects.toThrow('unknown');
    await expect(
      worker.reconcile({ ...test.input, extra: true } as never),
    ).rejects.toThrow('invalid');
    await expect(worker.reconcile(null as never)).rejects.toThrow('invalid');

    expect(test.run).not.toHaveBeenCalled();
    expect(test.release).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('hands cancellation presentation to the delivery composition exactly once', async () => {
    const test = await fixture('terminal');
    const cancellation = await composition(test).reconcile(test.input);
    if (
      cancellation.status !== 'completed' ||
      cancellation.presentation === undefined
    ) {
      throw new Error('missing cancellation presentation');
    }
    const [presentation] = await test.storage.listAttemptPresentations({
      tenantId: tenant.tenantId,
      attemptId: cancellation.presentation.attemptId,
    });
    if (presentation === undefined) throw new Error('missing presentation row');
    const target = {
      source: 'attempt' as const,
      tenantId: tenant.tenantId,
      task,
      attemptId: presentation.plan.attemptId,
      operationId: presentation.plan.operationId,
    };
    const receiver = vi.fn(async () => ({ receiptSha256: 'b'.repeat(64) }));
    const delivery = new PresentationDeliveryComposition({
      storage: test.storage,
      receiver: { receive: receiver },
      clock: test.clock,
      leases: { run: test.run },
    } satisfies PresentationDeliveryCompositionDependencies);

    const first = await delivery.deliver({ target });
    const replay = await delivery.deliver({ target });

    expect(first).toMatchObject({ source: 'attempt', state: 'converged' });
    expect(replay).toEqual(first);
    expect(receiver).toHaveBeenCalledOnce();
    expect(JSON.stringify(first)).not.toMatch(/claimToken|claimedFence/iu);
  });

  it('serializes concurrent workers and leaves no lease behind', async () => {
    const test = await fixture();
    const worker = composition(test);

    const results = await Promise.all([
      worker.reconcile(test.input),
      worker.reconcile(test.input),
      worker.reconcile(test.input),
    ]);

    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
    expect(test.run).toHaveBeenCalledTimes(3);
    expect(test.release).toHaveBeenCalledTimes(3);
    await expect(
      test.storage.acquireTaskLease({
        scope: task,
        ownerId: 'after-concurrency',
        leaseDurationMs: 60_000,
      }),
    ).resolves.toBeDefined();
  });

  it('releases a failed lease and recovers a shadowed working claim at a later fence', async () => {
    const test = await fixture();
    const claimLease = await test.storage.acquireTaskLease({
      scope: task,
      ownerId: 'crashed-worker',
      leaseDurationMs: 60_000,
    });
    await test.storage.claimTaskEffect({ lease: claimLease, ...test.input });
    await test.storage.releaseTaskLease(claimLease);
    await test.storage.registerActivation(activation('shadow'));

    const failingStorage = new Proxy(test.storage, {
      get(target, property, receiver) {
        if (property === 'applyVerifiedCancellationEffect') {
          return async () => {
            throw new Error('simulated worker crash');
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as LifecycleAuthorityStorage;
    const failing = new CancellationTaskEffectComposition({
      storage: failingStorage,
      clock: test.clock,
      leases: { run: test.run },
    });

    await expect(failing.reconcile(test.input)).rejects.toThrow(
      'simulated worker crash',
    );
    expect(test.release).toHaveBeenCalledTimes(2);

    const recovered = await composition(test).reconcile(test.input);
    expect(recovered).toMatchObject({ status: 'completed' });
    expectSanitized(recovered);
    expect(test.release).toHaveBeenCalledTimes(3);
  });
});
