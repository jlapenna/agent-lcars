import { describe, expect, it } from 'vitest';

import { canonicalRepoSpelling, matchesRepoAllowlist } from './repo-allowlist';

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
    // The most specific match wins regardless of order.
    [
      ['*/*', 'jlapenna/*', 'JLapenna/Agent-Lcars'],
      { owner: 'JLapenna', name: 'Agent-Lcars' },
    ],
    // No match keeps the remote's spelling.
    [['supersprinklesracing/*'], mixedCase],
    [[], mixedCase],
  ])('%j → %j', (patterns, expected) => {
    expect(canonicalRepoSpelling(mixedCase, patterns)).toEqual(expected);
  });
});
