import type {
  AttemptHistoryHead,
  AttemptHistoryStream,
  HistoryRecordReference,
  PresentationDeliveryRecord,
} from '@agent-lcars/dispatch-contracts';

import { readAttemptHistoryForTest } from './attempt-history-test-support';
import type { AttemptState } from './attempt-reducer';
import type {
  AttemptPresentationRecord,
  LifecycleAuthorityStorage,
} from './authority-storage';
import type {
  LaunchRejectionCommitFailure,
  LaunchRejectionHistoryStorageHooks,
} from './launch-rejection-history.spec.support';

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

interface LaunchRejectionReceipt {
  proofSha256: string;
  rejectedAt: string;
  canonicalDigest: string;
  outcomeDigest: string;
  history?: {
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
  launches: Map<string, { operationId: string; executionEpoch: number }>;
  outcomes: Map<string, string>;
  attemptHistories: Map<string, RawHistory>;
  taskHistories: Map<string, unknown>;
  acceptances: Map<string, unknown>;
  attemptAdmissionHistoryReceipts: Map<string, unknown>;
  launchRejectionReceipts: Map<string, LaunchRejectionReceipt>;
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

function command(history: RawHistory): RawHistoryEntry {
  return firstRecord(
    history,
    'command',
    (entry) =>
      (entry.payload.payload as { kind?: string } | undefined)?.kind ===
      'launch-rejected',
  );
}

function evidence(history: RawHistory): RawHistoryEntry {
  return firstRecord(history, 'evidence');
}

function mutateDigest(value: { recordDigest: string }): void {
  value.recordDigest = 'b'.repeat(64);
}

export const inMemoryLaunchRejectionHistoryHooks =
  (): LaunchRejectionHistoryStorageHooks => ({
    readAttemptHistory: readAttemptHistoryForTest,
    inspectLaunchRejection: (storage, attemptId) => {
      const value = internals(storage);
      const receipt = [...value.launchRejectionReceipts.values()].find(
        (candidate) =>
          candidate.history === undefined ||
          candidate.history.commandRef.aggregateId === attemptId,
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
        rejectionReceipt: receipt,
        presentation,
        presentationReceipt,
        delivery,
        deliveryReceipt,
      });
    },
    corruptLaunchRejection: (storage, corruption) => {
      const value = internals(storage);
      const history = historyFor(storage);
      const rejectionCommand = command(history);
      const rejectionEvidence = evidence(history);
      switch (corruption) {
        case 'head':
          history.head.aggregateRevision += 1;
          return;
        case 'registration-predecessor':
          firstRecord(history, 'command').record.previousRecordDigest =
            'b'.repeat(64);
          return;
        case 'rejection-command-record':
          mutateDigest(rejectionCommand.record);
          return;
        case 'rejection-command-payload':
          (
            rejectionCommand.payload.payload as Record<string, unknown>
          ).commandId = 'corrupt-launch-rejection';
          return;
        case 'rejection-command-digest':
          rejectionCommand.payload.canonicalDigest = 'b'.repeat(64);
          return;
        case 'command-ref': {
          const receipt = first(
            value.launchRejectionReceipts,
            'missing launch rejection receipt',
          );
          if (receipt.history === undefined)
            throw new Error('missing launch rejection history receipt');
          receipt.history.commandRef.recordDigest = 'b'.repeat(64);
          return;
        }
        case 'evidence-record':
          mutateDigest(rejectionEvidence.record);
          return;
        case 'evidence-payload':
          (
            rejectionEvidence.payload.outcome as Record<string, unknown>
          ).finalizedAt = '2026-08-22T00:08:00.000Z';
          return;
        case 'evidence-digest':
          rejectionEvidence.payload.outcomeDigest = 'b'.repeat(64);
          return;
        case 'evidence-ref': {
          const receipt = first(
            value.launchRejectionReceipts,
            'missing launch rejection receipt',
          );
          if (receipt.history === undefined)
            throw new Error('missing launch rejection history receipt');
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
        case 'rejection-receipt': {
          const receipt = first(
            value.launchRejectionReceipts,
            'missing launch rejection receipt',
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
        case 'delivery-receipt':
          first(
            value.presentationDeliveryReceipts,
            'missing delivery receipt',
          ).planDigest = 'b'.repeat(64);
          return;
        case 'launch-identity':
          first(value.launches, 'missing launch').operationId =
            'corrupt-launch-operation';
          return;
        case 'admission-receipt':
          value.attemptAdmissionHistoryReceipts.clear();
          return;
      }
    },
    failLaunchRejectionCommit: (storage, stage) => {
      const value = internals(storage);
      const maps: Record<LaunchRejectionCommitFailure, Map<string, unknown>> = {
        attempt: value.attempts as Map<string, unknown>,
        'outcome-index': value.outcomes as Map<string, unknown>,
        history: value.attemptHistories as Map<string, unknown>,
        'rejection-receipt': value.launchRejectionReceipts as Map<
          string,
          unknown
        >,
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
        throw new Error(`injected launch rejection ${stage} commit failure`);
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
  });
