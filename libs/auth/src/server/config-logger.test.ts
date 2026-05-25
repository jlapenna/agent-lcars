import { logger } from '@members/logging';

import { getAuthConfig } from './config';

// Mock dependencies
jest.mock('@auth/firebase-adapter', () => ({
  FirestoreAdapter: jest.fn().mockReturnValue({
    createUser: jest.fn(),
  }),
}));

jest.mock('next-auth/providers/slack', () => jest.fn().mockReturnValue({}));
jest.mock('next-auth/providers/strava', () => jest.fn().mockReturnValue({}));
jest.mock('next-auth/providers/credentials', () =>
  jest.fn().mockReturnValue({}),
);

jest.mock('@members/service-auth', () => ({
  getAuthSecret: jest.fn().mockResolvedValue('test-secret'),
}));

jest.mock('@members/firebase-server', () => ({
  getFirestore: jest.fn().mockResolvedValue({}),
  getFirebaseAdminApp: jest.fn(),
}));

jest.mock('@members/logging', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(), // Added info mock
  },
  LogLevel: {
    DEBUG: 'debug',
  },
}));

jest.mock('@members/slack', () => ({
  getSecrets: jest.fn().mockResolvedValue({ clientSecret: 'slack-secret' }),
  getBotDetails: jest
    .fn()
    .mockResolvedValue({ teamId: 'team-id', appId: 'app-id' }),
}));

jest.mock('@members/strava', () => ({
  getSecrets: jest.fn().mockResolvedValue({
    clientId: 'id',
    clientSecret: 'secret',
    redirectUri: 'uri',
  }),
}));

jest.mock('@members/util-server', () => ({
  ...jest.requireActual('@members/util-server'),
  enableTestingHandlers: jest.fn().mockReturnValue(false),
  getLogLevel: jest.fn().mockReturnValue('debug'),
  getSlackTeamId: jest.fn().mockReturnValue('test-team-id'),
  isSlackAdmin: jest.fn().mockReturnValue(false),
}));

jest.mock('@members/util/browser', () => ({
  getNextPublicSlackClientId: jest.fn().mockReturnValue('slack-client-id'),
}));

describe('getAuthConfig', () => {
  it('should return a config with a custom logger that calls the shared logger', async () => {
    const config = await getAuthConfig();

    expect(config.logger).toBeDefined();
    const authLogger = config.logger as any;

    // Verify logger.error
    authLogger.error('TEST_ERROR');
    expect(logger.error).toHaveBeenCalledWith('TEST_ERROR');

    // Verify logger.warn
    authLogger.warn('TEST_WARN');
    expect(logger.warn).toHaveBeenCalledWith('TEST_WARN');

    // Verify logger.debug
    authLogger.debug('TEST_DEBUG');
    expect(logger.debug).toHaveBeenCalledWith('TEST_DEBUG');
  });
});
