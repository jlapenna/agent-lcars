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
import { getFirebaseAuthAdmin, getFirestore } from '@members/firebase-server';
import { logger, LogLevel } from '@members/logging';
import { getAuthSecret } from '@members/service-auth';
import { getSecrets as getSlackSecrets } from '@members/slack';
import { getSecrets as getStravaSecrets } from '@members/strava';
import { getNextPublicSlackClientId } from '@members/util/browser';
import { enableTestingHandlers, getProjectId } from '@members/util-server';
import {
  getGoogleClientId,
  getGoogleClientSecret,
  getLogLevel,
  getMailFrom,
  getOptionalMailPassword,
  getOptionalMailPort,
  getOptionalMailServer,
  getOptionalMailUser,
  getSlackTeamId,
  getStravaClubId,
  isAdminEmail,
  isMailConfigured,
  isSlackAdmin,
} from '@members/util-server';
import type { NextAuthConfig } from 'next-auth';
import type { Provider } from 'next-auth/providers';
import Credentials from 'next-auth/providers/credentials';
import GoogleProvider from 'next-auth/providers/google';
import Nodemailer from 'next-auth/providers/nodemailer';
import Slack from 'next-auth/providers/slack';
import Strava from 'next-auth/providers/strava';
import { z } from 'zod';

import { resolveUserIdFromSlackId } from './identity';
import { getAuthJsAccount, getAuthJsAccountId } from './queries';
import { REQUIRED_WAIVER_VERSION } from './schema';
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
interface AppUser {
  id?: string;
  slack?: SlackUser;
  waiverVersionAccepted?: number;
}

interface AppJWT {
  sub?: string;
  slack?: SlackUser;
  isAdmin?: boolean;
  waiverVersionAccepted?: number;
}

export interface AuthConfigOptions {
  providers?: ('slack' | 'strava' | 'google' | 'email')[];
  /** When true, validates that the Strava athlete is a member of the expected club. */
  requireClubMembership?: boolean;
  /** Allowlist gating email-bearing providers (google, email). */
  allowedEmails?: string[];
  /**
   * Allowlist gating Strava sign-in by athlete ID. Strava returns no email, so
   * it cannot be gated by `allowedEmails`. When provided, only these athlete IDs
   * may sign in via Strava.
   */
  allowedStravaAthleteIds?: string[];
  /**
   * Override the route new users are redirected to.
   * Defaults to '/onboarding'. If set to null, the redirect is disabled.
   */
  newUserRoute?: string | null;
}

