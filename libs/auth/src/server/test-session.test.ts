import * as utilServer from '@repo/util-server';
import { headers } from 'next/headers';
import type { Session } from 'next-auth';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { getTestSession } from './test-session';

vi.mock('next/headers', () => ({
  headers: vi.fn(),
}));

vi.mock('@repo/firebase-server', () => ({
  getFirebaseAuthAdmin: vi.fn().mockResolvedValue({
    createCustomToken: vi.fn().mockResolvedValue('mock-firebase-token'),
  }),
}));

vi.mock('@repo/util-server', async (importOriginal) => ({
  ...(await importOriginal()),
  isE2eTesting: vi.fn().mockReturnValue(false),
  isMockAuthEnabled: vi.fn().mockReturnValue(false),
  isImpersonateAutomaticLogin: vi.fn().mockReturnValue(false),
  getE2eTestingUser: vi.fn().mockReturnValue(undefined),
  isAdminEmail: vi.fn().mockReturnValue(false),
}));

// Not requireActual: @repo/slack's barrel pulls in cloudevents/rag (and
// transitively @google/genai, which needs a ReadableStream global this test
// environment doesn't provide). This test only needs isSlackAdmin, reached
// transitively via the real (unmocked) `./auth` module's getMockSession.
vi.mock('@repo/slack', () => ({
  isSlackAdmin: vi.fn().mockReturnValue(false),
}));

vi.mock('@repo/strava', () => ({
  isOnecakeAdmin: vi.fn().mockReturnValue(false),
}));

const mockHeaders = headers as Mock;
const mockIsE2eTesting = utilServer.isE2eTesting as Mock;
const mockIsMockAuthEnabled = utilServer.isMockAuthEnabled as Mock;
const mockIsImpersonateAutomaticLogin =
  utilServer.isImpersonateAutomaticLogin as Mock;
const mockGetE2eTestingUser = utilServer.getE2eTestingUser as Mock;

function setHeader(value: string | null) {
  mockHeaders.mockResolvedValue({
    get: (name: string) => (name === 'X-e2e-auth-user' ? value : null),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
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
    const mockSession = vi.fn().mockResolvedValue({
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
