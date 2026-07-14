import { getFirestore } from '@repo/firebase-server';
import { logger } from '@repo/logging';
import * as utilServer from '@repo/util-server';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { getAuthConfig } from './config';

// Identifiable provider stubs so we can assert which providers were configured.
vi.mock('@auth/firebase-adapter', () => ({
  FirestoreAdapter: vi.fn().mockReturnValue({}),
}));
vi.mock('next-auth/providers/slack', () => ({
  default: vi.fn().mockReturnValue({ id: 'slack' }),
}));
vi.mock('next-auth/providers/strava', () => ({
  default: vi.fn().mockReturnValue({ id: 'strava' }),
}));
vi.mock('next-auth/providers/google', () => ({
  default: vi.fn().mockReturnValue({ id: 'google' }),
}));
vi.mock('next-auth/providers/nodemailer', () => ({
  default: vi.fn().mockImplementation((options) => ({ ...options })),
}));
vi.mock('next-auth/providers/credentials', () => ({
  default: vi.fn().mockImplementation((options) => options),
}));

vi.mock('@repo/service-auth', () => ({
  getAuthSecret: vi.fn().mockResolvedValue('test-secret'),
}));

vi.mock('@repo/firebase-server', () => ({
  getFirestore: vi.fn(),
  getFirebaseAdminApp: vi.fn(),
}));

vi.mock('@repo/logging', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
  LogLevel: {
    DEBUG: 'debug',
  },
}));

vi.mock('@repo/slack', () => ({
  getSecrets: vi.fn().mockResolvedValue({ clientSecret: 'slack-secret' }),
  isSlackAdmin: vi.fn().mockReturnValue(false),
}));

vi.mock('@repo/strava', () => ({
  getSecrets: vi
    .fn()
    .mockResolvedValue({ clientId: 'id', clientSecret: 'secret' }),
  isOnecakeAdmin: vi.fn().mockReturnValue(false),
}));

vi.mock('@repo/util/browser', () => ({
  getNextPublicSlackClientId: vi.fn().mockReturnValue('slack-client-id'),
}));

// Default: gating active (enableTestingHandlers === false) and SMTP configured.
vi.mock('@repo/util-server', async (importOriginal) => ({
  ...(await importOriginal()),
  enableTestingHandlers: vi.fn().mockReturnValue(false),
  getLogLevel: vi.fn().mockReturnValue('warn'),
  getSlackTeamId: vi.fn().mockReturnValue('test-team-id'),
  isAdminEmail: vi.fn().mockReturnValue(false),
  getProjectId: vi.fn().mockReturnValue('demo-project'),
  getGoogleClientId: vi.fn().mockReturnValue('google-id'),
  getGoogleClientSecret: vi.fn().mockReturnValue('google-secret'),
  getStravaClubId: vi.fn().mockReturnValue('40422'),
  isMailConfigured: vi.fn().mockReturnValue(true),
  getMailFrom: vi.fn().mockReturnValue('bot@supersprinkles.racing'),
  getOptionalMailServer: vi.fn().mockReturnValue('smtp-relay.gmail.com'),
  getOptionalMailPort: vi.fn().mockReturnValue('587'),
  getOptionalMailUser: vi.fn().mockReturnValue('bot@supersprinkles.racing'),
  getOptionalMailPassword: vi.fn().mockReturnValue('secret'),
}));

const makeFirestore = () => ({
  collection: vi.fn().mockReturnValue({
    doc: vi.fn().mockReturnValue({
      get: vi.fn().mockResolvedValue({ exists: false }),
      set: vi.fn().mockResolvedValue({}),
    }),
  }),
});

const getSignIn = async (options?: any): Promise<any> => {
  const config = await getAuthConfig(options);

  return config.callbacks!.signIn as any;
};

