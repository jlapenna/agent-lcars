import { createHash } from 'node:crypto';

import type {
  AttemptPresentationPlan,
  TaskPresentationPlan,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  InMemoryLifecycleAuthorityStorage,
  type PresentationDeliveryTarget,
  type TaskAuthorityScope,
} from './authority-storage';
import {
  PresentationDeliveryComposition,
  PresentationDeliveryCompositionConflict,
} from './presentation-delivery-composition';

const tenant = {
  tenantId: 'tenant-1102',
  repositoryId: 321,
  repository: 'o/r',
  installationId: 9,
};
const task: TaskAuthorityScope = {
  tenantId: tenant.tenantId,
  repositoryId: 321,
  issueNumber: 7,
};
const operationId = 'operation-1102';
const SHA = 'a'.repeat(64);
const attemptId = 'A'.repeat(22);

class Clock {
  value = '2026-08-22T00:00:00.000Z';
  now() {
    return this.value;
  }
}

function plan(): TaskPresentationPlan {
  return {
    schema: 'agent-lcars.task-presentation-plan/v1',
    version: 1,
    operationId,
    tenant,
    task,
    taskRevision: 1,
    sourceFactId: 'fact',
    taskEffectKey: 'effect',
    effectDigest: SHA,
    transitionDigest: SHA,
    activation: {
      activationId: 'activation',
      taskClassId: 'github-issue',
      authorityEpoch: 1,
      mode: 'central-authoritative',
    },
    presentation: {
      disposition: 'parked',
      humanAttention: 'required',
      notice: { kind: 'task-parked' },
      intentId: 'intent',
      intentRevision: 1,
      reason: 'policy-rejected',
    },
  };
}

function attemptPlan(): AttemptPresentationPlan {
  return {
    schema: 'agent-lcars.attempt-presentation-plan/v1',
    version: 1,
    operationId,
    tenant,
    task,
    attemptId,
    attemptRevision: 1,
    terminal: {
      kind: 'finalization',
      commandId: 'command',
      terminalFactId: 'terminal',
    },
    outcomeDigest: SHA,
    activation: {
      activationId: 'activation',
      taskClassId: 'github-issue',
      authorityEpoch: 1,
      mode: 'central-authoritative',
    },
    presentation: {
      kind: 'attempt-finalized',
      terminalState: 'succeeded',
      execution: 'exited',
      result: 'pull-request',
      reference: { kind: 'pull-request', number: 1 },
      evidenceValidation: 'validated',
    },
  };
}

