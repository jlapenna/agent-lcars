import { generateKeyPairSync } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_WATCHED_REPOS,
  getWatchedRepos,
  repoDisplayName,
  repoItemKey,
  repoKey,
  resolveWatchedRepo,
  UnwatchedRepoError,
} from './github-client';

/**
 * These suites reset the module registry in `beforeEach` (getGithubClient
 * memoizes its client at module scope, so each test needs a fresh
 * evaluation). A static import would bind the pre-reset instance once and
 * every test after the first would assert against a stale module - so the
 * dynamic import is the mechanism, not a style choice. Funnelled through
 * one helper so the reason is stated once instead of at fourteen call
 * sites.
 */
function freshGithubClientModule() {
  // eslint-disable-next-line no-restricted-syntax -- see above: vi.resetModules() invalidates the registry a static import would have bound.
  return import('./github-client');
}

const ENV_KEY = 'AGENT_LCARS_WATCHED_REPOS';
const CLAUDE_INTEGRATION = {
  label: 'agent:claude',
  replyTrigger: '@claude',
};

afterEach(() => {
  delete process.env[ENV_KEY];
});

// getGithubClient constructs a real @octokit/rest client wired up with the
// retry/throttling plugins; capturing the constructor args this way checks
// the actual options getGithubClient passes rather than re-testing the
// plugins' own retry/throttle mechanics (that's their test suite's job).
const octokitConstructorSpy = vi.fn();

vi.mock('@octokit/rest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@octokit/rest')>();
  class SpyOctokit extends actual.Octokit {
    constructor(options: ConstructorParameters<typeof actual.Octokit>[0]) {
      octokitConstructorSpy(options);
      super(options);
    }
  }
  return { Octokit: SpyOctokit };
});

