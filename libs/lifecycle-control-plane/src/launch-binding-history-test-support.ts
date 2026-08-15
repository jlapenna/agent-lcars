import type { AcceptedAttemptSpec } from '@agent-lcars/dispatch-contracts';

import { readAttemptHistoryForTest } from './attempt-history-test-support';
import { attemptTransitionDigest, reduceAttempt } from './attempt-reducer';
import { hydrateAttemptForTest } from './attempt-test-hydration';
import type {
  LifecycleAuthorityStorage,
  TaskAuthorityLease,
} from './authority-storage';

export interface BindingHistoryStorageHooks {
  readAttemptHistory: typeof readAttemptHistoryForTest;
  deleteAttemptHistory(storage: LifecycleAuthorityStorage): void;
  deleteAdmissionLineage(storage: LifecycleAuthorityStorage): void;
  deleteAdmissionHistoryArtifactsRetainAcceptance(
    storage: LifecycleAuthorityStorage,
  ): void;
  corruptAttemptHistoryHead(storage: LifecycleAuthorityStorage): void;
  corruptAttemptHistoryRecord(
    storage: LifecycleAuthorityStorage,
    kind: 'payload' | 'digest' | 'reference',
  ): void;
  corruptAdmissionReceipt(storage: LifecycleAuthorityStorage): void;
  corruptAdmissionTaskPointer(storage: LifecycleAuthorityStorage): void;
  failAttemptHistoryCommit(storage: LifecycleAuthorityStorage): () => void;
  inspectBindingInternals(storage: LifecycleAuthorityStorage): {
    factKeys: number;
    requestKeys: number;
    bindings: number;
  };
  prepareAwaitingBindingCancellation(
    storage: LifecycleAuthorityStorage,
    lease: TaskAuthorityLease,
    spec: AcceptedAttemptSpec,
  ): Promise<void>;
}

