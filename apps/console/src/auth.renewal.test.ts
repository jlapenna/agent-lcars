// @vitest-environment node
//
// Runs the real Auth.js session update, unlike auth.test.ts which replaces
// next-auth. `unstable_update` is an unstable API on a beta release: this is
// the test that fails if a new version stops passing `trigger: 'update'` to
// the jwt callback or stops writing the renewed session cookie.
import { decode, encode } from 'next-auth/jwt';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const mocks = vi.hoisted(() => {
  // Auth.js reads its environment when ./auth is first evaluated, so these
  // have to be in place before the imports below run.
  vi.stubEnv('AUTH_SECRET', 'renewal-test-secret');
  vi.stubEnv('AUTH_URL', 'https://lcars.example');
  vi.stubEnv('AUTH_TRUST_HOST', 'true');
  vi.stubEnv('AUTH_GITHUB_ID', 'client-id');
  vi.stubEnv('AUTH_GITHUB_SECRET', 'client-secret');
  vi.stubEnv('E2E_TESTING', 'false');
  return { headers: vi.fn(), cookieSet: vi.fn(), refresh: vi.fn() };
});
vi.mock('next/headers', () => ({
  headers: mocks.headers,
  cookies: async () => ({ set: mocks.cookieSet }),
}));
vi.mock('./lib/github-token-refresh', () => ({
  refreshGithubUserToken: mocks.refresh,
}));

import { auth, githubAccessTokenFor, withFreshGithubAccessToken } from './auth';

const SECRET = 'renewal-test-secret';
const COOKIE = '__Secure-authjs.session-token';
const NOW = Date.parse('2026-11-14T12:00:00Z');
const HOUR = 3_600_000;

async function requestWithSession(token: Record<string, unknown>) {
  const value = await encode({ token, secret: SECRET, salt: COOKIE });
  mocks.headers.mockResolvedValue(
    new Headers({
      cookie: `${COOKIE}=${value}`,
      host: 'lcars.example',
      'x-forwarded-proto': 'https',
    }),
  );
}

describe('operator token renewal through Auth.js', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(NOW), toFake: ['Date'] });
    mocks.cookieSet.mockReset();
    mocks.refresh.mockReset();
  });
  afterEach(() => vi.useRealTimers());
  afterAll(() => vi.unstubAllEnvs());

  it('renews an expired token from a server action and saves the rotated pair in the session cookie', async () => {
    await requestWithSession({
      sub: '123',
      githubLogin: 'operator',
      githubAccessToken: 'expired-token',
      githubAccessTokenIssuedAt: NOW - 9 * HOUR,
      githubAccessTokenExpiresAt: NOW - HOUR,
      githubRefreshToken: 'refresh-1',
    });
    mocks.refresh.mockResolvedValue({
      ok: true,
      accessToken: 'access-2',
      accessTokenExpiresAt: NOW + 8 * HOUR,
      refreshToken: 'refresh-2',
    });
    const stale = (await auth())!;
    expect(githubAccessTokenFor(stale)).toBe('expired-token');
    const fresh = await withFreshGithubAccessToken(stale);

    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith('refresh-1');
    expect(githubAccessTokenFor(fresh)).toBe('access-2');
    expect(fresh.user.login).toBe('operator');

    const saved = mocks.cookieSet.mock.calls.find(([name]) => name === COOKIE);
    expect(saved?.[2]).toMatchObject({ httpOnly: true, secure: true });
    const payload = await decode({
      token: saved?.[1] as string,
      secret: SECRET,
      salt: COOKIE,
    });
    expect(payload).toMatchObject({
      sub: '123',
      githubLogin: 'operator',
      githubAccessToken: 'access-2',
      githubAccessTokenIssuedAt: NOW,
      githubAccessTokenExpiresAt: NOW + 8 * HOUR,
      githubRefreshToken: 'refresh-2',
    });
  });

  it('does not touch the session of a token that is still current', async () => {
    await requestWithSession({
      sub: '123',
      githubLogin: 'operator',
      githubAccessToken: 'current-token',
      githubAccessTokenExpiresAt: NOW + HOUR,
      githubRefreshToken: 'refresh-1',
    });
    const session = (await auth())!;

    expect(await withFreshGithubAccessToken(session)).toBe(session);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });
});
