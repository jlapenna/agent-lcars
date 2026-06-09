import { getFirestore } from '@members/firebase-server';
import { logger } from '@members/logging';
import * as utilServer from '@members/util-server';

import { getAuthConfig } from './config';

// Identifiable provider stubs so we can assert which providers were configured.
jest.mock('@auth/firebase-adapter', () => ({
  FirestoreAdapter: jest.fn().mockReturnValue({}),
}));
jest.mock('next-auth/providers/slack', () =>
  jest.fn().mockReturnValue({ id: 'slack' }),
);
jest.mock('next-auth/providers/strava', () =>
  jest.fn().mockReturnValue({ id: 'strava' }),
);
jest.mock('next-auth/providers/google', () =>
  jest.fn().mockReturnValue({ id: 'google' }),
);
jest.mock('next-auth/providers/nodemailer', () =>
  jest.fn().mockImplementation((options) => ({ ...options })),
);
jest.mock('next-auth/providers/credentials', () =>
  jest.fn().mockImplementation((options) => options),
);

jest.mock('@members/service-auth', () => ({
  getAuthSecret: jest.fn().mockResolvedValue('test-secret'),
}));

jest.mock('@members/firebase-server', () => ({
  getFirestore: jest.fn(),
  getFirebaseAdminApp: jest.fn(),
}));

jest.mock('@members/logging', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
  LogLevel: {
    DEBUG: 'debug',
  },
}));

jest.mock('@members/slack', () => ({
  getSecrets: jest.fn().mockResolvedValue({ clientSecret: 'slack-secret' }),
}));

jest.mock('@members/strava', () => ({
  getSecrets: jest
    .fn()
    .mockResolvedValue({ clientId: 'id', clientSecret: 'secret' }),
}));

jest.mock('@members/util/browser', () => ({
  getNextPublicSlackClientId: jest.fn().mockReturnValue('slack-client-id'),
}));

// Default: gating active (enableTestingHandlers === false) and SMTP configured.
jest.mock('@members/util-server', () => ({
  ...jest.requireActual('@members/util-server'),
  enableTestingHandlers: jest.fn().mockReturnValue(false),
  getLogLevel: jest.fn().mockReturnValue('warn'),
  getSlackTeamId: jest.fn().mockReturnValue('test-team-id'),
  isSlackAdmin: jest.fn().mockReturnValue(false),
  isAdminEmail: jest.fn().mockReturnValue(false),
  getProjectId: jest.fn().mockReturnValue('demo-project'),
  getGoogleClientId: jest.fn().mockReturnValue('google-id'),
  getGoogleClientSecret: jest.fn().mockReturnValue('google-secret'),
  getStravaClubId: jest.fn().mockReturnValue('40422'),
  isMailConfigured: jest.fn().mockReturnValue(true),
  getMailFrom: jest.fn().mockReturnValue('bot@supersprinkles.racing'),
  getOptionalMailServer: jest.fn().mockReturnValue('smtp-relay.gmail.com'),
  getOptionalMailPort: jest.fn().mockReturnValue('587'),
  getOptionalMailUser: jest.fn().mockReturnValue('bot@supersprinkles.racing'),
  getOptionalMailPassword: jest.fn().mockReturnValue('secret'),
}));

const makeFirestore = () => ({
  collection: jest.fn().mockReturnValue({
    doc: jest.fn().mockReturnValue({
      get: jest.fn().mockResolvedValue({ exists: false }),
      set: jest.fn().mockResolvedValue({}),
    }),
  }),
});

const getSignIn = async (options?: any): Promise<any> => {
  const config = await getAuthConfig(options);

  return config.callbacks!.signIn as any;
};

describe('getAuthConfig allowlist gating', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getFirestore as jest.Mock).mockResolvedValue(makeFirestore());
    (utilServer.enableTestingHandlers as jest.Mock).mockReturnValue(false);
    (utilServer.isMailConfigured as jest.Mock).mockReturnValue(true);
  });

  describe('provider configuration', () => {
    it('adds the email (magic-link) provider when SMTP is configured', async () => {
      const config = await getAuthConfig({ providers: ['email'] });
      const email = config.providers.find((p: any) => p.id === 'email');
      expect(email).toBeDefined();
    });

    it('omits the email provider and warns when SMTP is not configured', async () => {
      (utilServer.isMailConfigured as jest.Mock).mockReturnValue(false);
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
      (utilServer.enableTestingHandlers as jest.Mock).mockReturnValue(true);
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
