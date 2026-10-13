import { describe, expect, it } from 'vitest';

import type { SessionRow } from '../../lib/session-archive';
import {
  matchesSessionView,
  parseViewFilters,
  setViewFilterParams,
} from './session-view-filters';

const row: SessionRow = {
  sessionId: 'ses-8f3a21c4',
  source: 'issue-agent',
  repo: { owner: 'jlapenna', name: 'agent-lcars' },
  agent: 'codex',
  title: 'Cover tied issue IDs',
  issueNumber: 2477,
  prUrls: [{ number: 2481, url: 'https://github.com/o/r/pull/2481' }],
  runId: 'jlapenna/agent-lcars#2477/r1',
  turns: 4,
  totalTokens: 1500,
  startedAt: '2026-10-13T10:00:00.000Z',
  lastActivityAt: '2026-10-13T10:30:00.000Z',
  liveness: 'ended',
};

describe('session view filters', () => {
  it('carries the view filters into links', () => {
    const params = new URLSearchParams('view=flat');
    setViewFilterParams(params, { agent: 'codex', q: '#2477' });
    expect(params.toString()).toBe('view=flat&agent=codex&q=%232477');
  });

  it('accepts only known agents and bounds the search text', () => {
    expect(parseViewFilters({ agent: 'codex', q: '  #2477 ' })).toEqual({
      agent: 'codex',
      q: '#2477',
    });
    expect(parseViewFilters({ agent: 'nobody' }).agent).toBeUndefined();
    // A repeated parameter arrives as an array; the first value wins.
    expect(parseViewFilters({ q: ['a ', 'b'], agent: ['codex', 'x'] })).toEqual(
      { agent: 'codex', q: 'a' },
    );
    expect(parseViewFilters({ q: 'x'.repeat(500) }).q).toHaveLength(128);
  });

  it('matches by agent and by session, issue, PR, run or repository text', () => {
    expect(matchesSessionView(row, { agent: 'codex' })).toBe(true);
    expect(matchesSessionView(row, { agent: 'opencode' })).toBe(false);
    for (const q of [
      '8f3a21',
      '#2477',
      '#2481',
      '/r1',
      'agent-lcars',
      'TIED',
    ]) {
      expect(matchesSessionView(row, { q })).toBe(true);
    }
    expect(matchesSessionView(row, { q: 'nope' })).toBe(false);
  });
});
