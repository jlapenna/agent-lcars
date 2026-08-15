import type {
  AttemptHistoryHead,
  AttemptHistoryStream,
  HistoryRecord,
} from '@agent-lcars/dispatch-contracts';

import type {
  LifecycleAuthorityStorage,
  TaskAuthorityLease,
} from './authority-storage';

export interface AttemptHistoryInspection {
  head: AttemptHistoryHead;
  records: Readonly<
    Record<
      AttemptHistoryStream,
      readonly { record: HistoryRecord; payload: unknown }[]
    >
  >;
}

type Inspector = (input: {
  lease: TaskAuthorityLease;
  tenantId: string;
  attemptId: string;
}) => Promise<AttemptHistoryInspection | undefined>;

const inspectors = new WeakMap<object, Inspector>();

/** Internal, lease-scoped inspection hook; never part of the authority API. */
export function registerAttemptHistoryInspector(
  storage: object,
  inspect: Inspector,
): void {
  inspectors.set(storage, inspect);
}

/** Test/support read only. No caller can write an Attempt history head. */
export async function readAttemptHistoryForTest(
  storage: LifecycleAuthorityStorage,
  input: Parameters<Inspector>[0],
): Promise<AttemptHistoryInspection | undefined> {
  const inspect = inspectors.get(storage);
  if (inspect === undefined)
    throw new Error('Storage adapter has no Attempt history inspection hook');
  return inspect(input);
}
