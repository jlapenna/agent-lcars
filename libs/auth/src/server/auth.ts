import { getFirebaseAuthAdmin } from '@repo/firebase-server';
import { logger } from '@repo/logging';
import { isOnecakeAdmin } from '@repo/strava';
import {
  getE2eTestingUser,
  isAdminEmail,
  isImpersonateAutomaticLogin,
  isMockAuthEnabled,
  isSlackAdmin,
} from '@repo/util-server';
import { NextRequest } from 'next/server';
import type { Session } from 'next-auth';

/**
 * Generates a basic mock session for impersonation in local/E2E testing.
 * Apps with app-specific session fields (e.g. slack) should pass a custom
 * mock session function to withImpersonation() instead.
 */
export async function getMockSession(userId: string): Promise<Session> {
  const email = userId.includes('@') ? userId : 'impersonated@example.com';
  const isAdmin =
    isSlackAdmin(userId) || isOnecakeAdmin(userId) || isAdminEmail(email);
  let firebaseToken: string | undefined;

  try {
    const authAdmin = await getFirebaseAuthAdmin();
    firebaseToken = await authAdmin.createCustomToken(userId, { isAdmin });
  } catch (error) {
    logger.error('getMockSession: Failed to generate Firebase token', error);
  }

  return {
    user: { id: userId, name: 'Impersonated User', email, isAdmin },
    firebaseToken,
    expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

/**
 * Wraps a NextAuth route handler pair so that, when automatic impersonation is
 * enabled, the `/api/auth/session` endpoint returns a mock session. This keeps
 * the client-side session (useSession / SessionProvider) consistent with the
 * impersonated session that server components get from `auth()`.
 *
 * Apps with app-specific session shapes should pass a custom `mockSessionFn`
 * (e.g. members passes one that includes Slack-specific fields).
 */
export function withImpersonation(
  routeHandlers: {
    GET: (req: NextRequest) => Promise<Response> | Response;
    POST: (req: NextRequest) => Promise<Response> | Response;
  },
  mockSessionFn: (userId: string) => Promise<Session> = getMockSession,
) {
  return {
    GET: async (req: NextRequest) => {
      if (
        isMockAuthEnabled() &&
        isImpersonateAutomaticLogin() &&
        req.nextUrl.pathname.includes('/api/auth/session')
      ) {
        const e2eTestingUser = getE2eTestingUser();
        if (e2eTestingUser) {
          const session = await mockSessionFn(e2eTestingUser);
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
