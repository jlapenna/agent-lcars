import type { AcceptedAttemptSpec } from '@agent-lcars/dispatch-contracts';

import { readAttemptHistoryForTest } from './attempt-history-test-support';
import {
  type LifecycleAuthorityStorage,
  type TaskAuthorityLease,
} from './authority-storage';
import { inMemoryBindingHistoryHooks } from './launch-binding-history-test-support';

/**
 * Test-only seams for the terminal/claim history contract.  These are kept
 * outside the public barrel deliberately: a durable adapter must provide the
 * same inspection and fault-injection semantics to the reusable contract,
 * while production code must not gain a history mutation API.
 */
export type TerminalClaimHistoryCorruption =
  | 'head'
  | 'missing-terminal-record'
  | 'missing-claim-record'
  | 'terminal-record'
  | 'claim-record'
  | 'terminal-payload'
  | 'claim-payload'
  | 'terminal-digest'
  | 'claim-digest'
  | 'terminal-private-ref'
  | 'claim-private-ref';

export interface TerminalClaimHistoryStorageHooks {
  readAttemptHistory: typeof readAttemptHistoryForTest;
  deleteAttemptHistory(storage: LifecycleAuthorityStorage): void;
  corruptAttemptHistory(
    storage: LifecycleAuthorityStorage,
    corruption: TerminalClaimHistoryCorruption,
  ): void;
  failAttemptHistoryCommit(storage: LifecycleAuthorityStorage): () => void;
  prepareAwaitingBindingCancellation(
    storage: LifecycleAuthorityStorage,
    lease: TaskAuthorityLease,
    spec: AcceptedAttemptSpec,
  ): Promise<void>;
}

interface StoredHistoryEntry {
  record: { recordDigest: string; canonicalDigest?: string };
  payload: {
    payload?: {
      kind?: string;
      binding?: { runId: number };
      claim?: { number?: number };
    };
    claim?: { kind?: string };
    canonicalDigest?: string;
    factId?: string;
  };
}

interface StoredHistory {
  head: { aggregateRevision: number };
  records: Map<string, StoredHistoryEntry[]>;
}

interface StoredIdempotency {
  counterpartId: string;
  historyRecordRef?: { recordDigest: string };
}

interface InMemoryInternals {
  attemptHistories: Map<string, StoredHistory>;
  factKeys: Map<string, StoredIdempotency>;
  requestKeys: Map<string, StoredIdempotency>;
}

function internals(storage: LifecycleAuthorityStorage): InMemoryInternals {
  return storage as unknown as InMemoryInternals;
}

function history(storage: LifecycleAuthorityStorage): StoredHistory {
  const value = internals(storage).attemptHistories.values().next().value;
  if (value === undefined) throw new Error('missing Attempt history');
  return value;
}

function firstFact(
  value: StoredHistory,
  kind: 'run-terminal' | 'agent-result-claim',
): StoredHistoryEntry {
  const entry = (value.records.get('fact') ?? []).find(
    (candidate) => candidate.payload.payload?.kind === kind,
  );
  if (entry === undefined) throw new Error(`missing ${kind} history fact`);
  return entry;
}

function firstRecord(
  value: StoredHistory,
  stream: 'fact' | 'claim',
  kind: 'run-terminal' | 'agent-result-claim',
): StoredHistoryEntry {
  const entry = (value.records.get(stream) ?? []).find((candidate) => {
    if (stream === 'fact') return candidate.payload.payload?.kind === kind;
    return candidate.payload.claim?.kind !== undefined;
  });
  if (entry === undefined) throw new Error(`missing ${stream} history record`);
  return entry;
}

function privateRef(
  storage: LifecycleAuthorityStorage,
  factId: string,
): StoredIdempotency {
  const value = internals(storage);
  // Request-side idempotency stores the observation's fact id as its
  // counterpart.  Mutating only this side deliberately exercises the
  // independent fact/request-reference integrity check.
  const idempotency = [...value.requestKeys.values()].find(
    (candidate) => candidate.counterpartId === factId,
  );
  if (idempotency === undefined)
    throw new Error(`missing private ref for ${factId}`);
  return idempotency;
}

/** Reference-adapter implementation of the mandatory test-only seams. */
export const inMemoryTerminalClaimHistoryHooks =
  (): TerminalClaimHistoryStorageHooks => ({
    readAttemptHistory: readAttemptHistoryForTest,
    deleteAttemptHistory: (storage) => {
      const histories = internals(storage).attemptHistories;
      const key = histories.keys().next().value;
      if (key === undefined) throw new Error('missing Attempt history');
      histories.delete(key);
    },
    corruptAttemptHistory: (storage, corruption) => {
      const value = history(storage);
      switch (corruption) {
        case 'head':
          value.head.aggregateRevision += 1;
          return;
        case 'missing-terminal-record': {
          const records = value.records.get('fact');
          if (records === undefined) throw new Error('missing fact stream');
          const index = records.findIndex(
            (candidate) => candidate.payload.payload?.kind === 'run-terminal',
          );
          if (index < 0) throw new Error('missing terminal history fact');
          records.splice(index, 1);
          return;
        }
        case 'missing-claim-record': {
          const records = value.records.get('claim');
          if (records === undefined) throw new Error('missing claim stream');
          if (records.length === 0)
            throw new Error('missing claim history record');
          records.pop();
          return;
        }
        case 'terminal-record':
          firstRecord(value, 'fact', 'run-terminal').record.recordDigest =
            'a'.repeat(64);
          return;
        case 'claim-record':
          firstRecord(
            value,
            'claim',
            'agent-result-claim',
          ).record.recordDigest = 'a'.repeat(64);
          return;
        case 'terminal-payload':
          {
            const binding = firstFact(value, 'run-terminal').payload.payload
              ?.binding;
            if (binding === undefined)
              throw new Error('missing binding payload');
            binding.runId = 99;
          }
          return;
        case 'claim-payload': {
          const claim = firstFact(value, 'agent-result-claim').payload.payload
            ?.claim;
          if (claim === undefined) throw new Error('missing claim payload');
          claim.number = 999;
          return;
        }
        case 'terminal-digest':
          firstFact(value, 'run-terminal').payload.canonicalDigest = 'a'.repeat(
            64,
          );
          return;
        case 'claim-digest':
          firstFact(value, 'agent-result-claim').payload.canonicalDigest =
            'a'.repeat(64);
          return;
        case 'terminal-private-ref': {
          const fact = firstFact(value, 'run-terminal').payload;
          if (fact.factId === undefined)
            throw new Error('missing terminal fact id');
          privateRef(storage, fact.factId).historyRecordRef = {
            recordDigest: 'a'.repeat(64),
          };
          return;
        }
        case 'claim-private-ref': {
          const fact = firstFact(value, 'agent-result-claim').payload;
          if (fact.factId === undefined)
            throw new Error('missing claim fact id');
          privateRef(storage, fact.factId).historyRecordRef = {
            recordDigest: 'a'.repeat(64),
          };
          return;
        }
      }
    },
    failAttemptHistoryCommit: (storage) => {
      const histories = internals(storage).attemptHistories;
      const originalSet = histories.set;
      histories.set = (() => {
        throw new Error('injected terminal/claim history commit failure');
      }) as typeof originalSet;
      return () => {
        histories.set = originalSet;
      };
    },
    prepareAwaitingBindingCancellation: (storage, lease, spec) =>
      inMemoryBindingHistoryHooks().prepareAwaitingBindingCancellation(
        storage,
        lease,
        spec,
      ),
  });
