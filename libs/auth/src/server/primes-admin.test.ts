import { getFirestore } from '@repo/firebase-server';
import * as utilServer from '@repo/util-server';

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

jest.mock('@repo/service-auth', () => ({
  getAuthSecret: jest.fn().mockResolvedValue('test-secret'),
}));

jest.mock('@repo/firebase-server', () => ({
  getFirestore: jest.fn(),
  getFirebaseAdminApp: jest.fn(),
  getFirebaseAuthAdmin: jest.fn().mockResolvedValue({
    createCustomToken: jest.fn().mockResolvedValue('mock-firebase-token'),
  }),
}));

jest.mock('@repo/logging', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
  LogLevel: { DEBUG: 'debug' },
}));

jest.mock('@repo/slack', () => ({
  getSecrets: jest.fn().mockResolvedValue({ clientSecret: 'slack-secret' }),
}));

jest.mock('@repo/strava', () => ({
  getSecrets: jest
    .fn()
    .mockResolvedValue({ clientId: 'id', clientSecret: 'secret' }),
}));

jest.mock('@repo/util/browser', () => ({
  getNextPublicSlackClientId: jest.fn().mockReturnValue('slack-client-id'),
}));

jest.mock('./queries', () => ({
  ...jest.requireActual('./queries'),
  getAuthJsAccount: jest.fn(),
}));

// Primes-shaped environment: Google/magic-link sign-in, database sessions,
// no Slack workspace admins, no Strava athlete allowlist.
jest.mock('@repo/util-server', () => ({
  ...jest.requireActual('@repo/util-server'),
  enableTestingHandlers: jest.fn().mockReturnValue(false),
  getLogLevel: jest.fn().mockReturnValue('warn'),
  getSlackTeamId: jest.fn().mockReturnValue('test-team-id'),
  isSlackAdmin: jest.fn().mockReturnValue(false),
  isAdminEmail: jest.fn().mockReturnValue(false),
  isOnecakeAdmin: jest.fn().mockReturnValue(false),
  getProjectId: jest.fn().mockReturnValue('preem-machine'),
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
  const config = await getAuthConfig({ providers: ['google', 'email'] });
  return config.callbacks!.session as any;
};

describe('Email-based admin (session callback, database sessions)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getFirestore as jest.Mock).mockResolvedValue(makeFirestore());
    // No Strava account linked.
    (getAuthJsAccount as jest.Mock).mockResolvedValue(null);
  });

  it('grants admin from the persisted admin-email bootstrap (slack.isAdmin)', async () => {
    // createUser/signIn bootstrap persists `slack: { id: '', isAdmin: true }`
    // for admin emails. Database sessions have no JWT, so the session
    // callback must read the grant off the user doc directly.
    const session = await getSessionCallback();
    const result = await session({
      session: { user: { id: '', email: 'admin@example.com' } },
      user: {
        id: 'uuid-123',
        email: 'admin@example.com',
        slack: { id: '', isAdmin: true },
      },
    });

    expect(result.user.isAdmin).toBe(true);
  });

  it('grants admin from a live ADMIN_EMAILS match without persisted state', async () => {
    (utilServer.isAdminEmail as jest.Mock).mockImplementation(
      (email: string) => email === 'admin@example.com',
    );

    const session = await getSessionCallback();
    const result = await session({
      session: { user: { id: '', email: 'admin@example.com' } },
      user: { id: 'uuid-123', email: 'admin@example.com' },
    });

    expect(utilServer.isAdminEmail).toHaveBeenCalledWith('admin@example.com');
    expect(result.user.isAdmin).toBe(true);
  });

  it('does not grant admin to a regular email user', async () => {
    const session = await getSessionCallback();
    const result = await session({
      session: { user: { id: '', email: 'rider@example.com' } },
      user: { id: 'uuid-456', email: 'rider@example.com' },
    });

    expect(result.user.isAdmin).toBe(false);
  });

  it('does not consult the email allowlist when the session has no email', async () => {
    const session = await getSessionCallback();
    const result = await session({
      session: { user: { id: '' } },
      user: { id: 'uuid-789' },
    });

    expect(utilServer.isAdminEmail).not.toHaveBeenCalled();
    expect(result.user.isAdmin).toBe(false);
  });
});
