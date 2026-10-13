import { describe, expect, it } from 'vitest';

import {
  matchesAgentsRun,
  matchesAgentsSession,
  matchesFind,
  parseAgentsViewFilters,
} from './agents-view-filters';

const now = Date.parse('2026-10-13T12:00:00Z');
const run = {
  id: 'run-1',
  pipeline: 'claude' as const,
  displayTitle: 'Bound the session listing',
  repo: { owner: 'jlapenna', name: 'agent-lcars' },
  issueNumber: 2617,
  updatedAt: '2026-10-13T10:00:00Z',
};

describe('parseAgentsViewFilters', () => {
  it('keeps known values and ignores the rest', () => {
    expect(
      parseAgentsViewFilters({ agent: 'codex', window: '24h', q: ' oom ' }),
    ).toEqual({ agent: 'codex', window: '24h', q: 'oom' });
    expect(
      parseAgentsViewFilters({ agent: 'robot', window: '3d', q: '  ' }),
    ).toEqual({ agent: undefined, window: undefined, q: undefined });
  });
});

describe('matchesAgentsRun', () => {
  it('narrows by agent and by find over title, anchor and run id', () => {
    const opts = { finished: false, now };
    expect(matchesAgentsRun(run, { agent: 'codex' }, opts)).toBe(false);
    expect(matchesAgentsRun(run, { agent: 'claude' }, opts)).toBe(true);
    expect(matchesAgentsRun(run, { q: 'agent-lcars#2617' }, opts)).toBe(true);
    expect(matchesAgentsRun(run, { q: 'SESSION' }, opts)).toBe(true);
    expect(matchesAgentsRun(run, { q: 'run-1' }, opts)).toBe(true);
    expect(matchesAgentsRun(run, { q: 'homelab' }, opts)).toBe(false);
  });

  it('applies the window to finished runs only', () => {
    expect(
      matchesAgentsRun(run, { window: '1h' }, { finished: true, now }),
    ).toBe(false);
    expect(
      matchesAgentsRun(run, { window: '24h' }, { finished: true, now }),
    ).toBe(true);
    expect(
      matchesAgentsRun(run, { window: '1h' }, { finished: false, now }),
    ).toBe(true);
  });
});

describe('matchesFind', () => {
  it('matches everything without a query and is case-insensitive', () => {
    expect(matchesFind(['Anything'], undefined)).toBe(true);
    expect(matchesFind(['Fix OOM', undefined], 'oom')).toBe(true);
    expect(matchesFind(['Fix OOM'], 'leak')).toBe(false);
  });
});

describe('matchesAgentsSession', () => {
  it('maps the dispatch agent to its CLI adapter and finds by title', () => {
    const session = {
      agent: 'claude-code' as const,
      sessionId: 's-1',
      title: 'Console restyle',
    };
    expect(matchesAgentsSession(session, { agent: 'claude' })).toBe(true);
    expect(matchesAgentsSession(session, { agent: 'codex' })).toBe(false);
    expect(matchesAgentsSession(session, { q: 'restyle' })).toBe(true);
    expect(matchesAgentsSession(session, { q: 'deploy' })).toBe(false);
  });
});
