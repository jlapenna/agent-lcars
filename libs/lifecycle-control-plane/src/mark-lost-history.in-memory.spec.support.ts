import type {
  AttemptHistoryHead,
  AttemptHistoryStream,
  HistoryRecordReference,
  PresentationDeliveryRecord,
} from '@agent-lcars/dispatch-contracts';

import type { AttemptState } from './attempt-reducer';
import type {
  AttemptPresentationRecord,
  LifecycleAuthorityStorage,
} from './authority-storage';
import type {
  MarkLostCommitFailure,
  MarkLostHistoryStorageHooks,
} from './mark-lost-history.spec.support';

interface RawHistoryEntry {
  record: {
    recordDigest: string;
    previousRecordDigest: string | null;
  };
  payload: Record<string, unknown>;
}

interface RawHistory {
  head: AttemptHistoryHead;
  records: Map<AttemptHistoryStream, RawHistoryEntry[]>;
}

interface MarkLostReceipt {
  receiptId: string;
  idempotencyKey: string;
  causalDigest: string;
  terminatedAt: string;
  canonicalDigest: string;
  outcomeDigest: string;
  history: {
    commandRef: HistoryRecordReference;
    evidenceRef: HistoryRecordReference;
  };
}

interface PresentationReceipt {
  planKey: string;
  planDigest: string;
  outcomeDigest: string;
  snapshot: AttemptPresentationRecord;
}

interface RawDelivery extends PresentationDeliveryRecord {
  claimTokenSha256?: string;
}

interface DeliveryReceipt {
  planDigest: string;
  kind: 'converged' | 'unknown';
  receiptSha256: string;
  resolvedAt: string;
  snapshot: PresentationDeliveryRecord;
}

interface InMemoryInternals {
  attempts: Map<string, AttemptState>;
  outcomes: Map<string, string>;
  attemptHistories: Map<string, RawHistory>;
  taskHistories: Map<string, unknown>;
  acceptances: Map<string, unknown>;
  attemptAdmissionHistoryReceipts: Map<string, unknown>;
  markLostReceipts: Map<string, MarkLostReceipt>;
  attemptPresentations: Map<string, AttemptPresentationRecord>;
  attemptPresentationReceipts: Map<string, PresentationReceipt>;
  presentationDeliveries: Map<string, RawDelivery>;
  presentationDeliveryReceipts: Map<string, DeliveryReceipt>;
}

function internals(storage: LifecycleAuthorityStorage): InMemoryInternals {
  return storage as unknown as InMemoryInternals;
}

function first<T>(map: Map<string, T>, message: string): T {
  const value = map.values().next().value as T | undefined;
  if (value === undefined) throw new Error(message);
  return value;
}

function historyFor(storage: LifecycleAuthorityStorage): RawHistory {
  return first(internals(storage).attemptHistories, 'missing Attempt history');
}

function firstRecord(
  history: RawHistory,
  stream: AttemptHistoryStream,
  predicate: (entry: RawHistoryEntry) => boolean = () => true,
): RawHistoryEntry {
  const entry = (history.records.get(stream) ?? []).find(predicate);
  if (entry === undefined) throw new Error(`missing ${stream} history record`);
  return entry;
}

function baselineFact(history: RawHistory): RawHistoryEntry {
  return firstRecord(
    history,
    'fact',
    (entry) =>
      (entry.payload.payload as { kind?: string } | undefined)?.kind ===
      'run-bound',
  );
}

function markLostCommand(history: RawHistory): RawHistoryEntry {
  return firstRecord(
    history,
    'command',
    (entry) =>
      (entry.payload.payload as { kind?: string } | undefined)?.kind ===
      'mark-lost',
  );
}

function evidence(history: RawHistory): RawHistoryEntry {
  return firstRecord(history, 'evidence');
}

function mutateDigest(value: { recordDigest: string }): void {
  value.recordDigest = 'b'.repeat(64);
}

