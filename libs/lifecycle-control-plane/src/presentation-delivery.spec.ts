import { createHash } from 'node:crypto';

import type {
  AttemptPresentationPlan,
  TaskPresentationPlan,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  type AttemptPresentationRecord,
  type AuthorityClock,
  AuthorityConflict,
  InMemoryLifecycleAuthorityStorage,
  type LifecycleAuthorityStorage,
  type PresentationDeliveryRecord,
  type PresentationDeliveryTarget,
  type TaskPresentationRecord,
} from './authority-storage';
import {
  PresentationDeliveryBoundary,
  PresentationDeliveryCoordinator,
  type VerifiedClaimedPresentationWork,
} from './presentation-delivery';

const T0 = '2026-08-22T00:00:00.000Z';
const T1 = '2026-08-22T01:00:00.000Z';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const tenant = {
  tenantId: 'tenant-presentation-delivery',
  repositoryId: 321,
  repository: 'octo/presentation-delivery',
  installationId: 654,
};
const task = {
  tenantId: tenant.tenantId,
  repositoryId: tenant.repositoryId,
  issueNumber: 7,
};
const attemptId = 'A'.repeat(22);

class ManualClock implements AuthorityClock {
  constructor(private value = T0) {}
  now(): string {
    return this.value;
  }
  set(value: string): void {
    this.value = value;
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

function planDigest(
  plan: TaskPresentationPlan | AttemptPresentationPlan,
): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(plan)))
    .digest('hex');
}

function taskPlan(operationId: string): TaskPresentationPlan {
  return {
    schema: 'agent-lcars.task-presentation-plan/v1',
    version: 1,
    operationId,
    tenant,
    task,
    taskRevision: 1,
    sourceFactId: 'fact-park',
    taskEffectKey: 'fact-park:park-projection',
    effectDigest: SHA_A,
    transitionDigest: SHA_A,
    activation: {
      activationId: 'activation-1',
      taskClassId: 'github-issue',
      authorityEpoch: 1,
      mode: 'central-authoritative',
    },
    presentation: {
      disposition: 'parked',
      humanAttention: 'required',
      notice: { kind: 'task-parked' },
      intentId: 'intent-1',
      intentRevision: 1,
      reason: 'policy-rejected',
    },
  };
}

function attemptPlan(operationId: string): AttemptPresentationPlan {
  return {
    schema: 'agent-lcars.attempt-presentation-plan/v1',
    version: 1,
    operationId,
    tenant,
    task,
    attemptId,
    attemptRevision: 9,
    terminal: {
      kind: 'finalization',
      commandId: 'finalize-1',
      terminalFactId: 'terminal-1',
    },
    outcomeDigest: SHA_A,
    activation: {
      activationId: 'activation-1',
      taskClassId: 'github-issue',
      authorityEpoch: 1,
      mode: 'central-authoritative',
    },
    presentation: {
      kind: 'attempt-finalized',
      terminalState: 'succeeded',
      execution: 'exited',
      result: 'pull-request',
      reference: { kind: 'pull-request', number: 44 },
      evidenceValidation: 'validated',
    },
  };
}

export interface PresentationDeliveryStorageFactory {
  create(
    clock: AuthorityClock,
  ): LifecycleAuthorityStorage | Promise<LifecycleAuthorityStorage>;
  /** Test-only setup seam; production storage derives these with the planners. */
  seed(input: {
    storage: LifecycleAuthorityStorage;
    source: 'task' | 'attempt';
    operationId: string;
    state?: 'pending' | 'obsolete';
  }): Promise<PresentationDeliveryTarget>;
  /** Deliberate backend corruption proves exact receipt/live-plan checks. */
  corrupt(input: {
    storage: LifecycleAuthorityStorage;
    target: PresentationDeliveryTarget;
    kind: 'plan' | 'delivery' | 'receipt';
  }): Promise<void>;
}

