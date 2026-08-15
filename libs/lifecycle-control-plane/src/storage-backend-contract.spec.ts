import { describe, expect, it } from 'vitest';

import { readAttemptHistoryForTest } from './attempt-history-test-support';
import {
  InMemoryLifecycleAuthorityStorage,
  type LifecycleAuthorityStorage,
} from './authority-storage';
import { inMemoryCancellationHistoryStorageHooks } from './cancellation-history.in-memory.spec.support';
import { InMemoryIngressPolicyInbox } from './ingress-policy';
import { inMemoryBindingHistoryHooks } from './launch-binding-history-test-support';
import { inMemoryLaunchResolutionHistoryStorageHooks } from './launch-resolution-history.in-memory.spec.support';
import { writeAttemptForTest } from './launch-resolution-test-support';
import { inMemoryPresentationDeliveryStorageHooks } from './presentation-delivery.in-memory.spec.support';
import { runLifecycleAuthorityBackendContract } from './storage-backend-contract.spec.support';
import { assertLifecycleAuthorityStorageMethodChecklist } from './storage-backend-method-checklist';
import type { AttemptAdmissionHistoryStorageHooks } from './task-attempt-admission.spec.support';
import { readTaskHistoryForTest } from './task-history-test-support';
import { inMemoryTerminalClaimHistoryHooks } from './terminal-claim-history.in-memory.spec.support';

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

const admissionHistory: AttemptAdmissionHistoryStorageHooks = {
  readAttemptHistory: readAttemptHistoryForTest,
  readTaskHistory: readTaskHistoryForTest,
  corruptAttemptHistory: (storage) => {
    const histories = (
      storage as unknown as {
        attemptHistories: Map<string, { head: { aggregateRevision: number } }>;
      }
    ).attemptHistories;
    const history = histories.values().next().value;
    if (history === undefined) throw new Error('missing Attempt history');
    history.head.aggregateRevision = 99;
  },
  corruptAttemptHistoryLaunch: (storage, kind) => {
    const histories = (
      storage as unknown as {
        attemptHistories: Map<
          string,
          {
            head: {
              attemptId: string;
              launch: { operationId: string; executionEpoch: number };
            };
          }
        >;
      }
    ).attemptHistories;
    const history = histories.values().next().value;
    if (history === undefined) throw new Error('missing Attempt history');
    if (kind === 'operation') history.head.launch.operationId = 'B'.repeat(22);
    else history.head.launch.executionEpoch = 2;
  },
  corruptLaunch: (storage, kind) => {
    const launches = (
      storage as unknown as {
        launches: Map<string, { repositoryId: number; executionEpoch: number }>;
      }
    ).launches;
    const launch = launches.values().next().value;
    if (launch === undefined) throw new Error('missing launch');
    if (kind === 'repository') launch.repositoryId = 999;
    else launch.executionEpoch = 2;
  },
  corruptTaskAdmissionHistory: (storage) => {
    const histories = (
      storage as unknown as {
        taskHistories: Map<
          string,
          { workRecords: Array<{ payload: { inputDigest: string } }> }
        >;
      }
    ).taskHistories;
    const history = histories.values().next().value;
    const record = history?.workRecords[0];
    if (record === undefined) throw new Error('missing Task admission history');
    record.payload.inputDigest = 'b'.repeat(64);
  },
  corruptAcceptanceSpecDigest: (storage) => {
    const acceptances = (
      storage as unknown as {
        acceptances: Map<string, { specDigest: string }>;
      }
    ).acceptances;
    const acceptance = acceptances.values().next().value;
    if (acceptance === undefined) throw new Error('missing acceptance');
    acceptance.specDigest = 'b'.repeat(64);
  },
  corruptAcceptanceTaskSnapshot: (storage) => {
    const acceptances = (
      storage as unknown as {
        acceptances: Map<string, { task: { updatedAt: string } }>;
      }
    ).acceptances;
    const acceptance = acceptances.values().next().value;
    if (acceptance === undefined) throw new Error('missing acceptance');
    acceptance.task.updatedAt = '2026-08-20T00:00:01.000Z';
  },
  failAttemptHistoryCommit: (storage) => {
    const histories = (
      storage as unknown as { attemptHistories: Map<string, unknown> }
    ).attemptHistories;
    const originalSet = histories.set;
    histories.set = (() => {
      throw new Error('injected Attempt history commit failure');
    }) as typeof originalSet;
    return () => {
      histories.set = originalSet;
    };
  },
};

runLifecycleAuthorityBackendContract({
  create: (clock, attemptIds) =>
    new InMemoryLifecycleAuthorityStorage(clock, {
      mint: () => attemptIds.mint(),
    }),
  hydrateAttempt: writeAttemptForTest,
  presentation: inMemoryPresentationDeliveryStorageHooks,
  createInbox: (clock, evidenceResolver) =>
    new InMemoryIngressPolicyInbox(clock, evidenceResolver),
  admissionHistory,
  bindingHistory: inMemoryBindingHistoryHooks(),
  launchResolutionHistory: inMemoryLaunchResolutionHistoryStorageHooks(),
  cancellationHistory: inMemoryCancellationHistoryStorageHooks(),
  terminalClaimHistory: inMemoryTerminalClaimHistoryHooks(),
});
