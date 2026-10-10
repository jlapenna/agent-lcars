import type { GithubAnchorProjection } from '@agent-lcars/orchestrator';
import type { CliSessionDoc } from '@agent-lcars/telemetry';
import { describe, expect, it } from 'vitest';

import { aggregateSessionLedger, docCost } from './session-ledger';
import {
  aggregateSessionSpend,
  assessCostBudget,
  parseCostBudget,
} from './session-spend';

const repo = { owner: 'jlapenna', name: 'agent-lcars' };
function doc(overrides: Partial<CliSessionDoc> = {}): CliSessionDoc {
  return {
    sessionId: 's',
    source: 'cli',
    agent: 'codex',
    repo,
    liveness: 'ended',
    startedAt: '2026-10-01T00:00:00Z',
    lastActivityAt: '2026-10-02T00:00:00Z',
    turns: 2,
    toolCallCounts: {},
    tokens: {
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    deliverables: { prNumbers: [], commitShas: [] },
    ...overrides,
  };
}
function projection(
  n: number,
  mergedAt?: string | null,
  overrides: Partial<GithubAnchorProjection> = {},
): GithubAnchorProjection {
  return {
    anchor: { repo: 'jlapenna/agent-lcars', issue: n },
    kind: 'pr',
    state: 'closed',
    title: 'PR',
    body: '',
    url: `https://github.com/jlapenna/agent-lcars/pull/${n}`,
    author: 'jlapenna',
    labels: [],
    assigneeLogins: [],
    sourceUpdatedAt: '2026-10-02T00:00:00Z',
    observedAt: '2026-10-02T00:00:00Z',
    ...(mergedAt !== undefined && { mergedAt }),
    ...overrides,
  };
}
const refs = (prNumbers: number[]) => ({ prNumbers, commitShas: [] });
const merged = '2026-09-01T00:00:00Z';

describe('selected session spend', () => {
  it('reconciles mixed providers/models and repeated attempts with both existing ledgers', () => {
    const docs = [
      doc({
        sessionId: 'a',
        totalCostUsd: 6,
        model: 'requested',
        resolvedModel: 'actual',
        deliverables: refs([42, 42, 43]),
      }),
      doc({
        sessionId: 'b',
        agent: 'opencode',
        totalCostUsd: 4,
        model: 'requested',
        resolvedModel: 'different',
        deliverables: refs([42]),
      }),
      doc({
        sessionId: 'c',
        agent: 'claude-code',
        model: 'claude-opus-4-7',
        deliverables: refs([43]),
      }),
      doc({ sessionId: 'd', totalCostUsd: 2 }),
      doc({ sessionId: 'e', model: 'unpriced', deliverables: refs([44]) }),
    ];
    const result = aggregateSessionSpend(
      docs,
      new Map([
        ['jlapenna/agent-lcars#42', projection(42, merged)],
        ['jlapenna/agent-lcars#43', projection(43, null)],
      ]),
    );
    expect(result).toMatchObject({
      mergedPRs: 1,
      unmergedPRs: 1,
      unknownPRs: 1,
    });
    const expectedEstimate = docCost(docs[2]!).costUsd!;
    expect(result.totals).toMatchObject({
      sessions: 5,
      reportedCostUsd: 12,
      estimatedCostUsd: expectedEstimate,
      unpricedSessions: 1,
    });
    expect(result.costPerMergedDeliverableUsd).toBeCloseTo(
      12 + expectedEstimate,
    );
    for (const rows of [
      result.byPipeline,
      result.byRequestedModel,
      result.byResolvedModel,
    ]) {
      expect(rows.reduce((n, r) => n + (r.costUsd ?? 0), 0)).toBeCloseTo(
        result.totals.costUsd!,
      );
      expect(rows.reduce((n, r) => n + r.sessions, 0)).toBe(5);
    }
    expect(result.byPipeline.map((r) => r.key)).toEqual(
      expect.arrayContaining(['codex', 'opencode', 'claude']),
    );
    expect(
      result.byResolvedModel.find((r) => r.key === 'unknown')?.sessions,
    ).toBe(3);
    const ledger = aggregateSessionLedger(docs);
    for (const rows of [ledger.byIssue, ledger.byWeek])
      expect(rows.reduce((n, r) => n + (r.costUsd ?? 0), 0)).toBeCloseTo(
        result.totals.costUsd!,
      );
    expect(
      result.deliverables.find((r) => r.key.endsWith('#42')),
    ).toMatchObject({ reportedCostUsd: 7, sessions: 2 });
    expect(
      result.deliverables.reduce(
        (n, r) => n + r.reportedCostUsd + r.estimatedCostUsd,
        0,
      ) + (result.withoutPR.costUsd ?? 0),
    ).toBeCloseTo(result.totals.costUsd!);
  });

  it('does not equate closed PRs, legacy projections, wrong identities or issues with merged deliverables', () => {
    const docs = [
      doc({ totalCostUsd: 5, deliverables: refs([1, 2, 3, 4, 5]) }),
    ];
    const result = aggregateSessionSpend(
      docs,
      new Map([
        ['jlapenna/agent-lcars#1', projection(1)],
        ['jlapenna/agent-lcars#2', projection(2, merged, { kind: 'issue' })],
        ['jlapenna/agent-lcars#3', projection(3, merged, { state: 'open' })],
        ['jlapenna/agent-lcars#4', projection(99, merged)],
        ['jlapenna/agent-lcars#5', projection(5, null)],
      ]),
    );
    expect(result).toMatchObject({
      mergedPRs: 0,
      unknownPRs: 4,
      unmergedPRs: 1,
    });
    expect(result.costPerMergedDeliverableUsd).toBeUndefined();
  });

  it('qualifies PR numbers by repository and preserves host-only spend', () => {
    const result = aggregateSessionSpend(
      [
        doc({ totalCostUsd: 2, deliverables: refs([42]) }),
        doc({
          totalCostUsd: 3,
          repo: { owner: 'other', name: 'repo' },
          deliverables: refs([42]),
        }),
        doc({ totalCostUsd: 4, repo: undefined, deliverables: refs([42]) }),
      ],
      new Map([['jlapenna/agent-lcars#42', projection(42, merged)]]),
    );
    expect(result.deliverables).toHaveLength(2);
    expect(result.withoutPR).toMatchObject({ sessions: 1, costUsd: 4 });
    expect(result.costPerMergedDeliverableUsd).toBe(9);
  });

  it('keeps absent costs unknown and uses resolved rates rather than the requested alias', () => {
    expect(
      docCost(doc({ model: 'claude-opus-4-7', resolvedModel: 'unpriced' }))
        .costUsd,
    ).toBeUndefined();
    const result = aggregateSessionSpend([doc({ model: 'unpriced' })]);
    expect(result.totals.costUsd).toBeUndefined();
    expect(result.totals.unpricedSessions).toBe(1);
    expect(
      aggregateSessionSpend([]).costPerMergedDeliverableUsd,
    ).toBeUndefined();
  });
});

describe('configured budget states', () => {
  const budget = parseCostBudget('10', '80');
  it.each([
    [0, 'Below warning threshold'],
    [7.99, 'Below warning threshold'],
    [8, 'Near budget'],
    [10, 'At or above budget'],
  ])('assesses known spend %s', (cost, label) => {
    expect(
      assessCostBudget(
        aggregateSessionSpend([doc({ totalCostUsd: Number(cost) })]),
        budget,
      ),
    ).toBe(label);
  });
  it('does not call incomplete low spend below threshold but preserves known threshold breaches', () => {
    expect(assessCostBudget(aggregateSessionSpend([doc()]), budget)).toBe(
      'Cannot assess: incomplete spend',
    );
    expect(
      assessCostBudget(aggregateSessionSpend([], new Map(), true), budget),
    ).toBe('Cannot assess: incomplete spend');
    expect(
      assessCostBudget(
        aggregateSessionSpend([doc({ totalCostUsd: 10 }), doc()]),
        budget,
      ),
    ).toBe('At or above budget');
  });
  it('shows missing/invalid configuration and never fabricates a limit', () => {
    const spend = aggregateSessionSpend([]);
    expect(assessCostBudget(spend, parseCostBudget())).toBe(
      'No budget configured',
    );
    for (const args of [
      ['0'],
      ['NaN'],
      ['10', '100'],
      ['10', ''],
      ['10', '-1'],
    ])
      expect(assessCostBudget(spend, parseCostBudget(...args))).toBe(
        'Budget configuration invalid',
      );
    expect(parseCostBudget('10')).toEqual({
      state: 'configured',
      limitUsd: 10,
      warningPercent: 80,
    });
  });
});
