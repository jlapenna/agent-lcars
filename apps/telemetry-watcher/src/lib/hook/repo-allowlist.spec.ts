import { describe, expect, it } from 'vitest';

import {
  canonicalRepoSpelling,
  matchesRepoAllowlist,
  matchesWorkspaceAllowlist,
} from './repo-allowlist';

describe('matchesRepoAllowlist', () => {
  const repo = { owner: 'jlapenna', name: 'agent-lcars' };
  it.each([
    [['jlapenna/*'], true],
    [['*/agent-lcars'], true],
    [['JLapenna/Agent-LCARS'], true],
    [['*/*'], true],
    [['supersprinklesracing/*'], false],
    [['jlapenna'], false],
    [['jlapenna/agent-lcars/extra'], false],
    [[], false],
  ])('%j → %s', (patterns, expected) => {
    expect(matchesRepoAllowlist(repo, patterns)).toBe(expected);
  });
});

describe('canonicalRepoSpelling', () => {
  const mixedCase = { owner: 'JLapenna', name: 'Agent-LCARS' };
  it.each([
    [['jlapenna/agent-lcars'], { owner: 'jlapenna', name: 'agent-lcars' }],
    [['jlapenna/*'], { owner: 'jlapenna', name: 'agent-lcars' }],
    [['*/agent-lcars'], { owner: 'jlapenna', name: 'agent-lcars' }],
    [['*/*'], { owner: 'jlapenna', name: 'agent-lcars' }],
    // A literal entry wins over wildcards regardless of order.
    [
      ['*/*', 'jlapenna/*', 'JLapenna/Agent-Lcars'],
      { owner: 'JLapenna', name: 'Agent-Lcars' },
    ],
    // A wildcard never mixes a literal's capitals with lowercase.
    [['JLapenna/*'], { owner: 'jlapenna', name: 'agent-lcars' }],
    [['*/Agent-LCARS'], { owner: 'jlapenna', name: 'agent-lcars' }],
    // Malformed patterns are ignored.
    [['jlapenna/agent-lcars/extra', 'jlapenna'], mixedCase],
    // No match keeps the remote's spelling.
    [['supersprinklesracing/*'], mixedCase],
    [[], mixedCase],
  ])('%j → %j', (patterns, expected) => {
    expect(canonicalRepoSpelling(mixedCase, patterns)).toEqual(expected);
  });
});

describe('matchesWorkspaceAllowlist', () => {
  it.each([
    ['/home/dev/p', ['/home/dev/p'], true],
    ['/home/dev/p/notes', ['/home/dev/p'], true],
    ['/home/dev/p/../p/notes', ['/home/dev/p'], true],
    ['/home/dev/p2', ['/home/dev/p'], false],
    ['/home/dev', ['/home/dev/p'], false],
    ['/home/dev/p/../secret', ['/home/dev/p'], false],
    ['p/notes', ['/home/dev/p'], false],
    ['/home/dev/p', [], false],
  ])('%s under %j → %s', (cwd, workspaces, expected) => {
    expect(matchesWorkspaceAllowlist(cwd, workspaces)).toBe(expected);
  });
});
