// This module does real WebCrypto RS256 signing (via jose's `SignJWT`):
// under the workspace-default jsdom environment, that fails with "payload
// must be an instance of Uint8Array" -- jsdom's window is torn down and
// rebuilt between Vitest's collection and run phases, so `jose`'s
// module-scoped `TextEncoder` (created once, at collection time) produces
// `Uint8Array` instances from a different realm than the one active when
// signing actually runs. github-app-tokens.ts is server-only (no DOM), so
// running this file in the real `node` environment sidesteps the mismatch
// entirely (vitest-setup.ts guards its `window` use accordingly).
// @vitest-environment node

import { generateKeyPairSync } from 'node:crypto';

import { decodeJwt, decodeProtectedHeader } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AppInstallationTokenProvider,
  createDispatchTokenProvider,
  createGithubClientAuthStrategy,
  REPO_HEADER,
  resolveRequestRepo,
} from './github-app-tokens';

const CLIENT_ID = 'Iv1.test0123456789ab';
const REPO = 'octo/example';
// No `AGENT_LCARS_CONTROL_PLANE_REPOSITORY` is set in this test
// environment, so `controlPlaneRepository()` falls back to this
// deployment's default -- see deployment.ts/.test.ts and
// github-actions-oidc.test.ts's identical convention.
const HOME_REPO = 'jlapenna/agent-lcars';

