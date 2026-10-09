// @vitest-environment node
import type { NextAuthConfig, Session } from 'next-auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: undefined as NextAuthConfig | undefined,
  headers: vi.fn(),
  getToken: vi.fn(),
  auth: vi.fn(),
}));
vi.mock('next-auth', () => ({
  default: (config: NextAuthConfig) => {
    mocks.config = config;
    return {
      auth: mocks.auth,
      handlers: {},
      signIn: vi.fn(),
      signOut: vi.fn(),
    };
  },
}));
vi.mock('next/headers', () => ({ headers: mocks.headers }));
vi.mock('next-auth/jwt', () => ({ getToken: mocks.getToken }));

import { auth, githubAccessTokenFor } from './auth';
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
      token: { sub: '123' },
      profile: { login: 'operator' },
      account: { provider: 'github', access_token: 'private-oauth-token' },
    } as Parameters<typeof jwt>[0]);
    expect(token).toMatchObject({
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

describe('hermetic session adapter', () => {
  it('injects a truthful non-admin identity without an OAuth token', async () => {
    vi.stubEnv('E2E_TESTING', 'true');
    mocks.headers.mockResolvedValue(
      new Headers({ 'x-e2e-auth-user': 'operator' }),
    );
    const injected = await auth();
    expect(injected?.user).toMatchObject({ login: 'operator', isAdmin: false });
    expect(injected && githubAccessTokenFor(injected)).toBeUndefined();
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
