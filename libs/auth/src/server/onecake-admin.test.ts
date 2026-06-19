import { getFirestore } from '@members/firebase-server';
import * as utilServer from '@members/util-server';

import { getAuthConfig } from './config';
import { getAuthJsAccount } from './queries';

// Minimal provider stubs (we only exercise the session callback here).
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
  getFirebaseAuthAdmin: jest.fn().mockResolvedValue({
    createCustomToken: jest.fn().mockResolvedValue('mock-firebase-token'),
  }),
}));

jest.mock('@members/logging', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
  LogLevel: { DEBUG: 'debug' },
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

jest.mock('./queries', () => ({
  ...jest.requireActual('./queries'),
  getAuthJsAccount: jest.fn(),
}));

// OneCake-shaped environment: Strava-only, with an athlete admin allowlist.
jest.mock('@members/util-server', () => ({
  ...jest.requireActual('@members/util-server'),
  enableTestingHandlers: jest.fn().mockReturnValue(false),
  getLogLevel: jest.fn().mockReturnValue('warn'),
  getSlackTeamId: jest.fn().mockReturnValue('test-team-id'),
  isSlackAdmin: jest.fn().mockReturnValue(false),
  isAdminEmail: jest.fn().mockReturnValue(false),
  isOnecakeAdmin: jest.fn(),
  getProjectId: jest.fn().mockReturnValue('onecake'),
  getStravaClubId: jest.fn().mockReturnValue('40422'),
  isMailConfigured: jest.fn().mockReturnValue(false),
}));

const makeFirestore = () => ({
  collection: jest.fn().mockReturnValue({
    doc: jest.fn().mockReturnValue({
      get: jest.fn().mockResolvedValue({ exists: false }),
      set: jest.fn().mockResolvedValue({}),
    }),
  }),
});

const getSessionCallback = async (): Promise<any> => {
  const config = await getAuthConfig();
  return config.callbacks!.session as any;
};

const stravaUser = { id: 'uuid-123', email: undefined };

describe('OneCake Strava-athlete admin gate (session callback)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getFirestore as jest.Mock).mockResolvedValue(makeFirestore());
    (getAuthJsAccount as jest.Mock).mockResolvedValue({
      userId: 'uuid-123',
      provider: 'strava',
      providerAccountId: '66304',
    });
  });

  it('grants admin to a Strava-only user whose athlete ID is allowlisted', async () => {
    (utilServer.isOnecakeAdmin as jest.Mock).mockImplementation(
      (id: string) => id === '66304',
    );

    const session = await getSessionCallback();
    const result = await session({
      session: { user: { id: '' } },
      user: stravaUser,
    });

    expect(utilServer.isOnecakeAdmin).toHaveBeenCalledWith('66304');
    // Admin is surfaced via the platform-agnostic flag, never via Slack.
    expect(result.user.isAdmin).toBe(true);
    expect(result.user.slack).toBeUndefined();
  });

  it('does not grant admin when the athlete ID is not allowlisted', async () => {
    (utilServer.isOnecakeAdmin as jest.Mock).mockReturnValue(false);

    const session = await getSessionCallback();
    const result = await session({
      session: { user: { id: '' } },
      user: stravaUser,
    });

    expect(result.user.isAdmin).toBe(false);
    expect(result.user.slack).toBeUndefined();
  });

  it('grants admin from a persisted user-doc flag (runtime promotion)', async () => {
    // Athlete is NOT on the ONECAKE_ADMINS allowlist...
    (utilServer.isOnecakeAdmin as jest.Mock).mockReturnValue(false);

    const session = await getSessionCallback();
    const result = await session({
      session: { user: { id: '' } },
      // ...but an admin granted them via the admin UI (persisted on the user doc).
      user: { ...stravaUser, isAdmin: true },
    });

    expect(result.user.isAdmin).toBe(true);
    expect(result.user.slack).toBeUndefined();
  });
});
