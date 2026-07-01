import { logger } from '@repo/logging';

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
    info: jest.fn(), // Added info mock
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
