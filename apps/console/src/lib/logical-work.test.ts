import { describe, expect, it } from 'vitest';

import type { AgentRun } from './agent-activity';
import { deriveActivityMetrics, deriveLogicalWork } from './logical-work';

const repo = { owner: 'supersprinklesracing', name: 'sprinkles' };
const key = 'supersprinklesracing/sprinkles#42';
const run = (overrides: Partial<AgentRun> = {}): AgentRun => ({
  id: 'supersprinklesracing/sprinkles#42/r1',
  repo,
  pipeline: 'claude',
  status: 'running',
  url: 'https://github.com/supersprinklesracing/sprinkles/issues/42',
  displayTitle: '#42 Fix the thing',
  issueNumber: 42,
  createdAt: '2026-08-29T00:00:00Z',
  updatedAt: '2026-08-29T00:01:00Z',
  elapsedSeconds: 60,
  ...overrides,
});
const taskMeta = new Map([
  [
    key,
    {
      repo,
      issueNumber: 42,
      title: 'Fix the thing',
      url: 'https://github.com/supersprinklesracing/sprinkles/issues/42',
    },
  ],
]);

describe('deriveLogicalWork', () => {
  it('uses authoritative runs for lifecycle while preserving GitHub task metadata', () => {
    const { work } = deriveLogicalWork({ runs: [run()], taskMeta });
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({
      title: 'Fix the thing',
      state: 'active',
      provenance: { kind: 'authoritative' },
    });
    expect(work[0].runs.map((item) => item.id)).toEqual([
      'supersprinklesracing/sprinkles#42/r1',
    ]);
  });

  it('makes a failed authority read unavailable rather than deriving state', () => {
    const { work } = deriveLogicalWork({
      runs: [run()],
      taskMeta,
      unavailableTaskKeys: new Set([key]),
    });
    expect(work[0].state).toBe('unavailable');
  });

  it('keeps duplicate live runs visible and counts run occupancy separately', () => {
    const runs = [run(), run({ id: 'supersprinklesracing/sprinkles#42/r2' })];
    const { work } = deriveLogicalWork({ runs, taskMeta });
    expect(work[0].anomalies).toHaveLength(1);
    expect(deriveActivityMetrics(work, runs)).toMatchObject({
      logicalTaskCount: 1,
      runningRuns: 2,
      queuedRuns: 0,
    });
  });
});