export const inMemoryMarkLostHistoryHooks =
  (): MarkLostHistoryStorageHooks => ({
    inspectMarkLost: (storage, attemptId) => {
      const value = internals(storage);
      const markLostReceipt = [...value.markLostReceipts.values()].find(
        (candidate) => candidate.history.commandRef.aggregateId === attemptId,
      );
      const presentation = [...value.attemptPresentations.values()].find(
        (record) => record.plan.attemptId === attemptId,
      );
      const presentationReceipt = [
        ...value.attemptPresentationReceipts.values(),
      ].find((candidate) => candidate.snapshot.plan.attemptId === attemptId);
      const delivery = [...value.presentationDeliveries.values()].find(
        (record) => record.attemptId === attemptId,
      );
      const deliveryReceipt = [
        ...value.presentationDeliveryReceipts.values(),
      ].find((candidate) => candidate.snapshot.attemptId === attemptId);
      return structuredClone({
        attempt: value.attempts.get(attemptId),
        history: value.attemptHistories.get(attemptId),
        outcomeIndex: value.outcomes.get(attemptId),
        markLostReceipt,
        presentation,
        presentationReceipt,
        delivery,
        deliveryReceipt,
      });
    },
    corruptMarkLost: (storage, corruption) => {
      const value = internals(storage);
      const history = historyFor(storage);
      const command = markLostCommand(history);
      const evidenceRecord = evidence(history);
      switch (corruption) {
        case 'head':
          history.head.aggregateRevision += 1;
          return;
        case 'baseline-fact-record':
          mutateDigest(baselineFact(history).record);
          return;
        case 'baseline-fact-payload': {
          const fact = baselineFact(history);
          (
            fact.payload.payload as { binding: Record<string, unknown> }
          ).binding.runId = 'corrupt-run-id';
          return;
        }
        case 'mark-lost-command-record':
          mutateDigest(command.record);
          return;
        case 'mark-lost-command-payload':
          (command.payload.payload as Record<string, unknown>).commandId =
            'corrupt-mark-lost';
          return;
        case 'mark-lost-command-digest':
          command.payload.canonicalDigest = 'b'.repeat(64);
          return;
        case 'command-ref': {
          const receipt = first(
            value.markLostReceipts,
            'missing mark-lost receipt',
          );
          receipt.history.commandRef.recordDigest = 'b'.repeat(64);
          return;
        }
        case 'evidence-record':
          mutateDigest(evidenceRecord.record);
          return;
        case 'evidence-payload':
          (
            evidenceRecord.payload.outcome as Record<string, unknown>
          ).finalizedAt = '2026-08-22T00:08:00.000Z';
          return;
        case 'evidence-digest':
          evidenceRecord.payload.outcomeDigest = 'b'.repeat(64);
          return;
        case 'evidence-ref': {
          const receipt = first(
            value.markLostReceipts,
            'missing mark-lost receipt',
          );
          receipt.history.evidenceRef.recordDigest = 'b'.repeat(64);
          return;
        }
        case 'outcome-ref':
          if (history.head.outcomeRef === undefined)
            throw new Error('missing outcome ref');
          history.head.outcomeRef.recordDigest = 'b'.repeat(64);
          return;
        case 'outcome-digest':
          history.head.outcomeDigest = 'b'.repeat(64);
          return;
        case 'legacy-outcome': {
          const attempt = first(value.attempts, 'missing Attempt');
          if (attempt.outcome === undefined)
            throw new Error('missing Attempt outcome');
          attempt.outcome.finalizedAt = '2026-08-22T00:08:00.000Z';
          return;
        }
        case 'outcome-index':
          value.outcomes.set(
            first(value.attempts, 'missing Attempt').spec.attemptId,
            'corrupt-outcome-index',
          );
          return;
        case 'mark-lost-receipt': {
          const receipt = first(
            value.markLostReceipts,
            'missing mark-lost receipt',
          );
          receipt.outcomeDigest = 'b'.repeat(64);
          return;
        }
        case 'presentation':
          first(
            value.attemptPresentations,
            'missing Attempt presentation',
          ).plan.outcomeDigest = 'b'.repeat(64);
          return;
        case 'presentation-receipt':
          first(
            value.attemptPresentationReceipts,
            'missing presentation receipt',
          ).outcomeDigest = 'b'.repeat(64);
          return;
        case 'delivery':
          first(
            value.presentationDeliveries,
            'missing presentation delivery',
          ).planDigest = 'b'.repeat(64);
          return;
        case 'admission-receipt':
          value.attemptAdmissionHistoryReceipts.clear();
          return;
      }
    },
    failMarkLostCommit: (storage, stage) => {
      const value = internals(storage);
      const maps: Record<MarkLostCommitFailure, Map<string, unknown>> = {
        attempt: value.attempts as Map<string, unknown>,
        'outcome-index': value.outcomes as Map<string, unknown>,
        history: value.attemptHistories as Map<string, unknown>,
        'mark-lost-receipt': value.markLostReceipts as Map<string, unknown>,
        presentation: value.attemptPresentations as Map<string, unknown>,
        'presentation-receipt': value.attemptPresentationReceipts as Map<
          string,
          unknown
        >,
        delivery: value.presentationDeliveries as Map<string, unknown>,
      };
      const map = maps[stage];
      const originalSet = map.set;
      map.set = (() => {
        throw new Error(`injected mark-lost ${stage} commit failure`);
      }) as typeof originalSet;
      return () => {
        map.set = originalSet;
      };
    },
    deleteAttemptHistoryLineage: (storage) => {
      const value = internals(storage);
      const attemptId = first(value.attempts, 'missing Attempt').spec.attemptId;
      value.attemptHistories.delete(attemptId);
      value.taskHistories.clear();
      value.acceptances.clear();
      for (const [key, receipt] of value.attemptAdmissionHistoryReceipts) {
        if ((receipt as { attemptId?: string }).attemptId === attemptId)
          value.attemptAdmissionHistoryReceipts.delete(key);
      }
    },
    cancelAttempt: (storage, phase) => {
      const value = internals(storage);
      const attempt = first(value.attempts, 'missing Attempt');
      attempt.cancellation = { eventId: 'test-cancellation' };
      if (phase === 'cancelling') attempt.phase = 'cancelling';
    },
  });
