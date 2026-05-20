/**
 * Auth.js v5 Configuration with Firebase Adapter
 *
 * This configuration sets up Auth.js (formerly NextAuth.js) v5 with:
 * - Firebase Firestore adapter for database persistence
 * - Slack OAuth provider for authentication
 * - Custom collection paths in Firestore
 * - JWT and session handling with custom fields
 *
 * @see https://authjs.dev
 * @see https://authjs.dev/getting-started/adapters/firebase
 */

import './types';

import { FirestoreAdapter } from '@auth/firebase-adapter';
import { getFirebaseAdminApp, getFirestore } from '@members/firebase-server';
import { logger, LogLevel } from '@members/logging';
import { getAuthSecret } from '@members/service-auth';
import { getSecrets as getSlackSecrets } from '@members/slack';
import { getSecrets as getStravaSecrets } from '@members/strava';
import { getNextPublicSlackClientId } from '@members/util/browser';
import { enableTestingHandlers } from '@members/util-server';
import { getLogLevel, getSlackTeamId, isSlackAdmin } from '@members/util-server';
import type { NextAuthConfig } from 'next-auth';
import type { Provider } from 'next-auth/providers';
import Credentials from 'next-auth/providers/credentials';
import Slack from 'next-auth/providers/slack';
import Strava from 'next-auth/providers/strava';
import { z } from 'zod';

import { getAuthJsAccount } from './queries';
import { SlackUser } from './types';

/**
 * Generates the Auth.js configuration object.
 *
 * This async function:
 * 1. Initializes the Firestore instance
 * 2. Retrieves Slack OAuth secrets
 * 3. Configures the Slack provider with team-specific settings
 * 4. Sets up the Firestore adapter with custom collection paths
 * 5. Configures callbacks for session and JWT handling
 *
 * @returns Promise resolving to the NextAuthConfig
 */