/** Reusable async contract for the inactive presentation delivery outbox. */
export function runPresentationDeliveryStorageContract(
  factory: PresentationDeliveryStorageFactory,
): void {
  describe('presentation delivery storage contract', () => {
    it.each(['task', 'attempt'] as const)(
      'converges one immutable %s plan exactly once',
      async (source) => {
        const clock = new ManualClock();
        const storage = await factory.create(clock);
        const target = await factory.seed({
          storage,
          source,
          operationId: `shared-operation-${source}`,
        });
        const lease = await storage.acquireTaskLease({
          scope: task,
          ownerId: `deliver-${source}`,
          leaseDurationMs: 60_000,
        });
        let seen: VerifiedClaimedPresentationWork | undefined;
        const receiver = vi.fn(
          async (work: VerifiedClaimedPresentationWork) => {
            seen = work;
            return { receiptSha256: SHA_B };
          },
        );
        const coordinator = new PresentationDeliveryCoordinator(
          storage,
          new PresentationDeliveryBoundary({ receive: receiver }, clock),
        );

        const first = await coordinator.deliver({ lease, target });
        expect(first).toMatchObject({
          source,
          operationId: target.operationId,
          state: 'converged',
          receiptSha256: SHA_B,
        });
        expect(await coordinator.deliver({ lease, target })).toEqual(first);
        expect(receiver).toHaveBeenCalledOnce();
        expect(seen?.source).toBe(source);
        expect(Object.isFrozen(seen)).toBe(true);
        expect(Object.isFrozen(seen?.plan)).toBe(true);
        expect(await storage.readPresentationDelivery(target)).toEqual(first);
        expect(JSON.stringify(first)).not.toMatch(
          /commentBody|label|assignee|login|url|authorization|token|secret/iu,
        );
      },
    );

    it('binds exact resolution replay and rejects structural or changed results', async () => {
      const clock = new ManualClock();
      const storage = await factory.create(clock);
      const target = await factory.seed({
        storage,
        source: 'attempt',
        operationId: 'attempt-exact-resolution',
      });
      const lease = await storage.acquireTaskLease({
        scope: task,
        ownerId: 'exact-resolution',
        leaseDurationMs: 60_000,
      });
      const claim = await storage.claimPresentationDelivery({ lease, target });
      if (claim.work === undefined) throw new Error('missing delivery work');
      const first = await new PresentationDeliveryBoundary(
        { receive: async () => ({ receiptSha256: SHA_A }) },
        clock,
      ).receive(claim.work);
      expect(
        await storage.resolveVerifiedPresentationDelivery({
          lease,
          resolution: first,
        }),
      ).toBe('applied');
      expect(
        await storage.resolveVerifiedPresentationDelivery({
          lease,
          resolution: first,
        }),
      ).toBe('replay');
      const changed = await new PresentationDeliveryBoundary(
        { receive: async () => ({ receiptSha256: SHA_B }) },
        clock,
      ).receive(claim.work);
      await expect(
        storage.resolveVerifiedPresentationDelivery({
          lease,
          resolution: changed,
        }),
      ).rejects.toThrow(AuthorityConflict);
      await expect(
        storage.resolveVerifiedPresentationDelivery({
          lease,
          resolution: {} as never,
        }),
      ).rejects.toThrow(AuthorityConflict);

      const beforeStaleReplay = await storage.readPresentationDelivery(target);
      clock.set(T1);
      const laterLease = await storage.acquireTaskLease({
        scope: task,
        ownerId: 'later-resolution-owner',
        leaseDurationMs: 60_000,
      });
      await expect(
        storage.resolveVerifiedPresentationDelivery({
          lease: laterLease,
          resolution: first,
        }),
      ).rejects.toThrow(AuthorityConflict);
      expect(await storage.readPresentationDelivery(target)).toEqual(
        beforeStaleReplay,
      );
    });

    it('suppresses same-fence replay and makes later-fence takeover unknown without a receiver call', async () => {
      const clock = new ManualClock();
      const storage = await factory.create(clock);
      const target = await factory.seed({
        storage,
        source: 'task',
        operationId: 'task-abandoned-delivery',
      });
      const lease = await storage.acquireTaskLease({
        scope: task,
        ownerId: 'first-delivery-owner',
        leaseDurationMs: 1,
      });
      const first = await storage.claimPresentationDelivery({ lease, target });
      expect(first).toMatchObject({ status: 'claimed' });
      const replay = await storage.claimPresentationDelivery({ lease, target });
      expect(replay.status).toBe('replay');
      expect('work' in replay).toBe(false);
      const receiver = vi.fn();
      const coordinator = new PresentationDeliveryCoordinator(
        storage,
        new PresentationDeliveryBoundary({ receive: receiver }, clock),
      );
      expect(await coordinator.deliver({ lease, target })).toMatchObject({
        state: 'in-flight',
      });
      expect(receiver).not.toHaveBeenCalled();

      clock.set(T1);
      const later = await storage.acquireTaskLease({
        scope: task,
        ownerId: 'later-delivery-owner',
        leaseDurationMs: 60_000,
      });
      expect(await coordinator.deliver({ lease: later, target })).toMatchObject(
        {
          state: 'unknown',
        },
      );
      expect(await coordinator.deliver({ lease: later, target })).toMatchObject(
        {
          state: 'unknown',
        },
      );
      expect(receiver).not.toHaveBeenCalled();
    });

    it('turns a post-begin receiver throw into durable unknown with no redispatch', async () => {
      const clock = new ManualClock();
      const storage = await factory.create(clock);
      const target = await factory.seed({
        storage,
        source: 'attempt',
        operationId: 'attempt-ambiguous-delivery',
      });
      const lease = await storage.acquireTaskLease({
        scope: task,
        ownerId: 'ambiguous-delivery',
        leaseDurationMs: 60_000,
      });
      const receiver = vi.fn(async () => {
        throw new Error('response lost');
      });
      const coordinator = new PresentationDeliveryCoordinator(
        storage,
        new PresentationDeliveryBoundary({ receive: receiver }, clock),
      );
      expect(await coordinator.deliver({ lease, target })).toMatchObject({
        state: 'unknown',
        receiptSha256: '0'.repeat(64),
      });
      expect(await coordinator.deliver({ lease, target })).toMatchObject({
        state: 'unknown',
      });
      expect(receiver).toHaveBeenCalledOnce();

      const malformedStorage = await factory.create(clock);
      const malformedTarget = await factory.seed({
        storage: malformedStorage,
        source: 'attempt',
        operationId: 'attempt-malformed-delivery-receipt',
      });
      const malformedLease = await malformedStorage.acquireTaskLease({
        scope: task,
        ownerId: 'malformed-delivery',
        leaseDurationMs: 60_000,
      });
      const malformedCoordinator = new PresentationDeliveryCoordinator(
        malformedStorage,
        new PresentationDeliveryBoundary(
          {
            receive: async () => ({
              receiptSha256: new String(SHA_B) as unknown as string,
            }),
          },
          clock,
        ),
      );
      expect(
        await malformedCoordinator.deliver({
          lease: malformedLease,
          target: malformedTarget,
        }),
      ).toMatchObject({
        state: 'unknown',
        receiptSha256: '0'.repeat(64),
      });
    });

    it('keeps obsolete Task work inert and isolates task/attempt namespaces', async () => {
      const clock = new ManualClock();
      const storage = await factory.create(clock);
      const operationId = 'shared-presentation-operation';
      const obsoleteTask = await factory.seed({
        storage,
        source: 'task',
        operationId,
        state: 'obsolete',
      });
      const attempt = await factory.seed({
        storage,
        source: 'attempt',
        operationId,
      });
      const lease = await storage.acquireTaskLease({
        scope: task,
        ownerId: 'namespace-delivery',
        leaseDurationMs: 60_000,
      });
      const receiver = vi.fn(async () => ({ receiptSha256: SHA_B }));
      const coordinator = new PresentationDeliveryCoordinator(
        storage,
        new PresentationDeliveryBoundary({ receive: receiver }, clock),
      );
      expect(
        await coordinator.deliver({ lease, target: obsoleteTask }),
      ).toMatchObject({ source: 'task', state: 'obsolete' });
      expect(
        await coordinator.deliver({ lease, target: attempt }),
      ).toMatchObject({ source: 'attempt', state: 'converged' });
      expect(receiver).toHaveBeenCalledOnce();
      expect(
        await storage.listPresentationDelivery({
          tenantId: tenant.tenantId,
        }),
      ).toHaveLength(2);
    });

    it('fails closed for foreign/expired authority and corrupted plan, delivery, or receipt', async () => {
      for (const kind of ['plan', 'delivery', 'receipt'] as const) {
        const clock = new ManualClock();
        const storage = await factory.create(clock);
        const target = await factory.seed({
          storage,
          source: 'attempt',
          operationId: `attempt-corrupt-${kind}`,
        });
        const lease = await storage.acquireTaskLease({
          scope: task,
          ownerId: `corrupt-${kind}`,
          leaseDurationMs: 60_000,
        });
        const coordinator = new PresentationDeliveryCoordinator(
          storage,
          new PresentationDeliveryBoundary(
            { receive: async () => ({ receiptSha256: SHA_B }) },
            clock,
          ),
        );
        await coordinator.deliver({ lease, target });
        await factory.corrupt({ storage, target, kind });
        await expect(coordinator.deliver({ lease, target })).rejects.toThrow(
          AuthorityConflict,
        );
      }

      const clock = new ManualClock();
      const storage = await factory.create(clock);
      const target = await factory.seed({
        storage,
        source: 'task',
        operationId: 'task-authority-isolation',
      });
      const foreign = await storage.acquireTaskLease({
        scope: { ...task, issueNumber: 99 },
        ownerId: 'foreign-delivery',
        leaseDurationMs: 60_000,
      });
      await expect(
        storage.claimPresentationDelivery({ lease: foreign, target }),
      ).rejects.toThrow(AuthorityConflict);
      const expired = await storage.acquireTaskLease({
        scope: task,
        ownerId: 'expired-delivery',
        leaseDurationMs: 1,
      });
      clock.set(T1);
      await expect(
        storage.claimPresentationDelivery({ lease: expired, target }),
      ).rejects.toThrow(AuthorityConflict);
    });
  });
}

