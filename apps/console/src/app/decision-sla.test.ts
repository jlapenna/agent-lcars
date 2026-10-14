import { describe, expect, it } from 'vitest';

import {
  DECISION_SLA_MS,
  decisionSlaSummary,
  isOverDecisionSla,
} from './decision-sla';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('decision SLA', () => {
  it('draws the line the mockup draws: 1h 05m on time, 2h 20m over', () => {
    expect(isOverDecisionSla(ago(65 * 60_000), NOW)).toBe(false);
    expect(isOverDecisionSla(ago(140 * 60_000), NOW)).toBe(true);
  });

  it('flags only waits strictly longer than the SLA', () => {
    expect(isOverDecisionSla(ago(DECISION_SLA_MS), NOW)).toBe(false);
    expect(isOverDecisionSla(ago(DECISION_SLA_MS + 1), NOW)).toBe(true);
  });

  it('never flags an unparseable timestamp', () => {
    expect(isOverDecisionSla('not a date', NOW)).toBe(false);
  });

  it('counts every late decision and finds the oldest regardless of order', () => {
    expect(
      decisionSlaSummary(
        [
          ago(47 * 60_000),
          ago(192 * 60_000),
          ago(14 * 60_000),
          ago(140 * 60_000),
        ],
        NOW,
      ),
    ).toEqual({ overSla: 2, oldest: ago(192 * 60_000) });
  });

  it('reports nothing when nothing waits', () => {
    expect(decisionSlaSummary([], NOW)).toEqual({ overSla: 0 });
  });
});
