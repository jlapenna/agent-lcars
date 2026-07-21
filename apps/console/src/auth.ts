import { required } from '@repo/util-server';
import { headers } from 'next/headers';
import type { Session } from 'next-auth';
import NextAuth from 'next-auth';
import GitHub from 'next-auth/providers/github';

const getAdminGithubLogin = () => required('AGENT_LCARS_ADMIN_GITHUB_LOGIN');

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

const nextAuth = NextAuth({
  providers: [GitHub],
  callbacks: {
    signIn({ profile }) {
      return profile?.login === getAdminGithubLogin();
    },
    jwt({ token, profile }) {
      if (profile) {
        token.githubLogin = profile.login;
        token.isAdmin = profile.login === getAdminGithubLogin();
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.sub ?? '';
      session.user.isAdmin = token.isAdmin === true;
      return session;
    },
  },
});

async function testSession(): Promise<Session | null | undefined> {
  if (process.env['E2E_TESTING'] !== 'true') return undefined;
  const user = (await headers()).get('x-e2e-auth-user');
  if (!user) return undefined;
  return user === 'unauthed' ? null : getMockSession(user);
}

export const auth: typeof nextAuth.auth = (async (...args: Parameters<typeof nextAuth.auth>) => {
  if (args.length === 0) {
    const session = await testSession();
    if (session !== undefined) return session;
  }
  return nextAuth.auth(...args);
}) as typeof nextAuth.auth;

export const { handlers, signIn, signOut } = nextAuth;