type InMemoryPresentationInternals = {
  taskPresentations: Map<string, TaskPresentationRecord>;
  attemptPresentations: Map<string, AttemptPresentationRecord>;
  presentationDeliveries: Map<string, PresentationDeliveryRecord>;
  presentationDeliveryReceipts: Map<string, { snapshot: unknown }>;
};

function deliveryKey(target: PresentationDeliveryTarget): string {
  return target.source === 'task'
    ? JSON.stringify([
        target.tenantId,
        'presentation-delivery',
        'task',
        target.task.repositoryId,
        target.task.issueNumber,
        target.operationId,
      ])
    : JSON.stringify([
        target.tenantId,
        'presentation-delivery',
        'attempt',
        target.task.repositoryId,
        target.task.issueNumber,
        target.attemptId,
        target.operationId,
      ]);
}

runPresentationDeliveryStorageContract({
  create: (clock) => new InMemoryLifecycleAuthorityStorage(clock),
  async seed({ storage, source, operationId, state = 'pending' }) {
    const internals = storage as unknown as InMemoryPresentationInternals;
    const plan =
      source === 'task' ? taskPlan(operationId) : attemptPlan(operationId);
    const target: PresentationDeliveryTarget =
      source === 'task'
        ? { source, tenantId: tenant.tenantId, task, operationId }
        : {
            source,
            tenantId: tenant.tenantId,
            task,
            attemptId,
            operationId,
          };
    if (source === 'task') {
      internals.taskPresentations.set(
        JSON.stringify([
          tenant.tenantId,
          task.repositoryId,
          task.issueNumber,
          'task-presentation',
          operationId,
        ]),
        {
          tenantId: tenant.tenantId,
          plan: plan as TaskPresentationPlan,
          deliveryState: state,
          ...(state === 'obsolete'
            ? { obsoleteAtTaskRevision: 2, obsoleteReason: 'task-resumed' }
            : {}),
        },
      );
    } else {
      internals.attemptPresentations.set(
        JSON.stringify([
          tenant.tenantId,
          attemptId,
          'attempt-presentation',
          operationId,
        ]),
        {
          tenantId: tenant.tenantId,
          plan: plan as AttemptPresentationPlan,
          deliveryState: 'pending',
        },
      );
    }
    internals.presentationDeliveries.set(deliveryKey(target), {
      source,
      tenantId: tenant.tenantId,
      task,
      ...(source === 'attempt' ? { attemptId } : {}),
      operationId,
      planDigest: planDigest(plan),
      state,
    });
    return target;
  },
  async corrupt({ storage, target, kind }) {
    const internals = storage as unknown as InMemoryPresentationInternals;
    if (kind === 'delivery') {
      const record = internals.presentationDeliveries.get(deliveryKey(target));
      if (record === undefined) throw new Error('missing delivery record');
      record.receiptSha256 = SHA_A;
      return;
    }
    if (kind === 'receipt') {
      const receipt = internals.presentationDeliveryReceipts.get(
        deliveryKey(target),
      );
      if (receipt === undefined) throw new Error('missing delivery receipt');
      receipt.snapshot = {};
      return;
    }
    if (target.source === 'task') {
      const key = JSON.stringify([
        target.tenantId,
        target.task.repositoryId,
        target.task.issueNumber,
        'task-presentation',
        target.operationId,
      ]);
      const record = internals.taskPresentations.get(key);
      if (record === undefined) throw new Error('missing Task plan');
      record.plan.effectDigest = SHA_B;
    } else {
      const key = JSON.stringify([
        target.tenantId,
        target.attemptId,
        'attempt-presentation',
        target.operationId,
      ]);
      const record = internals.attemptPresentations.get(key);
      if (record === undefined) throw new Error('missing Attempt plan');
      record.plan.outcomeDigest = SHA_B;
    }
  },
});
