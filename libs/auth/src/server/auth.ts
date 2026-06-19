import { getFirebaseAuthAdmin } from '@members/firebase-server';
import { logger } from '@members/logging';
import {
  getE2eTestingUser,
  isAdminEmail,
  isImpersonateAutomaticLogin,
  isMockAuthEnabled,
  isOnecakeAdmin,
  isSlackAdmin,
} from '@members/util-server';
import { NextRequest } from 'next/server';
import NextAuth, { Session } from 'next-auth';

import { getAuthConfig } from './config';
import { initWebLogging } from './logging-initialization';

// Initialize logging context for Next.js server runtime
initWebLogging();

const {
  handlers,
  auth: nextAuth,
  signIn,
  signOut,
} = NextAuth(async () => {
  logger.debug('auth.ts: Fetching auth config...');
  try {
    const config = await getAuthConfig();
    logger.debug('auth.ts: Auth config fetched successfully.');
    return config;
  } catch (error) {
    logger.error('auth.ts: Error fetching auth config:', error);
    throw error;
  }
});

/**
 * Generates a mock session for testing or development.
 */
async function getMockSession(userId: string): Promise<Session> {
  // Grant admin via the same mechanisms used in production so an impersonated
  // user reflects real authorization: Slack admin allowlist, OneCake Strava
  // athlete allowlist (ONECAKE_ADMINS), or admin email (ADMIN_EMAILS). The
  // impersonated id can be a Slack id, a Strava athlete id, or an email; if it
  // is an email it also feeds the email-based check.
  const email = userId.includes('@') ? userId : 'impersonated@example.com';
  const isAdmin =
    isSlackAdmin(userId) || isOnecakeAdmin(userId) || isAdminEmail(email);
  let firebaseToken: string | undefined;

  try {
    const authAdmin = await getFirebaseAuthAdmin();
    firebaseToken = await authAdmin.createCustomToken(userId, {
      isAdmin,
    });
  } catch (error) {
    logger.error(
      'auth.ts: Failed to generate Firebase token for mock session',
      error,
    );
  }

  return {
    user: {
      id: userId,
      name: 'Impersonated User',
      email,
      onboarding: {
        hasAcceptedWaiver: true,
        hasCompletedProfile: true,
        isStravaConnected: false,
        hasActiveMembership: true,
      },
      slack: {
        id: userId,
        isAdmin,
      },
    },
    firebaseToken,
    expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

/**
 * Enhanced auth function with E2E testing and development bypass.
 */
const auth: typeof nextAuth = (async (...args: Parameters<typeof nextAuth>) => {
  if (isMockAuthEnabled()) {
    // Fallback to automatic impersonation via env variable
    if (isImpersonateAutomaticLogin()) {
      const e2eTestingUser = getE2eTestingUser();
      if (e2eTestingUser) {
        logger.debug(
          `auth.ts: Automatically impersonating user ${e2eTestingUser} via IMPERSONATE env var`,
        );
        return await getMockSession(e2eTestingUser);
      }
    }
  }
  return (
    nextAuth as (
      ...args: Parameters<typeof nextAuth>
    ) => ReturnType<typeof nextAuth>
  )(...args);
}) as typeof nextAuth;

/**
 * Wraps a NextAuth route handler pair so that, when automatic impersonation is
 * enabled, the `/api/auth/session` endpoint returns the mock session. This keeps
 * the client-side session (useSession / SessionProvider) consistent with the
 * impersonated session that server components get from `auth()`.
 *
 * Apps that build their own NextAuth instance (e.g. to override providers or
 * `requireClubMembership`) should export `withImpersonation(handlers)` instead
 * of the raw handlers, otherwise client session state will be null under
 * impersonation even though server rendering is authenticated.
 */
export function withImpersonation(routeHandlers: {
  GET: (req: NextRequest) => Promise<Response> | Response;
  POST: (req: NextRequest) => Promise<Response> | Response;
}) {
  return {
    GET: async (req: NextRequest) => {
      if (
        isMockAuthEnabled() &&
        isImpersonateAutomaticLogin() &&
        req.nextUrl.pathname.includes('/api/auth/session')
      ) {
        const e2eTestingUser = getE2eTestingUser();
        if (e2eTestingUser) {
          const session = await getMockSession(e2eTestingUser);
          return new Response(JSON.stringify(session), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
      return routeHandlers.GET(req);
    },
    POST: routeHandlers.POST,
  };
}

// Wrap handlers for mock session support
const wrappedHandlers = withImpersonation(handlers);

export { auth, wrappedHandlers as handlers, signIn, signOut };
