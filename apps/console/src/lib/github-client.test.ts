import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_WATCHED_REPOS,
  getWatchedRepos,
  repoItemKey,
  repoKey,
  resolveWatchedRepo,
  UnwatchedRepoError,
} from './github-client';

const ENV_KEY = 'AGENT_LCARS_WATCHED_REPOS';

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe('getWatchedRepos', () => {
  it('falls back to the default single-repo list when unset', () => {
    expect(getWatchedRepos()).toEqual(DEFAULT_WATCHED_REPOS);
  });

  it('parses a valid JSON array from the env var', () => {
    process.env[ENV_KEY] = JSON.stringify([
      { owner: 'org-a', name: 'repo-a' },
      { owner: 'org-b', name: 'repo-b', workflowFiles: { opencode: null } },
    ]);

    expect(getWatchedRepos()).toEqual([
      { owner: 'org-a', name: 'repo-a' },
      { owner: 'org-b', name: 'repo-b', workflowFiles: { opencode: null } },
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

  it('throws when workflowFiles has a non-string, non-null value', () => {
    process.env[ENV_KEY] = JSON.stringify([
      { owner: 'org-a', name: 'repo-a', workflowFiles: { claude: 42 } },
    ]);
    expect(() => getWatchedRepos()).toThrow(/must be a string or null/);
  });
});

describe('resolveWatchedRepo', () => {
  it('returns the canonical watched-list entry for a match', () => {
    process.env[ENV_KEY] = JSON.stringify([
      { owner: 'org-a', name: 'repo-a', workflowFiles: { opencode: null } },
    ]);

    expect(resolveWatchedRepo({ owner: 'org-a', name: 'repo-a' })).toEqual({
      owner: 'org-a',
      name: 'repo-a',
      workflowFiles: { opencode: null },
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
        name: 'members',
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
