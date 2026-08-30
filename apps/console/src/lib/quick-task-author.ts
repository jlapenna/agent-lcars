import 'server-only';

import { isE2eTesting, isOnGoogleCloud } from '@agent-lcars/util-server';
import type { Session } from 'next-auth';

import { githubAccessTokenFor } from '../auth';
import { ActionError, type QuickTaskIssueCreator } from './backend-actions';
import { createGithubUserClient } from './github-client';

/**
 * Selects the identity used for the single issue-create write.
 *
 * Local E2E keeps using its fixture App client because its header-backed test
 * session intentionally has no real OAuth credential. Production fails
 * closed when an older session predates the user-token claim; signing in once
 * refreshes the encrypted session with the required token.
 */
export function quickTaskIssueCreatorFor(
  session: Session,
): QuickTaskIssueCreator | undefined {
  const accessToken = githubAccessTokenFor(session);
  if (!accessToken) {
    if (isE2eTesting() && !isOnGoogleCloud()) return undefined;
    throw new ActionError(
      'Sign out and back in before filing a Quick Task so GitHub can record you as its author',
      401,
    );
  }

  const client = createGithubUserClient(accessToken);
  return (parameters) => client.rest.issues.create(parameters);
}
