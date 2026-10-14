import type { GithubAnchorProjection } from '@agent-lcars/orchestrator';
import type { CliSessionDoc } from '@agent-lcars/telemetry';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  lifecycleCostMetrics,
  readLifecycleCostMetrics,
} from './lifecycle-cost-metrics';
import {
  getSessionArchive,
  type SessionArchiveResult,
} from './session-archive';
import { aggregateSessionSpend } from './session-spend';

vi.mock('./session-archive', () => ({
  ONE_HOUR_DAYS: 1 / 24,
  getSessionArchive: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
const repo = { owner: 'octo', name: 'example' };
function doc(
  sessionId: string,
  overrides: Partial<CliSessionDoc> = {},
): CliSessionDoc {
  return {
    sessionId,
    source: 'cli',
    agent: 'codex',
    repo,
    liveness: 'ended',
    startedAt: '2026-10-14T22:00:00.000Z',
    lastActivityAt: '2026-10-14T23:00:00.000Z',
    turns: 1,
    toolCallCounts: {},
    tokens: {
      inputTokens: 1000,
      outputTokens: 100,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    deliverables: {
      prNumbers: [42],
      qualifiedPRs: [{ repo, number: 42 }],
      commitShas: [],
    },
    ...overrides,
  };
}
const projection: GithubAnchorProjection = {
  anchor: { repo: 'octo/example', issue: 42 },
  kind: 'pr',
  state: 'closed',
  title: 'Useful change',
  body: '',
  url: 'https://github.com/octo/example/pull/42',
  labels: [],
  assigneeLogins: [],
  observedAt: '2026-10-14T23:00:00.000Z',
  sourceUpdatedAt: '2026-10-14T23:00:00.000Z',
  mergedAt: '2026-10-13T23:00:00.000Z',
};
function archive(
  docs: CliSessionDoc[],
  partial = false,
  projections = new Map([['octo/example#42', projection]]),
): SessionArchiveResult {
  return {
    available: true,
    rows: [],
    ledger: { byIssue: [], byWeek: [] },
    warnings: [],
    spend: aggregateSessionSpend(docs, projections, partial, 'lifecycle'),
  };
}

describe('lifecycle session cost proxy', () => {
  it('charges retry and no-PR sessions once against one duplicated known merge in their cohort', () => {
    const result = lifecycleCostMetrics(
      archive([
        doc('first', { totalCostUsd: 3 }),
        doc('retry', { totalCostUsd: 5 }),
        doc('failed', {
          totalCostUsd: 2,
          deliverables: { prNumbers: [], commitShas: [] },
        }),
      ]),
    );
    expect(result).toContain(
      'lcars_product_session_cost_sessions{pipeline="codex"} 3',
    );
    expect(result).toContain(
      'lcars_product_session_cost_merged_prs{pipeline="codex"} 1',
    );
    expect(result).toContain(
      'lcars_product_session_cost_per_merged_pr_proxy_usd{pipeline="codex",coverage="complete"} 10',
    );
    expect(result).not.toContain('octo');
    expect(result).not.toContain('first');
  });
  it('keeps estimates separate from reported money and marks an unpriced cohort ratio partial', () => {
    const selected = archive([
      doc('reported', { totalCostUsd: 3 }),
      doc('estimated', { model: 'claude-opus-4-7' }),
      doc('unknown', { model: 'unpriced' }),
    ]);
    const result = lifecycleCostMetrics(selected);
    expect(result).toContain(
      `lcars_product_session_cost_estimated_usd{pipeline="codex"} ${selected.spend!.totals.estimatedCostUsd}`,
    );
    expect(selected.spend!.totals.estimatedCostUsd).toBeGreaterThan(0);
    expect(result).toContain(
      'lcars_product_session_cost_reported_usd{pipeline="codex"} 3',
    );
    expect(result).toContain(
      'lcars_product_session_cost_unpriced_sessions{pipeline="codex"} 1',
    );
    expect(result).toContain('pipeline="codex",coverage="partial"');
  });
  it('omits the ratio when no price or merge is known instead of inventing free delivery', () => {
    const unknownPrice = lifecycleCostMetrics(
      archive([doc('unknown', { model: 'unpriced' })]),
    );
    expect(unknownPrice).not.toContain(
      'lcars_product_session_cost_per_merged_pr_proxy_usd{',
    );
    const unknownMerge = lifecycleCostMetrics(
      archive([doc('known-price', { totalCostUsd: 3 })], false, new Map()),
    );
    expect(unknownMerge).toContain(
      'lcars_product_session_cost_unknown_prs{pipeline="codex"} 1',
    );
    expect(unknownMerge).not.toContain(
      'lcars_product_session_cost_per_merged_pr_proxy_usd{',
    );
  });
  it('marks page overflow and incomplete projection reads without suppressing known partial amounts', () => {
    const selected = archive([doc('known', { totalCostUsd: 3 })], true);
    selected.warnings.push('Stored evidence unavailable');
    const result = lifecycleCostMetrics(selected);
    expect(result).toContain('lcars_product_session_cost_read_available 1');
    expect(result).toContain('lcars_product_session_cost_read_complete 0');
    expect(result).toContain('pipeline="codex",coverage="partial"} 3');
    expect(result).not.toContain('Stored evidence unavailable');
  });
  it('suppresses money on unavailable or nonfinite aggregation rather than exporting a healthy zero', () => {
    const failed = lifecycleCostMetrics();
    expect(failed).toContain('lcars_product_session_cost_read_available 0');
    expect(failed).not.toContain('lcars_product_session_cost_reported_usd{');
    const overflow = lifecycleCostMetrics(
      archive([
        doc('a', { totalCostUsd: Number.MAX_VALUE }),
        doc('b', { totalCostUsd: Number.MAX_VALUE }),
      ]),
    );
    expect(overflow).toContain('lcars_product_session_cost_read_available 0');
    expect(overflow).not.toContain('Infinity');
  });
  it('reads the canonical rolling-hour owner at the shared observation clock and sanitizes failures', async () => {
    vi.mocked(getSessionArchive).mockResolvedValue(archive([]));
    expect(
      await readLifecycleCostMetrics('2026-10-14T23:00:00.000Z'),
    ).toContain('lcars_product_session_cost_read_complete 1');
    expect(getSessionArchive).toHaveBeenCalledWith(
      { days: 1 / 24 },
      {
        includeSpend: true,
        observedAt: '2026-10-14T23:00:00.000Z',
        spendPipelineGrouping: 'lifecycle',
      },
    );
    vi.mocked(getSessionArchive).mockRejectedValue(new Error('private-token'));
    const failed = await readLifecycleCostMetrics('2026-10-14T23:00:00.000Z');
    expect(failed).toContain('lcars_product_session_cost_read_available 0');
    expect(failed).not.toContain('private-token');
  });
});
