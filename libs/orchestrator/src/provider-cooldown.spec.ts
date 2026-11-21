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
    summary: 'provider-limit',
    message: "You've hit your weekly limit · resets Sep 13, 12am (UTC)",
  },
};

const CODEX_FAILURE_PREFIX =
  'Provider quota or usage limit reached. The provider stopped this round before its final message; retained provider failure events: ';

describe('provider quota holds', () => {
  it('never derives a cooldown from an unclassified failure, even with quota text', () => {
    for (const pipeline of ['claude', 'codex']) {
      expect(
        providerCooldownForRun({
          ...run,
          pipeline,
          result: { ...run.result, summary: 'no-deliverable' },
        }),
      ).toBeUndefined();
    }
  });

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

  it.each([
    [
      `${CODEX_FAILURE_PREFIX}You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 11th, 2026 6:48 AM (UTC).`,
      '2026-11-09T01:00:00.000Z',
      '2026-11-11T06:48:00.000Z',
    ],
    [
      `${CODEX_FAILURE_PREFIX}You've hit your usage limit. Try again at Jan 1st, 2027 12:00 AM (UTC).`,
      '2026-12-31T22:00:00.000Z',
      '2027-01-01T00:00:00.000Z',
    ],
    [
      `${CODEX_FAILURE_PREFIX}You've hit your usage limit. Try again at Jan 2nd, 2027 12:30 PM (UTC).`,
      '2026-12-31T22:00:00.000Z',
      '2027-01-02T12:30:00.000Z',
    ],
    [
      `${CODEX_FAILURE_PREFIX}You've hit your usage limit. Try again at Jan 3rd, 2027 11:59 PM (UTC).`,
      '2026-12-31T22:00:00.000Z',
      '2027-01-03T23:59:00.000Z',
    ],
    [
      `${CODEX_FAILURE_PREFIX}You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Nov 9, 2026 6:48 AM (UTC).`,
      '2026-11-09T01:00:00.000Z',
      '2026-11-09T06:48:00.000Z',
    ],
    [
      `${CODEX_FAILURE_PREFIX}You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 11th, 2026 6:48 AM (UTC).\nYou’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 11th, 2026 6:48 AM (UTC).`,
      '2026-11-09T01:00:00.000Z',
      '2026-11-11T06:48:00.000Z',
    ],
  ])(
    'uses a runner-captured Codex CLI UTC reset (%s)',
    (message, updatedAt, expiresAt) => {
      expect(
        providerCooldownForRun({
          ...run,
          pipeline: 'codex',
          updatedAt,
          result: { ok: false, summary: 'provider-limit', message },
        })?.expiresAt,
      ).toBe(expiresAt);
    },
  );

  it.each([
    [
      'assistant final-message banner without CLI failure envelope',
      "You've hit your usage limit. Try again at Nov 11th, 2026 6:48 AM.",
    ],
    [
      'assistant final-message banner quoting literal (UTC) without CLI failure envelope',
      "You've hit your usage limit. Try again at Nov 11th, 2026 6:48 AM (UTC).",
    ],
    [
      'zone-less full date',
      `${CODEX_FAILURE_PREFIX}You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 11th, 2026 6:48 AM.`,
    ],
    [
      'non-UTC zone',
      `${CODEX_FAILURE_PREFIX}You’ve hit your usage limit. Try again at Nov 11th, 2026 6:48 AM (PST).`,
    ],
    [
      'date-less same-day time',
      `${CODEX_FAILURE_PREFIX}You've hit your usage limit. Try again at 6:48 AM (UTC).`,
    ],
    [
      'expired instant',
      `${CODEX_FAILURE_PREFIX}You've hit your usage limit. Try again at Nov 9th, 2026 1:00 AM (UTC).`,
    ],
    [
      'past MAX_RESET_MS',
      `${CODEX_FAILURE_PREFIX}You've hit your usage limit. Try again at Nov 16th, 2026 1:01 AM (UTC).`,
    ],
    [
      'invalid calendar date',
      `${CODEX_FAILURE_PREFIX}You've hit your usage limit. Try again at Feb 30th, 2026 6:48 AM (UTC).`,
    ],
    [
      'invalid month',
      `${CODEX_FAILURE_PREFIX}You've hit your usage limit. Try again at Foo 11th, 2026 6:48 AM (UTC).`,
    ],
    [
      'zero hour',
      `${CODEX_FAILURE_PREFIX}You've hit your usage limit. Try again at Nov 11th, 2026 0:30 AM (UTC).`,
    ],
    [
      '24-hour clock value',
      `${CODEX_FAILURE_PREFIX}You've hit your usage limit. Try again at Nov 11th, 2026 13:00 PM (UTC).`,
    ],
    [
      'conflicting duplicate events',
      `${CODEX_FAILURE_PREFIX}You've hit your usage limit. Try again at Nov 11th, 2026 6:48 AM (UTC).\nYou've hit your usage limit. Try again at Nov 11th, 2026 6:49 AM (UTC).`,
    ],
    [
      'mixed zoned and zone-less events',
      `${CODEX_FAILURE_PREFIX}You've hit your usage limit. Try again at Nov 11th, 2026 6:48 AM (UTC).\nYou've hit your usage limit. Try again at Nov 11th, 2026 6:48 AM.`,
    ],
  ])(
    'falls back to a bounded probe when Codex reset is %s',
    (_label, message) => {
      expect(
        providerCooldownForRun({
          ...run,
          pipeline: 'codex',
          updatedAt: '2026-11-09T01:00:00.000Z',
          result: { ok: false, summary: 'provider-limit', message },
        })?.expiresAt,
      ).toBe('2026-11-09T01:15:00.000Z');
    },
  );

  it('uses a bounded probe for an explicit provider-limit without a known reset', () => {
    expect(
      providerCooldownForRun({
        ...run,
        pipeline: 'opencode',
        result: { ok: false, summary: 'provider-limit' },
      })?.expiresAt,
    ).toBe('2026-09-12T01:15:00.000Z');
  });

  it.each(['claude', 'codex', 'opencode'])(
    'holds %s for one bounded probe after a model-capacity stop',
    (pipeline) => {
      expect(
        providerCooldownForRun({
          ...run,
          pipeline,
          result: {
            ok: false,
            summary: 'provider-capacity',
            message:
              'Selected model is at capacity. Provider failure: Selected model is at capacity. Please try a different model. resets Sep 13, 12am (UTC)',
          },
        })?.expiresAt,
      ).toBe('2026-09-12T01:15:00.000Z');
    },
  );

  it('does not turn other failures or successful artifacts into provider holds', () => {
    expect(
      providerCooldownForRun({
        ...run,
        result: { ok: false, summary: 'agent-timeout' },
      }),
    ).toBeUndefined();
    expect(
      providerCooldownForRun({ ...run, result: { ...run.result, ok: true } }),
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
