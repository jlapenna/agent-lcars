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
  AmbientTokenProvider,
  AppInstallationTokenProvider,
  createDispatchTokenProvider,
} from './github-app-tokens';

const CLIENT_ID = 'Iv1.test0123456789ab';
const REPO = 'octo/example';
// No `AGENT_LCARS_CONTROL_PLANE_REPOSITORY` is set in this test
// environment, so `controlPlaneRepository()` falls back to this
// deployment's default -- see deployment.ts/.test.ts and
// github-actions-oidc.test.ts's identical convention.
const HOME_REPO = 'jlapenna/agent-lcars';
const AMBIENT_TOKEN = 'gh-ambient-token-0123456789';

// Real RS256 keypair, generated once for the whole file: `SignJWT` needs a
// real key to sign against, and the JWT-shape tests decode (never verify)
// the result, so a fixed key is fine to reuse across tests.
const { privateKey: PRIVATE_KEY_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
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

describe('AmbientTokenProvider', () => {
  it('returns the same static token regardless of repo', async () => {
    const provider = new AmbientTokenProvider(AMBIENT_TOKEN);
    await expect(provider.tokenFor(REPO)).resolves.toBe(AMBIENT_TOKEN);
    await expect(provider.tokenFor('other/repo')).resolves.toBe(AMBIENT_TOKEN);
  });
});

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

  it('mints an access token scoped to just this repo with actions/issues write', async () => {
    const { fetchImpl, calls } = fakeAppFetch();
    const provider = new AppInstallationTokenProvider({
      clientId: CLIENT_ID,
      privateKeyPem: PRIVATE_KEY_PEM,
      fetchImpl,
    });

    await provider.tokenFor(REPO);

    expect(calls[1]?.body).toEqual({
      repositories: ['example'],
      permissions: { actions: 'write', issues: 'write' },
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

    it('fails clearly, without leaking the PEM, when the private key is not valid PKCS8', async () => {
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
        'GitHub App private key is not a valid PKCS8 RSA PEM',
      );
      expect(message).not.toContain('not-a-real-pem');
    });
  });
});

describe('createDispatchTokenProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws when AGENT_LCARS_GITHUB_TOKEN is unset, App envs unset', () => {
    expect(() => createDispatchTokenProvider({})).toThrow(
      'process.env.AGENT_LCARS_GITHUB_TOKEN not defined',
    );
  });

  it('throws when AGENT_LCARS_GITHUB_TOKEN is unset even with App envs set (home repo still needs it)', () => {
    expect(() =>
      createDispatchTokenProvider({
        AGENT_LCARS_APP_CLIENT_ID: CLIENT_ID,
        AGENT_LCARS_APP_PRIVATE_KEY: PRIVATE_KEY_PEM,
      }),
    ).toThrow('process.env.AGENT_LCARS_GITHUB_TOKEN not defined');
  });

  it('INERTNESS: with both App envs unset, returns an AmbientTokenProvider used for every repo -- byte-identical to pre-#1190 behavior', async () => {
    const provider = createDispatchTokenProvider({
      AGENT_LCARS_GITHUB_TOKEN: AMBIENT_TOKEN,
    });

    expect(provider).toBeInstanceOf(AmbientTokenProvider);
    await expect(provider.tokenFor(HOME_REPO)).resolves.toBe(AMBIENT_TOKEN);
    await expect(provider.tokenFor('sprinkles/some-repo')).resolves.toBe(
      AMBIENT_TOKEN,
    );
  });

  it('INERTNESS: with only one of the two App envs set, still falls back to the ambient token for every repo', async () => {
    const clientIdOnly = createDispatchTokenProvider({
      AGENT_LCARS_GITHUB_TOKEN: AMBIENT_TOKEN,
      AGENT_LCARS_APP_CLIENT_ID: CLIENT_ID,
    });
    expect(clientIdOnly).toBeInstanceOf(AmbientTokenProvider);
    await expect(clientIdOnly.tokenFor('sprinkles/some-repo')).resolves.toBe(
      AMBIENT_TOKEN,
    );

    const privateKeyOnly = createDispatchTokenProvider({
      AGENT_LCARS_GITHUB_TOKEN: AMBIENT_TOKEN,
      AGENT_LCARS_APP_PRIVATE_KEY: PRIVATE_KEY_PEM,
    });
    expect(privateKeyOnly).toBeInstanceOf(AmbientTokenProvider);
    await expect(privateKeyOnly.tokenFor('sprinkles/some-repo')).resolves.toBe(
      AMBIENT_TOKEN,
    );
  });

  it('with both App envs set, routes the home repo to the ambient token without ever touching fetch', async () => {
    const neverCalled = vi.fn();
    vi.stubGlobal('fetch', neverCalled);

    const provider = createDispatchTokenProvider({
      AGENT_LCARS_GITHUB_TOKEN: AMBIENT_TOKEN,
      AGENT_LCARS_APP_CLIENT_ID: CLIENT_ID,
      AGENT_LCARS_APP_PRIVATE_KEY: PRIVATE_KEY_PEM,
    });

    await expect(provider.tokenFor(HOME_REPO)).resolves.toBe(AMBIENT_TOKEN);
    expect(neverCalled).not.toHaveBeenCalled();
  });

  it('with both App envs set, routes a foreign repo through the App installation-token flow', async () => {
    const { fetchImpl, calls } = fakeAppFetch({
      tokenBody: {
        token: 'ghs_foreign-repo-token',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });
    vi.stubGlobal('fetch', fetchImpl);

    const provider = createDispatchTokenProvider({
      AGENT_LCARS_GITHUB_TOKEN: AMBIENT_TOKEN,
      AGENT_LCARS_APP_CLIENT_ID: CLIENT_ID,
      AGENT_LCARS_APP_PRIVATE_KEY: PRIVATE_KEY_PEM,
    });

    const token = await provider.tokenFor('sprinkles/some-repo');
    expect(token).toBe('ghs_foreign-repo-token');
    expect(token).not.toBe(AMBIENT_TOKEN);
    expect(
      calls.some((c) =>
        c.url.endsWith('/repos/sprinkles/some-repo/installation'),
      ),
    ).toBe(true);
  });
});
