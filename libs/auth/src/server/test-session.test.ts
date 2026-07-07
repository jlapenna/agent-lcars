import * as utilServer from '@repo/util-server';
import { headers } from 'next/headers';
import type { Session } from 'next-auth';

import { getTestSession } from './test-session';

jest.mock('next/headers', () => ({
  headers: jest.fn(),
}));

jest.mock('@repo/firebase-server', () => ({
  getFirebaseAuthAdmin: jest.fn().mockResolvedValue({
    createCustomToken: jest.fn().mockResolvedValue('mock-firebase-token'),
  }),
}));

jest.mock('@repo/util-server', () => ({
  ...jest.requireActual('@repo/util-server'),
  isE2eTesting: jest.fn().mockReturnValue(false),
  isMockAuthEnabled: jest.fn().mockReturnValue(false),
  isImpersonateAutomaticLogin: jest.fn().mockReturnValue(false),
  getE2eTestingUser: jest.fn().mockReturnValue(undefined),
  isSlackAdmin: jest.fn().mockReturnValue(false),
  isOnecakeAdmin: jest.fn().mockReturnValue(false),
  isAdminEmail: jest.fn().mockReturnValue(false),
}));

const mockHeaders = headers as jest.Mock;
const mockIsE2eTesting = utilServer.isE2eTesting as jest.Mock;
const mockIsMockAuthEnabled = utilServer.isMockAuthEnabled as jest.Mock;
const mockIsImpersonateAutomaticLogin =
  utilServer.isImpersonateAutomaticLogin as jest.Mock;
const mockGetE2eTestingUser = utilServer.getE2eTestingUser as jest.Mock;

function setHeader(value: string | null) {
  mockHeaders.mockResolvedValue({
    get: (name: string) => (name === 'X-e2e-auth-user' ? value : null),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsE2eTesting.mockReturnValue(false);
  mockIsMockAuthEnabled.mockReturnValue(false);
  mockIsImpersonateAutomaticLogin.mockReturnValue(false);
  mockGetE2eTestingUser.mockReturnValue(undefined);
  setHeader(null);
});

describe('getTestSession — e2e header branch', () => {
  beforeEach(() => {
    mockIsE2eTesting.mockReturnValue(true);
  });

  it('returns undefined when no header is present', async () => {
    expect(await getTestSession()).toBeUndefined();
  });

  it('returns null for the literal "unauthed" (logged-out simulation)', async () => {
    setHeader('unauthed');
    expect(await getTestSession()).toBeNull();
  });

  it('parses a JSON AuthUser into a session', async () => {
    setHeader(
      JSON.stringify({
        uid: 'some-user',
        email: 'test-user@example.com',
        displayName: 'E2E User',
        customClaims: { roles: ['admin'] },
      }),
    );
    const session = (await getTestSession()) as Session;
    expect(session.user.id).toBe('some-user');
    expect(session.user.name).toBe('E2E User');
    expect(session.user.email).toBe('test-user@example.com');
    expect(session.user.isAdmin).toBe(true);
    expect(session.customClaims).toEqual({ roles: ['admin'] });
  });

  it('marks users without the admin role as non-admin', async () => {
    setHeader(JSON.stringify({ uid: 'some-user', customClaims: {} }));
    const session = (await getTestSession()) as Session;
    expect(session.user.isAdmin).toBe(false);
  });

  it('throws on malformed JSON', async () => {
    setHeader('{not-json');
    await expect(getTestSession()).rejects.toThrow('Malformed JSON');
  });

  it('throws when the payload has no uid', async () => {
    setHeader(JSON.stringify({ email: 'x@example.com' }));
    await expect(getTestSession()).rejects.toThrow('Misconfigured');
  });

  it('ignores the header outside e2e runs', async () => {
    mockIsE2eTesting.mockReturnValue(false);
    setHeader(JSON.stringify({ uid: 'some-user' }));
    expect(await getTestSession()).toBeUndefined();
  });

  it('returns undefined when headers() throws (outside a request)', async () => {
    mockHeaders.mockRejectedValue(new Error('outside request scope'));
    expect(await getTestSession()).toBeUndefined();
  });
});

describe('getTestSession — env impersonation branch', () => {
  beforeEach(() => {
    mockIsMockAuthEnabled.mockReturnValue(true);
    mockIsImpersonateAutomaticLogin.mockReturnValue(true);
    mockGetE2eTestingUser.mockReturnValue('impersonated-user');
  });

  it('auto-logs-in the configured user via the default mock session', async () => {
    const session = (await getTestSession()) as Session;
    expect(session.user.id).toBe('impersonated-user');
  });

  it('uses the app-specific mock session when provided', async () => {
    const mockSession = jest.fn().mockResolvedValue({
      user: { id: 'impersonated-user', isAdmin: true },
      expires: new Date().toISOString(),
    });
    const session = (await getTestSession({ mockSession })) as Session;
    expect(mockSession).toHaveBeenCalledWith('impersonated-user');
    expect(session.user.isAdmin).toBe(true);
  });

  it('returns undefined without IMPERSONATE_AUTOMATIC_LOGIN', async () => {
    mockIsImpersonateAutomaticLogin.mockReturnValue(false);
    expect(await getTestSession()).toBeUndefined();
  });

  it('returns undefined when no user is configured', async () => {
    mockGetE2eTestingUser.mockReturnValue(undefined);
    expect(await getTestSession()).toBeUndefined();
  });
});

describe('getTestSession — inactive', () => {
  it('returns undefined when nothing is enabled', async () => {
    expect(await getTestSession()).toBeUndefined();
  });
});
