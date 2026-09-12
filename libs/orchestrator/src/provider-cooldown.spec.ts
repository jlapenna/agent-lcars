import { describe, expect, it } from 'vitest';

import {
  providerCooldownForRun,
  providerIsCoolingDown,
} from './provider-cooldown';

const run = {
  runId: 'work:quota/r1',
  state: 'finished' as const,
  pipeline: 'claude',
  updatedAt: '2026-09-12T01:00:00.000Z',
  result: {
    ok: false,
    summary: 'no-deliverable',
    message: "You've hit your weekly limit · resets Sep 13, 12am (UTC)",
  },
};

describe('provider quota holds', () => {
  it.each([
    ['Sep 13, 12am', '2026-09-13T00:00:00.000Z'],
    ['12am', '2026-09-13T00:00:00.000Z'],
    ['1:30pm', '2026-09-12T13:30:00.000Z'],
    ['Sep 30, 12am', '2026-09-12T01:15:00.000Z'],
    ['Feb 30, 12am', '2026-09-12T01:15:00.000Z'],
    ['25am', '2026-09-12T01:15:00.000Z'],
  ])('bounds the reported UTC reset %s', (reset, expiresAt) => {
    expect(
      providerCooldownForRun({
        ...run,
        result: {
          ...run.result,
          message: `You've hit your weekly limit · resets ${reset} (UTC)`,
        },
      })?.expiresAt,
    ).toBe(expiresAt);
  });

  it('resolves a reset across the year boundary', () => {
    expect(
      providerCooldownForRun({
        ...run,
        updatedAt: '2026-12-31T22:00:00.000Z',
        result: {
          ...run.result,
          message: "You've hit your weekly limit · resets Jan 1, 12am (UTC)",
        },
      })?.expiresAt,
    ).toBe('2027-01-01T00:00:00.000Z');
  });

  it('uses a bounded probe for an explicit provider-limit without a known reset', () => {
    expect(
      providerCooldownForRun({
        ...run,
        pipeline: 'opencode',
        result: { ok: false, summary: 'provider-limit' },
      })?.expiresAt,
    ).toBe('2026-09-12T01:15:00.000Z');
  });

  it('does not turn other failures, successful artifacts, or quoted task prose into provider holds', () => {
    expect(
      providerCooldownForRun({
        ...run,
        result: { ok: false, summary: 'agent-timeout' },
      }),
    ).toBeUndefined();
    expect(
      providerCooldownForRun({ ...run, result: { ...run.result, ok: true } }),
    ).toBeUndefined();
    expect(
      providerCooldownForRun({ ...run, pipeline: 'codex' }),
    ).toBeUndefined();
    expect(
      providerCooldownForRun({
        ...run,
        result: {
          ...run.result,
          message: `The task mentioned: ${run.result.message}`,
        },
      }),
    ).toBeUndefined();
  });

  it('expires at the deadline and fails open on malformed hold metadata', () => {
    const cooldown = providerCooldownForRun(run);
    expect(providerIsCoolingDown(cooldown, run.updatedAt)).toBe(true);
    expect(providerIsCoolingDown(cooldown, '2026-09-13T00:00:00.000Z')).toBe(
      false,
    );
    expect(providerIsCoolingDown({ expiresAt: 'invalid' }, run.updatedAt)).toBe(
      false,
    );
    expect(providerIsCoolingDown(undefined, run.updatedAt)).toBe(false);
  });
});
