import { getFirestore } from '@repo/firebase-server';
import * as strava from '@repo/strava';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { getAuthConfig } from './config';
import { getAuthJsAccount } from './queries';

// Minimal provider stubs (we only exercise the session callback here).
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
  getFirebaseAuthAdmin: vi.fn().mockResolvedValue({
    createCustomToken: vi.fn().mockResolvedValue('mock-firebase-token'),
  }),
}));

vi.mock('@repo/logging', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
  LogLevel: { DEBUG: 'debug' },
}));

vi.mock('@repo/slack', () => ({
  getSecrets: vi.fn().mockResolvedValue({ clientSecret: 'slack-secret' }),
  isSlackAdmin: vi.fn().mockReturnValue(false),
}));

vi.mock('@repo/strava', () => ({
  getSecrets: vi
    .fn()
    .mockResolvedValue({ clientId: 'id', clientSecret: 'secret' }),
  isOnecakeAdmin: vi.fn(),
}));

vi.mock('@repo/util/browser', () => ({
  getNextPublicSlackClientId: vi.fn().mockReturnValue('slack-client-id'),
}));

vi.mock('./queries', async (importOriginal) => ({
  ...(await importOriginal()),
  getAuthJsAccount: vi.fn(),
}));

// OneCake-shaped environment: Strava-only, with an athlete admin allowlist.
vi.mock('@repo/util-server', async (importOriginal) => ({
  ...(await importOriginal()),
  enableTestingHandlers: vi.fn().mockReturnValue(false),
  getLogLevel: vi.fn().mockReturnValue('warn'),
  getSlackTeamId: vi.fn().mockReturnValue('test-team-id'),
  isAdminEmail: vi.fn().mockReturnValue(false),
  getProjectId: vi.fn().mockReturnValue('onecake'),
  getStravaClubId: vi.fn().mockReturnValue('40422'),
  isMailConfigured: vi.fn().mockReturnValue(false),
}));

const makeFirestore = () => ({
  collection: vi.fn().mockReturnValue({
    doc: vi.fn().mockReturnValue({
      get: vi.fn().mockResolvedValue({ exists: false }),
      set: vi.fn().mockResolvedValue({}),
      // getRiderProfileRef() attaches a converter before .get()/.set(); return
      // the same doc mock so the chained calls still work.
      withConverter: vi.fn().mockReturnThis(),
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
    vi.clearAllMocks();
    (getFirestore as Mock).mockResolvedValue(makeFirestore());
    (getAuthJsAccount as Mock).mockResolvedValue({
      userId: 'uuid-123',
      provider: 'strava',
      providerAccountId: '66304',
    });
  });

  it('grants admin to a Strava-only user whose athlete ID is allowlisted', async () => {
    (strava.isOnecakeAdmin as Mock).mockImplementation(
      (id: string) => id === '66304',
    );

    const session = await getSessionCallback();
    const result = await session({
      session: { user: { id: '' } },
      user: stravaUser,
    });

    expect(strava.isOnecakeAdmin).toHaveBeenCalledWith('66304');
    // Admin is surfaced via the platform-agnostic flag, never via Slack.
    expect(result.user.isAdmin).toBe(true);
    expect(result.user.slack).toBeUndefined();
  });

  it('does not grant admin when the athlete ID is not allowlisted', async () => {
    (strava.isOnecakeAdmin as Mock).mockReturnValue(false);

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
    (strava.isOnecakeAdmin as Mock).mockReturnValue(false);

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
