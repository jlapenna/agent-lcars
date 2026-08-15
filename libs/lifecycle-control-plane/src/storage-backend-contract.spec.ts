import { describe, expect, it } from 'vitest';

import {
  InMemoryLifecycleAuthorityStorage,
  type LifecycleAuthorityStorage,
} from './authority-storage';
import { InMemoryIngressPolicyInbox } from './ingress-policy';
import { writeAttemptForTest } from './launch-resolution-test-support';
import { inMemoryPresentationDeliveryStorageHooks } from './presentation-delivery.in-memory.spec.support';
import { runLifecycleAuthorityBackendContract } from './storage-backend-contract.spec.support';
import { assertLifecycleAuthorityStorageMethodChecklist } from './storage-backend-method-checklist';

assertLifecycleAuthorityStorageMethodChecklist<InMemoryLifecycleAuthorityStorage>();

describe('lifecycle authority backend contract aggregate', () => {
  it('keeps the reference adapter assignable to the complete storage port', () => {
    const factory = {
      create(clock: { now(): string }): LifecycleAuthorityStorage {
        return new InMemoryLifecycleAuthorityStorage(clock, {
          mint: () => 'A'.repeat(22),
        });
      },
    };
    expect(
      factory.create({ now: () => '2026-08-01T00:00:00.000Z' }),
    ).toBeInstanceOf(InMemoryLifecycleAuthorityStorage);
  });
});

runLifecycleAuthorityBackendContract({
  create: (clock, attemptIds) =>
    new InMemoryLifecycleAuthorityStorage(clock, {
      mint: () => attemptIds.mint(),
    }),
  hydrateAttempt: writeAttemptForTest,
  presentation: inMemoryPresentationDeliveryStorageHooks,
  createInbox: (clock, evidenceResolver) =>
    new InMemoryIngressPolicyInbox(clock, evidenceResolver),
});
