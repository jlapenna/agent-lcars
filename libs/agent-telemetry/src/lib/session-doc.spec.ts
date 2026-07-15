import { buildSessionDoc, SESSION_RETENTION_DAYS } from './session-doc';
import { SessionSummary } from './types';
import { describe, it, test, expect } from 'vitest';

function baseSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 'session-1',
    source: 'cli',
    startedAt: '2026-07-10T10:00:00.000Z',
    lastActivityAt: '2026-07-10T10:05:00.000Z',
    turns: 2,
    toolCallCounts: { Bash: 1 },
    tokens: {
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    deliverables: { prNumbers: [], commitShas: [] },
    ...overrides,
  };
}

describe('buildSessionDoc', () => {
  it('builds a cli doc with only cli-relevant optional fields', () => {
    const doc = buildSessionDoc(
      baseSummary({
        host: 'my-laptop',
        cwd: '/home/dev/project',
        worktree: '/home/dev/project/.claude/worktrees/foo',
        branch: 'feat/foo',
      }),
      'live',
    );

    expect(doc).toEqual({
      sessionId: 'session-1',
      source: 'cli',
      liveness: 'live',
      startedAt: '2026-07-10T10:00:00.000Z',
      lastActivityAt: '2026-07-10T10:05:00.000Z',
      expireAt: '2026-08-09T10:05:00.000Z',
      turns: 2,
      toolCallCounts: { Bash: 1 },
      tokens: {
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      deliverables: { prNumbers: [], commitShas: [] },
      host: 'my-laptop',
      cwd: '/home/dev/project',
      worktree: '/home/dev/project/.claude/worktrees/foo',
      branch: 'feat/foo',
    });
    expect(doc).not.toHaveProperty('runId');
    expect(doc).not.toHaveProperty('issueNumber');
  });

  it('builds an issue-agent doc with runId/issueNumber but no cli fields', () => {
    const doc = buildSessionDoc(
      baseSummary({
        source: 'issue-agent',
        host: 'runner-host',
        cwd: '/home/runner/work/members/members',
      }),
      'ended',
      { runId: 'run-123', issueNumber: 2539 },
    );

    expect(doc).toEqual({
      sessionId: 'session-1',
      source: 'issue-agent',
      liveness: 'ended',
      startedAt: '2026-07-10T10:00:00.000Z',
      lastActivityAt: '2026-07-10T10:05:00.000Z',
      expireAt: '2026-08-09T10:05:00.000Z',
      turns: 2,
      toolCallCounts: { Bash: 1 },
      tokens: {
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      deliverables: { prNumbers: [], commitShas: [] },
      runId: 'run-123',
      issueNumber: 2539,
    });
    expect(doc).not.toHaveProperty('host');
    expect(doc).not.toHaveProperty('cwd');
  });

  it('omits optional fields entirely rather than writing undefined', () => {
    const doc = buildSessionDoc(baseSummary(), 'idle');

    expect(Object.keys(doc)).not.toContain('lastToolCall');
    expect(Object.keys(doc)).not.toContain('model');
    expect(Object.keys(doc)).not.toContain('permissionMode');
    expect(Object.keys(doc)).not.toContain('title');
    expect(Object.keys(doc)).not.toContain('host');
    expect(Object.keys(doc)).not.toContain('cwd');
    expect(Object.keys(doc)).not.toContain('worktree');
    expect(Object.keys(doc)).not.toContain('branch');
    expect(Object.keys(doc)).not.toContain('artifacts');
  });

  it('carries artifacts through on a cli doc when present and non-empty', () => {
    const doc = buildSessionDoc(
      baseSummary({ artifacts: ['report.md', 'chart.png'] }),
      'live',
    );

    expect(doc).toMatchObject({ artifacts: ['report.md', 'chart.png'] });
  });

  it('omits an empty artifacts list rather than writing []', () => {
    const doc = buildSessionDoc(baseSummary({ artifacts: [] }), 'live');

    expect(doc).not.toHaveProperty('artifacts');
  });

  it('never carries artifacts onto an issue-agent doc', () => {
    const doc = buildSessionDoc(
      baseSummary({
        source: 'issue-agent',
        artifacts: ['report.md'],
      }),
      'ended',
      { runId: 'run-123' },
    );

    expect(doc).not.toHaveProperty('artifacts');
  });

  it('computes expireAt as lastActivityAt + SESSION_RETENTION_DAYS', () => {
    const doc = buildSessionDoc(
      baseSummary({ lastActivityAt: '2026-01-01T00:00:00.000Z' }),
      'ended',
    );

    const expected = new Date('2026-01-01T00:00:00.000Z');
    expected.setUTCDate(expected.getUTCDate() + SESSION_RETENTION_DAYS);
    expect(doc.expireAt).toBe(expected.toISOString());
  });

  it('carries lastToolCall/model/permissionMode/title through when present', () => {
    const doc = buildSessionDoc(
      baseSummary({
        lastToolCall: { name: 'Edit', timestamp: '2026-07-10T10:04:00.000Z' },
        model: 'claude-sonnet-5',
        permissionMode: 'default',
        title: 'Fix flaky test',
      }),
      'live',
    );

    expect(doc).toMatchObject({
      lastToolCall: { name: 'Edit', timestamp: '2026-07-10T10:04:00.000Z' },
      model: 'claude-sonnet-5',
      permissionMode: 'default',
      title: 'Fix flaky test',
    });
  });
});
