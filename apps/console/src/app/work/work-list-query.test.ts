import { describe, expect, it } from 'vitest';

import {
  matchesWorkView,
  parseWorkListQuery,
  parseWorkViewFilters,
} from './work-list-query';

const now = Date.parse('2026-10-13T12:00:00Z');
const item = {
  id: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
  updatedAt: '2026-10-13T11:30:00Z',
  spec: {
    title: 'Add healthz',
    pipeline: 'claude',
    target: { repo: 'jlapenna/agent-lcars' },
  },
  origin: { principal: 'user:jlapenna' },
  runs: [{ pipeline: 'codex' }],
};

describe('Work view filters', () => {
  it('filters source-driven work without mistaking ordinary coding for an event', () => {
    const filters = parseWorkViewFilters({ activity: 'events' });
    expect(matchesWorkView(item, filters, now)).toBe(false);
    expect(
      matchesWorkView(
        {
          ...item,
          runs: [
            {
              pipeline: 'opencode',
              sourceRevision: {
                key: 'revision',
                input: { operation: 'fleet-triage:v1' },
              },
            },
          ],
        },
        filters,
        now,
      ),
    ).toBe(true);
    expect(
      matchesWorkView(
        {
          ...item,
          runs: [
            {
              pipeline: 'inbox-summary',
              sourceRevision: { key: 'revision', input: { context: '{}' } },
            },
          ],
        },
        filters,
        now,
      ),
    ).toBe(true);
    expect(parseWorkListQuery({ activity: 'events' })).not.toHaveProperty(
      'activity',
    );
  });

  it('keeps view filters out of the Work API input', () => {
    const input = parseWorkListQuery({
      repo: 'a/b',
      agent: 'codex',
      q: 'x',
      window: '1h',
    });
    expect(input).toEqual({
      state: undefined,
      repo: 'a/b',
      principal: undefined,
      cursor: undefined,
      limit: 200,
    });
  });

  it('ignores unknown windows rather than rejecting the page', () => {
    expect(parseWorkViewFilters({ window: '90d' }).window).toBeUndefined();
    expect(parseWorkViewFilters({ window: '24h' }).window).toBe('24h');
  });

  it('matches agent by requested or attempted pipeline, window and text', () => {
    expect(matchesWorkView(item, { agent: 'claude' }, now)).toBe(true);
    expect(matchesWorkView(item, { agent: 'codex' }, now)).toBe(true);
    expect(matchesWorkView(item, { agent: 'opencode' }, now)).toBe(false);
    expect(matchesWorkView(item, { window: '1h' }, now)).toBe(true);
    expect(
      matchesWorkView(
        { ...item, updatedAt: '2026-10-13T10:00:00Z' },
        { window: '1h' },
        now,
      ),
    ).toBe(false);
    expect(matchesWorkView(item, { q: 'HEALTHZ' }, now)).toBe(true);
    expect(matchesWorkView(item, { q: 'agent-lcars' }, now)).toBe(true);
    expect(matchesWorkView(item, { q: 'nope' }, now)).toBe(false);
  });
});
