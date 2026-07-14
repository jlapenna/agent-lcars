import { FirestoreAdapter } from '@auth/firebase-adapter';
import { getFirestore } from '@repo/firebase-server';
import { logger } from '@repo/logging';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { getAuthConfig } from './config';

// Mock dependencies
vi.mock('@auth/firebase-adapter', () => ({
  FirestoreAdapter: vi.fn(),
}));

vi.mock('next-auth/providers/slack', () => ({
  default: vi.fn().mockReturnValue({}),
}));
vi.mock('next-auth/providers/strava', () => ({
  default: vi.fn().mockReturnValue({}),
}));
vi.mock('next-auth/providers/credentials', () => ({
  default: vi.fn().mockReturnValue({}),
}));

vi.mock('@repo/service-auth', () => ({
  getAuthSecret: vi.fn().mockResolvedValue('test-secret'),
}));

vi.mock('@repo/firebase-server', () => ({
  getFirestore: vi.fn().mockResolvedValue({}),
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
  enableTestingHandlers: vi.fn().mockReturnValue(false),
  getLogLevel: vi.fn().mockReturnValue('debug'),
  getSlackTeamId: vi.fn().mockReturnValue('test-team-id'),
  getProjectId: vi.fn().mockReturnValue('demo-project'),
}));

vi.mock('@repo/util/browser', () => ({
  getNextPublicSlackClientId: vi.fn().mockReturnValue('slack-client-id'),
}));

describe('getAuthConfig Adapter Wrapper', () => {
  let mockUpdateSession: Mock;
  let mockGetSessionAndUser: Mock;

  beforeEach(() => {
    mockUpdateSession = vi.fn();
    mockGetSessionAndUser = vi.fn();

    (FirestoreAdapter as Mock).mockReturnValue({
      createUser: vi
        .fn()
        .mockImplementation((user) =>
          Promise.resolve({ id: 'user-uuid', ...user }),
        ),
      updateSession: mockUpdateSession,
      getSessionAndUser: mockGetSessionAndUser,
    });

    vi.clearAllMocks();
  });

  it('should handle contention error in updateSession by fetching current session', async () => {
    const config = await getAuthConfig();
    const adapter = config.adapter!;

    // Simulate contention error (code 10)
    const contentionError = new Error(
      'Aborted due to cross-transaction contention',
    );
    (contentionError as any).code = 10;
    mockUpdateSession.mockRejectedValueOnce(contentionError);

    // Mock getSessionAndUser success
    const mockSession = { sessionToken: 'token', expires: new Date() };
    mockGetSessionAndUser.mockResolvedValueOnce({ session: mockSession });

    const result = await adapter.updateSession!({
      sessionToken: 'token',
      expires: new Date(),
    });

    expect(mockUpdateSession).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Session update contention detected'),
    );
    expect(mockGetSessionAndUser).toHaveBeenCalledWith('token');
    expect(result).toEqual(mockSession);
  });
});

it('should force deterministic ID in linkAccount', async () => {
  const config = await getAuthConfig();
  const adapter = config.adapter!;
  const mockFirestore = await getFirestore();
  const mockDoc = { set: vi.fn() };
  const mockCollection = { doc: vi.fn().mockReturnValue(mockDoc) };
  mockFirestore.collection = vi.fn().mockReturnValue(mockCollection);

  const mockAccount = {
    providerAccountId: 'strava-123',
    provider: 'strava',
    type: 'oauth',
    userId: 'slack-123',
  };

  const linkedAccount = await adapter.linkAccount!(mockAccount as any);

  expect(linkedAccount!.id).toBe('slack-123_strava');
  expect(mockFirestore.collection).toHaveBeenCalledWith(
    'services/authjs/accounts',
  );
  expect(mockCollection.doc).toHaveBeenCalledWith('slack-123_strava');
});
