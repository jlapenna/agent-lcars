// @vitest-environment node
import type { NextAuthConfig, Session } from 'next-auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: undefined as NextAuthConfig | undefined,
  headers: vi.fn(),
  getToken: vi.fn(),
  auth: vi.fn(),
  update: vi.fn(),
  refresh: vi.fn(),
  recordRefresh: vi.fn(),
}));
vi.mock('next-auth', () => ({
  default: (config: NextAuthConfig) => {
    mocks.config = config;
    return {
      auth: mocks.auth,
      handlers: {},
      signIn: vi.fn(),
      signOut: vi.fn(),
      unstable_update: mocks.update,
    };
  },
}));
vi.mock('next/headers', () => ({ headers: mocks.headers }));
vi.mock('next-auth/jwt', () => ({ getToken: mocks.getToken }));
vi.mock('./lib/github-token-refresh', () => ({
  refreshGithubUserToken: mocks.refresh,
}));
vi.mock('./lib/operator-comment-observability', () => ({
  recordOperatorTokenIssued: vi.fn(),
  recordOperatorTokenRefresh: mocks.recordRefresh,
}));

import {
  auth,
  E2E_FIXTURE_GITHUB_USER_TOKEN,
  githubAccessTokenFor,
  githubAccessTokenIssuedAtFor,
  withFreshGithubAccessToken,
} from './auth';
import { createAdminAction } from './lib/auth-guards';
import { consoleLandingPath } from './lib/console-access';
import { authenticateWorkRequest, type WorkAuthDeps } from './lib/work-auth';
import { workGrants } from './lib/work-grants';

const grant = {
  principal: 'user:operator',
  subjects: ['github:operator'],
  pipelines: ['codex'],
  scopes: ['work.operator'],
};
const session = (login: string, isAdmin = false): Session => ({
  user: { id: login, login, isAdmin },
  expires: '2099-01-01T00:00:00.000Z',
});

