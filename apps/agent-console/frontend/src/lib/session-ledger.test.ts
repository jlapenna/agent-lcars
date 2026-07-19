import type {
  CliSessionDoc,
  IssueAgentSessionDoc,
} from '@repo/agent-telemetry';
import { describe, expect, it } from 'vitest';

import { aggregateSessionLedger } from './session-ledger';

function cliDoc(overrides: Partial<CliSessionDoc> = {}): CliSessionDoc {
  return {
    sessionId: 'cli-1',
    source: 'cli',
    liveness: 'ended',
    startedAt: '2026-01-05T10:00:00.000Z', // Monday of 2026-W02
    lastActivityAt: '2026-01-05T10:05:00.000Z',
    turns: 3,
    toolCallCounts: {},
    tokens: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    deliverables: { prNumbers: [], commitShas: [] },
    ...overrides,
  };
}

function agentDoc(
  overrides: Partial<IssueAgentSessionDoc> = {},
): IssueAgentSessionDoc {
  return {
    sessionId: 'agent-1',
    source: 'issue-agent',
    liveness: 'ended',
    startedAt: '2026-01-05T10:00:00.000Z',
    lastActivityAt: '2026-01-05T10:05:00.000Z',
    turns: 5,
    toolCallCounts: {},
    tokens: {
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    deliverables: { prNumbers: [], commitShas: [] },
    ...overrides,
  };
}

describe('aggregateSessionLedger', () => {
  it('returns empty ledgers for no docs', () => {
    expect(aggregateSessionLedger([])).toEqual({ byIssue: [], byWeek: [] });
  });

  it('buckets CLI sessions under no-issue and issue-agent sessions under their issue number', () => {
    const { byIssue } = aggregateSessionLedger([
      cliDoc({ sessionId: 'c1' }),
      agentDoc({ sessionId: 'a1', issueNumber: 42 }),
      agentDoc({ sessionId: 'a2', issueNumber: 42 }),
    ]);

    const byKey = new Map(byIssue.map((row) => [row.issueNumber, row]));
    expect(byKey.get('no-issue')?.sessions).toBe(1);
    expect(byKey.get(42)?.sessions).toBe(2);
    expect(byKey.get(42)?.turns).toBe(10); // 5 + 5
    expect(byKey.get(42)?.tokens).toBe(3000); // (1000+500)*2
  });

  it('buckets an issue-agent doc with no issueNumber under no-issue too', () => {
    const { byIssue } = aggregateSessionLedger([
      agentDoc({ sessionId: 'a1', issueNumber: undefined }),
    ]);

    expect(byIssue).toEqual([
      expect.objectContaining({ issueNumber: 'no-issue', sessions: 1 }),
    ]);
  });

  it('sums cost only across sessions that have totalCostUsd, leaving it undefined when none do', () => {
    const { byIssue } = aggregateSessionLedger([
      cliDoc({ sessionId: 'c1', totalCostUsd: undefined }),
      cliDoc({ sessionId: 'c2', totalCostUsd: undefined }),
    ]);

    expect(byIssue[0].costUsd).toBeUndefined();
    expect(byIssue[0].tokens).toBe(300); // both sessions' tokens still counted
  });

  it('sums cost across a mix of costed and uncosted sessions in the same bucket (partial total)', () => {
    const { byIssue } = aggregateSessionLedger([
      agentDoc({ sessionId: 'a1', issueNumber: 7, totalCostUsd: 1.5 }),
      agentDoc({ sessionId: 'a2', issueNumber: 7, totalCostUsd: undefined }),
    ]);

    const row = byIssue.find((r) => r.issueNumber === 7);
    expect(row?.costUsd).toBe(1.5);
    expect(row?.sessions).toBe(2);
  });

  it('sorts by cost desc, then tokens desc, with uncosted buckets ranked below any costed bucket', () => {
    const { byIssue } = aggregateSessionLedger([
      agentDoc({ sessionId: 'a1', issueNumber: 1, totalCostUsd: 0.5 }),
      agentDoc({ sessionId: 'a2', issueNumber: 2, totalCostUsd: 5 }),
      agentDoc({
        sessionId: 'a3',
        issueNumber: 3,
        totalCostUsd: undefined,
        tokens: {
          inputTokens: 9000,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      }),
      agentDoc({
        sessionId: 'a4',
        issueNumber: 4,
        totalCostUsd: undefined,
        tokens: {
          inputTokens: 100,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      }),
    ]);

    expect(byIssue.map((r) => r.issueNumber)).toEqual([2, 1, 3, 4]);
  });

  it('breaks a cost tie by tokens desc', () => {
    const { byIssue } = aggregateSessionLedger([
      agentDoc({
        sessionId: 'a1',
        issueNumber: 1,
        totalCostUsd: 2,
        tokens: {
          inputTokens: 100,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      }),
      agentDoc({
        sessionId: 'a2',
        issueNumber: 2,
        totalCostUsd: 2,
        tokens: {
          inputTokens: 9000,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      }),
    ]);

    expect(byIssue.map((r) => r.issueNumber)).toEqual([2, 1]);
  });

  it('buckets sessions into their ISO week (Monday-start)', () => {
    const { byWeek } = aggregateSessionLedger([
      // Sunday 2026-01-04 is the last day of ISO week 2026-W01.
      cliDoc({ sessionId: 'c1', startedAt: '2026-01-04T23:00:00.000Z' }),
      // Monday 2026-01-05 begins ISO week 2026-W02.
      cliDoc({ sessionId: 'c2', startedAt: '2026-01-05T00:30:00.000Z' }),
    ]);

    const byKey = new Map(byWeek.map((row) => [row.isoWeek, row]));
    expect(byKey.get('2026-W01')?.sessions).toBe(1);
    expect(byKey.get('2026-W02')?.sessions).toBe(1);
  });

  it('buckets an unparseable startedAt under an unknown week rather than throwing', () => {
    expect(() =>
      aggregateSessionLedger([cliDoc({ startedAt: '' })]),
    ).not.toThrow();

    const { byWeek } = aggregateSessionLedger([cliDoc({ startedAt: '' })]);
    expect(byWeek).toEqual([
      expect.objectContaining({ isoWeek: 'unknown', sessions: 1 }),
    ]);
  });

  it('aggregates a realistic mixed-source, mixed-cost, multi-week set correctly', () => {
    const ledger = aggregateSessionLedger([
      cliDoc({
        sessionId: 'c1',
        startedAt: '2026-01-05T10:00:00.000Z',
        turns: 4,
        tokens: {
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      }),
      agentDoc({
        sessionId: 'a1',
        issueNumber: 100,
        startedAt: '2026-01-05T12:00:00.000Z',
        turns: 6,
        totalCostUsd: 1.23,
        tokens: {
          inputTokens: 2000,
          outputTokens: 800,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      }),
      agentDoc({
        sessionId: 'a2',
        issueNumber: 100,
        startedAt: '2026-01-12T09:00:00.000Z', // next ISO week
        turns: 2,
        totalCostUsd: 0.45,
        tokens: {
          inputTokens: 500,
          outputTokens: 200,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      }),
    ]);

    expect(ledger.byIssue).toHaveLength(2);
    const issue100 = ledger.byIssue.find((r) => r.issueNumber === 100);
    expect(issue100).toMatchObject({
      sessions: 2,
      turns: 8,
      tokens: 3500,
      costUsd: 1.68,
    });

    expect(ledger.byWeek).toHaveLength(2);
    const week02 = ledger.byWeek.find((r) => r.isoWeek === '2026-W02');
    expect(week02).toMatchObject({ sessions: 2, costUsd: 1.23 });
    const week03 = ledger.byWeek.find((r) => r.isoWeek === '2026-W03');
    expect(week03).toMatchObject({ sessions: 1, costUsd: 0.45 });
  });
});
