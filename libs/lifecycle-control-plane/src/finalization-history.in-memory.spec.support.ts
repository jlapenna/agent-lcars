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

export type FinalizationHistoryCorruption =
  | 'head'
  | 'terminal-predecessor'
  | 'claim-predecessor'
  | 'validation-predecessor'
  | 'finalize-command-record'
  | 'finalize-command-payload'
  | 'finalize-command-digest'
  | 'evidence-record'
  | 'evidence-payload'
  | 'evidence-digest'
  | 'terminal-ref'
  | 'claim-ref'
  | 'validation-ref'
  | 'outcome-ref'
  | 'outcome-digest'
  | 'legacy-outcome'
  | 'outcome-index'
  | 'cancellation-provenance'
  | 'finalization-receipt'
  | 'presentation'
  | 'presentation-receipt'
  | 'delivery'
  | 'delivery-receipt';

export type FinalizationCommitFailure =
  | 'attempt'
  | 'outcome-index'
  | 'history'
  | 'finalization-receipt'
  | 'presentation'
  | 'presentation-receipt'
  | 'delivery';

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

interface FinalizationReceipt {
  attemptId: string;
  commandId: string;
  commandRef: HistoryRecordReference;
  evidenceRef: HistoryRecordReference;
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

export interface FinalizationHistoryInspection {
  attempt: AttemptState | undefined;
  history: RawHistory | undefined;
  outcomeIndex: string | undefined;
  finalizationReceipt: FinalizationReceipt | undefined;
  presentation: AttemptPresentationRecord | undefined;
  presentationReceipt: PresentationReceipt | undefined;
  delivery: RawDelivery | undefined;
  deliveryReceipt: DeliveryReceipt | undefined;
}

export interface FinalizationHistoryStorageHooks {
  readAttemptHistory: typeof readAttemptHistoryForTest;
  inspectFinalization(
    storage: LifecycleAuthorityStorage,
    attemptId: string,
  ): FinalizationHistoryInspection;
  corruptFinalization(
    storage: LifecycleAuthorityStorage,
    corruption: FinalizationHistoryCorruption,
  ): void;
  failFinalizationCommit(
    storage: LifecycleAuthorityStorage,
    stage: FinalizationCommitFailure,
  ): () => void;
  deleteAttemptHistoryLineage(storage: LifecycleAuthorityStorage): void;
}

interface InMemoryInternals {
  attempts: Map<string, AttemptState>;
  outcomes: Map<string, string>;
  attemptHistories: Map<string, RawHistory>;
  attemptAdmissionHistoryReceipts: Map<string, unknown>;
  finalizationHistoryReceipts: Map<string, FinalizationReceipt>;
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

function firstRecord(
  history: RawHistory,
  stream: AttemptHistoryStream,
  predicate: (entry: RawHistoryEntry) => boolean = () => true,
): RawHistoryEntry {
  const entry = (history.records.get(stream) ?? []).find(predicate);
  if (entry === undefined) throw new Error(`missing ${stream} history record`);
  return entry;
}

function payload(entry: RawHistoryEntry): Record<string, unknown> {
  return entry.payload;
}

function command(history: RawHistory): RawHistoryEntry {
  return firstRecord(
    history,
    'command',
    (entry) =>
      (payload(entry).payload as { kind?: string } | undefined)?.kind ===
      'finalize',
  );
}

function evidence(history: RawHistory): RawHistoryEntry {
  return firstRecord(history, 'evidence');
}

function historyFor(storage: LifecycleAuthorityStorage): RawHistory {
  return first(internals(storage).attemptHistories, 'missing Attempt history');
}

function mutateDigest(value: Record<string, unknown>): void {
  value.recordDigest = 'b'.repeat(64);
}

export const inMemoryFinalizationHistoryHooks =
  (): FinalizationHistoryStorageHooks => ({
    readAttemptHistory: readAttemptHistoryForTest,
    inspectFinalization: (storage, attemptId) => {
      const value = internals(storage);
      const finalizationReceipt = [
        ...value.finalizationHistoryReceipts.values(),
      ].find((receipt) => receipt.attemptId === attemptId);
      const presentation = [...value.attemptPresentations.values()].find(
        (record) => record.plan.attemptId === attemptId,
      );
      const presentationReceipt = [
        ...value.attemptPresentationReceipts.values(),
      ].find((receipt) => receipt.snapshot.plan.attemptId === attemptId);
      const delivery = [...value.presentationDeliveries.values()].find(
        (record) => record.attemptId === attemptId,
      );
      const deliveryReceipt = [
        ...value.presentationDeliveryReceipts.values(),
      ].find((receipt) => receipt.snapshot.attemptId === attemptId);
      return structuredClone({
        attempt: value.attempts.get(attemptId),
        history: value.attemptHistories.get(attemptId),
        outcomeIndex: value.outcomes.get(attemptId),
        finalizationReceipt,
        presentation,
        presentationReceipt,
        delivery,
        deliveryReceipt,
      });
    },
    corruptFinalization: (storage, corruption) => {
      const value = internals(storage);
      const history = historyFor(storage);
      const finalization = history.head.finalization;
      const finalizationCommand = command(history);
      const finalizationEvidence = evidence(history);
      switch (corruption) {
        case 'head':
          history.head.aggregateRevision += 1;
          return;
        case 'terminal-predecessor':
          firstRecord(history, 'fact', (entry) => {
            const nested = payload(entry).payload as
              { kind?: string } | undefined;
            return nested?.kind === 'run-terminal';
          }).record.previousRecordDigest = 'b'.repeat(64);
          return;
        case 'claim-predecessor':
          firstRecord(history, 'claim').record.previousRecordDigest =
            'b'.repeat(64);
          return;
        case 'validation-predecessor':
          firstRecord(history, 'validation').record.previousRecordDigest =
            'b'.repeat(64);
          return;
        case 'finalize-command-record':
          mutateDigest(finalizationCommand.record);
          return;
        case 'finalize-command-payload': {
          const nested = payload(finalizationCommand).payload as Record<
            string,
            unknown
          >;
          nested.commandId = 'corrupt-finalize-command';
          return;
        }
        case 'finalize-command-digest':
          payload(finalizationCommand).canonicalDigest = 'b'.repeat(64);
          return;
        case 'evidence-record':
          mutateDigest(finalizationEvidence.record);
          return;
        case 'evidence-payload': {
          const outcome = payload(finalizationEvidence).outcome as Record<
            string,
            unknown
          >;
          outcome.finalizedAt = '2026-08-16T00:08:00.000Z';
          return;
        }
        case 'evidence-digest':
          payload(finalizationEvidence).outcomeDigest = 'b'.repeat(64);
          return;
        case 'terminal-ref':
          if (finalization === undefined)
            throw new Error('missing finalization head');
          finalization.terminalFactRef.recordDigest = 'b'.repeat(64);
          return;
        case 'claim-ref':
          if (finalization?.claimRefs[0] === undefined)
            throw new Error('missing finalization claim ref');
          finalization.claimRefs[0].recordDigest = 'b'.repeat(64);
          return;
        case 'validation-ref':
          if (finalization?.validationRefs[0] === undefined)
            throw new Error('missing finalization validation ref');
          finalization.validationRefs[0].recordDigest = 'b'.repeat(64);
          return;
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
          attempt.outcome.finalizedAt = '2026-08-16T00:08:00.000Z';
          return;
        }
        case 'outcome-index':
          value.outcomes.set(
            first(value.attempts, 'missing Attempt').spec.attemptId,
            'corrupt-outcome-index',
          );
          return;
        case 'cancellation-provenance':
          if (history.head.cancellation === undefined)
            throw new Error('missing cancellation provenance');
          history.head.cancellation.commandRef.recordDigest = 'b'.repeat(64);
          return;
        case 'finalization-receipt': {
          const receipt = first(
            value.finalizationHistoryReceipts,
            'missing finalization receipt',
          );
          receipt.evidenceRef.recordDigest = 'b'.repeat(64);
          return;
        }
        case 'presentation': {
          const record = first(
            value.attemptPresentations,
            'missing Attempt presentation',
          );
          record.plan.outcomeDigest = 'b'.repeat(64);
          return;
        }
        case 'presentation-receipt': {
          const receipt = first(
            value.attemptPresentationReceipts,
            'missing presentation receipt',
          );
          receipt.outcomeDigest = 'b'.repeat(64);
          return;
        }
        case 'delivery': {
          const record = first(
            value.presentationDeliveries,
            'missing presentation delivery',
          );
          record.planDigest = 'b'.repeat(64);
          return;
        }
        case 'delivery-receipt': {
          const receipt = first(
            value.presentationDeliveryReceipts,
            'missing delivery receipt',
          );
          receipt.planDigest = 'b'.repeat(64);
          return;
        }
      }
    },
    failFinalizationCommit: (storage, stage) => {
      const value = internals(storage);
      const maps: Record<FinalizationCommitFailure, Map<string, unknown>> = {
        attempt: value.attempts as Map<string, unknown>,
        'outcome-index': value.outcomes as Map<string, unknown>,
        history: value.attemptHistories as Map<string, unknown>,
        'finalization-receipt': value.finalizationHistoryReceipts as Map<
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
        throw new Error(`injected ${stage} commit failure`);
      }) as typeof originalSet;
      return () => {
        map.set = originalSet;
      };
    },
    deleteAttemptHistoryLineage: (storage) => {
      const value = internals(storage);
      const attemptId = first(value.attempts, 'missing Attempt').spec.attemptId;
      const historyKey = value.attemptHistories.keys().next().value;
      if (historyKey === undefined) throw new Error('missing Attempt history');
      value.attemptHistories.delete(historyKey);
      for (const [key, receipt] of value.attemptAdmissionHistoryReceipts) {
        if ((receipt as { attemptId?: string }).attemptId === attemptId)
          value.attemptAdmissionHistoryReceipts.delete(key);
      }
    },
  });