beforeEach(() => {
  vi.stubEnv('AGENT_LCARS_ADMIN_GITHUB_LOGIN', 'admin');
  vi.stubEnv('AGENT_LCARS_ADMIN_GITHUB_LOGINS', 'admin');
  vi.stubEnv('AGENT_LCARS_WORK_GRANTS', JSON.stringify([grant]));
  vi.stubEnv('AUTH_SECRET', 'dummy-secret');
  vi.stubEnv('E2E_TESTING', 'false');
  for (const name of ['K_SERVICE', 'K_REVISION', 'CLOUD_RUN_JOB'])
    vi.stubEnv(name, undefined);
  mocks.headers.mockResolvedValue(new Headers());
  mocks.auth.mockResolvedValue(null);
  mocks.getToken.mockResolvedValue(null);
  mocks.update.mockReset();
  mocks.refresh.mockReset();
  mocks.recordRefresh.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

function signIn(login: unknown) {
  const callback = mocks.config!.callbacks!.signIn!;
  return callback({
    user: { id: '123' },
    account: null,
    profile: { login },
  } as Parameters<typeof callback>[0]);
}

describe('console OAuth admission and authority', () => {
  it('admits admins and effective operators case-insensitively, denying unknown and machine-only scopes', async () => {
    expect(await signIn('ADMIN')).toBe(true);
    expect(await signIn('Operator')).toBe(true);
    expect(await signIn('unknown')).toBe(false);
    expect(await signIn(undefined)).toBe(false);
    for (const scope of ['work.executor', 'work.cron']) {
      vi.stubEnv(
        'AGENT_LCARS_WORK_GRANTS',
        JSON.stringify([{ ...grant, scopes: [scope] }]),
      );
      expect(await signIn('operator')).toBe(false);
    }
  });

  it('keeps an operator non-admin and OAuth credentials out of the public session', async () => {
    const jwt = mocks.config!.callbacks!.jwt!;
    const token = await jwt({
      token: { sub: 'random-per-sign-in' },
      profile: { login: 'operator' },
      account: {
        provider: 'github',
        providerAccountId: '123',
        access_token: 'private-oauth-token',
      },
    } as Parameters<typeof jwt>[0]);
    expect(token).toMatchObject({
      sub: '123',
      isAdmin: false,
      githubAccessToken: 'private-oauth-token',
    });
    const callback = mocks.config!.callbacks!.session!;
    const publicSession = await callback({
      session: session('operator'),
      token,
    } as Parameters<typeof callback>[0]);
    expect(publicSession.user).toMatchObject({
      login: 'operator',
      isAdmin: false,
    });
    expect(JSON.stringify(publicSession)).not.toContain('private-oauth-token');
    expect(githubAccessTokenFor(publicSession)).toBeUndefined();
    mocks.auth.mockResolvedValue(publicSession);
    mocks.getToken.mockResolvedValue(token);
    const serverSession = await auth();
    expect(serverSession && githubAccessTokenFor(serverSession)).toBe(
      'private-oauth-token',
    );
    expect(JSON.stringify(serverSession)).not.toContain('private-oauth-token');
    // The sign-in time travels with the token so a later rejection can report
    // how long GitHub honoured it.
    expect(token.githubAccessTokenIssuedAt).toEqual(expect.any(Number));
    expect(serverSession && githubAccessTokenIssuedAtFor(serverSession)).toBe(
      token.githubAccessTokenIssuedAt,
    );
    expect(consoleLandingPath(serverSession)).toBe('/work');
    await expect(
      createAdminAction(async () => serverSession)(),
    ).rejects.toThrow('Unauthorized');
    expect(consoleLandingPath(session('admin', true))).toBe('/');
    expect(consoleLandingPath(session('unknown'))).toBeUndefined();
  });

  it('revokes sign-in, landing, and the next Work operation for an existing operator session', async () => {
    const deps: WorkAuthDeps = {
      session: async () => session('operator'),
      grants: workGrants,
      verifyGoogleIdToken: vi.fn(),
      verifySessionExpiryOidcToken: vi.fn(),
      verifyGithubActionsWorkOidcToken: vi.fn(),
    };
    const request = new Request('https://console.test/api/work/v1/items');
    expect(
      (await authenticateWorkRequest(request, deps))?.scopes.has(
        'work.operator',
      ),
    ).toBe(true);
    vi.stubEnv('AGENT_LCARS_WORK_GRANTS', '[]');
    expect(await signIn('operator')).toBe(false);
    expect(consoleLandingPath(session('operator'))).toBeUndefined();
    expect(await authenticateWorkRequest(request, deps)).toBeUndefined();
  });
});

describe('operator token renewal', () => {
  const NOW = Date.parse('2026-11-14T12:00:00Z');
  const HOUR = 3_600_000;

  beforeEach(() => vi.useFakeTimers({ now: new Date(NOW) }));
  afterEach(() => vi.useRealTimers());

  function jwtCallback(args: Record<string, unknown>) {
    const jwt = mocks.config!.callbacks!.jwt!;
    return jwt(args as Parameters<typeof jwt>[0]);
  }

  /** A session as `auth()` returns it for a JWT signed in `ageHours` ago. */
  async function serverSession(token: Record<string, unknown>) {
    mocks.auth.mockResolvedValue(session('operator'));
    mocks.getToken.mockResolvedValue(token);
    return (await auth())!;
  }

  const expired = {
    sub: '123',
    githubAccessToken: 'expired-token',
    githubAccessTokenIssuedAt: NOW - 9 * HOUR,
    githubAccessTokenExpiresAt: NOW - HOUR,
    githubRefreshToken: 'refresh-1',
  };

  it("keeps GitHub's expiry and refresh token in the JWT at sign-in, out of the session", async () => {
    const token = await jwtCallback({
      token: { sub: 'random' },
      profile: { login: 'operator' },
      account: {
        provider: 'github',
        providerAccountId: '123',
        access_token: 'access-1',
        expires_at: NOW / 1000 + 28_800,
        refresh_token: 'refresh-1',
      },
    });

    expect(token).toMatchObject({
      githubAccessToken: 'access-1',
      githubAccessTokenExpiresAt: NOW + 8 * HOUR,
      githubRefreshToken: 'refresh-1',
    });
    const signedIn = await serverSession(token as Record<string, unknown>);
    expect(JSON.stringify(signedIn)).not.toContain('refresh-1');
    expect(
      Object.getOwnPropertySymbols(signedIn).map(String).join(),
    ).not.toContain('refresh');
  });

  it('renews an expired token on a session update and rotates the refresh token', async () => {
    mocks.refresh.mockResolvedValue({
      ok: true,
      accessToken: 'access-2',
      accessTokenExpiresAt: NOW + 8 * HOUR,
      refreshToken: 'refresh-2',
    });

    const token = await jwtCallback({ token: expired, trigger: 'update' });

    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith('refresh-1');
    expect(token).toMatchObject({
      sub: '123',
      githubAccessToken: 'access-2',
      githubAccessTokenIssuedAt: NOW,
      githubAccessTokenExpiresAt: NOW + 8 * HOUR,
      githubRefreshToken: 'refresh-2',
    });
    expect(mocks.recordRefresh).toHaveBeenCalledExactlyOnceWith('refreshed', {
      tokenAgeSeconds: 9 * 3600,
    });
  });

  it('never renews on a plain session read, where the cookie may not be written', async () => {
    const token = await jwtCallback({ token: expired });

    expect(token).toBe(expired);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('leaves a token alone until it is within five minutes of expiry', async () => {
    const current = {
      ...expired,
      githubAccessTokenExpiresAt: NOW + 6 * 60_000,
    };
    expect(await jwtCallback({ token: current, trigger: 'update' })).toBe(
      current,
    );
    expect(mocks.refresh).not.toHaveBeenCalled();

    mocks.refresh.mockResolvedValue({ ok: true, accessToken: 'access-2' });
    const due = { ...expired, githubAccessTokenExpiresAt: NOW + 4 * 60_000 };
    const renewed = await jwtCallback({ token: due, trigger: 'update' });
    expect(renewed).toMatchObject({
      githubAccessToken: 'access-2',
      // GitHub sent no new refresh token or expiry: keep the old refresh
      // token and drop the stale expiry.
      githubRefreshToken: 'refresh-1',
    });
    expect(renewed).not.toHaveProperty('githubAccessTokenExpiresAt');
  });

  it('forgets a refresh token GitHub refuses, keeps the old access token and reports why', async () => {
    mocks.refresh.mockResolvedValue({
      ok: false,
      outcome: 'refused',
      githubError: 'bad_refresh_token',
    });

    const token = await jwtCallback({ token: expired, trigger: 'update' });

    const { githubRefreshToken: _spent, ...withoutRefreshToken } = expired;
    expect(token).toEqual(withoutRefreshToken);
    expect(mocks.recordRefresh).toHaveBeenCalledExactlyOnceWith('refused', {
      tokenAgeSeconds: 9 * 3600,
      githubError: 'bad_refresh_token',
    });
    // The session no longer counts as renewable: the next write goes
    // straight to re-authorization instead of another refused exchange.
    const session = await serverSession(token as Record<string, unknown>);
    expect(await withFreshGithubAccessToken(session)).toBe(session);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('keeps the refresh token for a retry when GitHub does not answer', async () => {
    mocks.refresh.mockResolvedValue({ ok: false, outcome: 'failed' });

    expect(await jwtCallback({ token: expired, trigger: 'update' })).toBe(
      expired,
    );
    expect(mocks.recordRefresh).toHaveBeenCalledExactlyOnceWith('failed', {
      tokenAgeSeconds: 9 * 3600,
    });
  });

  it('counts one renewal per exchange, not per request that reused it', async () => {
    mocks.refresh.mockResolvedValue({
      ok: true,
      accessToken: 'access-2',
      shared: true,
    });

    const token = await jwtCallback({ token: expired, trigger: 'update' });

    expect(token).toMatchObject({ githubAccessToken: 'access-2' });
    expect(mocks.recordRefresh).not.toHaveBeenCalled();
  });

  it('ignores whatever a browser sends as the update payload', async () => {
    const current = { ...expired, githubAccessTokenExpiresAt: NOW + HOUR };

    const token = await jwtCallback({
      token: current,
      trigger: 'update',
      session: { githubAccessToken: 'attacker', isAdmin: true },
    });

    expect(token).toBe(current);
  });

  it('hands a server action the renewed token after saving the session', async () => {
    mocks.refresh.mockResolvedValue({
      ok: true,
      accessToken: 'access-2',
      accessTokenExpiresAt: NOW + 8 * HOUR,
      refreshToken: 'refresh-2',
    });
    // Auth.js runs the jwt callback inside the update it was asked for.
    mocks.update.mockImplementation(async () => {
      await jwtCallback({ token: expired, trigger: 'update' });
      return null;
    });
    const stale = await serverSession(expired);

    const fresh = await withFreshGithubAccessToken(stale);

    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({});
    expect(githubAccessTokenFor(fresh)).toBe('access-2');
    expect(githubAccessTokenIssuedAtFor(fresh)).toBe(NOW);
    expect(fresh.user).toEqual(stale.user);
    expect(JSON.stringify(fresh)).not.toContain('access-2');
    // Renewed once: the fresh session is not due again.
    expect(await withFreshGithubAccessToken(fresh)).toBe(fresh);
    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it('returns the session unchanged when renewal fails or cannot be saved', async () => {
    const stale = await serverSession(expired);

    mocks.refresh.mockResolvedValue({ ok: false, outcome: 'failed' });
    mocks.update.mockImplementation(async () => {
      await jwtCallback({ token: expired, trigger: 'update' });
      return null;
    });
    expect(await withFreshGithubAccessToken(stale)).toBe(stale);

    mocks.update.mockRejectedValue(new Error('cookies are read-only here'));
    expect(await withFreshGithubAccessToken(stale)).toBe(stale);
    expect(githubAccessTokenFor(stale)).toBe('expired-token');
  });

  it('does not try to renew a current token or a session without a refresh token', async () => {
    const current = await serverSession({
      ...expired,
      githubAccessTokenExpiresAt: NOW + HOUR,
    });
    expect(await withFreshGithubAccessToken(current)).toBe(current);

    const { githubRefreshToken: _dropped, ...withoutRefresh } = expired;
    const legacy = await serverSession(withoutRefresh);
    expect(await withFreshGithubAccessToken(legacy)).toBe(legacy);

    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe('hermetic session adapter', () => {
  it('injects a truthful non-admin identity with only the fixture user token', async () => {
    vi.stubEnv('E2E_TESTING', 'true');
    mocks.headers.mockResolvedValue(
      new Headers({ 'x-e2e-auth-user': 'operator' }),
    );
    const injected = await auth();
    expect(injected?.user).toMatchObject({ login: 'operator', isAdmin: false });
    expect(injected && githubAccessTokenFor(injected)).toBe(
      E2E_FIXTURE_GITHUB_USER_TOKEN,
    );
    mocks.headers.mockResolvedValue(
      new Headers({ 'x-e2e-auth-user': 'e2e-agent-lcars-admin' }),
    );
    expect((await auth())?.user.isAdmin).toBe(true);
  });

  it.each(['K_SERVICE', 'K_REVISION', 'CLOUD_RUN_JOB'])(
    'ignores injected sessions on Cloud Run (%s)',
    async (name) => {
      vi.stubEnv('E2E_TESTING', 'true');
      vi.stubEnv(name, 'deployed');
      mocks.headers.mockResolvedValue(
        new Headers({ 'x-e2e-auth-user': 'e2e-agent-lcars-admin' }),
      );
      expect(await auth()).toBeNull();
    },
  );
});