describe('getGithubClient', () => {
  const BASE_URL_ENV_KEY = 'AGENT_CONSOLE_GITHUB_API_BASE_URL';
  // None of these tests are about auth (that's `describe('getGithubClient
  // auth')` below) - they exercise the retry/throttle/timeout mechanics
  // that are identical regardless of which auth branch getGithubClient()
  // takes. Setting the e2e fixture base URL selects the static-token
  // branch (see getGithubClient()'s own comment), which needs no App
  // credentials and never mints a real token, keeping these tests decoupled
  // from #1284's App-token machinery entirely.
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    octokitConstructorSpy.mockClear();
    process.env[BASE_URL_ENV_KEY] = 'https://example.invalid/e2e-fixture';
    warnSpy = vi.spyOn(console, 'warn').mockReturnValue(undefined);
  });

  afterEach(() => {
    delete process.env[BASE_URL_ENV_KEY];
    warnSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('configures a bounded retry budget and rate-limit throttling', async () => {
    const { getGithubClient } = await freshGithubClientModule();
    getGithubClient();

    expect(octokitConstructorSpy).toHaveBeenCalledTimes(1);
    const options = octokitConstructorSpy.mock.calls[0][0];

    expect(options.retry).toEqual({ retries: 2 });
    expect(typeof options.throttle.onRateLimit).toBe('function');
    expect(typeof options.throttle.onSecondaryRateLimit).toBe('function');
    expect(typeof options.request.fetch).toBe('function');
  });

  it('caches the client across calls instead of constructing a new one', async () => {
    const { getGithubClient } = await freshGithubClientModule();

    const first = getGithubClient();
    const second = getGithubClient();

    expect(second).toBe(first);
    expect(octokitConstructorSpy).toHaveBeenCalledTimes(1);
  });

  it('retries a rate-limited request within the wait budget, up to the attempt budget, then gives up', async () => {
    const { getGithubClient } = await freshGithubClientModule();
    getGithubClient();
    const options = octokitConstructorSpy.mock.calls[0][0];
    const fakeRequest = {
      method: 'GET',
      url: 'https://api.github.com/repos/o/r',
    };

    // retryAfter=5s is well within the 15s wait budget, so only the
    // attempt-count budget (2) governs these.
    expect(options.throttle.onRateLimit(5, fakeRequest, {}, 0)).toBe(true);
    expect(options.throttle.onRateLimit(5, fakeRequest, {}, 1)).toBe(true);
    expect(options.throttle.onRateLimit(5, fakeRequest, {}, 2)).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy.mock.calls[0][0]).toMatch(
      /^agent-lcars: GitHub rate limit hit/,
    );
    // Last argument is the retrying/giving-up suffix.
    expect(warnSpy.mock.calls[0].at(-1)).toMatch(/retrying/);
    expect(warnSpy.mock.calls[2].at(-1)).toMatch(/giving up/);
  });

  it('declines a rate-limited retry whose retryAfter exceeds the wait budget, even on the first attempt', async () => {
    const { getGithubClient } = await freshGithubClientModule();
    getGithubClient();
    const options = octokitConstructorSpy.mock.calls[0][0];
    const fakeRequest = {
      method: 'GET',
      url: 'https://api.github.com/repos/o/r',
    };

    // GitHub's own retryAfter (120s) blows past the 15s wait budget - the
    // throttling plugin would otherwise block its shared queue for the
    // full 120s before timeoutFetch's own AbortSignal ever gets a turn.
    expect(options.throttle.onRateLimit(120, fakeRequest, {}, 0)).toBe(false);
    expect(warnSpy.mock.calls[0][0]).toMatch(
      /^agent-lcars: GitHub rate limit hit/,
    );
    expect(warnSpy.mock.calls[0].at(-1)).toMatch(/giving up/);
  });

  it('retries a secondary rate limit within the wait budget, up to the attempt budget, then gives up', async () => {
    const { getGithubClient } = await freshGithubClientModule();
    getGithubClient();
    const options = octokitConstructorSpy.mock.calls[0][0];
    const fakeRequest = {
      method: 'POST',
      url: 'https://api.github.com/graphql',
    };

    expect(options.throttle.onSecondaryRateLimit(10, fakeRequest, {}, 0)).toBe(
      true,
    );
    expect(options.throttle.onSecondaryRateLimit(10, fakeRequest, {}, 2)).toBe(
      false,
    );
    expect(warnSpy.mock.calls[0][0]).toMatch(
      /^agent-lcars: GitHub secondary rate limit hit/,
    );
    expect(warnSpy.mock.calls[0].at(-1)).toMatch(/retrying/);
    expect(warnSpy.mock.calls[1].at(-1)).toMatch(/giving up/);
  });

  it('declines a secondary-rate-limited retry whose retryAfter exceeds the wait budget', async () => {
    const { getGithubClient } = await freshGithubClientModule();
    getGithubClient();
    const options = octokitConstructorSpy.mock.calls[0][0];
    const fakeRequest = {
      method: 'POST',
      url: 'https://api.github.com/graphql',
    };

    expect(options.throttle.onSecondaryRateLimit(90, fakeRequest, {}, 0)).toBe(
      false,
    );
    expect(warnSpy.mock.calls[0].at(-1)).toMatch(/giving up/);
  });

  it('retries a GET on a retryable 5xx but does not retry a mutating POST', async () => {
    const { getGithubClient } = await freshGithubClientModule();
    const client = getGithubClient();

    const jsonResponse = (body: unknown, status: number) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    // GET: a transient 500 on the first attempt is safe to retry - the
    // request never mutated anything, so a second attempt cannot duplicate
    // side effects.
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ message: 'boom' }, 500))
      .mockResolvedValueOnce(jsonResponse({ ok: true }, 200));

    await client.request('GET /repos/{owner}/{repo}', {
      owner: 'o',
      repo: 'r',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    fetchSpy.mockClear();

    // POST (a mutation, e.g. issues.createComment in backend-actions.ts): a
    // 500 might mean the comment already landed and only the response was
    // lost, so retrying here would risk posting a duplicate. Must reject
    // after exactly one attempt, never a second.
    fetchSpy.mockResolvedValueOnce(jsonResponse({ message: 'boom' }, 500));

    await expect(
      client.request(
        'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
        { owner: 'o', repo: 'r', issue_number: 1, body: 'hi' },
      ),
    ).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("adds a bounded timeout signal to requests that don't already have one", async () => {
    const { getGithubClient } = await freshGithubClientModule();
    getGithubClient();
    const options = octokitConstructorSpy.mock.calls[0][0];

    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);

    await options.request.fetch('https://api.github.com/repos/o/r');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('preserves a caller-supplied signal instead of overriding it', async () => {
    const { getGithubClient } = await freshGithubClientModule();
    getGithubClient();
    const options = octokitConstructorSpy.mock.calls[0][0];

    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);

    const controller = new AbortController();
    await options.request.fetch('https://api.github.com/repos/o/r', {
      signal: controller.signal,
    });

    const init = fetchSpy.mock.calls[0][1];
    expect(init.signal).toBe(controller.signal);
  });
});

