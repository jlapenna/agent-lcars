import { describe, expect, it } from 'vitest';

import { readAttemptHistoryForTest } from './attempt-history-test-support';
import type { AttemptState } from './attempt-reducer';
import type {
  AuthorityClock,
  LifecycleAuthorityStorage,
  TaskAuthorityLease,
  WriteResult,
} from './authority-storage';
import type { AttemptPresentationRecord } from './authority-storage';
import { admittedFixture } from './terminal-finalizer.spec.support';

export type LaunchRejectionHistoryCorruption =
  | 'head'
  | 'registration-predecessor'
  | 'rejection-command-record'
  | 'rejection-command-payload'
  | 'rejection-command-digest'
  | 'command-ref'
  | 'evidence-record'
  | 'evidence-payload'
  | 'evidence-digest'
  | 'evidence-ref'
  | 'outcome-ref'
  | 'outcome-digest'
  | 'legacy-outcome'
  | 'outcome-index'
  | 'rejection-receipt'
  | 'presentation'
  | 'presentation-receipt'
  | 'delivery'
  | 'delivery-receipt'
  | 'launch-identity'
  | 'admission-receipt';

export type LaunchRejectionCommitFailure =
  | 'attempt'
  | 'outcome-index'
  | 'history'
  | 'rejection-receipt'
  | 'presentation'
  | 'presentation-receipt'
  | 'delivery';

export interface LaunchRejectionHistoryInspection {
  attempt: AttemptState | undefined;
  history:
    | {
        head: unknown;
        records: Map<string, unknown[]>;
      }
    | undefined;
  outcomeIndex: string | undefined;
  rejectionReceipt: unknown;
  presentation: AttemptPresentationRecord | undefined;
  presentationReceipt: unknown;
  delivery: unknown;
  deliveryReceipt: unknown;
}

export interface LaunchRejectionHistoryStorageHooks {
  readAttemptHistory: typeof readAttemptHistoryForTest;
  inspectLaunchRejection(
    storage: LifecycleAuthorityStorage,
    attemptId: string,
  ): LaunchRejectionHistoryInspection;
  corruptLaunchRejection(
    storage: LifecycleAuthorityStorage,
    corruption: LaunchRejectionHistoryCorruption,
  ): void;
  failLaunchRejectionCommit(
    storage: LifecycleAuthorityStorage,
    stage: LaunchRejectionCommitFailure,
  ): () => void;
  deleteAttemptHistoryLineage(storage: LifecycleAuthorityStorage): void;
}

export interface LaunchRejectionHistoryStorageFactory {
  create(
    clock: AuthorityClock,
  ): LifecycleAuthorityStorage | Promise<LifecycleAuthorityStorage>;
  historyHooks: LaunchRejectionHistoryStorageHooks;
}

export interface LaunchRejectionCompositionFactory extends LaunchRejectionHistoryStorageFactory {
  reject(input: {
    storage: LifecycleAuthorityStorage;
    lease: TaskAuthorityLease;
    proof: unknown;
    expectedAttemptRevision: number;
  }): Promise<WriteResult>;
}

/**
 * Reusable provider-neutral contract for direct no-run launch terminalization.
 * The aggregate storage suite invokes this with the reference adapter; an
 * eventual durable backend can use the same contract without exposing its
 * internals through the authority port.
 */
