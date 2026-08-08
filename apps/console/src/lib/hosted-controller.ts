import 'server-only';

import {
  type BrokerPassOptions,
  processNormalizedEvent,
} from '@agent-lcars/dispatch-controller/main';
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
>;

/**
 * Run one controller transition inside App Hosting. Webhook admission,
 * completion callbacks, and direct reconciliation deliberately share these
 * credentials, Firestore authority settings, and compatibility identities.
 */
export function processHostedControllerEvent({
  normalized,
  isPullRequest,
  transportRunId,
  authorityOwner,
  pollCompletionUntilTerminal,
}: HostedControllerEvent): Promise<void> {
  return processNormalizedEvent({
    normalized,
    githubToken: required('AGENT_LCARS_GITHUB_TOKEN'),
    storageMode: 'authority',
    authorityEpoch: required('DISPATCH_AUTHORITY_EPOCH'),
    storagePortFactory: () =>
      new FirestoreStoragePort({
        projectId: required('PROJECT_ID'),
        databaseId: required('DISPATCH_FIRESTORE_DATABASE_ID'),
      }),
    isPullRequest,
    transportRunId,
    authorityOwner,
    pollCompletionUntilTerminal,
    maintainer: maintainerLogin(),
    projectionIdentities: [
      { login: 'github-actions[bot]', type: 'Bot' },
      { login: maintainerLogin(), type: 'User' },
    ],
  });
}
