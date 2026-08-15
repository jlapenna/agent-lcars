import type {
  AttemptHistoryInspection,
  AttemptHistoryStream,
} from '@agent-lcars/dispatch-contracts';

import { readAttemptHistoryForTest } from './attempt-history-test-support';
import type { LifecycleAuthorityStorage } from './authority-storage';

/** Test-only faults used by the reusable validation-history contract. */
export type ValidationHistoryCorruption =
  | 'head'
  | 'terminal-lineage'
  | 'claim-lineage'
  | 'work'
  | 'start-command'
  | 'validation-command'
  | 'validation-record'
  | 'validation-ref'
  | 'private-receipt';

export interface ValidationHistoryStorageHooks {
  readAttemptHistory: typeof readAttemptHistoryForTest;
  deleteAttemptHistory(storage: LifecycleAuthorityStorage): void;
  corruptValidationHistory(
    storage: LifecycleAuthorityStorage,
    corruption: ValidationHistoryCorruption,
  ): void;
  failValidationHistoryCommit(storage: LifecycleAuthorityStorage): () => void;
}

interface StoredHistoryEntry {
  record: {
    recordDigest: string;
    canonicalDigest?: string;
  };
  payload: {
    canonicalDigest?: string;
    payload?: {
      kind?: string;
      terminalFactRef?: { recordDigest: string };
      claimFactRef?: { recordDigest: string };
    };
    terminalFactRef?: { recordDigest: string };
    claimFactRef?: { recordDigest: string };
    validationFactId?: string;
    validation?: unknown;
  };
}

interface StoredHistory {
  head: {
    aggregateRevision: number;
    finalization?: {
      validationRefs: Array<{ recordDigest: string }>;
    };
  };
  records: Map<AttemptHistoryStream, StoredHistoryEntry[]>;
}

interface StoredValidationWork {
  claimFactId: string;
  state: 'pending' | 'resolving' | 'complete';
  validationFactId?: string;
}

interface StoredReceipt {
  validationFactId?: string;
  commandRef?: { recordDigest: string };
  validationRef?: { recordDigest: string };
}

interface InMemoryInternals {
  attemptHistories: Map<string, StoredHistory>;
  validationWork: Map<string, StoredValidationWork>;
  validationHistoryReceipts?: Map<string, StoredReceipt>;
}

function internals(storage: LifecycleAuthorityStorage): InMemoryInternals {
  return storage as unknown as InMemoryInternals;
}

function history(storage: LifecycleAuthorityStorage): StoredHistory {
  const value = internals(storage).attemptHistories.values().next().value;
  if (value === undefined) throw new Error('missing Attempt history');
  return value;
}

function record(
  value: StoredHistory,
  stream: AttemptHistoryStream,
): StoredHistoryEntry {
  const entry = value.records.get(stream)?.at(-1);
  if (entry === undefined) throw new Error(`missing ${stream} history record`);
  return entry;
}

function validationRecord(value: StoredHistory): StoredHistoryEntry {
  return record(value, 'validation');
}

/** Reference-adapter implementation; deliberately not exported publicly. */
export const inMemoryValidationHistoryHooks =
  (): ValidationHistoryStorageHooks => ({
    readAttemptHistory: async (storage, input) => {
      const inspected = await readAttemptHistoryForTest(storage, input);
      return inspected as AttemptHistoryInspection | undefined;
    },
    deleteAttemptHistory: (storage) => {
      const histories = internals(storage).attemptHistories;
      const key = histories.keys().next().value;
      if (key === undefined) throw new Error('missing Attempt history');
      histories.delete(key);
    },
    corruptValidationHistory: (storage, corruption) => {
      const value = history(storage);
      switch (corruption) {
        case 'head':
          value.head.aggregateRevision += 1;
          return;
        case 'terminal-lineage':
          validationRecord(value).payload.terminalFactRef = {
            recordDigest: 'a'.repeat(64),
          };
          return;
        case 'claim-lineage':
          validationRecord(value).payload.claimFactRef = {
            recordDigest: 'a'.repeat(64),
          };
          return;
        case 'work': {
          const work = internals(storage).validationWork.values().next().value;
          if (work === undefined) throw new Error('missing validation work');
          work.claimFactId = 'corrupt-claim';
          return;
        }
        case 'start-command': {
          const command = (value.records.get('command') ?? []).find(
            (entry) => entry.payload.payload?.kind === 'start-validation',
          );
          if (command === undefined) throw new Error('missing start command');
          command.record.recordDigest = 'a'.repeat(64);
          return;
        }
        case 'validation-command': {
          const command = (value.records.get('command') ?? []).find(
            (entry) =>
              entry.payload.payload?.kind === 'validate-claim-requested',
          );
          if (command === undefined)
            throw new Error('missing validation command');
          command.record.recordDigest = 'a'.repeat(64);
          return;
        }
        case 'validation-record':
          validationRecord(value).record.recordDigest = 'a'.repeat(64);
          return;
        case 'validation-ref': {
          const refs = value.head.finalization?.validationRefs;
          if (refs === undefined || refs.length === 0)
            throw new Error('missing validation head ref');
          refs[0] = { recordDigest: 'a'.repeat(64) };
          return;
        }
        case 'private-receipt': {
          const receipts = internals(storage).validationHistoryReceipts;
          const receipt = receipts?.values().next().value;
          if (receipt === undefined)
            throw new Error('missing validation history receipt');
          receipt.validationRef = { recordDigest: 'a'.repeat(64) };
          return;
        }
      }
    },
    failValidationHistoryCommit: (storage) => {
      const histories = internals(storage).attemptHistories;
      const originalSet = histories.set;
      histories.set = (() => {
        throw new Error('injected validation history commit failure');
      }) as typeof originalSet;
      return () => {
        histories.set = originalSet;
      };
    },
  });
