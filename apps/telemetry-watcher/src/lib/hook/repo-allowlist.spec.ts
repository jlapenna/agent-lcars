import { describe, expect, it } from 'vitest';

import { matchesRepoAllowlist } from './repo-allowlist';

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
