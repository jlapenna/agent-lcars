import { describe, expect, it, vi } from 'vitest';

import {
  type GitHubCredentialProfile,
  GitHubInstallationTokenMinter,
  GitHubInstallationTokenMintUnknownError,
} from './github-installation-token-minter';
import {
  InstallationTokenMinterBoundary,
  type InstallationTokenMintPlan,
} from './mint-resolution';

const PLAN: InstallationTokenMintPlan = {
  installationId: 456,
  repositoryId: 123,
  credentialProfileId: 'worker-minimal-v1',
};
const PROFILE: GitHubCredentialProfile = {
  ...PLAN,
  permissions: {
    contents: 'write',
    issues: 'write',
    metadata: 'read',
  },
};
const APP_JWT = 'header.payload.signature';
const INSTALLATION_TOKEN = 'ghs_ephemeral_token';
const EXPIRES_AT = '2026-08-14T21:00:00.000Z';

function response(
  value: unknown,
  status = 201,
  contentType = 'application/json; charset=utf-8',
) {
  return new Response(
    typeof value === 'string' ? value : JSON.stringify(value),
    { status, headers: { 'Content-Type': contentType } },
  );
}

function successfulResponse(overrides: Record<string, unknown> = {}) {
  return response({
    token: INSTALLATION_TOKEN,
    expires_at: EXPIRES_AT,
    permissions: PROFILE.permissions,
    repository_selection: 'selected',
    ...overrides,
  });
}

function harness(
  options: {
    profile?: unknown;
    authentication?: string | Error;
    request?: () => Promise<Response>;
  } = {},
) {
  const profile = Object.hasOwn(options, 'profile') ? options.profile : PROFILE;
  const authentication = options.authentication ?? APP_JWT;
  const request = vi.fn(options.request ?? (async () => successfulResponse()));
  const resolve = vi.fn(async () => profile as GitHubCredentialProfile);
  const getToken = vi.fn(async () => {
    if (authentication instanceof Error) throw authentication;
    return authentication;
  });
  return {
    minter: new GitHubInstallationTokenMinter(
      { resolve },
      { getToken },
      request as typeof fetch,
    ),
    request,
    resolve,
    getToken,
  };
}

