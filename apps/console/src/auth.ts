import 'server-only';

import {
  isE2eTesting,
  isOnGoogleCloud,
  optional,
  required,
} from '@agent-lcars/util-server';
import { headers } from 'next/headers';
import type { Session } from 'next-auth';
import NextAuth from 'next-auth';
import { getToken } from 'next-auth/jwt';
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
      // The local E2E adapter supplies a deterministic GitHub login as its
      // injected identity. Direct Work admission must retain the same
      // concrete actor boundary as production rather than inventing one.
      login: userId,
      isAdmin: true,
    },
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

const SERVER_GITHUB_ACCESS_TOKEN = Symbol('server-github-access-token');

type ServerSession = Session & {
  [SERVER_GITHUB_ACCESS_TOKEN]?: string;
};

/**
 * Returns the signed-in user's GitHub OAuth token only from a server-side
 * session produced by this module. The symbol is never added by Auth.js's
 * public session callback, so `/api/auth/session` cannot serialize it to the
 * browser.
 */
export function githubAccessTokenFor(session: Session): string | undefined {
  return (session as ServerSession)[SERVER_GITHUB_ACCESS_TOKEN];
}

async function attachServerGithubAccessToken(
  session: Session,
): Promise<Session> {
  const secureCookie =
    optional('AUTH_URL')?.startsWith('https://') ?? isOnGoogleCloud();
  const token = await getToken({
    req: { headers: new Headers(await headers()) },
    secret: required('AUTH_SECRET'),
    secureCookie,
  });
  if (typeof token?.githubAccessToken === 'string') {
    Object.defineProperty(session, SERVER_GITHUB_ACCESS_TOKEN, {
      configurable: false,
      enumerable: false,
      value: token.githubAccessToken,
      writable: false,
    });
  }
  return session;
}

const nextAuth = NextAuth({
  providers: [
    GitHub({
      // Quick Tasks are created with the operator's token so GitHub records
      // the signed-in human as the author. `repo` is required because the
      // watched repository set includes private repositories.
      authorization: { params: { scope: 'repo read:user user:email' } },
    }),
  ],
  callbacks: {
    signIn({ profile }) {
      return isAdminGithubLogin(profile?.login);
    },
    jwt({ token, profile, account }) {
      if (typeof profile?.login === 'string') {
        token.githubLogin = profile.login;
        token.isAdmin = isAdminGithubLogin(profile.login);
      }
      if (
        account?.provider === 'github' &&
        typeof account.access_token === 'string'
      ) {
        // Auth.js encrypts the JWT cookie with AUTH_SECRET. Keep this out of
        // the public session callback; attachServerGithubAccessToken decodes
        // it only for same-process server callers.
        token.githubAccessToken = account.access_token;
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
    const authenticated = await nextAuth.auth();
    return authenticated
      ? attachServerGithubAccessToken(authenticated)
      : authenticated;
  }
  return nextAuth.auth(...args);
}) as typeof nextAuth.auth;

export const { handlers, signIn, signOut } = nextAuth;
