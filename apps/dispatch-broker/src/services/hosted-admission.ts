import type { LedgerProjectionIdentity } from '../github-api';
import type { NormalizedEvent } from '../normalize';
import type { StoragePort } from '../storage/port';

export interface HostedAdmissionInput {
  normalized: NormalizedEvent;
  githubToken: string;
  storageMode: string;
  authorityEpoch?: string;
  isPullRequest: boolean;
  transportRunId: number;
  authorityOwner: string;
  maintainer?: string;
  actionConcurrency?: { group: string; eventName?: string };
  projectionIdentities?: readonly LedgerProjectionIdentity[];
  pollCompletionUntilTerminal?: boolean;
  authorityBusyWaitMs?: number;
}

export interface HostedAdmissionDependencies {
  storagePortFactory(): StoragePort;
  process(
    input: HostedAdmissionInput & {
      storagePortFactory: () => StoragePort;
    },
  ): Promise<void>;
}

/** Transport-neutral admission boundary shared by Actions and hosted routes. */
export async function admitHostedDelivery(
  input: HostedAdmissionInput,
  dependencies: HostedAdmissionDependencies,
): Promise<void> {
  await dependencies.process({
    ...input,
    storagePortFactory: dependencies.storagePortFactory,
  });
}
