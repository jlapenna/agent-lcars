import {
  attemptHistoryPayloadDigest,
  canonicalDurableJson,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it } from 'vitest';

import { readAttemptHistoryForTest } from './attempt-history-test-support';
import {
  type AuthorityClock,
  InMemoryLifecycleAuthorityStorage,
} from './authority-storage';
import { LaunchRejectionComposition } from './launch-rejection-composition';
import { admittedFixture } from './terminal-finalizer.spec.support';

const T0 = '2026-08-22T00:01:00.000Z';
const T1 = '2026-08-22T00:02:00.000Z';

class Clock implements AuthorityClock {
  constructor(private value: string) {}

  now(): string {
    return this.value;
  }

  set(value: string): void {
    this.value = value;
  }
}

describe('LaunchRejectionComposition', () => {
  it('replays an exact stable proof at its committed time after clock advance', async () => {
    const clock = new Clock(T0);
    const storage = new InMemoryLifecycleAuthorityStorage(clock, {
      mint: () => 'A'.repeat(22),
    });
    const { lease, spec } = await admittedFixture(storage);
    await storage.claimLaunchWork({
      lease,
      tenantId: spec.tenant.tenantId,
      attemptId: spec.attemptId,
    });
    const proof = {
      tenantId: spec.tenant.tenantId,
      repositoryId: spec.tenant.repositoryId,
      task: spec.task,
      attemptId: spec.attemptId,
      operationId: spec.attemptId,
      executionEpoch: 1,
      proofSha256: 'a'.repeat(64),
    };
    const composition = new LaunchRejectionComposition({
      storage,
      clock,
      verifier: { verify: async () => proof },
    });

    await expect(
      composition.reject({
        lease,
        proof: undefined,
        expectedAttemptRevision: 1,
      }),
    ).resolves.toBe('applied');
    const committed = await storage.readAttempt({
      tenantId: spec.tenant.tenantId,
      attemptId: spec.attemptId,
    });
    expect(committed?.outcome?.finalizedAt).toBe(T0);

    clock.set(T1);
    await expect(
      composition.reject({
        lease,
        proof: undefined,
        expectedAttemptRevision: 1,
      }),
    ).resolves.toBe('replay');
    expect(
      await storage.readAttempt({
        tenantId: spec.tenant.tenantId,
        attemptId: spec.attemptId,
      }),
    ).toEqual(committed);
    const history = await readAttemptHistoryForTest(storage, {
      lease,
      tenantId: spec.tenant.tenantId,
      attemptId: spec.attemptId,
    });
    expect(history?.records.command).toHaveLength(2);
    expect(history?.records.evidence).toHaveLength(1);
  });

  it('fails closed when a pre-history replay has a jointly tampered outcome index and receipt', async () => {
    const clock = new Clock(T0);
    const storage = new InMemoryLifecycleAuthorityStorage(clock, {
      mint: () => 'A'.repeat(22),
    });
    const { lease, spec } = await admittedFixture(storage);
    await storage.claimLaunchWork({
      lease,
      tenantId: spec.tenant.tenantId,
      attemptId: spec.attemptId,
    });
    const proof = {
      tenantId: spec.tenant.tenantId,
      repositoryId: spec.tenant.repositoryId,
      task: spec.task,
      attemptId: spec.attemptId,
      operationId: spec.attemptId,
      executionEpoch: 1,
      proofSha256: 'a'.repeat(64),
    };
    const composition = new LaunchRejectionComposition({
      storage,
      clock,
      verifier: { verify: async () => proof },
    });
    await composition.reject({
      lease,
      proof: undefined,
      expectedAttemptRevision: 1,
    });

    const internals = storage as unknown as {
      attempts: Map<
        string,
        { outcome?: { failure?: { evidenceRef: string } } }
      >;
      outcomes: Map<string, string>;
      attemptHistories: Map<string, unknown>;
      attemptAdmissionHistoryReceipts: Map<string, unknown>;
      launchRejectionReceipts: Map<string, { outcomeDigest: string }>;
    };
    internals.attemptHistories.clear();
    internals.attemptAdmissionHistoryReceipts.clear();
    const outcome = internals.attempts.get(spec.attemptId)?.outcome;
    if (outcome?.failure === undefined) throw new Error('missing outcome');
    outcome.failure.evidenceRef = 'jointly-tampered';
    internals.outcomes.set(spec.attemptId, canonicalDurableJson(outcome));
    const receipt = internals.launchRejectionReceipts.values().next().value;
    if (receipt === undefined) throw new Error('missing rejection receipt');
    receipt.outcomeDigest = attemptHistoryPayloadDigest(outcome);

    await expect(
      composition.reject({
        lease,
        proof: undefined,
        expectedAttemptRevision: 1,
      }),
    ).rejects.toThrow('Launch rejection replay conflicts');
  });
});
