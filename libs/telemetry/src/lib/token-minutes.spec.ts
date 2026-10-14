import { describe, expect, it } from 'vitest';

import { nextTokenMinutes, parseTokenMinutes } from './token-minutes';
import { type TokenUsage } from './types';

const NOW = '2026-10-13T12:00:30.000Z';

function usage(inputTokens: number): TokenUsage {
  return {
    inputTokens,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
}

describe('nextTokenMinutes', () => {
  it('credits growth of the stored total to the minute the event occurred', () => {
    expect(
      nextTokenMinutes(
        {
          tokens: usage(100),
          tokenMinutes: [{ minute: '2026-10-13T11:58:00.000Z', tokens: 40 }],
        },
        usage(160),
        '2026-10-13T11:59:45.000Z',
        NOW,
      ).tokenMinutes,
    ).toEqual([
      { minute: '2026-10-13T11:58:00.000Z', tokens: 40 },
      { minute: '2026-10-13T11:59:00.000Z', tokens: 60 },
    ]);
  });

  it('adds to an existing minute and never mutates the stored list', () => {
    const stored = [{ minute: '2026-10-13T12:00:00.000Z', tokens: 5 }];
    expect(
      nextTokenMinutes(
        { tokens: usage(10), tokenMinutes: stored },
        usage(17),
        NOW,
        NOW,
      ).tokenMinutes,
    ).toEqual([{ minute: '2026-10-13T12:00:00.000Z', tokens: 12 }]);
    expect(stored[0]?.tokens).toBe(5);
  });

  it('credits nothing on a first write or a shrinking total, but still marks the session measured', () => {
    expect(nextTokenMinutes(undefined, usage(500), NOW, NOW)).toEqual({
      tokenMinutes: [],
      tokenMinutesBase: 500,
    });
    expect(
      nextTokenMinutes({ tokens: usage(500) }, usage(400), NOW, NOW),
    ).toEqual({ tokenMinutes: [], tokenMinutesBase: 500 });
  });

  it('drops minutes older than the window and credits a future event now', () => {
    expect(
      nextTokenMinutes(
        {
          tokens: usage(0),
          tokenMinutes: [
            { minute: '2026-10-13T11:20:00.000Z', tokens: 9 },
            { minute: '2026-10-13T11:30:00.000Z', tokens: 3 },
          ],
        },
        usage(8),
        '2026-10-13T12:05:00.000Z',
        NOW,
      ).tokenMinutes,
    ).toEqual([
      { minute: '2026-10-13T11:30:00.000Z', tokens: 3 },
      { minute: '2026-10-13T12:00:00.000Z', tokens: 8 },
    ]);
  });
});

describe('nextTokenMinutes after a dip', () => {
  it('credits only growth above the highest total already credited', () => {
    const dipped = nextTokenMinutes({ tokens: usage(500) }, usage(0), NOW, NOW);
    expect(dipped.tokenMinutes).toEqual([]);
    const recovered = nextTokenMinutes(
      { tokens: usage(0), ...dipped },
      usage(520),
      NOW,
      NOW,
    );
    expect(recovered).toEqual({
      tokenMinutes: [{ minute: '2026-10-13T12:00:00.000Z', tokens: 20 }],
      tokenMinutesBase: 520,
    });
  });
});

describe('parseTokenMinutes', () => {
  it('keeps only well-formed entries', () => {
    expect(
      parseTokenMinutes([
        { minute: '2026-10-13T12:00:00.000Z', tokens: 1 },
        { minute: 'soon', tokens: 1 },
        { minute: '2026-10-13T12:01:00.000Z', tokens: -1 },
        { minute: '2026-10-13T12:02:00.000Z', tokens: 1.5 },
        null,
      ]),
    ).toEqual([{ minute: '2026-10-13T12:00:00.000Z', tokens: 1 }]);
    expect(parseTokenMinutes('nope')).toBeUndefined();
  });
});
