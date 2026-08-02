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

const ENV_KEY = 'AGENT_LCARS_WATCHED_REPOS';
const CLAUDE_INTEGRATION = {
  workflowFile: 'claude.yml',
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
  const TOKEN_ENV_KEY = 'AGENT_LCARS_GITHUB_TOKEN';

  beforeEach(() => {
    vi.resetModules();
    octokitConstructorSpy.mockClear();
    process.env[TOKEN_ENV_KEY] = 'test-token';
  });

  afterEach(() => {
    delete process.env[TOKEN_ENV_KEY];
  });

  it('configures a bounded retry budget and rate-limit throttling', async () => {
    const { getGithubClient } = await import('./github-client');
    getGithubClient();

    expect(octokitConstructorSpy).toHaveBeenCalledTimes(1);
    const options = octokitConstructorSpy.mock.calls[0][0];

    expect(options.retry).toEqual({ retries: 2 });
    expect(typeof options.throttle.onRateLimit).toBe('function');
    expect(typeof options.throttle.onSecondaryRateLimit).toBe('function');
    expect(typeof options.request.fetch).toBe('function');
  });

  it('caches the client across calls instead of constructing a new one', async () => {
    const { getGithubClient } = await import('./github-client');

    const first = getGithubClient();
    const second = getGithubClient();

    expect(second).toBe(first);
    expect(octokitConstructorSpy).toHaveBeenCalledTimes(1);
  });

  it('retries a rate-limited request up to the bounded budget, then gives up', async () => {
    const { getGithubClient } = await import('./github-client');
    getGithubClient();
    const options = octokitConstructorSpy.mock.calls[0][0];
    const fakeRequest = {
      method: 'GET',
      url: 'https://api.github.com/repos/o/r',
    };

    const warnSpy = vi.spyOn(console, 'warn').mockReturnValue(undefined);

    expect(options.throttle.onRateLimit(30, fakeRequest, {}, 0)).toBe(true);
    expect(options.throttle.onRateLimit(30, fakeRequest, {}, 1)).toBe(true);
    expect(options.throttle.onRateLimit(30, fakeRequest, {}, 2)).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy.mock.calls[0][0]).toMatch(/^agent-lcars: GitHub rate limit/);

    warnSpy.mockRestore();
  });

  it('retries a secondary rate limit up to the bounded budget, then gives up', async () => {
    const { getGithubClient } = await import('./github-client');
    getGithubClient();
    const options = octokitConstructorSpy.mock.calls[0][0];
    const fakeRequest = {
      method: 'POST',
      url: 'https://api.github.com/graphql',
    };

    const warnSpy = vi.spyOn(console, 'warn').mockReturnValue(undefined);

    expect(options.throttle.onSecondaryRateLimit(60, fakeRequest, {}, 0)).toBe(
      true,
    );
    expect(options.throttle.onSecondaryRateLimit(60, fakeRequest, {}, 2)).toBe(
      false,
    );
    expect(warnSpy.mock.calls[0][0]).toMatch(
      /^agent-lcars: GitHub secondary rate limit/,
    );

    warnSpy.mockRestore();
  });

  it("adds a bounded timeout signal to requests that don't already have one", async () => {
    const { getGithubClient } = await import('./github-client');
    getGithubClient();
    const options = octokitConstructorSpy.mock.calls[0][0];

    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);

    await options.request.fetch('https://api.github.com/repos/o/r');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);

    vi.unstubAllGlobals();
  });

  it('preserves a caller-supplied signal instead of overriding it', async () => {
    const { getGithubClient } = await import('./github-client');
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

    vi.unstubAllGlobals();
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
        agents: { claude: { workflowFile: 'claude.yml' } },
      },
    ]);
    expect(() => getWatchedRepos()).toThrow(/agents\.claude\.label/);
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
