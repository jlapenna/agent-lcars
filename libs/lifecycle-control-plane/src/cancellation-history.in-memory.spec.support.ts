import { readAttemptHistoryForTest } from './attempt-history-test-support';
import type { CancellationHistoryStorageHooks } from './task-effects.spec.support';

/**
 * Reference-adapter-only hooks for the cancellation-history contract.  The
 * generic contract intentionally knows nothing about these private maps.
 */
export const inMemoryCancellationHistoryStorageHooks =
  (): CancellationHistoryStorageHooks => ({
    readAttemptHistory: readAttemptHistoryForTest,
    corruptCancellationReceipt: (storage, kind) => {
      const value = storage as unknown as {
        cancellationReceipts: Map<
          string,
          {
            history?: {
              commandRef: { recordDigest: string };
              evidenceRef?: { recordDigest: string };
            };
          }
        >;
      };
      const receipt = value.cancellationReceipts.values().next().value;
      if (receipt?.history === undefined)
        throw new Error('missing cancellation history receipt');
      if (kind === 'command-ref')
        receipt.history.commandRef.recordDigest = 'b'.repeat(64);
      else if (receipt.history.evidenceRef === undefined)
        throw new Error('missing evidence ref');
      else receipt.history.evidenceRef.recordDigest = 'b'.repeat(64);
    },
    corruptCancellationHistoryRecord: (storage, kind) => {
      const value = storage as unknown as {
        attemptHistories: Map<
          string,
          {
            records: Map<
              string,
              Array<{
                record: { recordDigest: string };
                payload: { payload?: { commandId?: string } };
              }>
            >;
          }
        >;
        cancellationReceipts: Map<
          string,
          { history?: { commandRef: { recordDigest: string } } }
        >;
      };
      const history = value.attemptHistories.values().next().value;
      const command = history?.records.get('command')?.[1];
      if (command === undefined)
        throw new Error('missing cancellation command record');
      if (kind === 'payload') {
        if (command.payload.payload === undefined)
          throw new Error('missing command payload');
        command.payload.payload.commandId = 'corrupt-command';
      } else if (kind === 'digest') {
        command.record.recordDigest = 'b'.repeat(64);
      } else {
        const receipt = value.cancellationReceipts?.values().next().value as
          { history?: { commandRef: { recordDigest: string } } } | undefined;
        if (receipt?.history === undefined)
          throw new Error('missing cancellation history receipt');
        receipt.history.commandRef.recordDigest = 'b'.repeat(64);
      }
    },
    corruptCancellationHistoryHead: (storage) => {
      const histories = (
        storage as unknown as {
          attemptHistories: Map<
            string,
            { head: { aggregateRevision: number } }
          >;
        }
      ).attemptHistories;
      const history = histories.values().next().value;
      if (history === undefined) throw new Error('missing Attempt history');
      history.head.aggregateRevision = 99;
    },
    corruptCancellationHistoryLaunchState: (storage) => {
      const histories = (
        storage as unknown as {
          attemptHistories: Map<
            string,
            { head: { launch: { state: string } } }
          >;
        }
      ).attemptHistories;
      const history = histories.values().next().value;
      if (history === undefined) throw new Error('missing Attempt history');
      history.head.launch.state = 'accepted';
    },
    corruptCancellationAdmission: (storage) => {
      const receipts = (
        storage as unknown as {
          attemptAdmissionHistoryReceipts: Map<
            string,
            { admissionDigest: string }
          >;
        }
      ).attemptAdmissionHistoryReceipts;
      const receipt = receipts.values().next().value;
      if (receipt === undefined)
        throw new Error('missing admission history receipt');
      receipt.admissionDigest = 'b'.repeat(64);
    },
    deleteCancellationHistoryLineage: (storage) => {
      const value = storage as unknown as {
        attemptHistories: Map<string, unknown>;
        attemptAdmissionHistoryReceipts: Map<string, unknown>;
      };
      value.attemptHistories.clear();
      value.attemptAdmissionHistoryReceipts.clear();
    },
    failCancellationHistoryCommit: (storage) => {
      const histories = (
        storage as unknown as {
          attemptHistories: Map<string, unknown>;
        }
      ).attemptHistories;
      const originalSet = histories.set;
      histories.set = (() => {
        throw new Error('injected cancellation history commit failure');
      }) as typeof originalSet;
      return () => {
        histories.set = originalSet;
      };
    },
  });
