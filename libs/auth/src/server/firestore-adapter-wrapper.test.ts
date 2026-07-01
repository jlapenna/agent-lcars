import { FirestoreAdapter } from '@auth/firebase-adapter';
import { logger } from '@repo/logging';

import { getAuthConfig } from './config';

// Mock dependencies
jest.mock('@auth/firebase-adapter', () => ({
  FirestoreAdapter: jest.fn(),
}));

jest.mock('next-auth/providers/slack', () => jest.fn().mockReturnValue({}));
jest.mock('next-auth/providers/strava', () => jest.fn().mockReturnValue({}));
jest.mock('next-auth/providers/credentials', () =>
  jest.fn().mockReturnValue({}),
);

jest.mock('@repo/service-auth', () => ({
  getAuthSecret: jest.fn().mockResolvedValue('test-secret'),
}));

jest.mock('@repo/firebase-server', () => ({
  getFirestore: jest.fn().mockResolvedValue({}),
  getFirebaseAdminApp: jest.fn(),
}));

jest.mock('@repo/logging', () => ({
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

jest.mock('@repo/slack', () => ({
  getSecrets: jest.fn().mockResolvedValue({ clientSecret: 'slack-secret' }),
  getBotDetails: jest
    .fn()
    .mockResolvedValue({ teamId: 'team-id', appId: 'app-id' }),
}));

jest.mock('@repo/strava', () => ({
  getSecrets: jest.fn().mockResolvedValue({
    clientId: 'id',
    clientSecret: 'secret',
    redirectUri: 'uri',
  }),
}));

jest.mock('@repo/util-server', () => ({
  ...jest.requireActual('@repo/util-server'),
  enableTestingHandlers: jest.fn().mockReturnValue(false),
  getLogLevel: jest.fn().mockReturnValue('debug'),
  getSlackTeamId: jest.fn().mockReturnValue('test-team-id'),
  isSlackAdmin: jest.fn().mockReturnValue(false),
  getProjectId: jest.fn().mockReturnValue('demo-project'),
}));

jest.mock('@repo/util/browser', () => ({
  getNextPublicSlackClientId: jest.fn().mockReturnValue('slack-client-id'),
}));

describe('getAuthConfig Adapter Wrapper', () => {
  let mockUpdateSession: jest.Mock;
  let mockGetSessionAndUser: jest.Mock;

  beforeEach(() => {
    mockUpdateSession = jest.fn();
    mockGetSessionAndUser = jest.fn();

    (FirestoreAdapter as jest.Mock).mockReturnValue({
      createUser: jest
        .fn()
        .mockImplementation((user) =>
          Promise.resolve({ id: 'user-uuid', ...user }),
        ),
      updateSession: mockUpdateSession,
      getSessionAndUser: mockGetSessionAndUser,
    });

    jest.clearAllMocks();
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
  const mockFirestore = await jest
    .requireMock('@repo/firebase-server')
    .getFirestore();
  const mockDoc = { set: jest.fn() };
  const mockCollection = { doc: jest.fn().mockReturnValue(mockDoc) };
  mockFirestore.collection = jest.fn().mockReturnValue(mockCollection);

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