describe('getGithubClient auth', () => {
  const CLIENT_ID_ENV_KEY = 'AGENT_LCARS_APP_CLIENT_ID';
  const PRIVATE_KEY_ENV_KEY = 'AGENT_LCARS_APP_PRIVATE_KEY';
  const BASE_URL_ENV_KEY = 'AGENT_CONSOLE_GITHUB_API_BASE_URL';
  // A real key: construction eagerly parse-validates it (mirroring
  // createDispatchTokenProvider's own fail-fast construction - see
  // createGithubClientAuthStrategy's doc comment), so a syntactically
  // invalid placeholder would throw before any of these tests reached
  // their own assertions.
  const { privateKey: FAKE_PRIVATE_KEY_PEM } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  beforeEach(() => {
    vi.resetModules();
    octokitConstructorSpy.mockClear();
    delete process.env[CLIENT_ID_ENV_KEY];
    delete process.env[PRIVATE_KEY_ENV_KEY];
    delete process.env[BASE_URL_ENV_KEY];
  });

  afterEach(() => {
    delete process.env[CLIENT_ID_ENV_KEY];
    delete process.env[PRIVATE_KEY_ENV_KEY];
    delete process.env[BASE_URL_ENV_KEY];
  });

  it('#1284: throws when AGENT_LCARS_APP_CLIENT_ID is unset', async () => {
    process.env[PRIVATE_KEY_ENV_KEY] = FAKE_PRIVATE_KEY_PEM;
    const { getGithubClient } = await freshGithubClientModule();
    expect(() => getGithubClient()).toThrow(
      'process.env.AGENT_LCARS_APP_CLIENT_ID not defined',
    );
  });

  it('#1284: throws when AGENT_LCARS_APP_PRIVATE_KEY is unset', async () => {
    process.env[CLIENT_ID_ENV_KEY] = 'Iv1.test0123456789ab';
    const { getGithubClient } = await freshGithubClientModule();
    expect(() => getGithubClient()).toThrow(
      'process.env.AGENT_LCARS_APP_PRIVATE_KEY not defined',
    );
  });

  it("#1284: wires the App authStrategy with both env vars and this client's own permission set", async () => {
    process.env[CLIENT_ID_ENV_KEY] = 'Iv1.test0123456789ab';
    process.env[PRIVATE_KEY_ENV_KEY] = FAKE_PRIVATE_KEY_PEM;
    const { getGithubClient } = await freshGithubClientModule();

    getGithubClient();

    const options = octokitConstructorSpy.mock.calls[0][0];
    expect(typeof options.authStrategy).toBe('function');
    expect(options.auth).toEqual({
      clientId: 'Iv1.test0123456789ab',
      privateKeyPem: FAKE_PRIVATE_KEY_PEM,
      permissions: {
        actions: 'write',
        contents: 'write',
        issues: 'write',
        pull_requests: 'write',
      },
    });
    expect(options.baseUrl).toBeUndefined();
  });

  it('#1284: e2e mode (AGENT_CONSOLE_GITHUB_API_BASE_URL set) needs no App credentials and skips the authStrategy entirely', async () => {
    process.env[BASE_URL_ENV_KEY] = 'http://localhost:4200/api/e2e/github';
    const { getGithubClient } = await freshGithubClientModule();

    // Would throw ('AGENT_LCARS_APP_CLIENT_ID not defined') if the e2e
    // branch fell through to the App path - it doesn't.
    expect(() => getGithubClient()).not.toThrow();

    const options = octokitConstructorSpy.mock.calls[0][0];
    expect(options.authStrategy).toBeUndefined();
    expect(options.auth).toBe('e2e-fixture-token');
    expect(options.baseUrl).toBe('http://localhost:4200/api/e2e/github');
  });

  it('#1284: throws at construction time (not first request) when the App private key does not parse', async () => {
    process.env[CLIENT_ID_ENV_KEY] = 'Iv1.test0123456789ab';
    process.env[PRIVATE_KEY_ENV_KEY] = 'not-a-real-pem';
    const { getGithubClient } = await freshGithubClientModule();

    expect(() => getGithubClient()).toThrow(
      'GitHub App private key is not a valid PEM-encoded RSA private key (PKCS1 or PKCS8)',
    );
  });
});

