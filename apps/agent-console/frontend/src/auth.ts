import { createAppAuth } from '@repo/auth/server';
import { getAgentConsoleAdminGithubLogin } from '@repo/util-server';
import type { Session } from 'next-auth';

/**
 * Mock session for the shared test-session adapter (LAN preview:
 * IMPERSONATE_AUTOMATIC_LOGIN=true + E2E_TESTING_USER=<name>).
 * agent-console is a single-admin app, so the injected identity is an
 * admin — this replaces the old SKIP_AUTH_FOR_LAN_PREVIEW bypass.
 */
async function getMockSession(userId: string): Promise<Session> {
  return {
    user: {
      id: userId,
      name: 'LAN Preview',
      email: `${userId}@example.com`,
      isAdmin: true,
    },
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

export const { auth, handlers, signIn, signOut } = createAppAuth({
  config: () => ({
    providers: ['github'],
    allowedGithubLogins: [getAgentConsoleAdminGithubLogin()],
    adapter: false,
    newUserRoute: null,
  }),
  mockSession: getMockSession,
});