describe('inactive GitHub installation-token minter', () => {
  it('makes one fixed-origin repository-restricted mint from the exact profile', async () => {
    const test = harness();
    await expect(test.minter.mint(PLAN)).resolves.toEqual({
      kind: 'issued',
      token: INSTALLATION_TOKEN,
      tokenExpiresAt: EXPIRES_AT,
    });
    expect(test.resolve).toHaveBeenCalledExactlyOnceWith(PLAN);
    expect(test.getToken).toHaveBeenCalledTimes(1);
    expect(test.request).toHaveBeenCalledTimes(1);
    const [url, init] = test.request.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      'https://api.github.com/app/installations/456/access_tokens',
    );
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${APP_JWT}`);
    expect(headers.get('accept')).toBe('application/vnd.github+json');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('user-agent')).toBe(
      'agent-lcars-lifecycle-control-plane',
    );
    expect(headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(JSON.parse(init.body as string)).toEqual({
      repository_ids: [PLAN.repositoryId],
      permissions: PROFILE.permissions,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('gives the profile resolver an immutable plan snapshot', async () => {
    const request = vi.fn(async () => successfulResponse());
    const minter = new GitHubInstallationTokenMinter(
      {
        async resolve(plan) {
          expect(Object.isFrozen(plan)).toBe(true);
          expect(Reflect.set(plan, 'repositoryId', 999)).toBe(false);
          return PROFILE;
        },
      },
      {
        async getToken() {
          return APP_JWT;
        },
      },
      request as typeof fetch,
    );
    await expect(minter.mint(PLAN)).resolves.toMatchObject({ kind: 'issued' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(PLAN.repositoryId).toBe(123);
  });

  it.each([
    ['missing profile', { profile: undefined }],
    ['mismatched installation', { profile: { ...PROFILE, installationId: 9 } }],
    ['mismatched repository', { profile: { ...PROFILE, repositoryId: 9 } }],
    [
      'mismatched profile id',
      { profile: { ...PROFILE, credentialProfileId: 'different-profile' } },
    ],
    ['empty permissions', { profile: { ...PROFILE, permissions: {} } }],
    [
      'malformed permission',
      { profile: { ...PROFILE, permissions: { contents: 'admin' } } },
    ],
    ['authentication error', { authentication: new Error('app-jwt-secret') }],
    ['malformed App JWT', { authentication: 'app-jwt-secret' }],
  ])('fails %s before any GitHub call', async (_name, options) => {
    const test = harness(options);
    await expect(test.minter.mint(PLAN)).resolves.toEqual({
      kind: 'definitely-not-started',
    });
    expect(test.request).not.toHaveBeenCalled();
  });

  it('rejects malformed plan identity before profile or auth resolution', async () => {
    for (const plan of [
      { ...PLAN, installationId: 0 },
      { ...PLAN, repositoryId: Number.MAX_SAFE_INTEGER + 1 },
      { ...PLAN, credentialProfileId: '' },
    ]) {
      const test = harness();
      await expect(test.minter.mint(plan)).resolves.toEqual({
        kind: 'definitely-not-started',
      });
      expect(test.resolve).not.toHaveBeenCalled();
      expect(test.getToken).not.toHaveBeenCalled();
      expect(test.request).not.toHaveBeenCalled();
    }
  });

  it.each([401, 403, 404, 422])(
    'treats documented rejection %s as definite no-send',
    async (status) => {
      const test = harness({
        request: async () => response('provider-secret', status, 'text/plain'),
      });
      await expect(test.minter.mint(PLAN)).resolves.toEqual({
        kind: 'definitely-not-started',
      });
      expect(test.request).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['network', async () => Promise.reject(new Error('network-secret'))],
    [
      'undocumented client response',
      async () => response('provider-secret', 400),
    ],
    ['server response', async () => response('provider-secret', 500)],
    ['malformed JSON', async () => response('{')],
    ['wrong media type', async () => response('{}', 201, 'text/plain')],
    ['oversized response', async () => response('x'.repeat(256 * 1_024 + 1))],
    [
      'missing field',
      async () =>
        response({
          token: INSTALLATION_TOKEN,
          permissions: PROFILE.permissions,
          repository_selection: 'selected',
        }),
    ],
    [
      'mismatched permissions',
      async () => successfulResponse({ permissions: { metadata: 'read' } }),
    ],
    [
      'mismatched repository',
      async () => successfulResponse({ repositories: [{ id: 999 }] }),
    ],
    [
      'multiple repositories',
      async () =>
        successfulResponse({ repositories: [{ id: 123 }, { id: 999 }] }),
    ],
    [
      'unrestricted selection',
      async () => successfulResponse({ repository_selection: 'all' }),
    ],
    ['malformed token', async () => successfulResponse({ token: '' })],
    [
      'malformed expiry',
      async () => successfulResponse({ expires_at: 'not-a-time' }),
    ],
  ])(
    'makes ambiguous %s failure generic and never retries',
    async (_name, call) => {
      const test = harness({ request: call });
      let error: unknown;
      try {
        await test.minter.mint(PLAN);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(GitHubInstallationTokenMintUnknownError);
      expect((error as Error).message).toBe(
        'GitHub installation token mint outcome is unknown',
      );
      expect(JSON.stringify(error)).not.toContain('secret');
      expect(test.request).toHaveBeenCalledTimes(1);
    },
  );

  it('accepts the documented minimal success response', async () => {
    const test = harness({
      request: async () =>
        response({ token: INSTALLATION_TOKEN, expires_at: EXPIRES_AT }),
    });
    await expect(test.minter.mint(PLAN)).resolves.toEqual({
      kind: 'issued',
      token: INSTALLATION_TOKEN,
      tokenExpiresAt: EXPIRES_AT,
    });
  });

  it('accepts documented optional repository fields without returning them', async () => {
    const test = harness({
      request: async () =>
        successfulResponse({
          repositories: [
            {
              id: PLAN.repositoryId,
              full_name: 'octo/example',
              provider_secret: 'never-returned',
            },
          ],
          single_file: null,
        }),
    });
    const result = await test.minter.mint(PLAN);
    expect(result).toEqual({
      kind: 'issued',
      token: INSTALLATION_TOKEN,
      tokenExpiresAt: EXPIRES_AT,
    });
    expect(JSON.stringify(result)).not.toContain('provider_secret');
  });

  it('lets the mint boundary reject expired and over-one-hour token lifetimes', async () => {
    for (const expires_at of [
      '2026-08-14T19:59:59.000Z',
      '2026-08-14T21:00:00.001Z',
    ]) {
      const test = harness({
        request: async () => successfulResponse({ expires_at }),
      });
      const boundary = new InstallationTokenMinterBoundary(test.minter, {
        now: () => '2026-08-14T20:00:00.000Z',
      });
      await expect(
        boundary.mint(PLAN, {
          grantId: 'grant-1',
          attemptId: 'A'.repeat(22),
          requestId: 'request-1',
          credentialProfileId: PLAN.credentialProfileId,
          issuanceState: 'pending',
          mintState: 'mint-in-progress',
          mintStartedAt: '2026-08-14T19:59:00.000Z',
        }),
      ).rejects.toThrow('lifetime contract');
      expect(test.request).toHaveBeenCalledTimes(1);
    }
  });
});
