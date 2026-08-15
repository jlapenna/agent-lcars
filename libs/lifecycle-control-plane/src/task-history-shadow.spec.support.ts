import type { ActivationRecord } from '@agent-lcars/dispatch-contracts';
import { describe, expect, it } from 'vitest';

import type {
  AuthorityClock,
  LifecycleAuthorityStorage,
  TaskAuthorityLease,
} from './authority-storage';
import { mintTaskEffectTransition } from './task-effect-capability';
import type { TaskHistoryInspection } from './task-history-test-support';
import { readTaskHistoryForTest } from './task-history-test-support';
import type { TaskIntentState } from './task-intent-reducer';
import { reduceTaskIntent } from './task-intent-reducer';

const T0 = '2026-08-21T00:00:00.000Z';
const SHA = 'a'.repeat(64);

export interface TaskHistoryShadowStorageFactory {
  create(clock: AuthorityClock): Promise<LifecycleAuthorityStorage>;
  read: typeof readTaskHistoryForTest;
  hydrateLegacyTask(input: {
    storage: LifecycleAuthorityStorage;
    lease: TaskAuthorityLease;
    expectedRevision: number;
    state: TaskIntentState;
  }): Promise<void>;
  /** Test-only corruption seam; production storage has no history writer. */
  corruptHead: (storage: LifecycleAuthorityStorage) => void;
  /** Test-only corruption seam; production storage has no history writer. */
  deleteAuxHead: (
    storage: LifecycleAuthorityStorage,
    stream: 'effect' | 'command' | 'presentation',
  ) => void;
  /** Returns a restore function after making the next history commit fail. */
  failHistoryCommit: (storage: LifecycleAuthorityStorage) => () => void;
}

interface Fixture {
  tenant: {
    tenantId: string;
    repositoryId: number;
    repository: string;
    installationId: number;
  };
  task: { tenantId: string; repositoryId: number; issueNumber: number };
  activation: ActivationRecord;
}

class ContractClock implements AuthorityClock {
  private value = T0;

  now(): string {
    return this.value;
  }

  set(value: string): void {
    this.value = value;
  }
}

function fixture(suffix = 'contract'): Fixture {
  const tenant = {
    tenantId: `history-${suffix}`,
    repositoryId: 1901,
    repository: `octo/history-${suffix}`,
    installationId: 1902,
  };
  return {
    tenant,
    task: { tenantId: tenant.tenantId, repositoryId: 1901, issueNumber: 1 },
    activation: {
      schema: 'agent-lcars.control-plane-activation/v1',
      version: 1,
      tenant,
      taskClassId: 'github-issue',
      activationId: `history-${suffix}`,
      authorityEpoch: 1,
      effectiveBoundary: 1,
      mode: 'central-authoritative',
      effectMode: 'enabled',
      recordedAt: T0,
    },
  };
}

function transition(
  clock: ContractClock,
  value: Fixture,
  factId: string,
  expectedRevision: number,
  semanticDigest = SHA,
) {
  return mintTaskEffectTransition(
    {
      expectedRevision,
      envelope: {
        schema: 'agent-lcars.control-plane-signal/v1',
        version: 1,
        requestId: `request-${factId}`,
        factId,
        tenant: value.tenant,
        task: value.task,
        signal: {
          kind: 'requested-work',
          mode: 'implement',
          requestKey: `key-${factId}`,
        },
        receivedAt: T0,
        source: {
          kind: 'github-webhook',
          deliveryId: `delivery-${factId}`,
          repositoryId: value.tenant.repositoryId,
          installationId: value.tenant.installationId,
          bodySha256: SHA,
          event: 'issues',
          action: 'labeled',
          actorId: 8,
          actorLogin: 'octo',
          occurredAt: T0,
          hmacKeyVersion: 'key-v1',
        },
      },
      policyDecision: {
        schema: 'agent-lcars.policy-decision/v1',
        version: 1,
        policy: {
          policyId: 'history-policy',
          policyVersion: 1,
          contentSha256: SHA,
        },
        decision: 'accepted',
        ruleId: 'maintainer',
        sourceFactId: factId,
        principal: { kind: 'github-actor', actorId: 8, login: 'octo' },
        evidenceRef: `evidence-${factId}`,
        decidedAt: T0,
      },
      activation: value.activation,
      candidate: {
        intentId: `intent-${factId}`,
        semanticKey: `semantic-${factId}`,
        semanticDigest,
        orderingKey: { occurredAt: T0, tieBreaker: `tie-${factId}` },
      },
    },
    clock,
  );
}

async function acquire(
  storage: LifecycleAuthorityStorage,
  value: Fixture,
  ownerId = 'history-contract',
): Promise<TaskAuthorityLease> {
  return storage.acquireTaskLease({
    scope: value.task,
    ownerId,
    leaseDurationMs: 60_000,
  });
}

function read(
  factory: TaskHistoryShadowStorageFactory,
  storage: LifecycleAuthorityStorage,
  input: Parameters<typeof readTaskHistoryForTest>[1],
): Promise<TaskHistoryInspection | undefined> {
  return factory.read(storage, input);
}

/**
 * Reusable async contract for a backend's Task-history shadow implementation.
 * The read/corruption/fault seams are intentionally test-only and are not part
 * of LifecycleAuthorityStorage or any package barrel.
 */
