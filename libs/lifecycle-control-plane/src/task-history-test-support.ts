import type {
  HistoryRecord,
  ReplayReceipt,
  TaskHistoryHead,
} from '@agent-lcars/dispatch-contracts';

import type {
  LifecycleAuthorityStorage,
  TaskAuthorityLease,
} from './authority-storage';

export interface TaskHistoryInspection {
  head: TaskHistoryHead;
  factRecords: readonly HistoryRecord[];
  intentRecords: readonly HistoryRecord[];
  effectRecords: readonly HistoryRecord[];
  workRecords: readonly HistoryRecord[];
  presentationRecords: readonly HistoryRecord[];
  replayReceipts: readonly ReplayReceipt[];
  /** Payload-bearing seam for exact admission pointer assertions. */
  workRecordEntries?: readonly { record: HistoryRecord; payload: unknown }[];
}

type Inspector = (input: {
  lease: TaskAuthorityLease;
  tenantId: string;
  task: { tenantId: string; repositoryId: number; issueNumber: number };
}) => Promise<TaskHistoryInspection | undefined>;

const inspectors = new WeakMap<object, Inspector>();

/** Internal, lease-scoped inspection hook; never part of the authority API. */
export function registerTaskHistoryInspector(
  storage: object,
  inspect: Inspector,
): void {
  inspectors.set(storage, inspect);
}

/** Test/support read only. No caller can write a history head or record. */
export async function readTaskHistoryForTest(
  storage: LifecycleAuthorityStorage,
  input: Parameters<Inspector>[0],
): Promise<TaskHistoryInspection | undefined> {
  const inspect = inspectors.get(storage);
  if (inspect === undefined)
    throw new Error('Storage adapter has no task history inspection hook');
  return inspect(input);
}
