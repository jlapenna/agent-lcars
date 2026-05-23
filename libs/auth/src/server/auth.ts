import { getFirebaseAdminApp } from '@members/firebase-server';
import { logger } from '@members/logging';
import {
  getE2eTestingUser,
  isImpersonateAutomaticLogin,
  isMockAuthEnabled,
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
  const isAdmin = isSlackAdmin(userId);
  let firebaseToken: string | undefined;

  try {
    const adminApp = await getFirebaseAdminApp();
    firebaseToken = await adminApp.auth().createCustomToken(userId, {
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
      email: 'impersonated@example.com',
      onboarding: {
        hasAcceptedWaiver: true,
        hasCompletedProfile: true,
        isStravaConnected: false,
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

// Wrap handlers for mock session support
const wrappedHandlers = {
  GET: async (req: NextRequest) => {
    if (isMockAuthEnabled()) {
      if (
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
    }
    return handlers.GET(req);
  },
  POST: handlers.POST,
};

export { auth, wrappedHandlers as handlers, signIn, signOut };
