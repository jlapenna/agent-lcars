import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';

import { logger } from '@agent-lcars/logging';
import {
  isE2eTesting,
  isOnGoogleCloud,
  optional,
  required,
} from '@agent-lcars/util-server';
import { headers } from 'next/headers';
import type { Session } from 'next-auth';
import NextAuth from 'next-auth';
import { getToken, type JWT } from 'next-auth/jwt';
import GitHub from 'next-auth/providers/github';

import { canSignInToConsole } from './lib/console-access';
import { isAdminGithubLogin } from './lib/deployment';
import { refreshGithubUserToken } from './lib/github-token-refresh';
import {
  recordOperatorTokenIssued,
  recordOperatorTokenRefresh,
} from './lib/operator-comment-observability';

/**
 * Mock session for the E2E test-session adapter (E2E_TESTING=true +
 * an `x-e2e-auth-user` request header -- see testSession() below).
 * Only explicit admin fixtures have admin authority — this replaces the old
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
      isAdmin:
        userId === 'e2e-agent-lcars-admin' || userId === 'ungranted-admin',
    },
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

const SERVER_GITHUB_ACCESS_TOKEN = Symbol('server-github-access-token');
const SERVER_GITHUB_ACCESS_TOKEN_ISSUED_AT = Symbol(
  'server-github-access-token-issued-at',
);
const SERVER_GITHUB_ACCESS_TOKEN_EXPIRES_AT = Symbol(
  'server-github-access-token-expires-at',
);
const SERVER_GITHUB_ACCESS_TOKEN_RENEWABLE = Symbol(
  'server-github-access-token-renewable',
);

type ServerSession = Session & {
  [SERVER_GITHUB_ACCESS_TOKEN]?: string;
  [SERVER_GITHUB_ACCESS_TOKEN_ISSUED_AT]?: number;
  [SERVER_GITHUB_ACCESS_TOKEN_EXPIRES_AT]?: number;
  [SERVER_GITHUB_ACCESS_TOKEN_RENEWABLE]?: true;
};

/** What the server keeps beside the operator token; never the refresh token
 *  itself, which stays inside the encrypted session cookie. */
interface ServerGithubTokenFacts {
  issuedAt?: number | undefined;
  expiresAt?: number | undefined;
  renewable?: boolean | undefined;
}

/**
 * Renew this long before GitHub's stated expiry, so a write that starts with
 * a nearly expired token does not lose a race against the clock.
 */
const RENEW_BEFORE_EXPIRY_MS = 5 * 60_000;

/**
 * Returns the signed-in user's GitHub OAuth token only from a server-side
 * session produced by this module. The symbol is never added by Auth.js's
 * public session callback, so `/api/auth/session` cannot serialize it to the
 * browser.
 */
export function githubAccessTokenFor(session: Session): string | undefined {
  return (session as ServerSession)[SERVER_GITHUB_ACCESS_TOKEN];
}

/**
 * When this session's GitHub token was issued (epoch ms), for sessions signed
 * in since the console began recording it. The sign-in app's tokens expire
 * eight hours after issue, so a rejection reports the token's age.
 */
