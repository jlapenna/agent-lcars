import { describe, expect, it } from 'vitest';

import {
  expireTokenRate,
  fleetTokenRate,
  tokenRate,
  type TokenRateSnapshot,
} from './token-rate';

const observedAt = '2026-10-13T12:00:40.000Z';

function snapshot(
  sessions: TokenRateSnapshot['sessions'],
  capped = false,
): TokenRateSnapshot {
  return { sessions, capped, observedAt };
}

describe('tokenRate', () => {
  it('sums complete minutes and averages the last five', () => {
    const rate = tokenRate(
      snapshot([
        {
          agent: 'claude-code',
          repo: 'jlapenna/agent-lcars',
          minutes: [
            { minute: '2026-10-13T11:55:00.000Z', tokens: 500 },
            { minute: '2026-10-13T11:59:00.000Z', tokens: 1_000 },
            // The minute in progress is not complete.
            { minute: '2026-10-13T12:00:00.000Z', tokens: 9_999 },
          ],
        },
        {
          agent: 'codex',
          repo: 'jlapenna/homelab',
          minutes: [{ minute: '2026-10-13T11:59:00.000Z', tokens: 500 }],
        },
      ]),
    );
    expect(rate?.series).toHaveLength(30);
    expect(rate?.series[29]).toBe(1_500);
    expect(rate?.series[25]).toBe(500);
    // The last five complete minutes, 11:55 to 11:59, hold 2,000 tokens.
    expect(rate?.perMinute).toBe(400);
    expect(rate).toMatchObject({ sessions: 2, partial: false });
  });

  it('filters by repository and Work pipeline', () => {
    const sessions = snapshot([
      {
        agent: 'claude-code',
        repo: 'jlapenna/agent-lcars',
        minutes: [{ minute: '2026-10-13T11:59:00.000Z', tokens: 100 }],
      },
      {
        agent: 'codex',
        repo: 'jlapenna/homelab',
        minutes: [{ minute: '2026-10-13T11:59:00.000Z', tokens: 50 }],
      },
    ]);
    expect(tokenRate(sessions, { agent: 'claude' })?.series[29]).toBe(100);
    expect(tokenRate(sessions, { repo: 'jlapenna/homelab' })?.series[29]).toBe(
      50,
    );
  });

  it('is a known zero with no active session', () => {
    expect(tokenRate(snapshot([]))).toMatchObject({
      perMinute: 0,
      sessions: 0,
      partial: false,
    });
  });

  it('is unknown when no active session is measured, partial when some are', () => {
    expect(tokenRate(snapshot([{ agent: 'codex' }]))).toBeUndefined();
    expect(
      tokenRate(snapshot([{ agent: 'codex' }, { agent: 'codex', minutes: [] }]))
        ?.partial,
    ).toBe(true);
    expect(
      tokenRate(snapshot([{ agent: 'codex', minutes: [] }], true))?.partial,
    ).toBe(true);
  });
});

describe('fleetTokenRate', () => {
  it('names why the rate is unavailable', () => {
    expect(fleetTokenRate(undefined)).toEqual({
      unavailable: 'session store unavailable',
    });
    expect(fleetTokenRate(snapshot([{ agent: 'codex' }]))).toEqual({
      unavailable: 'no per-minute data',
    });
  });
});

describe('expireTokenRate', () => {
  it('turns a rate read too long ago into unavailable', () => {
    const rate = tokenRate(snapshot([]));
    const read = Date.parse(observedAt);
    expect(expireTokenRate(rate, read + 60_000, 180_000)).toBe(rate);
    expect(expireTokenRate(rate, read + 181_000, 180_000)).toEqual({
      unavailable: 'stale · refresh to update',
    });
    expect(expireTokenRate(undefined, read, 180_000)).toBeUndefined();
  });
});