describe('getAuthConfig allowlist gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getFirestore as Mock).mockResolvedValue(makeFirestore());
    (utilServer.enableTestingHandlers as Mock).mockReturnValue(false);
    (utilServer.isMailConfigured as Mock).mockReturnValue(true);
  });

  describe('provider configuration', () => {
    it('adds the email (magic-link) provider when SMTP is configured', async () => {
      const config = await getAuthConfig({ providers: ['email'] });
      const email = config.providers.find((p: any) => p.id === 'email');
      expect(email).toBeDefined();
    });

    it('omits the email provider and warns when SMTP is not configured', async () => {
      (utilServer.isMailConfigured as Mock).mockReturnValue(false);
      const config = await getAuthConfig({ providers: ['email'] });
      const email = config.providers.find((p: any) => p.id === 'email');
      expect(email).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('SMTP is not fully configured'),
      );
    });

    it('configures google, strava, and email together', async () => {
      const config = await getAuthConfig({
        providers: ['google', 'strava', 'email'],
      });

      const ids = config.providers.map((p: any) => p.id);
      expect(ids).toEqual(
        expect.arrayContaining(['google', 'strava', 'email']),
      );
    });
  });

  describe('Strava athlete-ID allowlist', () => {
    it('rejects a Strava athlete not in the allowlist', async () => {
      const signIn = await getSignIn({
        allowedStravaAthleteIds: ['111', '222'],
      });
      const result = await signIn({
        user: { id: 'u1', email: null },
        account: { provider: 'strava', providerAccountId: '999' },
        profile: {},
      });
      expect(result).toBe(false);
    });

    it('allows a Strava athlete in the allowlist', async () => {
      const signIn = await getSignIn({
        allowedStravaAthleteIds: ['111', '222'],
      });
      const result = await signIn({
        user: { id: 'u1', email: null },
        account: { provider: 'strava', providerAccountId: '222' },
        profile: {},
      });
      expect(result).toBe(true);
    });

    it('tolerates numeric athlete IDs and surrounding whitespace', async () => {
      const signIn = await getSignIn({
        allowedStravaAthleteIds: [' 222 '],
      });
      const result = await signIn({
        user: { id: 'u1', email: null },
        // providerAccountId arrives as a number from some flows.
        account: { provider: 'strava', providerAccountId: 222 },
        profile: {},
      });
      expect(result).toBe(true);
    });

    it('rejects Strava when the allowlist is set but the athlete ID is missing', async () => {
      const signIn = await getSignIn({
        allowedStravaAthleteIds: ['111'],
      });
      const result = await signIn({
        user: { id: 'u1', email: null },
        account: { provider: 'strava', providerAccountId: undefined },
        profile: {},
      });
      expect(result).toBe(false);
    });
  });

  describe('email allowlist', () => {
    it('rejects a Google sign-in whose email is not allowed', async () => {
      const signIn = await getSignIn({ allowedEmails: ['ok@example.com'] });
      const result = await signIn({
        user: { id: 'u1', email: 'nope@example.com' },
        account: { provider: 'google' },
        profile: {},
      });
      expect(result).toBe(false);
    });

    it('allows a Google sign-in whose email is allowed (case-insensitive)', async () => {
      const signIn = await getSignIn({ allowedEmails: ['ok@example.com'] });
      const result = await signIn({
        user: { id: 'u1', email: 'OK@Example.com' },
        account: { provider: 'google' },
        profile: {},
      });
      expect(result).toBe(true);
    });

    it('rejects a magic-link email sign-in not in the allowlist', async () => {
      const signIn = await getSignIn({ allowedEmails: ['ok@example.com'] });
      const result = await signIn({
        user: { id: 'u1', email: 'nope@example.com' },
        account: { provider: 'email' },
        profile: {},
      });
      expect(result).toBe(false);
    });

    it('does not gate when no allowedEmails is provided', async () => {
      const signIn = await getSignIn({});
      const result = await signIn({
        user: { id: 'u1', email: 'anyone@example.com' },
        account: { provider: 'google' },
        profile: {},
      });
      expect(result).toBe(true);
    });

    it('does not subject Strava to the email gate (gated by athlete ID instead)', async () => {
      // Strava carries no email; with both allowlists set, an allowed athlete
      // must pass even though their email is null.
      const signIn = await getSignIn({
        allowedEmails: ['ok@example.com'],
        allowedStravaAthleteIds: ['222'],
      });
      const result = await signIn({
        user: { id: 'u1', email: null },
        account: { provider: 'strava', providerAccountId: '222' },
        profile: {},
      });
      expect(result).toBe(true);
    });
  });

  describe('testing-handlers bypass', () => {
    it('bypasses both allowlists when testing handlers are enabled', async () => {
      (utilServer.enableTestingHandlers as Mock).mockReturnValue(true);
      const signIn = await getSignIn({
        allowedEmails: ['ok@example.com'],
        allowedStravaAthleteIds: ['111'],
      });
      const result = await signIn({
        user: { id: 'u1', email: 'nope@example.com' },
        account: { provider: 'strava', providerAccountId: '999' },
        profile: {},
      });
      expect(result).toBe(true);
    });
  });
});