export function runTaskHistoryShadowStorageContract(
  factory: TaskHistoryShadowStorageFactory,
): void {
  describe('Task history shadow storage contract', () => {
    it('creates a mirror, replays by exact refs, and isolates leases', async () => {
      const clock = new ContractClock();
      const storage = await factory.create(clock);
      const value = fixture();
      await storage.registerActivation(value.activation);
      const lease = await acquire(storage, value);
      const first = transition(clock, value, 'contract-1', 0);
      await storage.applyTaskEffectTransition({ lease, transition: first });
      await storage.applyTaskEffectTransition({
        lease,
        transition: transition(clock, value, 'contract-2', 1),
      });
      await expect(
        storage.applyTaskEffectTransition({ lease, transition: first }),
      ).resolves.toMatchObject({ status: 'replay', task: { revision: 1 } });
      await expect(
        storage.applyTaskEffectTransition({
          lease,
          transition: transition(clock, value, 'contract-1', 0, 'b'.repeat(64)),
        }),
      ).rejects.toThrow(/conflict|digest|different command/i);
      const history = await read(factory, storage, {
        lease,
        tenantId: value.tenant.tenantId,
        task: value.task,
      });
      expect(history?.head).toMatchObject({
        aggregateRevision: 2,
        factHead: { count: 2 },
        intentHead: { count: 3 },
      });
      expect(history?.effectRecords).toHaveLength(2);
      expect(history?.workRecords).toHaveLength(0);
      expect('writeTaskHistory' in storage).toBe(false);

      const foreign = await storage.acquireTaskLease({
        scope: { ...value.task, tenantId: 'history-foreign' },
        ownerId: 'foreign',
        leaseDurationMs: 60_000,
      });
      await expect(
        read(factory, storage, {
          lease: foreign,
          tenantId: value.tenant.tenantId,
          task: value.task,
        }),
      ).rejects.toThrow();

      const late = transition(clock, value, 'contract-late', 2);
      clock.set('2026-08-21T01:00:01.000Z');
      await expect(
        storage.applyTaskEffectTransition({ lease, transition: late }),
      ).rejects.toThrow(/lease|authority/i);
    });

    it('upgrades a legacy Task and fails closed on corruption', async () => {
      const clock = new ContractClock();
      const storage = await factory.create(clock);
      const value = fixture('legacy');
      await storage.registerActivation(value.activation);
      const lease = await acquire(storage, value);
      const first = transition(clock, value, 'legacy-1', 0);
      const reduced = reduceTaskIntent(undefined, first.input);
      if (reduced.status !== 'applied')
        throw new Error('legacy fixture did not reduce');
      await factory.hydrateLegacyTask({
        storage,
        lease,
        expectedRevision: 0,
        state: reduced.state,
      });
      await storage.applyTaskEffectTransition({
        lease,
        transition: transition(clock, value, 'legacy-2', 1),
      });
      const upgraded = await read(factory, storage, {
        lease,
        tenantId: value.tenant.tenantId,
        task: value.task,
      });
      expect(upgraded?.head).toMatchObject({
        aggregateRevision: 2,
        factHead: { count: 2 },
      });
      factory.corruptHead(storage);
      await expect(
        storage.applyTaskEffectTransition({
          lease,
          transition: transition(clock, value, 'legacy-2', 1),
        }),
      ).rejects.toThrow(/history/i);
    });

    for (const stream of ['effect', 'command', 'presentation'] as const) {
      it(`fails closed when the ${stream} auxiliary head is deleted`, async () => {
        const clock = new ContractClock();
        const storage = await factory.create(clock);
        const value = fixture(`missing-${stream}`);
        await storage.registerActivation(value.activation);
        const lease = await acquire(storage, value);
        const first = transition(clock, value, `missing-${stream}-1`, 0);
        await storage.applyTaskEffectTransition({ lease, transition: first });
        const before = {
          task: await storage.readTask(value.task),
          effects: await storage.listTaskEffects({
            tenantId: value.tenant.tenantId,
            task: value.task,
          }),
          presentations: await storage.listTaskPresentations({
            tenantId: value.tenant.tenantId,
            task: value.task,
          }),
        };

        factory.deleteAuxHead(storage, stream);
        await expect(
          storage.applyTaskEffectTransition({ lease, transition: first }),
        ).rejects.toThrow(/history/i);
        await expect(
          storage.applyTaskEffectTransition({
            lease,
            transition: transition(clock, value, `missing-${stream}-2`, 1),
          }),
        ).rejects.toThrow(/history/i);
        expect(await storage.readTask(value.task)).toEqual(before.task);
        expect(
          await storage.listTaskEffects({
            tenantId: value.tenant.tenantId,
            task: value.task,
          }),
        ).toEqual(before.effects);
        expect(
          await storage.listTaskPresentations({
            tenantId: value.tenant.tenantId,
            task: value.task,
          }),
        ).toEqual(before.presentations);
      });
    }

    it('rolls back legacy and shadow state when history commit fails', async () => {
      const clock = new ContractClock();
      const storage = await factory.create(clock);
      const value = fixture('rollback');
      await storage.registerActivation(value.activation);
      const lease = await acquire(storage, value);
      const first = transition(clock, value, 'rollback-1', 0);
      const second = transition(clock, value, 'rollback-2', 1);
      await storage.applyTaskEffectTransition({ lease, transition: first });
      const before = await storage.readTask(value.task);
      const restore = factory.failHistoryCommit(storage);
      await expect(
        storage.applyTaskEffectTransition({ lease, transition: second }),
      ).rejects.toThrow();
      restore();
      expect(await storage.readTask(value.task)).toEqual(before);
      expect(
        await storage.listTaskEffects({
          tenantId: value.tenant.tenantId,
          task: value.task,
        }),
      ).toHaveLength(1);
    });
  });
}