export const getAuthConfig = async (): Promise<NextAuthConfig> => {
  logger.debug('getAuthConfig: Starting...');

  const firestore = await getFirestore();
  const slackSecrets = await getSlackSecrets();
  const stravaSecrets = await getStravaSecrets();
  const authSecret = await getAuthSecret();

  const providers: Provider[] = [
    Slack({
      clientId: getNextPublicSlackClientId(),
      clientSecret: slackSecrets.clientSecret,
      authorization: {
        params: {
          scope: 'openid profile email',
        },
      },
      /**
       * Profile callback - transforms the OIDC profile into the Auth.js user object.
       *
       * CRITICAL: The Firestore adapter calls `.add()` which auto-generates the document ID.
       * This auto-generated ID becomes the user.id and cannot be overridden.
       * Therefore, we store Slack-specific data in a custom `slack` object.
       *
       * Note: Firestore adapter auto-generates document IDs, so we use a custom field.
       * @see https://authjs.dev/getting-started/providers/slack
       */
      profile(profile) {
        return {
          name: profile.name,
          email: profile.email,
          image: profile.picture,
          slack: {
            id: profile.sub, // Slack User ID from OIDC sub claim
            teamId: profile['https://slack.com/team_id'] as string | undefined,
            isAdmin: false, // Will be computed in session callback
          },
        };
      },
      allowDangerousEmailAccountLinking: true,
    }),
    Strava({
      clientId: stravaSecrets.clientId,
      clientSecret: stravaSecrets.clientSecret,
      authorization: {
        params: {
          scope: 'read,activity:read,activity:read_all,profile:read_all',
        },
      },
    }),
  ];

  // Conditionally add Credentials provider for testing and local development
  if (enableTestingHandlers()) {
    providers.push(
      Credentials({
        id: 'credentials',
        name: 'Mock Login',
        credentials: {
          userId: { label: 'User ID', type: 'text' },
          name: { label: 'Name', type: 'text' },
          email: { label: 'Email', type: 'text' },
          isAdmin: { label: 'Is Admin', type: 'text' },
        },
        async authorize(credentials) {
          const schema = z.object({
            userId: z.string().default('test-user'),
            name: z.string().default('Test User'),
            email: z.string().default('test@example.com'),
            isAdmin: z.enum(['true', 'false']).default('false'),
          });

          const parsed = schema.safeParse(credentials);
          if (!parsed.success) return null;

          const data = parsed.data;

          return {
            id: data.userId,
            name: data.name,
            email: data.email,
            slack: {
              id: data.userId, // mock same ID
              isAdmin: data.isAdmin === 'true',
            },
          };
        },
      }),
    );
  }

  const firestoreAdapter = FirestoreAdapter({
    firestore,
    collections: {
      users: 'services/authjs/users',
      accounts: 'services/authjs/accounts',
      sessions: 'services/authjs/sessions',
      verificationTokens: 'services/authjs/verificationTokens',
    },
  });

  const adapter: NextAuthConfig['adapter'] = {
    ...firestoreAdapter,
    async updateSession(session) {
      if (!firestoreAdapter.updateSession) {
        return null;
      }
      try {
        return await firestoreAdapter.updateSession(session);
      } catch (error: unknown) {
        const err = error as { code?: number; message?: string };
        if (err.code === 10 || err.message?.includes('contention')) {
          logger.warn(
            'getAuthConfig: Session update contention detected, ignoring update and fetching current session.',
          );
          // If update failed due to contention, the session likely exists.
          // We fetch it to return valid session data.
          if (firestoreAdapter.getSessionAndUser) {
            const result = await firestoreAdapter.getSessionAndUser(
              session.sessionToken,
            );
            return result?.session ?? null;
          }
        }
        throw error;
      }
    },
  };

  return {
    secret: authSecret,
    trustHost: true,
    /**
     * Configure the Firestore adapter for database persistence.
     *
     * The adapter handles:
     * - User creation and retrieval
     * - Account linking (OAuth providers)
     * - Session management
     * - Verification tokens
     *
     * Custom collection paths are used to organize Auth.js data
     * under the 'services/authjs' path.
     *
     * @see https://authjs.dev/getting-started/adapters/firebase
     */
    adapter,

    /**
     * Configure authentication providers.
     *
     * Currently using Slack OAuth with:
     * - Team-specific authorization (restricts to specific workspace)
     * - OpenID Connect scopes for profile and email
     * - Custom profile callback to map Slack ID to user.id
     */
    providers,

    /**
     * Callbacks allow you to control what happens during authentication.
     *
     * @see https://authjs.dev/guides/extending-the-session
     */
    callbacks: {
      /**
       * JWT callback - called whenever a JSON Web Token is created or updated.
       *
       * This is required when using the Credentials provider (which uses JWTs).
       * We propagate the Slack data from the user object to the token.
       */
      async jwt({ token, user }) {
        if (user?.slack) {
          token.slack = user.slack;
          token.sub = user.id;
        }
        return token;
      },

      /**
       * Session callback - called whenever a session is checked.
       *
       * With database sessions, this callback receives the user object
       * directly from the database. We populate the session with Slack-specific
       * data and generate a Firebase custom token for client-side auth.
       *
       * @param session - The session object
       * @param user - The user object from the database
       * @returns The modified session object
       */
      async session({ session, user, token }) {
        // Handle Database strategy (user) or JWT strategy (token)
        const slackData = (user?.slack || token?.slack) as
          | SlackUser
          | undefined;

        // Handle E2E testing mock user or standard user
        if (session.user && slackData) {
          // Keep the internal Firestore ID available (or fallback to token sub)
          session.user.id = user?.id || token?.sub || '';

          // Populate Strava connection status
          try {
            const stravaAccount = await getAuthJsAccount(
              firestore,
              session.user.id,
              'strava',
            );
            session.user.isStravaConnected = !!stravaAccount;
          } catch (error) {
            logger.error(
              'Failed to check Strava connection for session:',
              error,
            );
          }

          // Populate Slack-specific data
          session.user.slack = {
            id: slackData.id,
            teamId: slackData.teamId,
            isAdmin: isSlackAdmin(slackData.id),
          };

          // Generate Firebase custom token for client-side Firebase authentication
          try {
            const adminApp = await getFirebaseAdminApp();
            session.firebaseToken = await adminApp
              .auth()
              .createCustomToken(slackData.id, {
                isAdmin: session.user.slack.isAdmin,
              });
          } catch (error) {
            logger.error('Failed to create Firebase custom token:', error);
          }
        }

        return session;
      },

      /**
       * SignIn callback - called when a user signs in.
       *
       * We use this to enforce that the user is signing in from the correct Slack workspace.
       * This is a security measure to mitigate the risk of 'allowDangerousEmailAccountLinking: true'.
       */
      async signIn({ account, profile }) {
        if (account?.provider === 'slack') {
          const slackTeamId = getSlackTeamId();
          const teamId = profile?.['https://slack.com/team_id'];
          if (slackTeamId && teamId !== slackTeamId) {
            logger.warn(
              `Rejecting sign-in from incorrect Slack team: ${teamId} (expected ${slackTeamId})`,
            );
            return false;
          }
        }
        return true;
      },
    },

    /**
     * Configure session handling.
     *
     * When using database sessions (with an adapter), Auth.js automatically
     * creates and manages sessions in the database.
     */
    session: {
      strategy: enableTestingHandlers() ? 'jwt' : 'database',
      // Default session max age is 30 days
      maxAge: 30 * 24 * 60 * 60, // 30 days in seconds
    },

    /**
     * Configure pages for authentication UI.
     *
     * You can customize these to use your own pages:
     * - signIn: '/auth/signin'
     * - signOut: '/auth/signout'
     * - error: '/auth/error'
     * - verifyRequest: '/auth/verify-request'
     * - newUser: '/auth/new-user'
     */
    pages: {
      // signIn: '/auth/signin', // Uncomment to use custom sign-in page
      newUser: '/onboarding',
    },

    /**
     * Enable debug messages in development.
     */
    debug: getLogLevel()?.toLowerCase() == LogLevel.DEBUG,

    /**
     * Custom logger to ensure structured logging and avoid ANSI color codes.
     */
    logger: {
      error(code, ...message) {
        logger.error(code, ...message);
      },
      warn(code, ...message) {
        logger.warn(code, ...message);
      },
      debug(code, ...message) {
        logger.debug(code, ...message);
      },
    },
  };
};
