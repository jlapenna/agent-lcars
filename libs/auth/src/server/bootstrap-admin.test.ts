import { getFirestore } from '@repo/firebase-server';
import { logger } from '@repo/logging';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAuthConfig } from './config';

// Mock dependencies
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
vi.mock('next-auth/providers/credentials', () => ({
  default: vi.fn().mockImplementation((options) => options),
}));

vi.mock('@repo/service-auth', () => ({
  getAuthSecret: vi.fn().mockResolvedValue('test-secret'),
}));

vi.mock('@repo/firebase-server', () => ({
  getFirestore: vi.fn().mockResolvedValue({
    collection: vi.fn().mockImplementation((name) => {
      if (name === 'services/authjs/users') {
        return {
          doc: vi.fn().mockImplementation((_id) => ({
            get: vi.fn().mockImplementation(() => {
              // We'll dynamically override this mock in tests using Jest spy/mock on the returned promise
              return Promise.resolve({
                exists: true,
                data: () => ({
                  slack: {
                    id: 'U12345',
                    isAdmin: false,
                  },
                }),
              });
            }),
            set: vi.fn().mockResolvedValue({}),
          })),
        };
      }
      return {
        doc: vi.fn().mockReturnValue({
          get: vi.fn().mockResolvedValue({ exists: false }),
          set: vi.fn().mockResolvedValue({}),
        }),
      };
    }),
  }),
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
  getBotDetails: vi
    .fn()
    .mockResolvedValue({ teamId: 'team-id', appId: 'app-id' }),
  isSlackAdmin: vi.fn().mockReturnValue(false),
}));

vi.mock('@repo/strava', () => ({
  getSecrets: vi.fn().mockResolvedValue({
    clientId: 'id',
    clientSecret: 'secret',
    redirectUri: 'uri',
  }),
  isOnecakeAdmin: vi.fn().mockReturnValue(false),
}));

vi.mock('@repo/util-server', async (importOriginal) => ({
  ...(await importOriginal()),
  enableTestingHandlers: vi.fn().mockReturnValue(true),
  getLogLevel: vi.fn().mockReturnValue('debug'),
  getSlackTeamId: vi.fn().mockReturnValue('test-team-id'),
  isAdminEmail: vi.fn().mockImplementation((email: string) => {
    return [
      'jlapenna@supersprinkles.racing',
      'haley@supersprinkles.racing',
      'liz@supersprinkles.racing',
    ].includes(email);
  }),
  getProjectId: vi.fn().mockReturnValue('demo-project'),
}));

vi.mock('@repo/util/browser', () => ({
  getNextPublicSlackClientId: vi.fn().mockReturnValue('slack-client-id'),
}));

