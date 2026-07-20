import { describe, expect, it } from 'vitest';

import { buildStubSummary } from './stub-summary';

describe('buildStubSummary', () => {
  it('builds a minimal issue-agent summary with zeroed turns/tokens and empty deliverables', () => {
    const summary = buildStubSummary({
      sessionId: 'opencode-run-123',
      agent: 'opencode',
      startedAt: '2026-07-19T10:00:00.000Z',
      lastActivityAt: '2026-07-19T10:05:00.000Z',
    });

    expect(summary).toEqual({
      sessionId: 'opencode-run-123',
      source: 'issue-agent',
      agent: 'opencode',
      startedAt: '2026-07-19T10:00:00.000Z',
      lastActivityAt: '2026-07-19T10:05:00.000Z',
      turns: 0,
      toolCallCounts: {},
      tokens: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      deliverables: { prNumbers: [], commitShas: [] },
    });
  });

  it('includes title when given', () => {
    const summary = buildStubSummary({
      sessionId: 'opencode-run-123',
      agent: 'opencode',
      startedAt: '2026-07-19T10:00:00.000Z',
      lastActivityAt: '2026-07-19T10:00:00.000Z',
      title: 'Fix the flaky test',
    });

    expect(summary.title).toBe('Fix the flaky test');
  });

  it('omits title entirely rather than writing undefined when absent', () => {
    const summary = buildStubSummary({
      sessionId: 'opencode-run-123',
      agent: 'opencode',
      startedAt: '2026-07-19T10:00:00.000Z',
      lastActivityAt: '2026-07-19T10:00:00.000Z',
    });

    expect(summary).not.toHaveProperty('title');
  });

  it('carries the given agent through unchanged', () => {
    const summary = buildStubSummary({
      sessionId: 'codex-run-456',
      agent: 'codex',
      startedAt: '2026-07-19T10:00:00.000Z',
      lastActivityAt: '2026-07-19T10:00:00.000Z',
    });

    expect(summary.agent).toBe('codex');
  });
});