export function githubAccessTokenIssuedAtFor(
  session: Session,
): number | undefined {
  return (session as ServerSession)[SERVER_GITHUB_ACCESS_TOKEN_ISSUED_AT];
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
  return typeof token?.githubAccessToken === 'string'
    ? withServerGithubAccessToken(session, token.githubAccessToken, {
        issuedAt: numberOrUndefined(token.githubAccessTokenIssuedAt),
        expiresAt: numberOrUndefined(token.githubAccessTokenExpiresAt),
        renewable: typeof token.githubRefreshToken === 'string',
      })
    : session;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/** The placeholder user token carried by hermetic E2E sessions only. */
export const E2E_FIXTURE_GITHUB_USER_TOKEN = 'e2e-fixture-user-token';

function withServerGithubAccessToken(
  session: Session,
  accessToken: string,
  facts: ServerGithubTokenFacts = {},
): Session {
  const hidden = (key: symbol, value: unknown) =>
    Object.defineProperty(session, key, {
      configurable: false,
      enumerable: false,
      value,
      writable: false,
    });
  hidden(SERVER_GITHUB_ACCESS_TOKEN, accessToken);
  if (facts.issuedAt !== undefined)
    hidden(SERVER_GITHUB_ACCESS_TOKEN_ISSUED_AT, facts.issuedAt);
  if (facts.expiresAt !== undefined)
    hidden(SERVER_GITHUB_ACCESS_TOKEN_EXPIRES_AT, facts.expiresAt);
  if (facts.renewable) hidden(SERVER_GITHUB_ACCESS_TOKEN_RENEWABLE, true);
  return session;
}

/** Carries a renewed token out of the `jwt` callback to the server action
 *  that asked for it, without a second decode of the cookie it just wrote. */
const renewalScope = new AsyncLocalStorage<{ renewed?: JWT }>();

function isDueForRenewal(expiresAt: number | undefined): boolean {
  return (
    expiresAt !== undefined && Date.now() >= expiresAt - RENEW_BEFORE_EXPIRY_MS
  );
}

/**
 * Replaces an expiring GitHub token inside the session JWT using its refresh
 * token. Runs only on a session update, which always writes the session
 * cookie: GitHub rotates the refresh token, so renewing where the cookie
 * cannot be written (a Server Component render) would strand the session on
 * a spent one. A failed renewal leaves the token as it was; the write that
 * needed it is then refused and takes the re-authorization path.
 */
async function withRenewedGithubToken(token: JWT): Promise<JWT> {
  const refreshToken = token.githubRefreshToken;
  if (
    typeof refreshToken !== 'string' ||
    !isDueForRenewal(numberOrUndefined(token.githubAccessTokenExpiresAt))
  ) {
    return token;
  }
  const issuedAt = numberOrUndefined(token.githubAccessTokenIssuedAt);
  const tokenAgeSeconds =
    issuedAt === undefined
      ? undefined
      : Math.round((Date.now() - issuedAt) / 1000);
  const refreshed = await refreshGithubUserToken(refreshToken);
  if (refreshed === undefined) return token;
  if (!refreshed.ok) {
    recordOperatorTokenRefresh(refreshed.outcome, {
      tokenAgeSeconds,
      githubError: refreshed.githubError,
    });
    return token;
  }
  recordOperatorTokenRefresh('refreshed', { tokenAgeSeconds });
  const renewed: JWT = {
    ...token,
    githubAccessToken: refreshed.accessToken,
    githubAccessTokenIssuedAt: Date.now(),
    githubRefreshToken: refreshed.refreshToken ?? refreshToken,
  };
  if (refreshed.accessTokenExpiresAt === undefined)
    delete renewed.githubAccessTokenExpiresAt;
  else renewed.githubAccessTokenExpiresAt = refreshed.accessTokenExpiresAt;
  const scope = renewalScope.getStore();
  if (scope) scope.renewed = renewed;
  return renewed;
}

const nextAuth = NextAuth({
  providers: [
    GitHub({
      // Quick Tasks and console replies use the operator's token so GitHub records
      // the signed-in human as the author. `repo` is required because the
      // watched repository set includes private repositories.
      authorization: { params: { scope: 'repo read:user user:email' } },
    }),
  ],
  callbacks: {
    signIn({ profile }) {
      return canSignInToConsole(profile?.login);
    },
    async jwt({ token, profile, account, trigger }) {
      // Without a database adapter Auth.js gives every sign-in a random user
      // id, so per-user state (Inbox push subscriptions, decision snoozes,
      // the browser notification ledger) would split across sign-ins. The
      // GitHub account id is the stable principal those stores key on.
      if (account?.provider === 'github' && account.providerAccountId)
        token.sub = account.providerAccountId;
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
        token.githubAccessTokenIssuedAt = Date.now();
        // GitHub issues this app an eight-hour token with a refresh token.
        // Both stay in the encrypted cookie so a server action can renew the
        // token without sending the operator back through GitHub.
        if (typeof account.expires_at === 'number')
          token.githubAccessTokenExpiresAt = account.expires_at * 1000;
        else delete token.githubAccessTokenExpiresAt;
        if (typeof account.refresh_token === 'string')
          token.githubRefreshToken = account.refresh_token;
        else delete token.githubRefreshToken;
        recordOperatorTokenIssued(account);
      }
      // Never read the update payload: a browser can send one. The only
      // effect of an update is renewing a token that is due anyway.
      if (trigger === 'update') return withRenewedGithubToken(token);
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
  if (user === 'unauthed') return null;
  // Operator-attributed writes (console replies) require a user token. The
  // hermetic suite routes every GitHub call to its fixture API, which never
  // inspects credentials, so a placeholder stands in for the OAuth token.
  return withServerGithubAccessToken(
    await getMockSession(user),
    E2E_FIXTURE_GITHUB_USER_TOKEN,
  );
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

/**
 * The session with a GitHub token that is still good for a write. When the
 * session's token has reached GitHub's expiry, this renews it with the
 * session's refresh token and stores the result in the session cookie.
 *
 * Call it only from a Server Action or Route Handler: the renewed cookie
 * must be written. Sessions without a refresh token (signed in before the
 * console kept one, or the hermetic E2E session) and failed renewals return
 * the session unchanged, so the write is refused and re-authorizes instead.
 */
export async function withFreshGithubAccessToken(
  session: Session,
): Promise<Session> {
  const current = session as ServerSession;
  if (
    !current[SERVER_GITHUB_ACCESS_TOKEN_RENEWABLE] ||
    !isDueForRenewal(current[SERVER_GITHUB_ACCESS_TOKEN_EXPIRES_AT])
  ) {
    return session;
  }
  const scope: { renewed?: JWT } = {};
  try {
    await renewalScope.run(scope, () => nextAuth.unstable_update({}));
  } catch (error) {
    logger.warn('GitHub operator token renewal could not be saved', error);
    return session;
  }
  const renewed = scope.renewed;
  if (typeof renewed?.githubAccessToken !== 'string') return session;
  return withServerGithubAccessToken(
    { ...session },
    renewed.githubAccessToken,
    {
      issuedAt: numberOrUndefined(renewed.githubAccessTokenIssuedAt),
      expiresAt: numberOrUndefined(renewed.githubAccessTokenExpiresAt),
      renewable: typeof renewed.githubRefreshToken === 'string',
    },
  );
}
