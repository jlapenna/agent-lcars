import { afterEach, describe, expect, it } from 'vitest';

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
