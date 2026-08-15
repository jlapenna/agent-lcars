import { readAttemptHistoryForTest } from './attempt-history-test-support';
import type { LaunchResolutionHistoryStorageHooks } from './launch-resolution.spec.support';

/** Reference-adapter-only seams for the launch-resolution history contract. */
export const inMemoryLaunchResolutionHistoryStorageHooks =
  (): LaunchResolutionHistoryStorageHooks => ({
    readAttemptHistory: readAttemptHistoryForTest,
    deleteAttemptHistory: (storage) => {
      const histories = (
        storage as unknown as { attemptHistories: Map<string, unknown> }
      ).attemptHistories;
      const key = histories.keys().next().value;
      if (key === undefined) throw new Error('missing Attempt history');
      histories.delete(key);
    },
    deleteAdmissionLineage: (storage) => {
      const value = storage as unknown as {
        attemptHistories: Map<string, unknown>;
        attemptAdmissionHistoryReceipts: Map<string, unknown>;
      };
      value.attemptHistories.clear();
      value.attemptAdmissionHistoryReceipts.clear();
    },
    corruptLaunchResolutionReceipt: (storage, kind) => {
      const receipts = (
        storage as unknown as {
          launchResolutionReceipts: Map<
            string,
            {
              responseSha256: string;
              history?: { commandRef: { recordDigest: string } };
            }
          >;
        }
      ).launchResolutionReceipts;
      const receipt = receipts.values().next().value;
      if (receipt === undefined) throw new Error('missing launch receipt');
      if (kind === 'response') receipt.responseSha256 = 'b'.repeat(64);
      else if (kind === 'command-ref') {
        if (receipt.history === undefined)
          throw new Error('missing launch history ref');
        receipt.history = {
          ...receipt.history,
          commandRef: {
            ...receipt.history.commandRef,
            recordDigest: 'b'.repeat(64),
          },
        };
      } else {
        delete receipt.history;
      }
    },
    corruptLaunchResolutionHistoryRecord: (storage, kind) => {
      const histories = (
        storage as unknown as {
          attemptHistories: Map<
            string,
            {
              records: Map<
                string,
                Array<{
                  record: { recordDigest: string };
                  payload: {
                    payload?: { kind?: string; commandId?: string };
                  };
                }>
              >;
            }
          >;
        }
      ).attemptHistories;
      const history = histories.values().next().value;
      const command = history?.records.get('command')?.[1];
      if (command === undefined)
        throw new Error('missing launch history command');
      if (kind === 'payload') {
        if (command.payload.payload === undefined)
          throw new Error('missing launch command payload');
        command.payload = {
          ...command.payload,
          payload: {
            ...command.payload.payload,
            commandId: 'corrupt-launch-command',
          },
        };
      } else {
        command.record = {
          ...command.record,
          recordDigest: 'b'.repeat(64),
        };
      }
    },
    corruptLaunchResolutionHistoryHead: (storage) => {
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
    corruptLaunchResolutionAdmission: (storage, kind) => {
      const receipts = (
        storage as unknown as {
          attemptAdmissionHistoryReceipts: Map<
            string,
            {
              admissionDigest: string;
              taskAdmissionRecordRef: { recordDigest: string };
            }
          >;
        }
      ).attemptAdmissionHistoryReceipts;
      const entry = receipts.entries().next().value;
      if (entry === undefined) throw new Error('missing admission receipt');
      const [key, receipt] = entry;
      if (kind === 'receipt') {
        receipts.set(key, {
          ...receipt,
          admissionDigest: 'b'.repeat(64),
        });
      } else {
        receipts.set(key, {
          ...receipt,
          taskAdmissionRecordRef: {
            ...receipt.taskAdmissionRecordRef,
            recordDigest: 'b'.repeat(64),
          },
        });
      }
    },
    failLaunchResolutionHistoryCommit: (storage) => {
      const histories = (
        storage as unknown as { attemptHistories: Map<string, unknown> }
      ).attemptHistories;
      const originalSet = histories.set;
      histories.set = (() => {
        throw new Error('injected launch history commit failure');
      }) as typeof originalSet;
      return () => {
        histories.set = originalSet;
      };
    },
    inspectLaunchResolutionInternals: (storage) => {
      const value = storage as unknown as {
        attempts: Map<string, unknown>;
        launches: Map<string, unknown>;
        launchResolutionReceipts: Map<string, unknown>;
        attemptHistories: Map<string, unknown>;
      };
      return {
        attempts: value.attempts.size,
        launches: value.launches.size,
        receipts: value.launchResolutionReceipts.size,
        histories: value.attemptHistories.size,
      };
    },
  });
