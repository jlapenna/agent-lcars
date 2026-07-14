import { logger } from '@repo/logging';
import { describe, expect, it, vi } from 'vitest';

import { getAuthConfig } from './config';

// Mock dependencies
vi.mock('@auth/firebase-adapter', () => ({
  FirestoreAdapter: vi.fn().mockReturnValue({
    createUser: vi.fn(),
  }),
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
    info: vi.fn(), // Added info mock
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