describe('getWatchedRepos', () => {
  it('falls back to the default single-repo list when unset', () => {
    expect(getWatchedRepos()).toEqual(DEFAULT_WATCHED_REPOS);
  });

  it('parses a valid JSON array from the env var', () => {
    process.env[ENV_KEY] = JSON.stringify([
      { owner: 'org-a', name: 'repo-a' },
      { owner: 'org-b', name: 'repo-b', agents: { opencode: null } },
    ]);

    expect(getWatchedRepos()).toEqual([
      { owner: 'org-a', name: 'repo-a' },
      { owner: 'org-b', name: 'repo-b', agents: { opencode: null } },
    ]);
  });

  it('throws on malformed JSON', () => {
    process.env[ENV_KEY] = '{not json';
    expect(() => getWatchedRepos()).toThrow(/not valid JSON/);
  });

  it('throws on an empty array', () => {
    process.env[ENV_KEY] = '[]';
    expect(() => getWatchedRepos()).toThrow(/non-empty JSON array/);
  });

  it('throws when an entry is missing owner/name', () => {
    process.env[ENV_KEY] = JSON.stringify([{ owner: 'org-a' }]);
    expect(() => getWatchedRepos()).toThrow(/name must be a non-empty string/);
  });

  it('throws when an agent integration is not an object or null', () => {
    process.env[ENV_KEY] = JSON.stringify([
      { owner: 'org-a', name: 'repo-a', agents: { claude: 42 } },
    ]);
    expect(() => getWatchedRepos()).toThrow(/must be an object or null/);
  });

  it('throws when an agent integration is incomplete', () => {
    process.env[ENV_KEY] = JSON.stringify([
      {
        owner: 'org-a',
        name: 'repo-a',
        agents: { claude: { label: 'agent:claude' } },
      },
    ]);
    expect(() => getWatchedRepos()).toThrow(/agents\.claude\.replyTrigger/);
  });

  it('parses a complete agent integration', () => {
    process.env[ENV_KEY] = JSON.stringify([
      {
        owner: 'org-a',
        name: 'repo-a',
        agents: { claude: CLAUDE_INTEGRATION },
      },
    ]);
    expect(getWatchedRepos()[0].agents?.claude).toEqual(CLAUDE_INTEGRATION);
  });

  it('throws when reply-trigger aliases are malformed', () => {
    process.env[ENV_KEY] = JSON.stringify([
      {
        owner: 'org-a',
        name: 'repo-a',
        agents: {
          claude: { ...CLAUDE_INTEGRATION, replyTriggerAliases: [''] },
        },
      },
    ]);
    expect(() => getWatchedRepos()).toThrow(/replyTriggerAliases/);
  });

  it('parses an alias', () => {
    process.env[ENV_KEY] = JSON.stringify([
      { owner: 'org-a', name: 'repo-a', alias: 'Repo A' },
    ]);

    expect(getWatchedRepos()).toEqual([
      { owner: 'org-a', name: 'repo-a', alias: 'Repo A' },
    ]);
  });

  it('throws when alias is an empty string', () => {
    process.env[ENV_KEY] = JSON.stringify([
      { owner: 'org-a', name: 'repo-a', alias: '' },
    ]);
    expect(() => getWatchedRepos()).toThrow(/alias must be a non-empty string/);
  });

  it('throws when alias is not a string', () => {
    process.env[ENV_KEY] = JSON.stringify([
      { owner: 'org-a', name: 'repo-a', alias: 42 },
    ]);
    expect(() => getWatchedRepos()).toThrow(/alias must be a non-empty string/);
  });
});

describe('resolveWatchedRepo', () => {
  it('returns the canonical watched-list entry for a match', () => {
    process.env[ENV_KEY] = JSON.stringify([
      { owner: 'org-a', name: 'repo-a', agents: { opencode: null } },
    ]);

    expect(resolveWatchedRepo({ owner: 'org-a', name: 'repo-a' })).toEqual({
      owner: 'org-a',
      name: 'repo-a',
      agents: { opencode: null },
    });
  });

  // Security-critical: Server Action arguments are client-controlled at the
  // HTTP boundary regardless of their TS signature, so a client-supplied
  // repo that isn't in the configured watched list must be rejected, not
  // trusted and passed straight to the GitHub client.
  it('rejects a repo that is not in the watched list', () => {
    expect(() =>
      resolveWatchedRepo({ owner: 'not-watched', name: 'other-repo' }),
    ).toThrow(UnwatchedRepoError);
  });

  it('does not match on owner or name alone', () => {
    expect(() =>
      resolveWatchedRepo({
        owner: 'supersprinklesracing',
        name: 'not-members',
      }),
    ).toThrow(UnwatchedRepoError);
    expect(() =>
      resolveWatchedRepo({
        owner: 'not-supersprinklesracing',
        name: 'sprinkles',
      }),
    ).toThrow(UnwatchedRepoError);
  });
});

describe('repoKey / repoItemKey', () => {
  it('formats owner/name', () => {
    expect(repoKey({ owner: 'a', name: 'b' })).toBe('a/b');
  });

  it('formats owner/name#number', () => {
    expect(repoItemKey({ owner: 'a', name: 'b' }, 42)).toBe('a/b#42');
  });
});

describe('repoDisplayName', () => {
  it('falls back to repoKey when no alias is set', () => {
    expect(repoDisplayName({ owner: 'a', name: 'b' })).toBe('a/b');
  });

  it('prefers the alias when present', () => {
    expect(repoDisplayName({ owner: 'a', name: 'b', alias: 'Repo B' })).toBe(
      'Repo B',
    );
  });

  it('falls back to repoKey when the alias is an empty string', () => {
    expect(repoDisplayName({ owner: 'a', name: 'b', alias: '' })).toBe('a/b');
  });
});