export const getAuthConfig = async (
  options?: AuthConfigOptions,
): Promise<NextAuthConfig> => {
  logger.debug('getAuthConfig: Starting...');

  const firestore = await getFirestore();
  const authSecret = await getAuthSecret();

  const projectId = getProjectId();
  const isOneCake = projectId?.startsWith('onecake');
  const requireClubMembership =
    options?.requireClubMembership ?? isOneCake ?? false;
  const requestedProviders =
    options?.providers || (isOneCake ? ['strava'] : ['slack', 'strava']);
  const providers: Provider[] = [];

  if (requestedProviders.includes('slack')) {
    const slackSecrets = await getSlackSecrets();
    providers.push(
      Slack({
        clientId: getNextPublicSlackClientId(),
        clientSecret: slackSecrets.clientSecret,
        authorization: {
          params: {
            scope: 'openid profile email',
          },
        },
        profile(profile) {
          return {
            id: profile.sub,
            name: profile.name,
            email: profile.email,
            image: profile.picture,
            slack: {
              id: profile.sub,
              teamId: profile['https://slack.com/team_id'] as
                | string
                | undefined,
              isAdmin: false,
            },
          };
        },
        allowDangerousEmailAccountLinking: true,
      }),
    );
  }

  if (requestedProviders.includes('strava')) {
    const stravaSecrets = await getStravaSecrets();
    providers.push(
      Strava({
        clientId: stravaSecrets.clientId,
        clientSecret: stravaSecrets.clientSecret,
        authorization: {
          params: {
            scope: 'read,activity:read,activity:read_all,profile:read_all',
          },
        },
      }),
    );
  }

  if (requestedProviders.includes('google')) {
    const googleId = getGoogleClientId();
    const googleSecret = getGoogleClientSecret();
    if (googleId && googleSecret) {
      providers.push(
        GoogleProvider({
          clientId: googleId,
          clientSecret: googleSecret,
          // Google verifies email ownership, so it is safe to link a Google
          // sign-in to an existing account with the same (e.g. magic-link)
          // email instead of failing with OAuthAccountNotLinked.
          allowDangerousEmailAccountLinking: true,
        }),
      );
    }
  }

  if (requestedProviders.includes('email')) {
    // Magic-link sign-in over SMTP (Google Workspace relay). Self-disables when
    // SMTP is not fully configured so Google/Strava keep working in environments
    // where the MAIL_* secrets are not yet provisioned.
    if (isMailConfigured()) {
      providers.push(
        Nodemailer({
          id: 'email',
          name: 'Email',
          from: getMailFrom(),
          server: {
            host: getOptionalMailServer(),
            port: Number(getOptionalMailPort()),
            auth: {
              user: getOptionalMailUser(),
              pass: getOptionalMailPassword(),
            },
          },
        }),
      );
    } else {
      logger.warn(
        'getAuthConfig: email provider requested but SMTP is not fully configured; skipping magic-link provider.',
      );
    }
  }

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
        },
        async authorize(credentials) {
          const schema = z.object({
            userId: z.string().default('test-user'),
            name: z.string().default('Test User'),
            email: z.string().default('test@example.com'),
          });

          const parsed = schema.safeParse(credentials);
          if (!parsed.success) return null;

          const data = parsed.data;

          let resolvedId = data.userId;
          if (data.userId.startsWith('slack-') || data.userId.startsWith('U')) {
            try {
              resolvedId = await resolveUserIdFromSlackId(firestore, {
                id: data.userId,
                name: data.name,
                email: data.email,
              });
            } catch (err) {
              logger.error(
                'Failed to resolve UUID in credentials authorize:',
                err,
              );
              throw err;
            }
          }

          const isAdmin =
            data.userId === 'slack-123' ||
            data.userId === 'admin-123' ||
            data.email.startsWith('admin@') ||
            isSlackAdmin(data.userId) ||
            isAdminEmail(data.email);

          return {
            id: resolvedId,
            name: data.name,
            email: data.email,
            slack: {
              id: data.userId, // mock original Slack ID
              isAdmin,
            },
            waiverVersionAccepted: REQUIRED_WAIVER_VERSION,
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
    async createUser(user) {
      if (!firestoreAdapter.createUser) {
        throw new Error('FirestoreAdapter does not support createUser');
      }
      const createdUser = await firestoreAdapter.createUser(user);
      if (user.email && isAdminEmail(user.email)) {
        logger.info(
          `createUser: Bootstrapping admin status for new user ${user.email}`,
        );
        await firestore
          .collection('services/authjs/users')
          .doc(createdUser.id)
          .set(
            {
              slack: {
                id: '',
                isAdmin: true,
              },
            },
            { merge: true },
          );
        if (createdUser.slack) {
          createdUser.slack.isAdmin = true;
        } else {
          createdUser.slack = { id: '', isAdmin: true };
        }
      }
      return createdUser;
    },
    async linkAccount(account) {
      // Force deterministic Account ID for easy lookups
      const id = getAuthJsAccountId(account.userId, account.provider);
      const { id: _removedId, ...accountData } = account as Record<
        string,
        unknown
      >;
      await firestore
        .collection('services/authjs/accounts')
        .doc(id)
        .set(accountData);
      return { ...account, id } as typeof account;
    },
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
        const appUser = user as AppUser | undefined;
        const appToken = token as AppJWT;
        if (appUser?.slack) {
          appToken.slack = appUser.slack;
          appToken.sub = appUser.id;
          appToken.isAdmin =
            appUser.slack.isAdmin || isSlackAdmin(appUser.slack.id);
          if (appUser.waiverVersionAccepted !== undefined) {
            appToken.waiverVersionAccepted = appUser.waiverVersionAccepted;
          }
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
        const appUser = user as AppUser | undefined;
        const appToken = token as AppJWT | undefined;
        // Handle Database strategy (user) or JWT strategy (token)
        const slackData = (appUser?.slack || appToken?.slack) as
          | SlackUser
          | undefined;

        if (session.user) {
          const internalId = appUser?.id || appToken?.sub || '';

          // Use the canonical NextAuth UUID.
          session.user.id = internalId;

          // Populate Onboarding Status
          let hasCompletedProfile = false;
          let isStravaConnected = false;
          let hasActiveMembership = false;

          try {
            const stravaAccountPromise = getAuthJsAccount(
              firestore,
              internalId,
              'strava',
            );

            let riderProfileDoc = await firestore
              .collection('user-profiles')
              .doc(session.user.id)
              .get();

            if (
              !riderProfileDoc.exists &&
              slackData?.id &&
              slackData.id !== session.user.id
            ) {
              riderProfileDoc = await firestore
                .collection('user-profiles')
                .doc(slackData.id)
                .get();
            }

            if (riderProfileDoc.exists) {
              const riderProfile = riderProfileDoc.data();
              hasCompletedProfile =
                !!riderProfile?.contact?.phoneNumber &&
                !!riderProfile?.emergencyContact?.name;
              hasActiveMembership =
                riderProfile?.membership?.status === 'Active';
            }

            const stravaAccount = await stravaAccountPromise;

            isStravaConnected = !!stravaAccount;
          } catch (error) {
            logger.error('Failed to check onboarding status:', error);
          }

          session.user.onboarding = {
            hasAcceptedWaiver:
              (appUser?.waiverVersionAccepted ??
                appToken?.waiverVersionAccepted ??
                0) >= REQUIRED_WAIVER_VERSION,
            hasCompletedProfile,
            isStravaConnected,
            hasActiveMembership,
          };

          if (slackData) {
            // Populate Slack-specific data
            session.user.slack = {
              id: slackData.id,
              teamId: slackData.teamId,
              isAdmin: appToken?.isAdmin ?? isSlackAdmin(slackData.id),
            };
          }

          // Generate Firebase custom token for client-side Firebase authentication
          try {
            const authAdmin = await getFirebaseAuthAdmin();
            session.firebaseToken = await authAdmin.createCustomToken(
              session.user.id,
              {
                isAdmin: session.user.slack?.isAdmin ?? false,
              },
            );
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
      async signIn({ user, account, profile }) {
        // Bootstrap admin status if user's email is in the admin list
        if (user?.id && user?.email && isAdminEmail(user.email)) {
          try {
            const userRef = firestore
              .collection('services/authjs/users')
              .doc(user.id);
            const userDoc = await userRef.get();
            if (userDoc.exists) {
              const userData = userDoc.data();
              if (!userData?.slack?.isAdmin) {
                logger.info(
                  `signIn: Bootstrapping admin status for user ${user.id} (${user.email})`,
                );
                await userRef.set(
                  {
                    slack: {
                      ...(userData?.slack || { id: '' }),
                      isAdmin: true,
                    },
                  },
                  { merge: true },
                );
              }
            }
          } catch (err) {
            logger.error(
              `signIn: Failed to bootstrap admin status for user ${user?.id}:`,
              err,
            );
          }
        }

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

        // Strava returns no email, so gate it by athlete ID instead. When a
        // Strava allowlist is configured, only those athlete IDs may sign in.
        const stravaIdGated =
          account?.provider === 'strava' && !!options?.allowedStravaAthleteIds;
        if (stravaIdGated && !enableTestingHandlers()) {
          const allowedIds = (options?.allowedStravaAthleteIds ?? []).map(
            (id) => id.toString().trim(),
          );
          const athleteId = account?.providerAccountId?.toString().trim();
          if (!athleteId || !allowedIds.includes(athleteId)) {
            logger.warn(
              `Rejecting Strava sign-in: athlete ${athleteId ?? '(unknown)'} is not in the allowed list`,
            );
            return false;
          }
        }

        // Email-bearing providers (google, magic-link email) are gated by the
        // email allowlist. Strava is excluded here since it carries no email and
        // is handled by the athlete-ID gate above.
        if (
          options?.allowedEmails &&
          !enableTestingHandlers() &&
          !stravaIdGated
        ) {
          const allowed = options.allowedEmails.map((e) =>
            e.toLowerCase().trim(),
          );
          const email = user.email?.toLowerCase().trim();
          if (!email || !allowed.includes(email)) {
            logger.warn(
              `Rejecting ${account?.provider ?? 'unknown'} sign-in: ${user.email ?? '(no email)'} is not in the allowed list`,
            );
            return false;
          }
        }

        if (
          requireClubMembership &&
          account?.provider === 'strava' &&
          account.access_token
        ) {
          const expectedClubId = getStravaClubId() || '40422';
          try {
            logger.debug(
              `Validating Strava club membership for club ${expectedClubId}...`,
            );
            const response = await fetch(
              'https://www.strava.com/api/v3/athlete/clubs',
              {
                headers: {
                  Authorization: `Bearer ${account.access_token}`,
                },
              },
            );
            if (response.ok) {
              const clubs = (await response.json()) as {
                id: number | string;
              }[];
              const isMember = clubs.some(
                (club) => club.id.toString() === expectedClubId.toString(),
              );
              const deniedRedirect =
                isOneCake || options?.requireClubMembership
                  ? '/denied'
                  : '/login?error=AccessDenied';
              if (!isMember) {
                logger.warn(
                  `Rejecting Strava sign-in: athlete is not a member of club ${expectedClubId}`,
                );
                // Revoke token immediately
                await fetch('https://www.strava.com/oauth/deauthorize', {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${account.access_token}`,
                  },
                }).catch((e) => logger.error('Failed to deauthorize token', e));
                return `${deniedRedirect}${deniedRedirect.includes('?') ? '&' : '?'}reason=club_membership_required`;
              }
              logger.debug(`Strava club membership validated successfully.`);
            } else {
              logger.error(
                'Failed to fetch Strava clubs for validation',
                await response.text(),
              );
              const deniedRedirect =
                isOneCake || options?.requireClubMembership
                  ? '/denied'
                  : '/login?error=AccessDenied';
              return `${deniedRedirect}${deniedRedirect.includes('?') ? '&' : '?'}reason=club_membership_check_failed`;
            }
          } catch (e) {
            logger.error('Error validating Strava club membership', e);
            const deniedRedirect =
              isOneCake || options?.requireClubMembership
                ? '/denied'
                : '/login?error=AccessDenied';
            return `${deniedRedirect}${deniedRedirect.includes('?') ? '&' : '?'}reason=club_membership_check_failed`;
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
      signIn: enableTestingHandlers() ? undefined : '/login',
      newUser:
        options?.newUserRoute !== undefined
          ? (options.newUserRoute ?? undefined)
          : '/onboarding',
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
