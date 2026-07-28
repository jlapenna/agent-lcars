import { describe, expect, it } from 'vitest';

import type { SessionRow } from './session-archive';
import { groupSessionsByIssue } from './session-issue-groups';

function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: 'session-1',
    source: 'cli',
    repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
    agent: 'claude-code',
    title: 'Fix flaky login test',
    prUrls: [],
    turns: 4,
    totalTokens: 1500,
    startedAt: '2026-07-10T10:00:00.000Z',
    lastActivityAt: '2026-07-10T10:05:00.000Z',
    liveness: 'ended',
    ...overrides,
  };
}

describe('groupSessionsByIssue', () => {
  it('returns no groups for no rows', () => {
    expect(groupSessionsByIssue([])).toEqual([]);
  });

  it('buckets CLI sessions under a single no-issue group', () => {
    const groups = groupSessionsByIssue([
      makeRow({ sessionId: 'c1' }),
      makeRow({ sessionId: 'c2' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].issueNumber).toBe('no-issue');
    expect(groups[0].repo).toBeUndefined();
    expect(groups[0].sessions.map((r) => r.sessionId)).toEqual(['c1', 'c2']);
  });

  it('groups multiple sessions from the same issue together, preserving row order', () => {
    const groups = groupSessionsByIssue([
      makeRow({
        sessionId: 'a2',
        source: 'issue-agent',
        issueNumber: 42,
        issueUrl: 'https://github.com/o/r/issues/42',
      }),
      makeRow({ sessionId: 'c1' }),
      makeRow({
        sessionId: 'a1',
        source: 'issue-agent',
        issueNumber: 42,
        issueUrl: 'https://github.com/o/r/issues/42',
      }),
    ]);

    expect(groups).toHaveLength(2);
    const issueGroup = groups.find((g) => g.issueNumber === 42);
    expect(issueGroup?.sessions.map((r) => r.sessionId)).toEqual(['a2', 'a1']);
    expect(issueGroup?.repo).toEqual({
      owner: 'supersprinklesracing',
      name: 'sprinkles',
    });
    expect(issueGroup?.issueUrl).toBe('https://github.com/o/r/issues/42');
  });

  it('keeps two different repos with the same issue number in separate groups', () => {
    const groups = groupSessionsByIssue([
      makeRow({
        sessionId: 'a1',
        source: 'issue-agent',
        issueNumber: 42,
        repo: { owner: 'org-a', name: 'repo-a' },
        issueUrl: 'https://github.com/org-a/repo-a/issues/42',
      }),
      makeRow({
        sessionId: 'a2',
        source: 'issue-agent',
        issueNumber: 42,
        repo: { owner: 'org-b', name: 'repo-b' },
        issueUrl: 'https://github.com/org-b/repo-b/issues/42',
      }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].repo?.owner).toBe('org-a');
    expect(groups[1].repo?.owner).toBe('org-b');
  });

  it('orders groups by first appearance, mirroring the newest-first row order', () => {
    const groups = groupSessionsByIssue([
      makeRow({
        sessionId: 'a1',
        source: 'issue-agent',
        issueNumber: 10,
      }),
      makeRow({ sessionId: 'c1' }),
      makeRow({
        sessionId: 'a2',
        source: 'issue-agent',
        issueNumber: 20,
      }),
    ]);

    expect(groups.map((g) => g.issueNumber)).toEqual([10, 'no-issue', 20]);
  });
});