describe('Admin Bootstrapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Credentials Provider', () => {
    it('should assign isAdmin: true if the email is in the admin email list', async () => {
      const config = await getAuthConfig();
      const credentialsProvider = config.providers.find(
        (p: any) => p.id === 'credentials',
      ) as any;

      expect(credentialsProvider).toBeDefined();

      const user = await credentialsProvider.authorize({
        userId: 'some-user',
        name: 'Haley Admin',
        email: 'haley@supersprinkles.racing',
      });

      expect(user).toBeDefined();
      expect(user.slack.isAdmin).toBe(true);
    });

    it('should assign isAdmin: false if the email is not in the admin email list', async () => {
      const config = await getAuthConfig();
      const credentialsProvider = config.providers.find(
        (p: any) => p.id === 'credentials',
      ) as any;

      const user = await credentialsProvider.authorize({
        userId: 'some-user',
        name: 'Normal User',
        email: 'normal@example.com',
      });

      expect(user).toBeDefined();
      expect(user.slack.isAdmin).toBe(false);
    });
  });

  describe('signIn Callback', () => {
    it('should bootstrap user admin state in Firestore if they log in with an admin email and do not have admin bit set', async () => {
      const config = await getAuthConfig();
      const signInCallback = config.callbacks!.signIn as any;

      const mockGet = vi.fn().mockResolvedValue({
        exists: true,
        data: () => ({
          slack: {
            id: 'U12345',
            isAdmin: false,
          },
        }),
      });
      const mockSet = vi.fn().mockResolvedValue({});
      const mockDoc = { get: mockGet, set: mockSet };
      const mockCollection = { doc: vi.fn().mockReturnValue(mockDoc) };
      const mockFirestore = await getFirestore();
      mockFirestore.collection = vi.fn().mockReturnValue(mockCollection);

      const user = {
        id: 'user-uuid',
        email: 'liz@supersprinkles.racing',
      };

      const result = await signInCallback({
        user,
        account: { provider: 'strava' },
        profile: {},
      });

      expect(result).toBe(true);
      expect(mockFirestore.collection).toHaveBeenCalledWith(
        'services/authjs/users',
      );
      expect(mockCollection.doc).toHaveBeenCalledWith('user-uuid');
      expect(mockGet).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith(
        {
          slack: {
            id: 'U12345',
            isAdmin: true,
          },
        },
        { merge: true },
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining(
          'Bootstrapping admin status for user user-uuid',
        ),
      );
    });

    it('should not write to Firestore if the user logging in is already an admin', async () => {
      const config = await getAuthConfig();
      const signInCallback = config.callbacks!.signIn as any;

      const mockGet = vi.fn().mockResolvedValue({
        exists: true,
        data: () => ({
          slack: {
            id: 'U12345',
            isAdmin: true,
          },
        }),
      });
      const mockSet = vi.fn().mockResolvedValue({});
      const mockDoc = { get: mockGet, set: mockSet };
      const mockCollection = { doc: vi.fn().mockReturnValue(mockDoc) };
      const mockFirestore = await getFirestore();
      mockFirestore.collection = vi.fn().mockReturnValue(mockCollection);

      const user = {
        id: 'user-uuid',
        email: 'liz@supersprinkles.racing',
      };

      const result = await signInCallback({
        user,
        account: { provider: 'strava' },
        profile: {},
      });

      expect(result).toBe(true);
      expect(mockSet).not.toHaveBeenCalled();
    });

    it('should not write to Firestore if the user logging in does not have an admin email', async () => {
      const config = await getAuthConfig();
      const signInCallback = config.callbacks!.signIn as any;

      // #2619: the signIn callback now also checks whether this user's doc
      // exists (to gate pending-invite reconciliation) regardless of admin
      // email, so `mockGet` is exercised here even though this user isn't an
      // admin. No pending invite matches in this test's default `@repo/invites`
      // mock (see invite-reconciliation.test.ts for that behavior).
      const mockGet = vi.fn().mockResolvedValue({ exists: false });
      const mockSet = vi.fn();
      const mockDoc = { get: mockGet, set: mockSet };
      const mockCollection = { doc: vi.fn().mockReturnValue(mockDoc) };
      const mockFirestore = await getFirestore();
      mockFirestore.collection = vi.fn().mockReturnValue(mockCollection);

      const user = {
        id: 'user-uuid',
        email: 'normal@example.com',
      };

      const result = await signInCallback({
        user,
        account: { provider: 'strava' },
        profile: {},
      });

      expect(result).toBe(true);
      expect(mockGet).toHaveBeenCalled();
      expect(mockSet).not.toHaveBeenCalled();
    });
  });

  describe('createUser Adapter Method', () => {
    it('should bootstrap user admin state in Firestore and returned user object if registering with an admin email', async () => {
      const config = await getAuthConfig();
      const createUserMethod = config.adapter!.createUser as any;

      const mockSet = vi.fn().mockResolvedValue({});
      const mockDoc = { set: mockSet };
      const mockCollection = { doc: vi.fn().mockReturnValue(mockDoc) };
      const mockFirestore = await getFirestore();
      mockFirestore.collection = vi.fn().mockReturnValue(mockCollection);

      const user = {
        name: 'Haley Admin',
        email: 'haley@supersprinkles.racing',
        emailVerified: null,
      };

      const result = await createUserMethod(user);

      expect(result).toBeDefined();
      expect(result.id).toBe('user-uuid');
      expect(result.slack).toBeDefined();
      expect(result.slack.isAdmin).toBe(true);

      expect(mockFirestore.collection).toHaveBeenCalledWith(
        'services/authjs/users',
      );
      expect(mockCollection.doc).toHaveBeenCalledWith('user-uuid');
      expect(mockSet).toHaveBeenCalledWith(
        {
          slack: {
            id: '',
            isAdmin: true,
          },
        },
        { merge: true },
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining(
          'createUser: Bootstrapping admin status for new user haley@supersprinkles.racing',
        ),
      );
    });

    it('should not bootstrap admin state, but still stamps account-creation metadata, for a non-admin email', async () => {
      const config = await getAuthConfig();
      const createUserMethod = config.adapter!.createUser as any;

      const mockSet = vi.fn().mockResolvedValue({});
      const mockDoc = { set: mockSet };
      const mockCollection = { doc: vi.fn().mockReturnValue(mockDoc) };
      const mockFirestore = await getFirestore();
      mockFirestore.collection = vi.fn().mockReturnValue(mockCollection);

      const user = {
        name: 'Normal User',
        email: 'normal@example.com',
        emailVerified: null,
      };

      const result = await createUserMethod(user);

      expect(result).toBeDefined();
      expect(result.slack).toBeUndefined();
      // Only the #2487 account-creation-metadata stamp writes — never the
      // admin-bootstrap `slack` write, which is gated on `isAdminEmail`.
      expect(mockSet).toHaveBeenCalledTimes(1);
      expect(mockSet).toHaveBeenCalledWith(
        { metadata: { createdAt: expect.anything() } },
        { merge: true },
      );
    });
  });
});