// Real RS256 keypair, generated once for the whole file: `SignJWT` needs a
// real key to sign against, and the JWT-shape tests decode (never verify)
// the result, so a fixed key is fine to reuse across tests.
const { privateKey: PRIVATE_KEY_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

// A second throwaway keypair, encoded as PKCS1 (`BEGIN RSA PRIVATE KEY`) --
// the format GitHub's App settings page's "Generate a private key" button
// actually downloads (#1276), and which `importPKCS8` used to reject.
const { privateKey: PRIVATE_KEY_PEM_PKCS1 } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** A URL-aware fake fetch for the App flow's two endpoints: installation
 *  resolution (`GET .../installation`) and access-token minting
 *  (`POST .../access_tokens`). Defaults to a happy-path response for both,
 *  overridable per test. */
function fakeAppFetch(overrides?: {
  installationStatus?: number;
  installationBody?: unknown;
  tokenStatus?: number;
  tokenBody?: unknown;
}): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const {
    installationStatus = 200,
    installationBody = { id: 987 },
    tokenStatus = 201,
    tokenBody = {
      token: 'ghs_minted-token',
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
  } = overrides ?? {};
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body:
        init?.body === undefined
          ? undefined
          : (JSON.parse(String(init.body)) as unknown),
    });
    if (url.endsWith('/installation')) {
      return new Response(JSON.stringify(installationBody), {
        status: installationStatus,
      });
    }
    return new Response(JSON.stringify(tokenBody), { status: tokenStatus });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('AppInstallationTokenProvider', () => {
  it('mints a well-formed App JWT: RS256, iss = clientId, 9-minute expiry with a 60s clock-skew backdated iat', async () => {
    const { fetchImpl, calls } = fakeAppFetch();
    const provider = new AppInstallationTokenProvider({
      clientId: CLIENT_ID,
      privateKeyPem: PRIVATE_KEY_PEM,
      fetchImpl,
    });

    await provider.tokenFor(REPO);

    const authHeader = calls[0]?.headers['Authorization'];
    expect(authHeader).toMatch(/^Bearer /);
    const jwt = authHeader!.slice('Bearer '.length);

    // Decoded, never verified -- there is no public key to verify against
    // here, and this test only asserts the *shape* mintAppJwt produces.
    const header = decodeProtectedHeader(jwt);
    expect(header.alg).toBe('RS256');

    const payload = decodeJwt(jwt);
    expect(payload.iss).toBe(CLIENT_ID);
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
    // 9 minutes of validity plus the 60s backdate on `iat` -- independent
    // of real wall-clock time, so this is not flaky under load.
    expect(payload.exp! - payload.iat!).toBe(9 * 60 + 60);
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(payload.iat).toBeLessThanOrEqual(nowSeconds - 59);
    expect(payload.iat).toBeGreaterThanOrEqual(nowSeconds - 65);
  });

  it('mints a well-formed App JWT from a PKCS1-encoded key (the format GitHub downloads, #1276)', async () => {
    const { fetchImpl, calls } = fakeAppFetch();
    const provider = new AppInstallationTokenProvider({
      clientId: CLIENT_ID,
      privateKeyPem: PRIVATE_KEY_PEM_PKCS1,
      fetchImpl,
    });

    const token = await provider.tokenFor(REPO);
    expect(token).toBe('ghs_minted-token');

    const authHeader = calls[0]?.headers['Authorization'];
    expect(authHeader).toMatch(/^Bearer /);
    const jwt = authHeader!.slice('Bearer '.length);
    const header = decodeProtectedHeader(jwt);
    expect(header.alg).toBe('RS256');
    const payload = decodeJwt(jwt);
    expect(payload.iss).toBe(CLIENT_ID);
  });

  it('resolves the installation id before minting a scoped access token', async () => {
    const { fetchImpl, calls } = fakeAppFetch({
      installationBody: { id: 555 },
    });
    const provider = new AppInstallationTokenProvider({
      clientId: CLIENT_ID,
      privateKeyPem: PRIVATE_KEY_PEM,
      fetchImpl,
    });

    const token = await provider.tokenFor(REPO);

    expect(token).toBe('ghs_minted-token');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(
      `https://api.github.com/repos/${REPO}/installation`,
    );
    expect(calls[0]?.method).toBe('GET');
    expect(calls[1]?.url).toBe(
      'https://api.github.com/app/installations/555/access_tokens',
    );
    expect(calls[1]?.method).toBe('POST');
  });

  it('mints an access token scoped to just this repo with actions/issues/pull_requests write', async () => {
    const { fetchImpl, calls } = fakeAppFetch();
    const provider = new AppInstallationTokenProvider({
      clientId: CLIENT_ID,
      privateKeyPem: PRIVATE_KEY_PEM,
      fetchImpl,
    });

    await provider.tokenFor(REPO);

    // `pull_requests` (alongside `issues`) is required: GitHub's
    // issue-comment endpoint authorizes a PR-anchored comment against
    // `pull_requests`, not `issues` -- see `DEFAULT_PERMISSIONS`'s doc
    // comment in github-app-tokens.ts for the production incident this
    // pins (every PR-anchored outcome report 403ing).
    expect(calls[1]?.body).toEqual({
      repositories: ['example'],
      permissions: {
        actions: 'write',
        issues: 'write',
        pull_requests: 'write',
      },
    });
  });

  it('requests a caller-supplied permission set instead of the default, when given one', async () => {
    const { fetchImpl, calls } = fakeAppFetch();
    const provider = new AppInstallationTokenProvider({
      clientId: CLIENT_ID,
      privateKeyPem: PRIVATE_KEY_PEM,
      fetchImpl,
      permissions: {
        actions: 'write',
        contents: 'write',
        issues: 'write',
        pull_requests: 'write',
      },
    });

    await provider.tokenFor(REPO);

    expect(calls[1]?.body).toEqual({
      repositories: ['example'],
      permissions: {
        actions: 'write',
        contents: 'write',
        issues: 'write',
        pull_requests: 'write',
      },
    });
  });

  it('caches the minted token: a second call within its expiry window does not re-fetch', async () => {
    const { fetchImpl, calls } = fakeAppFetch();
    const provider = new AppInstallationTokenProvider({
      clientId: CLIENT_ID,
      privateKeyPem: PRIVATE_KEY_PEM,
      fetchImpl,
    });

    const first = await provider.tokenFor(REPO);
    expect(calls).toHaveLength(2);

    const second = await provider.tokenFor(REPO);
    expect(second).toBe(first);
    expect(calls).toHaveLength(2); // no additional fetch calls
  });

  it('refreshes when the cached token is within 5 minutes of expiry', async () => {
    const { fetchImpl, calls } = fakeAppFetch({
      tokenBody: {
        token: 'ghs_almost-expired',
        // Already inside the 5-minute refresh buffer relative to "now" --
        // no need to fake the passage of time to exercise the refresh path.
        expires_at: new Date(Date.now() + 4 * 60 * 1000).toISOString(),
      },
    });
    const provider = new AppInstallationTokenProvider({
      clientId: CLIENT_ID,
      privateKeyPem: PRIVATE_KEY_PEM,
      fetchImpl,
    });

    await provider.tokenFor(REPO);
    expect(calls).toHaveLength(2);

    await provider.tokenFor(REPO);
    expect(calls).toHaveLength(4); // installation + access-token, re-minted
  });

  it('caches per repo independently', async () => {
    const { fetchImpl, calls } = fakeAppFetch();
    const provider = new AppInstallationTokenProvider({
      clientId: CLIENT_ID,
      privateKeyPem: PRIVATE_KEY_PEM,
      fetchImpl,
    });

    await provider.tokenFor('octo/example');
    await provider.tokenFor('octo/other');
    expect(calls).toHaveLength(4);

    await provider.tokenFor('octo/example');
    await provider.tokenFor('octo/other');
    expect(calls).toHaveLength(4); // both served from cache
  });

  describe('invalidate', () => {
    it('forces the next tokenFor(repo) call to re-mint instead of serving the cache', async () => {
      const { fetchImpl, calls } = fakeAppFetch();
      const provider = new AppInstallationTokenProvider({
        clientId: CLIENT_ID,
        privateKeyPem: PRIVATE_KEY_PEM,
        fetchImpl,
      });

      await provider.tokenFor(REPO);
      expect(calls).toHaveLength(2);

      provider.invalidate(REPO);
      await provider.tokenFor(REPO);
      expect(calls).toHaveLength(4); // re-minted, not served from cache
    });

    it('only drops the invalidated repo, leaving other repos cached', async () => {
      const { fetchImpl, calls } = fakeAppFetch();
      const provider = new AppInstallationTokenProvider({
        clientId: CLIENT_ID,
        privateKeyPem: PRIVATE_KEY_PEM,
        fetchImpl,
      });

      await provider.tokenFor('octo/example');
      await provider.tokenFor('octo/other');
      expect(calls).toHaveLength(4);

      provider.invalidate('octo/example');
      await provider.tokenFor('octo/other');
      expect(calls).toHaveLength(4); // still cached, no new fetch

      await provider.tokenFor('octo/example');
      expect(calls).toHaveLength(6); // re-minted
    });

    it('is a no-op for a repo that was never cached', async () => {
      const { fetchImpl, calls } = fakeAppFetch();
      const provider = new AppInstallationTokenProvider({
        clientId: CLIENT_ID,
        privateKeyPem: PRIVATE_KEY_PEM,
        fetchImpl,
      });

      expect(() => provider.invalidate('never/cached')).not.toThrow();
      expect(calls).toHaveLength(0);
    });
  });

  describe('error paths leak no secrets', () => {
    it('fails clearly when the installation lookup fails, without echoing the JWT or private key', async () => {
      const { fetchImpl } = fakeAppFetch({
        installationStatus: 404,
        installationBody: { message: 'Not Found' },
      });
      const provider = new AppInstallationTokenProvider({
        clientId: CLIENT_ID,
        privateKeyPem: PRIVATE_KEY_PEM,
        fetchImpl,
      });

      await expect(provider.tokenFor(REPO)).rejects.toThrow(
        `failed to resolve GitHub App installation for ${REPO}: GitHub returned 404`,
      );
    });

    it('fails clearly when the access-token mint fails, without echoing the JWT or private key', async () => {
      const { fetchImpl } = fakeAppFetch({
        tokenStatus: 403,
        tokenBody: { message: 'Forbidden' },
      });
      const provider = new AppInstallationTokenProvider({
        clientId: CLIENT_ID,
        privateKeyPem: PRIVATE_KEY_PEM,
        fetchImpl,
      });

      let error: unknown;
      try {
        await provider.tokenFor(REPO);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toBe(
        `failed to mint GitHub App installation access token for ${REPO}: GitHub returned 403`,
      );
      expect(message).not.toContain(PRIVATE_KEY_PEM);
      expect(message).not.toContain('BEGIN PRIVATE KEY');
      // No JWT (three dot-separated base64url segments) leaked either.
      expect(message).not.toMatch(/[\w-]+\.[\w-]+\.[\w-]+/);
    });

    it('wraps a network failure during installation resolution with a clear, token-free message', async () => {
      const throwingFetch = (async () => {
        throw new TypeError(
          'fetch failed: getaddrinfo ENOTFOUND api.github.com',
        );
      }) as typeof fetch;
      const provider = new AppInstallationTokenProvider({
        clientId: CLIENT_ID,
        privateKeyPem: PRIVATE_KEY_PEM,
        fetchImpl: throwingFetch,
      });

      await expect(provider.tokenFor(REPO)).rejects.toThrow(
        `failed to resolve GitHub App installation for ${REPO}: fetch failed: getaddrinfo ENOTFOUND api.github.com`,
      );
    });

    it('fails clearly, without leaking the PEM, when the private key is not a valid PEM at all', async () => {
      const { fetchImpl } = fakeAppFetch();
      const provider = new AppInstallationTokenProvider({
        clientId: CLIENT_ID,
        privateKeyPem: 'not-a-real-pem',
        fetchImpl,
      });

      let error: unknown;
      try {
        await provider.tokenFor(REPO);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toBe(
        'GitHub App private key is not a valid PEM-encoded RSA private key (PKCS1 or PKCS8)',
      );
      expect(message).not.toContain('not-a-real-pem');
    });
  });
});

describe('createDispatchTokenProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws when AGENT_LCARS_APP_CLIENT_ID is unset', () => {
    expect(() =>
      createDispatchTokenProvider({
        AGENT_LCARS_APP_PRIVATE_KEY: PRIVATE_KEY_PEM,
      }),
    ).toThrow('process.env.AGENT_LCARS_APP_CLIENT_ID not defined');
  });

  it('throws when AGENT_LCARS_APP_CLIENT_ID is unset even with nothing else set', () => {
    expect(() => createDispatchTokenProvider({})).toThrow(
      'process.env.AGENT_LCARS_APP_CLIENT_ID not defined',
    );
  });

  it('throws when AGENT_LCARS_APP_PRIVATE_KEY is unset', () => {
    expect(() =>
      createDispatchTokenProvider({
        AGENT_LCARS_APP_CLIENT_ID: CLIENT_ID,
      }),
    ).toThrow('process.env.AGENT_LCARS_APP_PRIVATE_KEY not defined');
  });

  it('#1284: returns an AppInstallationTokenProvider -- there is no more ambient-token fallback for any repo, home included', () => {
    const provider = createDispatchTokenProvider({
      AGENT_LCARS_APP_CLIENT_ID: CLIENT_ID,
      AGENT_LCARS_APP_PRIVATE_KEY: PRIVATE_KEY_PEM,
    });

    expect(provider).toBeInstanceOf(AppInstallationTokenProvider);
  });

  it('#1284: routes the home repo through the App installation-token flow, same as any other repo', async () => {
    const { fetchImpl, calls } = fakeAppFetch({
      tokenBody: {
        token: 'ghs_home-repo-token',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });
    vi.stubGlobal('fetch', fetchImpl);

    const provider = createDispatchTokenProvider({
      AGENT_LCARS_APP_CLIENT_ID: CLIENT_ID,
      AGENT_LCARS_APP_PRIVATE_KEY: PRIVATE_KEY_PEM,
    });

    const token = await provider.tokenFor(HOME_REPO);
    expect(token).toBe('ghs_home-repo-token');
    expect(
      calls.some((c) => c.url.endsWith(`/repos/${HOME_REPO}/installation`)),
    ).toBe(true);
  });

  it('routes a foreign repo through the same App installation-token flow', async () => {
    const { fetchImpl, calls } = fakeAppFetch({
      tokenBody: {
        token: 'ghs_foreign-repo-token',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });
    vi.stubGlobal('fetch', fetchImpl);

    const provider = createDispatchTokenProvider({
      AGENT_LCARS_APP_CLIENT_ID: CLIENT_ID,
      AGENT_LCARS_APP_PRIVATE_KEY: PRIVATE_KEY_PEM,
    });

    const token = await provider.tokenFor('sprinkles/some-repo');
    expect(token).toBe('ghs_foreign-repo-token');
    expect(
      calls.some((c) =>
        c.url.endsWith('/repos/sprinkles/some-repo/installation'),
      ),
    ).toBe(true);
  });

  it('#1276: throws at construction time (not first dispatch) when the App private key does not parse, without ever touching fetch', () => {
    const neverCalled = vi.fn();
    vi.stubGlobal('fetch', neverCalled);

    expect(() =>
      createDispatchTokenProvider({
        AGENT_LCARS_APP_CLIENT_ID: CLIENT_ID,
        AGENT_LCARS_APP_PRIVATE_KEY: 'not-a-real-pem',
      }),
    ).toThrow(
      'GitHub App private key is not a valid PEM-encoded RSA private key (PKCS1 or PKCS8)',
    );
    // The failure is synchronous, during construction -- no attempt to
    // resolve an installation or mint a token was ever made, unlike the
    // pre-#1276 behavior where this only surfaced on the first foreign-repo
    // `tokenFor` call.
    expect(neverCalled).not.toHaveBeenCalled();
  });

  it('#1276: a PKCS1-encoded App private key (the format GitHub downloads) does NOT throw at construction', () => {
    expect(() =>
      createDispatchTokenProvider({
        AGENT_LCARS_APP_CLIENT_ID: CLIENT_ID,
        AGENT_LCARS_APP_PRIVATE_KEY: PRIVATE_KEY_PEM_PKCS1,
      }),
    ).not.toThrow();
  });
});

describe('resolveRequestRepo', () => {
  it('derives owner/repo from REST-shaped structured parameters', () => {
    expect(resolveRequestRepo({ owner: 'octo', repo: 'example' })).toBe(
      'octo/example',
    );
  });

  it('derives owner/name from GraphQL variables (item-enrichment.ts convention)', () => {
    expect(
      resolveRequestRepo({
        variables: { owner: 'octo', name: 'example' },
      }),
    ).toBe('octo/example');
  });

  it('prefers the explicit REPO_HEADER override over structured owner/repo', () => {
    expect(
      resolveRequestRepo({
        owner: 'wrong-owner',
        repo: 'wrong-repo',
        headers: { [REPO_HEADER]: 'octo/example' },
      }),
    ).toBe('octo/example');
  });

  it('falls back to the header when no structured owner/repo or variables are present (the search/GraphQL-mutation case)', () => {
    expect(
      resolveRequestRepo({
        headers: { [REPO_HEADER]: 'octo/example' },
      }),
    ).toBe('octo/example');
  });

  it('returns undefined when nothing resolves', () => {
    expect(resolveRequestRepo({})).toBeUndefined();
    expect(resolveRequestRepo({ owner: 'octo' })).toBeUndefined();
    expect(
      resolveRequestRepo({ variables: { owner: 'octo' } }),
    ).toBeUndefined();
  });
});

describe('createGithubClientAuthStrategy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A minimal fake matching the shape `createGithubClientAuthStrategy`'s
   *  hook actually calls: `request.endpoint.merge(route, parameters)` plus
   *  `request(options)` itself. Captures every `request(options)` call so
   *  tests can assert on the Authorization header actually sent. */
  function fakeOctokitRequest(responses: (Record<string, unknown> | Error)[]) {
    const calls: Record<string, unknown>[] = [];
    let callIndex = 0;
    const request = Object.assign(
      async (options: Record<string, unknown>) => {
        calls.push(options);
        const response = responses[Math.min(callIndex, responses.length - 1)];
        callIndex += 1;
        if (response instanceof Error) throw response;
        return response;
      },
      {
        endpoint: {
          merge: (
            route: unknown,
            parameters?: Record<string, unknown>,
          ): Record<string, unknown> =>
            typeof route === 'string'
              ? {
                  method: route.split(' ')[0],
                  url: route.split(' ')[1],
                  ...parameters,
                }
              : { ...(route as Record<string, unknown>), ...parameters },
        },
      },
    );
    return { request, calls };
  }

  it('routes a REST-shaped request to a token minted for its owner/repo', async () => {
    const { fetchImpl } = fakeAppFetch({
      tokenBody: {
        token: 'ghs_routed-token',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });
    const strategy = createGithubClientAuthStrategy({
      clientId: CLIENT_ID,
      privateKeyPem: PRIVATE_KEY_PEM,
      fetchImpl,
    });
    const { request, calls } = fakeOctokitRequest([{ status: 200 }]);

    await strategy.hook(request, {
      method: 'GET',
      url: '/repos/{owner}/{repo}',
      owner: 'octo',
      repo: 'example',
      headers: {},
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers).toMatchObject({
      authorization: 'token ghs_routed-token',
    });
  });

  it('routes a GraphQL request via its owner/name variables', async () => {
    const { fetchImpl } = fakeAppFetch({
      tokenBody: {
        token: 'ghs_graphql-token',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });
    const strategy = createGithubClientAuthStrategy({
      clientId: CLIENT_ID,
      privateKeyPem: PRIVATE_KEY_PEM,
      fetchImpl,
    });
    const { request, calls } = fakeOctokitRequest([{ status: 200 }]);

    await strategy.hook(request, {
      method: 'POST',
      url: '/graphql',
      variables: { owner: 'octo', name: 'example' },
      headers: {},
    });

    expect(calls[0]?.headers).toMatchObject({
      authorization: 'token ghs_graphql-token',
    });
  });

  it('routes via an explicit REPO_HEADER override and strips the header before sending', async () => {
    const { fetchImpl } = fakeAppFetch({
      tokenBody: {
        token: 'ghs_header-routed-token',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });
    const strategy = createGithubClientAuthStrategy({
      clientId: CLIENT_ID,
      privateKeyPem: PRIVATE_KEY_PEM,
      fetchImpl,
    });
    const { request, calls } = fakeOctokitRequest([{ status: 200 }]);

    await strategy.hook(request, {
      method: 'POST',
      url: '/graphql',
      variables: { pullRequestId: 'PR_kwabc' },
      headers: { [REPO_HEADER]: 'octo/example' },
    });

    expect(calls[0]?.headers).toMatchObject({
      authorization: 'token ghs_header-routed-token',
    });
    expect(calls[0]?.headers).not.toHaveProperty(REPO_HEADER);
  });

  it('throws a clear error, without ever calling fetch, when no repo can be resolved', async () => {
    const neverCalled = vi.fn();
    const strategy = createGithubClientAuthStrategy({
      clientId: CLIENT_ID,
      privateKeyPem: PRIVATE_KEY_PEM,
      fetchImpl: neverCalled as unknown as typeof fetch,
    });
    const { request } = fakeOctokitRequest([{ status: 200 }]);

    await expect(
      strategy.hook(request, {
        method: 'GET',
        url: '/user',
        headers: {},
      }),
    ).rejects.toThrow(/cannot determine the target repo/);
    expect(neverCalled).not.toHaveBeenCalled();
  });

  it('retries exactly once with a freshly minted token after a 401, then succeeds', async () => {
    const { fetchImpl } = fakeAppFetch({
      tokenBody: {
        token: 'ghs_first-token',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });
    const strategy = createGithubClientAuthStrategy({
      clientId: CLIENT_ID,
      privateKeyPem: PRIVATE_KEY_PEM,
      fetchImpl,
    });
    const unauthorized = Object.assign(new Error('Bad credentials'), {
      status: 401,
    });
    const { request, calls } = fakeOctokitRequest([
      unauthorized,
      { status: 200 },
    ]);

    const result = await strategy.hook(request, {
      method: 'GET',
      url: '/repos/{owner}/{repo}',
      owner: 'octo',
      repo: 'example',
      headers: {},
    });

    expect(result).toEqual({ status: 200 });
    expect(calls).toHaveLength(2);
    // Both attempts carry the same token here (fakeAppFetch always mints
    // the same fixed response) - what matters is that a fresh mint was
    // actually attempted (provider.invalidate + a second tokenFor), not
    // that the retried request just replayed the first failed attempt.
    expect(calls[0]?.headers).toMatchObject({
      authorization: 'token ghs_first-token',
    });
    expect(calls[1]?.headers).toMatchObject({
      authorization: 'token ghs_first-token',
    });
  });

  it('does not retry a non-401 failure', async () => {
    const { fetchImpl } = fakeAppFetch({
      tokenBody: {
        token: 'ghs_token',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });
    const strategy = createGithubClientAuthStrategy({
      clientId: CLIENT_ID,
      privateKeyPem: PRIVATE_KEY_PEM,
      fetchImpl,
    });
    const serverError = Object.assign(new Error('Internal Server Error'), {
      status: 500,
    });
    const { request, calls } = fakeOctokitRequest([
      serverError,
      { status: 200 },
    ]);

    await expect(
      strategy.hook(request, {
        method: 'GET',
        url: '/repos/{owner}/{repo}',
        owner: 'octo',
        repo: 'example',
        headers: {},
      }),
    ).rejects.toThrow('Internal Server Error');
    expect(calls).toHaveLength(1);
  });

  it('forwards a caller-supplied permission set to the underlying provider mint', async () => {
    const { fetchImpl, calls: appCalls } = fakeAppFetch();
    const strategy = createGithubClientAuthStrategy({
      clientId: CLIENT_ID,
      privateKeyPem: PRIVATE_KEY_PEM,
      fetchImpl,
      permissions: { issues: 'write', pull_requests: 'write' },
    });
    const { request } = fakeOctokitRequest([{ status: 200 }]);

    await strategy.hook(request, {
      method: 'GET',
      url: '/repos/{owner}/{repo}',
      owner: 'octo',
      repo: 'example',
      headers: {},
    });

    expect(appCalls[1]?.body).toEqual({
      repositories: ['example'],
      permissions: { issues: 'write', pull_requests: 'write' },
    });
  });
});