function digest(value: unknown): string {
  const canonical = (child: unknown): unknown =>
    Array.isArray(child)
      ? child.map(canonical)
      : child !== null && typeof child === 'object'
        ? Object.fromEntries(
            Object.entries(child)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : child;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

async function setup(
  source: 'task' | 'attempt' = 'task',
  state: 'pending' | 'obsolete' = 'pending',
) {
  const clock = new Clock();
  const storage = new InMemoryLifecycleAuthorityStorage(clock);
  const p = source === 'task' ? plan() : attemptPlan();
  const target: PresentationDeliveryTarget =
    source === 'task'
      ? { source, tenantId: tenant.tenantId, task, operationId }
      : { source, tenantId: tenant.tenantId, task, attemptId, operationId };
  const internals = storage as unknown as Record<string, Map<string, any>>;
  const planKey =
    source === 'task'
      ? JSON.stringify([
          tenant.tenantId,
          task.repositoryId,
          task.issueNumber,
          'task-presentation',
          operationId,
        ])
      : JSON.stringify([
          tenant.tenantId,
          attemptId,
          'attempt-presentation',
          operationId,
        ]);
  const deliveryKey =
    source === 'task'
      ? JSON.stringify([
          tenant.tenantId,
          'presentation-delivery',
          'task',
          task.repositoryId,
          task.issueNumber,
          operationId,
        ])
      : JSON.stringify([
          tenant.tenantId,
          'presentation-delivery',
          'attempt',
          task.repositoryId,
          task.issueNumber,
          attemptId,
          operationId,
        ]);
  if (source === 'task')
    internals.taskPresentations.set(planKey, {
      tenantId: tenant.tenantId,
      plan: p,
      deliveryState: state,
      ...(state === 'obsolete'
        ? { obsoleteAtTaskRevision: 2, obsoleteReason: 'task-resumed' }
        : {}),
    });
  else
    internals.attemptPresentations.set(planKey, {
      tenantId: tenant.tenantId,
      plan: p,
      deliveryState: 'pending',
    });
  internals.presentationDeliveries.set(deliveryKey, {
    source,
    tenantId: tenant.tenantId,
    task,
    ...(source === 'attempt' ? { attemptId } : {}),
    operationId,
    planDigest: digest(p),
    state,
  });
  let chain = Promise.resolve();
  const run = vi.fn(
    async (
      scope: TaskAuthorityScope,
      operation: (lease: any) => Promise<any>,
    ) => {
      const current = chain.then(async () => {
        const lease = await storage.acquireTaskLease({
          scope,
          ownerId: 'composition',
          leaseDurationMs: 60_000,
        });
        try {
          return await operation(lease);
        } finally {
          await storage.releaseTaskLease(lease);
        }
      });
      chain = current.then(
        () => undefined,
        () => undefined,
      );
      return current;
    },
  );
  return {
    clock,
    storage,
    target,
    run,
    composition: (receiver: any) =>
      new PresentationDeliveryComposition({
        storage,
        receiver,
        clock,
        leases: { run },
      }),
  };
}

describe('inactive presentation delivery composition', () => {
  it('owns the lease and returns only the durable receipt', async () => {
    const t = await setup();
    const receiver = vi.fn(async () => ({ receiptSha256: 'b'.repeat(64) }));
    const result = await t
      .composition({ receive: receiver })
      .deliver({ target: t.target });
    expect(result).toMatchObject({ source: 'task', state: 'converged' });
    expect(JSON.stringify(result)).not.toMatch(
      /token|fence|authorization|provider|secret/iu,
    );
    expect(receiver).toHaveBeenCalledOnce();
    expect(t.run).toHaveBeenCalledWith(task, expect.any(Function));
    expect(
      await t.composition({ receive: receiver }).deliver({ target: t.target }),
    ).toEqual(result);
    expect(receiver).toHaveBeenCalledOnce();
  });

  it('delivers an Attempt row and isolates a colliding Task operation ID', async () => {
    const taskRow = await setup('task');
    const attempt = taskRow;
    const p = attemptPlan();
    const internals = attempt.storage as unknown as Record<
      string,
      Map<string, any>
    >;
    const attemptTarget: PresentationDeliveryTarget = {
      source: 'attempt',
      tenantId: tenant.tenantId,
      task,
      attemptId,
      operationId,
    };
    internals.attemptPresentations.set(
      JSON.stringify([
        tenant.tenantId,
        attemptId,
        'attempt-presentation',
        operationId,
      ]),
      { tenantId: tenant.tenantId, plan: p, deliveryState: 'pending' },
    );
    internals.presentationDeliveries.set(
      JSON.stringify([
        tenant.tenantId,
        'presentation-delivery',
        'attempt',
        task.repositoryId,
        task.issueNumber,
        attemptId,
        operationId,
      ]),
      {
        source: 'attempt',
        tenantId: tenant.tenantId,
        task,
        attemptId,
        operationId,
        planDigest: digest(p),
        state: 'pending',
      },
    );
    const receiver = vi.fn(async () => ({ receiptSha256: 'b'.repeat(64) }));
    const result = await attempt
      .composition({ receive: receiver })
      .deliver({ target: attemptTarget });
    const taskResult = await taskRow
      .composition({ receive: receiver })
      .deliver({ target: taskRow.target });
    expect(result.source).toBe('attempt');
    expect(taskResult.source).toBe('task');
    expect(receiver).toHaveBeenCalledTimes(2);
  });

  it('serializes concurrent calls and converts receiver failure to unknown', async () => {
    const t = await setup();
    const receiver = vi.fn(async () => {
      throw new Error('provider down');
    });
    const c = t.composition({ receive: receiver });
    const results = await Promise.all([
      c.deliver({ target: t.target }),
      c.deliver({ target: t.target }),
    ]);
    expect(results[0]).toMatchObject({ state: 'unknown' });
    expect(results[1]).toMatchObject({ state: 'unknown' });
    expect(receiver).toHaveBeenCalledOnce();
    expect(await c.deliver({ target: t.target })).toMatchObject({
      state: 'unknown',
    });
    expect(receiver).toHaveBeenCalledOnce();
    await expect(
      t.storage.acquireTaskLease({
        scope: task,
        ownerId: 'after',
        leaseDurationMs: 1,
      }),
    ).resolves.toBeTruthy();
  });

  it('rejects malformed, foreign, and unknown targets before leasing', async () => {
    const t = await setup();
    const c = t.composition({ receive: vi.fn() });
    for (const target of [
      null,
      { ...t.target, tenantId: 'other' },
      { ...t.target, operationId: 'missing' },
    ])
      await expect(c.deliver({ target } as never)).rejects.toBeInstanceOf(
        PresentationDeliveryCompositionConflict,
      );
    expect(t.run).not.toHaveBeenCalled();
  });

  it('keeps obsolete delivery inert', async () => {
    const t = await setup('task', 'obsolete');
    const receiver = vi.fn();
    const result = await t
      .composition({ receive: receiver })
      .deliver({ target: t.target });
    expect(result.state).toBe('obsolete');
    expect(receiver).not.toHaveBeenCalled();
  });

  it('takes over abandoned in-flight work without calling the receiver', async () => {
    const t = await setup();
    const lease = await t.storage.acquireTaskLease({
      scope: task,
      ownerId: 'abandoned',
      leaseDurationMs: 1,
    });
    const claim = await t.storage.claimPresentationDelivery({
      lease,
      target: t.target,
    });
    expect(claim.status).toBe('claimed');
    t.clock.value = '2026-08-23T00:00:00.000Z';
    const receiver = vi.fn();
    const result = await t
      .composition({ receive: receiver })
      .deliver({ target: t.target });
    expect(result.state).toBe('unknown');
    expect(receiver).not.toHaveBeenCalled();
  });

  it('does not allow caller task scope to redirect a durable operation', async () => {
    const t = await setup();
    const receiver = vi.fn();
    await expect(
      t.composition({ receive: receiver }).deliver({
        target: { ...t.target, task: { ...task, issueNumber: 99 } },
      }),
    ).rejects.toBeInstanceOf(PresentationDeliveryCompositionConflict);
    expect(t.run).not.toHaveBeenCalled();
  });

  it.each(['plan', 'delivery', 'receipt'] as const)(
    'fails closed when the durable %s is corrupted',
    async (kind) => {
      const t = await setup();
      const internals = t.storage as unknown as Record<
        string,
        Map<string, any>
      >;
      const planKey = JSON.stringify([
        tenant.tenantId,
        task.repositoryId,
        task.issueNumber,
        'task-presentation',
        operationId,
      ]);
      const deliveryKey = JSON.stringify([
        tenant.tenantId,
        'presentation-delivery',
        'task',
        task.repositoryId,
        task.issueNumber,
        operationId,
      ]);
      if (kind === 'plan')
        internals.taskPresentations.get(planKey).plan.effectDigest = 'b'.repeat(
          64,
        );
      if (kind === 'delivery')
        internals.presentationDeliveries.get(deliveryKey).planDigest =
          'b'.repeat(64);
      if (kind === 'receipt')
        internals.presentationDeliveryReceipts.set(deliveryKey, {
          snapshot: {},
        });
      await expect(
        t.composition({ receive: vi.fn() }).deliver({ target: t.target }),
      ).rejects.toThrow();
      expect(t.run).not.toHaveBeenCalled();
    },
  );
});
