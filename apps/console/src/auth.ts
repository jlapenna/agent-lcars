import 'server-only';

import { isE2eTesting, isOnGoogleCloud } from '@agent-lcars/util-server';
import { headers } from 'next/headers';
import type { Session } from 'next-auth';
import NextAuth from 'next-auth';
import GitHub from 'next-auth/providers/github';

import { isAdminGithubLogin } from './lib/deployment';

/**
 * Mock session for the E2E test-session adapter (E2E_TESTING=true +
 * an `x-e2e-auth-user` request header -- see testSession() below).
 * The injected identity is an admin — this replaces the old
 * SKIP_AUTH_FOR_LAN_PREVIEW bypass.
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
      return isAdminGithubLogin(profile?.login);
    },
    jwt({ token, profile }) {
      if (profile) {
        token.githubLogin = profile.login;
        token.isAdmin = isAdminGithubLogin(profile.login);
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.sub ?? '';
      session.user.isAdmin = token.isAdmin === true;
      session.user.login =
        typeof token.githubLogin === 'string' ? token.githubLogin : undefined;
      return session;
    },
  },
});

async function testSession(): Promise<Session | null | undefined> {
  // isOnGoogleCloud() (not NODE_ENV: the E2E suite itself runs the
  // standalone `next build` server, so NODE_ENV is already 'production'
  // there) checks the Cloud Run container contract's reserved K_SERVICE/
  // K_REVISION/CLOUD_RUN_JOB vars -- present only on a real deployed
  // instance, never in a local/CI E2E run. This is a hard backstop, not
  // just a redundant check: this bypass grants a full-admin session with
  // zero GitHub auth to anyone who sends the right header, and it must
  // stay dead even if E2E_TESTING were ever set on the live service
  // outside of apphosting.yaml (e.g. a manual `gcloud run services
  // update --set-env-vars` during debugging).
  if (!isE2eTesting() || isOnGoogleCloud()) return undefined;
  const user = (await headers()).get('x-e2e-auth-user');
  if (!user) return undefined;
  return user === 'unauthed' ? null : getMockSession(user);
}

export const auth: typeof nextAuth.auth = (async (
  ...args: Parameters<typeof nextAuth.auth>
) => {
  if ((args as unknown[]).length === 0) {
    const session = await testSession();
    if (session !== undefined) return session;
  }
  return nextAuth.auth(...args);
}) as typeof nextAuth.auth;

export const { handlers, signIn, signOut } = nextAuth;