/** Reference-adapter hooks shared by the standalone and aggregate contracts. */
export const inMemoryBindingHistoryHooks = (): BindingHistoryStorageHooks => ({
  readAttemptHistory: readAttemptHistoryForTest,
  deleteAttemptHistory: (storage) => {
    const histories = (
      storage as unknown as { attemptHistories: Map<string, unknown> }
    ).attemptHistories;
    const key = histories.keys().next().value;
    if (key === undefined) throw new Error('missing history');
    histories.delete(key);
  },
  deleteAdmissionLineage: (storage) => {
    const value = storage as unknown as {
      attemptHistories: Map<string, unknown>;
      taskHistories: Map<string, unknown>;
      acceptances: Map<string, unknown>;
      attemptAdmissionHistoryReceipts: Map<string, unknown>;
    };
    value.attemptHistories.clear();
    value.taskHistories.clear();
    value.acceptances.clear();
    value.attemptAdmissionHistoryReceipts.clear();
  },
  deleteAdmissionHistoryArtifactsRetainAcceptance: (storage) => {
    const value = storage as unknown as {
      attemptHistories: Map<string, unknown>;
      attemptAdmissionHistoryReceipts: Map<string, unknown>;
    };
    value.attemptHistories.clear();
    value.attemptAdmissionHistoryReceipts.clear();
  },
  corruptAttemptHistoryHead: (storage) => {
    const histories = (
      storage as unknown as {
        attemptHistories: Map<string, { head: { aggregateRevision: number } }>;
      }
    ).attemptHistories;
    const history = histories.values().next().value;
    if (history === undefined) throw new Error('missing history');
    history.head.aggregateRevision = 99;
  },
  corruptAttemptHistoryRecord: (storage, kind) => {
    const value = storage as unknown as {
      attemptHistories: Map<
        string,
        {
          records: Map<
            string,
            Array<{
              record: { recordDigest: string };
              payload: { payload?: { binding?: { runId: number } } };
            }>
          >;
        }
      >;
      factKeys: Map<string, { historyRecordRef?: { recordDigest: string } }>;
      requestKeys: Map<string, { historyRecordRef?: { recordDigest: string } }>;
    };
    const history = value.attemptHistories.values().next().value;
    const entry = history?.records.get('fact')?.[0];
    if (entry === undefined) throw new Error('missing binding history record');
    if (kind === 'payload') {
      if (entry.payload.payload?.binding === undefined)
        throw new Error('missing binding payload');
      entry.payload.payload.binding.runId = 99;
    } else if (kind === 'digest') {
      entry.record.recordDigest = 'a'.repeat(64);
    } else {
      const idempotency = value.factKeys.values().next().value;
      if (idempotency === undefined)
        throw new Error('missing binding idempotency record');
      idempotency.historyRecordRef = { recordDigest: 'a'.repeat(64) };
      const request = value.requestKeys.values().next().value;
      if (request === undefined)
        throw new Error('missing binding request record');
      request.historyRecordRef = { recordDigest: 'b'.repeat(64) };
    }
  },
  corruptAdmissionReceipt: (storage) => {
    const receipts = (
      storage as unknown as {
        attemptAdmissionHistoryReceipts: Map<
          string,
          { admissionDigest: string }
        >;
      }
    ).attemptAdmissionHistoryReceipts;
    const receipt = receipts.values().next().value;
    if (receipt === undefined) throw new Error('missing admission receipt');
    receipt.admissionDigest = 'a'.repeat(64);
  },
  corruptAdmissionTaskPointer: (storage) => {
    const receipts = (
      storage as unknown as {
        attemptAdmissionHistoryReceipts: Map<
          string,
          { taskAdmissionRecordRef: { recordDigest: string } }
        >;
      }
    ).attemptAdmissionHistoryReceipts;
    const receipt = receipts.values().next().value;
    if (receipt === undefined) throw new Error('missing admission receipt');
    receipt.taskAdmissionRecordRef = { recordDigest: 'a'.repeat(64) };
  },
  failAttemptHistoryCommit: (storage) => {
    const histories = (
      storage as unknown as { attemptHistories: Map<string, unknown> }
    ).attemptHistories;
    const originalSet = histories.set;
    histories.set = (() => {
      throw new Error('injected history failure');
    }) as typeof originalSet;
    return () => {
      histories.set = originalSet;
    };
  },
  inspectBindingInternals: (storage) => {
    const value = storage as unknown as {
      factKeys: Map<string, unknown>;
      requestKeys: Map<string, unknown>;
      bindings: Map<string, unknown>;
    };
    return {
      factKeys: value.factKeys.size,
      requestKeys: value.requestKeys.size,
      bindings: value.bindings.size,
    };
  },
  prepareAwaitingBindingCancellation: async (storage, lease, spec) => {
    const attempt = await storage.readAttempt({
      tenantId: spec.tenant.tenantId,
      attemptId: spec.attemptId,
    });
    if (attempt === undefined) throw new Error('missing attempt');
    const event = {
      kind: 'request-cancel' as const,
      eventId: 'binding-cancel-test',
    };
    const reduced = reduceAttempt(attempt, {
      kind: 'transition',
      expectedRevision: attempt.revision,
      transitionedAt: attempt.updatedAt,
      canonicalDigest: attemptTransitionDigest(event),
      event,
    });
    if (reduced.status !== 'applied')
      throw new Error('cancellation was not applied');
    await hydrateAttemptForTest(storage, {
      lease,
      expectedRevision: attempt.revision,
      next: reduced.state,
    });
    const value = storage as unknown as {
      cancellationWork: Map<
        string,
        {
          tenantId: string;
          attemptId: string;
          eventId: string;
          executionEpoch: number;
          state: 'awaiting-binding' | 'pending';
        }
      >;
    };
    value.cancellationWork.set(`${spec.attemptId}:binding-cancel-test`, {
      tenantId: spec.tenant.tenantId,
      attemptId: spec.attemptId,
      eventId: 'binding-cancel-test',
      executionEpoch: attempt.executionEpoch,
      state: 'awaiting-binding',
    });
  },
});
