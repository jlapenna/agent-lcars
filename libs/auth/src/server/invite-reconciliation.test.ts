import { getFirestore } from '@repo/firebase-server';
import { reconcilePendingInviteForEmail } from '@repo/invites';
import { logger } from '@repo/logging';
import { Firestore } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { getAuthConfig } from './config';

// Minimal provider stubs (we only exercise createUser/signIn here).
vi.mock('@auth/firebase-adapter', () => ({
  FirestoreAdapter: vi.fn().mockReturnValue({
    createUser: vi
      .fn()
      .mockImplementation((user) =>
        Promise.resolve({ id: 'user-uuid', ...user }),
      ),
  }),
}));
vi.mock('next-auth/providers/slack', () => ({
  default: vi.fn().mockReturnValue({}),
}));
vi.mock('next-auth/providers/strava', () => ({
  default: vi.fn().mockReturnValue({}),
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

vi.mock('@repo/invites', () => ({
  reconcilePendingInviteForEmail: vi.fn().mockResolvedValue(undefined),
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

vi.mock('@repo/util-server', async (importOriginal) => ({
  ...(await importOriginal()),
  enableTestingHandlers: vi.fn().mockReturnValue(false),
  getLogLevel: vi.fn().mockReturnValue('warn'),
  getSlackTeamId: vi.fn().mockReturnValue('test-team-id'),
  isAdminEmail: vi.fn().mockReturnValue(false),
  getProjectId: vi.fn().mockReturnValue('preem-machine'),
  isMailConfigured: vi.fn().mockReturnValue(false),
}));

const mockedReconcile = reconcilePendingInviteForEmail as Mock;

function makeUserDocFirestore(userDocExists: boolean): Firestore {
  const mockGet = vi.fn().mockResolvedValue({
    exists: userDocExists,
    data: () => ({}),
  });
  const mockSet = vi.fn().mockResolvedValue({});
  const mockDoc = { get: mockGet, set: mockSet };
  const mockCollection = { doc: vi.fn().mockReturnValue(mockDoc) };
  return {
    collection: vi.fn().mockReturnValue(mockCollection),
  } as unknown as Firestore;
}

vi.mock('@repo/firebase-server', () => ({
  getFirestore: vi.fn(),
  getFirebaseAdminApp: vi.fn(),
}));

describe('Pending invite reconciliation on sign-in (#2619)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedReconcile.mockResolvedValue(undefined);
  });

  describe('createUser adapter method (brand-new accounts)', () => {
    it('reconciles a pending invite for the new account email', async () => {
      const firestore = makeUserDocFirestore(true);

      vi.mocked(getFirestore).mockResolvedValue(firestore);

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

      vi.mocked(getFirestore).mockResolvedValue(firestore);

      const config = await getAuthConfig({ providers: ['google', 'email'] });
      const createUserMethod = config.adapter!.createUser as any;

      await createUserMethod({ name: 'No Email User', emailVerified: null });

      expect(mockedReconcile).not.toHaveBeenCalled();
    });

    it('logs and swallows a reconciliation failure instead of failing account creation', async () => {
      const firestore = makeUserDocFirestore(true);

      vi.mocked(getFirestore).mockResolvedValue(firestore);
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

      vi.mocked(getFirestore).mockResolvedValue(firestore);

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

      vi.mocked(getFirestore).mockResolvedValue(firestore);

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

      vi.mocked(getFirestore).mockResolvedValue(firestore);
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
