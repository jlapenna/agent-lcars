import { getFirestore } from '@repo/firebase-server';
import * as utilServer from '@repo/util-server';
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
  isOnecakeAdmin: vi.fn().mockReturnValue(false),
}));

vi.mock('@repo/util/browser', () => ({
  getNextPublicSlackClientId: vi.fn().mockReturnValue('slack-client-id'),
}));

vi.mock('./queries', async (importOriginal) => ({
  ...(await importOriginal()),
  getAuthJsAccount: vi.fn(),
}));

// Primes-shaped environment: Google/magic-link sign-in, database sessions,
// no Slack workspace admins, no Strava athlete allowlist.
vi.mock('@repo/util-server', async (importOriginal) => ({
  ...(await importOriginal()),
  enableTestingHandlers: vi.fn().mockReturnValue(false),
  getLogLevel: vi.fn().mockReturnValue('warn'),
  getSlackTeamId: vi.fn().mockReturnValue('test-team-id'),
  isAdminEmail: vi.fn().mockReturnValue(false),
  getProjectId: vi.fn().mockReturnValue('preem-machine'),
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
  const config = await getAuthConfig({ providers: ['google', 'email'] });
  return config.callbacks!.session as any;
};

describe('Email-based admin (session callback, database sessions)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getFirestore as Mock).mockResolvedValue(makeFirestore());
    // No Strava account linked.
    (getAuthJsAccount as Mock).mockResolvedValue(null);
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
    (utilServer.isAdminEmail as Mock).mockImplementation(
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
