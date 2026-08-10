import 'server-only';

import {
  type BrokerPassOptions,
  processNormalizedEvent,
} from '@agent-lcars/dispatch-controller/main';
import { admitHostedDelivery } from '@agent-lcars/dispatch-controller/services/hosted-admission';
import { FirestoreStoragePort } from '@agent-lcars/dispatch-controller/storage/firestore-port';
import { required } from '@agent-lcars/util-server';

import { maintainerLogin } from './deployment';

type HostedControllerEvent = Pick<
  BrokerPassOptions,
  | 'normalized'
  | 'isPullRequest'
  | 'transportRunId'
  | 'authorityOwner'
  | 'pollCompletionUntilTerminal'
  | 'authorityBusyWaitMs'
>;

/**
 * Run one controller transition inside App Hosting. Webhook admission,
 * completion callbacks, and direct reconciliation deliberately share these
 * credentials and Firestore authority settings.
 */
export function processHostedControllerEvent({
  normalized,
  isPullRequest,
  transportRunId,
  authorityOwner,
  pollCompletionUntilTerminal,
  authorityBusyWaitMs,
}: HostedControllerEvent): Promise<void> {
  return admitHostedDelivery(
    {
      normalized,
      githubToken: required('AGENT_LCARS_GITHUB_TOKEN'),
      isPullRequest,
      transportRunId,
      authorityOwner,
      pollCompletionUntilTerminal,
      authorityBusyWaitMs,
      maintainer: maintainerLogin(),
      projectionIdentities: [
        { login: 'github-actions[bot]', type: 'Bot' },
        { login: maintainerLogin(), type: 'User' },
      ],
    },
    {
      storagePortFactory: () =>
        new FirestoreStoragePort({
          projectId: required('PROJECT_ID'),
          databaseId: required('DISPATCH_FIRESTORE_DATABASE_ID'),
        }),
      process: processNormalizedEvent,
    },
  );
}
