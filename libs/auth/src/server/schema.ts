import { timestampCodec, zodLooseObject } from '@repo/firestore';
import { z } from 'zod';

/**
 * Auth.js Account Schema (matches the requirements of the Firestore Adapter)
 * @see https://authjs.dev/reference/core/adapters#account
 */
export const AuthJsAccountSchema = zodLooseObject({
  userId: z.string(), // Links to services/authjs/users
  type: z.string(), // e.g. "oauth", "oidc", "email"
  provider: z.string(), // e.g. "slack", "strava"
  providerAccountId: z.string(), // The ID from the provider (e.g. Strava Athlete ID)
  refresh_token: z.string().optional(),
  access_token: z.string().optional(),
  expires_at: z.number().optional(), // Timestamp in seconds (standard for OAuth2)
  token_type: z.string().optional(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
  session_state: z.string().optional(),
});

export type AuthJsAccount = z.infer<typeof AuthJsAccountSchema> & {
  id?: string;
};

/**
 * Auth.js User Schema (as stored in services/authjs/users)
 * Note: This is separate from RiderProfile, but they are linked via IDs or Slack ID.
 */
export const AuthJsUserSchema = zodLooseObject({
  name: z.string().optional(),
  email: z.string().optional(),
  image: z.string().optional(),
  /** Persisted admin grant (OneCake admin UI). Allowlist/Slack admins are
   * derived separately and do not depend on this flag. */
  isAdmin: z.boolean().optional(),
  emailVerified: timestampCodec.nullish(),
  slack: zodLooseObject({
    id: z.string(),
    teamId: z.string().optional(),
    isAdmin: z.boolean().optional(),
  }).optional(),
  waiverAcceptedAt: timestampCodec.nullish(),
  waiverVersionAccepted: z.number().nullish(),
});

export type AuthJsUser = z.infer<typeof AuthJsUserSchema> & {
  id?: string;
};

export const REQUIRED_WAIVER_VERSION = 1;
