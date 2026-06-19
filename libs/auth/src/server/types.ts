/**
 * Type augmentation for Auth.js to extend the built-in session and JWT types
 * with custom fields specific to this application.
 *
 * These type extensions ensure TypeScript knows about our custom fields
 * throughout the Auth.js flow (session, JWT, user, etc.).
 *
 * Note: In Auth.js v5, JWT types are part of the main 'next-auth' module,
 * not a separate 'next-auth/jwt' module.
 *
 * @see https://authjs.dev/getting-started/typescript
 */

import type { DefaultSession } from 'next-auth';

/**
 * Represents a Slack user within the application context.
 */
export interface SlackUser {
  /** Slack user ID (e.g., 'U12345') */
  id: string;
  /** Slack team/workspace ID */
  teamId?: string;
  /** Whether the user has admin privileges in the Slack workspace */
  isAdmin: boolean;
}

/**
 * Extend the built-in types with custom fields.
 * @see https://authjs.dev/getting-started/typescript
 */
declare module 'next-auth' {
  /**
   * Extended Session type with custom fields.
   */
  interface Session {
    /** Firebase custom token for client-side Firebase authentication */
    firebaseToken?: string;
    user: {
      /** Internal database user ID */
      id: string;
      /**
       * Canonical, platform-agnostic admin flag. This is the field every
       * authorization consumer should read. Sourced in the session callback
       * from whichever admin mechanism applies to the signed-in identity:
       * Slack workspace admin (web/bot), OneCake Strava-athlete allowlist
       * (ONECAKE_ADMINS), or admin email (ADMIN_EMAILS). Do NOT read admin
       * status off `slack` — Slack is just one identity provider.
       */
      isAdmin: boolean;
      /** Slack-specific identity data (web/bot). Not an authorization source. */
      slack?: SlackUser;
      /** Onboarding and compliance gates */
      onboarding: {
        hasAcceptedWaiver: boolean;
        hasCompletedProfile: boolean;
        isStravaConnected: boolean;
        hasActiveMembership: boolean;
      };
    } & DefaultSession['user'];
  }

  /**
   * Extended User type.
   */
  interface User {
    /** Slack-specific user data */
    slack?: SlackUser;
  }

  /**
   * Extend the JWT type to include custom fields.
   */
  interface JWT {
    /** Slack-specific user data */
    slack?: SlackUser;
  }
}
