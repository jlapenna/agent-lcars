import { describe, expect, it } from 'vitest';

import { buildSessionDoc, SESSION_RETENTION_DAYS } from './session-doc';
import { SessionSummary } from './types';

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
    expect(doc).not.toHaveProperty('transcriptGcsUri');
  });

  it('carries transcriptGcsUri onto an issue-agent doc when present', () => {
    const doc = buildSessionDoc(
      baseSummary({ source: 'issue-agent' }),
      'ended',
      {
        runId: 'run-123',
        issueNumber: 2539,
        transcriptGcsUri:
          'gs://supersprinklesracing-agent-session-transcripts/runs/run-123/session-1.jsonl',
      },
    );

    expect(doc).toMatchObject({
      transcriptGcsUri:
        'gs://supersprinklesracing-agent-session-transcripts/runs/run-123/session-1.jsonl',
    });
  });

  it('omits transcriptGcsUri when absent rather than writing undefined', () => {
    const doc = buildSessionDoc(
      baseSummary({ source: 'issue-agent' }),
      'ended',
      { runId: 'run-123' },
    );

    expect(doc).not.toHaveProperty('transcriptGcsUri');
  });

  it('never carries transcriptGcsUri onto a cli doc even if passed by mistake', () => {
    // BuildSessionDocOptions doesn't discriminate by source, so a caller
    // could pass transcriptGcsUri alongside a cli summary — the builder
    // itself must still gate it to the issue-agent branch, since only
    // IssueAgentSessionDoc declares the field.
    const doc = buildSessionDoc(baseSummary({ source: 'cli' }), 'live', {
      transcriptGcsUri: 'gs://bucket/runs/1/session.jsonl',
    });

    expect(doc).not.toHaveProperty('transcriptGcsUri');
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

  it('omits expireAt instead of throwing when lastActivityAt has no parseable timestamp', () => {
    const doc = buildSessionDoc(baseSummary({ lastActivityAt: '' }), 'ended');

    expect(doc).not.toHaveProperty('expireAt');
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

  it('carries totalCostUsd/result through when present, on either source', () => {
    const cliDoc = buildSessionDoc(
      baseSummary({
        totalCostUsd: 0.42,
        result: { subtype: 'success', isError: false },
      }),
      'ended',
    );
    expect(cliDoc).toMatchObject({
      totalCostUsd: 0.42,
      result: { subtype: 'success', isError: false },
    });

    const issueAgentDoc = buildSessionDoc(
      baseSummary({
        source: 'issue-agent',
        totalCostUsd: 0,
        result: { subtype: 'error_max_turns', isError: true },
      }),
      'ended',
      { runId: 'run-123' },
    );
    expect(issueAgentDoc).toMatchObject({
      totalCostUsd: 0,
      result: { subtype: 'error_max_turns', isError: true },
    });
  });

  it('omits totalCostUsd/result entirely when absent from the summary', () => {
    const doc = buildSessionDoc(baseSummary(), 'idle');
    expect(doc).not.toHaveProperty('totalCostUsd');
    expect(doc).not.toHaveProperty('result');
  });
});
