import type { CliSessionDoc } from '@agent-lcars/telemetry';
import { describe, expect, it } from 'vitest';

import {
  aggregateSpendByRepository,
  NO_REPOSITORY,
} from './session-spend-by-repo';

const now = Date.parse('2026-10-13T15:00:00Z');
const lcars = { owner: 'jlapenna', name: 'agent-lcars' };
const homelab = { owner: 'jlapenna', name: 'homelab' };

function doc(overrides: Partial<CliSessionDoc> = {}): CliSessionDoc {
  return {
    sessionId: 's',
    source: 'cli',
    agent: 'codex',
    repo: lcars,
    liveness: 'ended',
    startedAt: '2026-10-13T09:00:00Z',
    lastActivityAt: '2026-10-13T10:00:00Z',
    turns: 2,
    toolCallCounts: {},
    tokens: {
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    deliverables: { prNumbers: [], commitShas: [] },
    totalCostUsd: 2,
    ...overrides,
  };
}

describe('aggregateSpendByRepository', () => {
  it('splits today (UTC day) from the seven-day total per repository', () => {
    const spend = aggregateSpendByRepository(
      [
        doc({ totalCostUsd: 2 }),
        doc({ totalCostUsd: 3, lastActivityAt: '2026-10-12T23:59:00Z' }),
        doc({ repo: homelab, totalCostUsd: 1 }),
        // Outside seven days: not counted anywhere.
        doc({ totalCostUsd: 100, lastActivityAt: '2026-10-01T00:00:00Z' }),
      ],
      now,
      14,
    );
    expect(spend.rows.map((row) => row.repo)).toEqual([
      'jlapenna/agent-lcars',
      'jlapenna/homelab',
    ]);
    expect(spend.rows[0]).toMatchObject({
      todayUsd: 2,
      sevenDayUsd: 5,
      sessions7d: 2,
      perSessionUsd: 2.5,
      estimated: false,
      unpriced: 0,
    });
    expect(spend.todayUsd).toBe(3);
    expect(spend.sevenDayUsd).toBe(6);
    expect(spend.sevenDayUnavailable).toBe(false);
  });

  it('counts unpriced sessions without inventing cost, and buckets repo-less CLI sessions', () => {
    const spend = aggregateSpendByRepository(
      [
        doc({ repo: undefined, totalCostUsd: 1 }),
        doc({ totalCostUsd: undefined, model: undefined }),
      ],
      now,
      14,
    );
    const lcarsRow = spend.rows.find(
      (row) => row.repo === 'jlapenna/agent-lcars',
    );
    expect(lcarsRow).toMatchObject({
      sevenDayUsd: 0,
      sessions7d: 1,
      unpriced: 1,
    });
    expect(
      spend.rows.find((row) => row.repo === NO_REPOSITORY)?.sevenDayUsd,
    ).toBe(1);
  });

  it('withholds seven-day figures when the window is shorter than seven days', () => {
    expect(
      aggregateSpendByRepository([doc()], now, 1).sevenDayUnavailable,
    ).toBe(true);
  });
});