export function runLaunchRejectionHistoryStorageContract(
  factory: LaunchRejectionCompositionFactory,
): void {
  const proofFor = (spec: AttemptState['spec']) => ({
    tenantId: spec.tenant.tenantId,
    repositoryId: spec.tenant.repositoryId,
    task: spec.task,
    attemptId: spec.attemptId,
    operationId: spec.attemptId,
    executionEpoch: 1,
    proofSha256: 'a'.repeat(64),
  });

  const prepare = async (clock: AuthorityClock) => {
    const storage = await factory.create(clock);
    const value = await admittedFixture(storage);
    await storage.claimLaunchWork({
      lease: value.lease,
      tenantId: value.spec.tenant.tenantId,
      attemptId: value.spec.attemptId,
    });
    return { storage, ...value };
  };

  describe('launch-rejection history storage contract', () => {
    it('atomically records the decision, evidence, presentation, and private receipt', async () => {
      const clock: AuthorityClock = {
        now: () => '2026-08-22T00:01:00.000Z',
      };
      const { storage, lease, spec } = await prepare(clock);
      await expect(
        factory.reject({
          storage,
          lease,
          proof: proofFor(spec),
          expectedAttemptRevision: 1,
        }),
      ).resolves.toBe('applied');
      const inspection = factory.historyHooks.inspectLaunchRejection(
        storage,
        spec.attemptId,
      );
      expect(inspection.attempt).toMatchObject({
        phase: 'terminal',
        outcome: {
          execution: 'not_started',
          evidence: { kind: 'lifecycle-decision' },
        },
      });
      expect(inspection.history?.records.get('command')).toHaveLength(2);
      expect(inspection.history?.records.get('evidence')).toHaveLength(1);
      expect(inspection.rejectionReceipt).toBeDefined();
      expect(inspection.presentation?.plan.terminal).toMatchObject({
        kind: 'lifecycle-decision',
        decision: 'launch-rejected',
      });
      await expect(
        factory.reject({
          storage,
          lease,
          proof: proofFor(spec),
          expectedAttemptRevision: 1,
        }),
      ).resolves.toBe('replay');
      expect(
        factory.historyHooks.inspectLaunchRejection(storage, spec.attemptId),
      ).toEqual(inspection);
    });

    it('rejects changed identity, revision, and forged proofs without mutation', async () => {
      const clock: AuthorityClock = {
        now: () => '2026-08-22T00:01:00.000Z',
      };
      const { storage, lease, spec } = await prepare(clock);
      await expect(
        factory.reject({
          storage,
          lease,
          proof: { ...proofFor(spec), proofSha256: 'b'.repeat(64) },
          expectedAttemptRevision: 1,
        }),
      ).resolves.toBe('applied');
      const before = factory.historyHooks.inspectLaunchRejection(
        storage,
        spec.attemptId,
      );
      await expect(
        factory.reject({
          storage,
          lease,
          proof: { ...proofFor(spec), operationId: 'wrong-operation' },
          expectedAttemptRevision: 1,
        }),
      ).rejects.toThrow();
      expect(
        factory.historyHooks.inspectLaunchRejection(storage, spec.attemptId),
      ).toEqual(before);
    });

    it.each<LaunchRejectionHistoryCorruption>([
      'head',
      'registration-predecessor',
      'rejection-command-record',
      'rejection-command-payload',
      'rejection-command-digest',
      'command-ref',
      'evidence-record',
      'evidence-payload',
      'evidence-digest',
      'evidence-ref',
      'outcome-ref',
      'outcome-digest',
      'legacy-outcome',
      'outcome-index',
      'rejection-receipt',
      'presentation',
      'presentation-receipt',
      'delivery',
      'launch-identity',
      'admission-receipt',
    ])('fails closed on independent %s corruption', async (corruption) => {
      const clock: AuthorityClock = {
        now: () => '2026-08-22T00:01:00.000Z',
      };
      const { storage, lease, spec } = await prepare(clock);
      await factory.reject({
        storage,
        lease,
        proof: proofFor(spec),
        expectedAttemptRevision: 1,
      });
      factory.historyHooks.corruptLaunchRejection(storage, corruption);
      const corrupted = factory.historyHooks.inspectLaunchRejection(
        storage,
        spec.attemptId,
      );
      await expect(
        factory.reject({
          storage,
          lease,
          proof: proofFor(spec),
          expectedAttemptRevision: 1,
        }),
      ).rejects.toThrow();
      expect(
        factory.historyHooks.inspectLaunchRejection(storage, spec.attemptId),
      ).toEqual(corrupted);
    });

    it.each<LaunchRejectionCommitFailure>([
      'attempt',
      'outcome-index',
      'history',
      'rejection-receipt',
      'presentation',
      'presentation-receipt',
      'delivery',
    ])('rolls back every durable write when %s fails', async (stage) => {
      const clock: AuthorityClock = {
        now: () => '2026-08-22T00:01:00.000Z',
      };
      const { storage, lease, spec } = await prepare(clock);
      const before = factory.historyHooks.inspectLaunchRejection(
        storage,
        spec.attemptId,
      );
      const restore = factory.historyHooks.failLaunchRejectionCommit(
        storage,
        stage,
      );
      try {
        await expect(
          factory.reject({
            storage,
            lease,
            proof: proofFor(spec),
            expectedAttemptRevision: 1,
          }),
        ).rejects.toThrow();
      } finally {
        restore();
      }
      expect(
        factory.historyHooks.inspectLaunchRejection(storage, spec.attemptId),
      ).toEqual(before);
      await expect(
        factory.reject({
          storage,
          lease,
          proof: proofFor(spec),
          expectedAttemptRevision: 1,
        }),
      ).resolves.toBe('applied');
    });

    it('preserves pre-history compatibility without fabricating a shadow lineage', async () => {
      const clock: AuthorityClock = {
        now: () => '2026-08-22T00:01:00.000Z',
      };
      const storage = await factory.create(clock);
      const { lease, spec } = await admittedFixture(storage);
      factory.historyHooks.deleteAttemptHistoryLineage(storage);
      await expect(
        factory.reject({
          storage,
          lease,
          proof: proofFor(spec),
          expectedAttemptRevision: 1,
        }),
      ).resolves.toBe('applied');
      const inspection = factory.historyHooks.inspectLaunchRejection(
        storage,
        spec.attemptId,
      );
      expect(inspection.attempt?.phase).toBe('terminal');
      expect(inspection.history).toBeUndefined();
      expect(inspection.rejectionReceipt).toBeDefined();
      await expect(
        factory.reject({
          storage,
          lease,
          proof: proofFor(spec),
          expectedAttemptRevision: 1,
        }),
      ).resolves.toBe('replay');
    });
  });
}
