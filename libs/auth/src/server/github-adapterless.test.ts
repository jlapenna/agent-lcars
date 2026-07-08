import { getFirestore } from '@repo/firebase-server';
import * as utilServer from '@repo/util-server';
import type { Session } from 'next-auth';

import { AuthConfigOptions, getAuthConfig } from './config';

jest.mock('@auth/firebase-adapter', () => ({
  FirestoreAdapter: jest.fn().mockReturnValue({}),
}));
jest.mock('next-auth/providers/github', () =>
  jest.fn().mockReturnValue({ id: 'github' }),
);
jest.mock('next-auth/providers/credentials', () =>
  jest.fn().mockImplementation((options) => options),
);

jest.mock('@repo/service-auth', () => ({
  getAuthSecret: jest.fn().mockResolvedValue('test-secret'),
}));

jest.mock('@repo/firebase-server', () => ({
  getFirestore: jest.fn(),
  getFirebaseAdminApp: jest.fn(),
  getFirebaseAuthAdmin: jest.fn(),
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
  isAdminEmail: jest.fn().mockReturnValue(false),
  getProjectId: jest.fn().mockReturnValue('demo-project'),
  getAgentConsoleGithubOauthClientId: jest.fn().mockReturnValue('gh-id'),
  getAgentConsoleGithubOauthClientSecret: jest
    .fn()
    .mockReturnValue('gh-secret'),
}));

const ADAPTERLESS_GITHUB: AuthConfigOptions = {
  adapter: false,
  providers: ['github'],
  allowedGithubLogins: ['allowed-login'],
  newUserRoute: null,
};

describe('getAuthConfig adapter-less GitHub mode (agent-console)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (utilServer.enableTestingHandlers as jest.Mock).mockReturnValue(false);
  });

  it('configures the github provider without touching Firestore', async () => {
    const config = await getAuthConfig({ ...ADAPTERLESS_GITHUB });

    expect(getFirestore).not.toHaveBeenCalled();
    expect(config.adapter).toBeUndefined();
    expect(config.session?.strategy).toBe('jwt');
    expect(
      config.providers.some((p) => (p as { id?: string }).id === 'github'),
    ).toBe(true);
  });

  it('keeps the Firestore adapter and database strategy by default', async () => {
    (getFirestore as jest.Mock).mockResolvedValue({
      collection: jest.fn(),
    });
    const config = await getAuthConfig();

    expect(getFirestore).toHaveBeenCalled();
    expect(config.adapter).toBeDefined();
    expect(config.session?.strategy).toBe('database');
  });

  it('allows a GitHub sign-in for an allowlisted login', async () => {
    const config = await getAuthConfig({ ...ADAPTERLESS_GITHUB });
    const result = await config.callbacks?.signIn?.({
      user: { id: 'u1' },
      account: {
        provider: 'github',
        providerAccountId: '1',
        type: 'oauth',
      },
      profile: { login: 'allowed-login' },
    });
    expect(result).toBe(true);
  });

  it('rejects a GitHub sign-in for a non-allowlisted login', async () => {
    const config = await getAuthConfig({ ...ADAPTERLESS_GITHUB });
    const result = await config.callbacks?.signIn?.({
      user: { id: 'u1' },
      account: {
        provider: 'github',
        providerAccountId: '2',
        type: 'oauth',
      },
      profile: { login: 'intruder' },
    });
    expect(result).toBe(false);
  });

  it('rejects a GitHub sign-in with no login on the profile', async () => {
    const config = await getAuthConfig({ ...ADAPTERLESS_GITHUB });
    const result = await config.callbacks?.signIn?.({
      user: { id: 'u1' },
      account: {
        provider: 'github',
        providerAccountId: '3',
        type: 'oauth',
      },
      profile: {},
    });
    expect(result).toBe(false);
  });

  it('persists the GitHub login on the JWT', async () => {
    const config = await getAuthConfig({ ...ADAPTERLESS_GITHUB });
    const token = await config.callbacks?.jwt?.({
      token: { sub: 'u1' },
      user: { id: 'u1' },
      account: null,
      profile: { login: 'allowed-login' },
    });
    expect((token as { githubLogin?: string }).githubLogin).toBe(
      'allowed-login',
    );
  });

  it('grants admin in the session for an allowlisted login', async () => {
    const config = await getAuthConfig({ ...ADAPTERLESS_GITHUB });
    const session = (await config.callbacks?.session?.({
      session: {
        user: { id: '', isAdmin: false },
        expires: new Date().toISOString(),
      },
      token: { sub: 'u1', githubLogin: 'allowed-login' },
    } as never)) as Session;

    expect(session.user.isAdmin).toBe(true);
    expect(session.user.onboarding).toBeUndefined();
    expect(session.firebaseToken).toBeUndefined();
  });

  it('does not grant admin for a login missing from the allowlist', async () => {
    const config = await getAuthConfig({ ...ADAPTERLESS_GITHUB });
    const session = (await config.callbacks?.session?.({
      session: {
        user: { id: '', isAdmin: false },
        expires: new Date().toISOString(),
      },
      token: { sub: 'u1', githubLogin: 'intruder' },
    } as never)) as Session;

    expect(session.user.isAdmin).toBe(false);
  });
});
