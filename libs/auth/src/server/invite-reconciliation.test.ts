import { reconcilePendingInviteForEmail } from '@repo/invites';
import { logger } from '@repo/logging';

import { getAuthConfig } from './config';

// Minimal provider stubs (we only exercise createUser/signIn here).
jest.mock('@auth/firebase-adapter', () => ({
  FirestoreAdapter: jest.fn().mockReturnValue({
    createUser: jest
      .fn()
      .mockImplementation((user) =>
        Promise.resolve({ id: 'user-uuid', ...user }),
      ),
  }),
}));
jest.mock('next-auth/providers/slack', () => jest.fn().mockReturnValue({}));
jest.mock('next-auth/providers/strava', () => jest.fn().mockReturnValue({}));
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

jest.mock('@repo/invites', () => ({
  reconcilePendingInviteForEmail: jest.fn().mockResolvedValue(undefined),
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
  isSlackAdmin: jest.fn().mockReturnValue(false),
}));

jest.mock('@repo/strava', () => ({
  getSecrets: jest
    .fn()
    .mockResolvedValue({ clientId: 'id', clientSecret: 'secret' }),
  isOnecakeAdmin: jest.fn().mockReturnValue(false),
}));

jest.mock('@repo/util/browser', () => ({
  getNextPublicSlackClientId: jest.fn().mockReturnValue('slack-client-id'),
}));

jest.mock('@repo/util-server', () => ({
  ...jest.requireActual('@repo/util-server'),
  enableTestingHandlers: jest.fn().mockReturnValue(false),
  getLogLevel: jest.fn().mockReturnValue('warn'),
  getSlackTeamId: jest.fn().mockReturnValue('test-team-id'),
  isAdminEmail: jest.fn().mockReturnValue(false),
  getProjectId: jest.fn().mockReturnValue('preem-machine'),
  isMailConfigured: jest.fn().mockReturnValue(false),
}));

const mockedReconcile = reconcilePendingInviteForEmail as jest.Mock;

function makeUserDocFirestore(userDocExists: boolean) {
  const mockGet = jest.fn().mockResolvedValue({
    exists: userDocExists,
    data: () => ({}),
  });
  const mockSet = jest.fn().mockResolvedValue({});
  const mockDoc = { get: mockGet, set: mockSet };
  const mockCollection = { doc: jest.fn().mockReturnValue(mockDoc) };
  return {
    collection: jest.fn().mockReturnValue(mockCollection),
  };
}

jest.mock('@repo/firebase-server', () => ({
  getFirestore: jest.fn(),
  getFirebaseAdminApp: jest.fn(),
}));

describe('Pending invite reconciliation on sign-in (#2619)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedReconcile.mockResolvedValue(undefined);
  });

  describe('createUser adapter method (brand-new accounts)', () => {
    it('reconciles a pending invite for the new account email', async () => {
      const firestore = makeUserDocFirestore(true);

      (
        jest.requireMock('@repo/firebase-server') as any
      ).getFirestore.mockResolvedValue(firestore);

      const config = await getAuthConfig({ providers: ['google', 'email'] });
      const createUserMethod = config.adapter!.createUser as any;

      const result = await createUserMethod({
        name: 'New Rider',
        email: 'newrider@example.com',
        emailVerified: null,
      });

      expect(result.id).toBe('user-uuid');
      expect(mockedReconcile).toHaveBeenCalledWith(
        firestore,
        'newrider@example.com',
        'user-uuid',
      );
    });

    it('does not attempt reconciliation when the new account has no email', async () => {
      const firestore = makeUserDocFirestore(true);

      (
        jest.requireMock('@repo/firebase-server') as any
      ).getFirestore.mockResolvedValue(firestore);

      const config = await getAuthConfig({ providers: ['google', 'email'] });
      const createUserMethod = config.adapter!.createUser as any;

      await createUserMethod({ name: 'No Email User', emailVerified: null });

      expect(mockedReconcile).not.toHaveBeenCalled();
    });

    it('logs and swallows a reconciliation failure instead of failing account creation', async () => {
      const firestore = makeUserDocFirestore(true);

      (
        jest.requireMock('@repo/firebase-server') as any
      ).getFirestore.mockResolvedValue(firestore);
      mockedReconcile.mockRejectedValue(new Error('firestore blip'));

      const config = await getAuthConfig({ providers: ['google', 'email'] });
      const createUserMethod = config.adapter!.createUser as any;

      const result = await createUserMethod({
        name: 'New Rider',
        email: 'newrider@example.com',
        emailVerified: null,
      });

      expect(result.id).toBe('user-uuid');
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          'Failed to reconcile pending invite for newrider@example.com',
        ),
        expect.any(Error),
      );
    });
  });

  describe('signIn callback (ordinary sign-in)', () => {
    it('reconciles a pending invite for an existing account on ordinary sign-in', async () => {
      const firestore = makeUserDocFirestore(true);

      (
        jest.requireMock('@repo/firebase-server') as any
      ).getFirestore.mockResolvedValue(firestore);

      const config = await getAuthConfig({ providers: ['google', 'email'] });
      const signInCallback = config.callbacks!.signIn as any;

      const result = await signInCallback({
        user: { id: 'existing-user-uuid', email: 'rider@example.com' },
        account: { provider: 'google' },
        profile: {},
      });

      expect(result).toBe(true);
      expect(mockedReconcile).toHaveBeenCalledWith(
        firestore,
        'rider@example.com',
        'existing-user-uuid',
      );
    });

    it('does not reconcile for a brand-new account (user doc does not exist yet)', async () => {
      // signIn runs *before* adapter.createUser in the Auth.js OAuth flow, so
      // a new user's doc — and canonical id — don't exist yet at this point.
      const firestore = makeUserDocFirestore(false);

      (
        jest.requireMock('@repo/firebase-server') as any
      ).getFirestore.mockResolvedValue(firestore);

      const config = await getAuthConfig({ providers: ['google', 'email'] });
      const signInCallback = config.callbacks!.signIn as any;

      const result = await signInCallback({
        user: { id: 'raw-provider-id', email: 'newrider@example.com' },
        account: { provider: 'google' },
        profile: {},
      });

      expect(result).toBe(true);
      expect(mockedReconcile).not.toHaveBeenCalled();
    });

    it('logs and swallows a reconciliation failure instead of rejecting sign-in', async () => {
      const firestore = makeUserDocFirestore(true);

      (
        jest.requireMock('@repo/firebase-server') as any
      ).getFirestore.mockResolvedValue(firestore);
      mockedReconcile.mockRejectedValue(new Error('firestore blip'));

      const config = await getAuthConfig({ providers: ['google', 'email'] });
      const signInCallback = config.callbacks!.signIn as any;

      const result = await signInCallback({
        user: { id: 'existing-user-uuid', email: 'rider@example.com' },
        account: { provider: 'google' },
        profile: {},
      });

      expect(result).toBe(true);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          'Failed to reconcile pending invite for rider@example.com',
        ),
        expect.any(Error),
      );
    });
  });
});
