import './types';

import {
  getE2eTestingUser,
  isE2eTesting,
  isImpersonateAutomaticLogin,
  isMockAuthEnabled,
} from '@repo/util-server';
import { headers } from 'next/headers';
import type { Session } from 'next-auth';

import { getMockSession } from './auth';

/**
 * Header carrying an e2e-injected identity. Playwright suites set it via
 * route interception (see `useE2eTestingUserBeforeEach()` and friends); the
 * shared proxy factory (`@repo/app/proxy`) forwards it downstream during e2e
 * runs. The literal value `'unauthed'` simulates a logged-out user.
 */
export const E2E_AUTH_USER_HEADER = 'X-e2e-auth-user';

/**
 * Shape of the JSON payload e2e suites put in the header. Mirrors the
 * Firebase-flavored AuthUser the primes suite has always injected.
 */
interface E2eAuthUser {
  uid: string;
  email?: string;
  displayName?: string;
  customClaims?: { roles?: string[] } & Record<string, unknown>;
}

export interface TestSessionOptions {
  /**
   * App-specific mock-session shape for env-driven impersonation (e.g.
   * members includes Slack identity + onboarding). Defaults to the basic
   * shared mock session.
   */
  mockSession?: (userId: string) => Promise<Session>;
}

/**
 * The ONE test-session adapter (#2127). Every non-production identity
 * injection across the four Next.js apps resolves here, replacing the three
 * previous per-app mechanisms (members' local `getMockSession` auto-login,
 * primes' inline `X-e2e-auth-user` parsing, agent-console's
 * `SKIP_AUTH_FOR_LAN_PREVIEW` bypass).
 *
 * Activation, in precedence order:
 * 1. **e2e header** — only when `E2E_TESTING` is set: the `X-e2e-auth-user`
 *    request header is interpreted as the session (`'unauthed'` → logged
 *    out).
 * 2. **env impersonation** — only when `IMPERSONATE_AUTOMATIC_LOGIN` is set:
 *    `E2E_TESTING_USER` is auto-logged-in via the mock session (local dev
 *    and LAN preview).
 *
 * Neither flag is ever set in a deployed environment.
 *
 * @returns `undefined` when inactive (fall through to the real NextAuth
 * session), `null` for an explicit logged-out simulation, or the injected
 * `Session`.
 */
export async function getTestSession(
  options: TestSessionOptions = {},
): Promise<Session | null | undefined> {
  const headerSession = await getE2eHeaderSession();
  if (headerSession !== undefined) {
    return headerSession;
  }

  if (isMockAuthEnabled() && isImpersonateAutomaticLogin()) {
    const userId = getE2eTestingUser();
    if (userId) {
      const mockSession = options.mockSession ?? getMockSession;
      return await mockSession(userId);
    }
  }

  return undefined;
}

async function getE2eHeaderSession(): Promise<Session | null | undefined> {
  if (!isE2eTesting()) {
    return undefined;
  }

  let header: string | null;
  try {
    header = (await headers()).get(E2E_AUTH_USER_HEADER);
  } catch {
    // headers() throws outside a request context (e.g. build-time render).
    return undefined;
  }
  if (!header) {
    return undefined;
  }
  if (header === 'unauthed') {
    return null;
  }

  let authUser: E2eAuthUser;
  try {
    authUser = JSON.parse(header) as E2eAuthUser;
  } catch {
    throw new Error(
      `Malformed JSON in ${E2E_AUTH_USER_HEADER} header: ${header}`,
    );
  }
  if (!authUser.uid) {
    throw new Error(`Misconfigured E2E Testing User in header: ${header}`);
  }

  return {
    user: {
      id: authUser.uid,
      name: authUser.displayName ?? 'E2E User',
      email: authUser.email ?? null,
      isAdmin: !!authUser.customClaims?.roles?.includes('admin'),
    },
    ...(authUser.customClaims && { customClaims: authUser.customClaims }),
    expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
}
