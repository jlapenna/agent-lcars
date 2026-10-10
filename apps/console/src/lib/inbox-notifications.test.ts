import { describe, expect, it } from 'vitest';

import {
  advanceNotificationState,
  emptyNotificationState,
  type InboxNotificationSnapshot,
  notificationHref,
  parseNotificationState,
} from './inbox-notifications';

const decision = { id: 'owner/repo#1', generation: 'needs-human' };
const snapshot = (
  at: number,
  decisions = [decision],
  available = true,
): InboxNotificationSnapshot => ({
  principalId: 'viewer',
  observedAt: at,
  available,
  sourceTimes: { queue: at, activity: at, native: at },
  decisions,
});
const baseline = () =>
  advanceNotificationState(
    { ...emptyNotificationState(), enabled: true },
    snapshot(100_000),
    100_000,
  );

describe('authenticated Inbox notification accounting', () => {
  it('starts quiet and ignores ordinary re-observation without queuing duplicates', () => {
    const state = baseline();
    expect(state.pending).toEqual([]);
    expect(
      advanceNotificationState(state, snapshot(110_000), 110_000).pending,
    ).toEqual([]);
    expect(
      advanceNotificationState(
        emptyNotificationState(),
        snapshot(100_000),
        100_000,
      ).active,
    ).toBeNull();
  });
  it('detects an observed reopening and a new native park round', () => {
    const absent = advanceNotificationState(
      baseline(),
      snapshot(110_000, []),
      110_000,
    );
    expect(
      advanceNotificationState(absent, snapshot(120_000), 120_000).pending,
    ).toEqual([decision]);
    const park = { id: 'work:01ABC', generation: 'work:01ABC/r1' };
    const state = advanceNotificationState(
      { ...emptyNotificationState(), enabled: true },
      snapshot(100_000, [park]),
      100_000,
    );
    const newRound = { ...park, generation: 'work:01ABC/r2' };
    expect(
      advanceNotificationState(state, snapshot(110_000, [newRound]), 110_000)
        .pending,
    ).toEqual([newRound]);
  });
  it('never converts partial, stale, future or out-of-order data into disappearances', () => {
    const state = baseline();
    for (const sample of [
      snapshot(110_000, [], false),
      snapshot(90_000, []),
      snapshot(100_000, []),
      snapshot(200_000, []),
      snapshot(1_000, []),
    ]) {
      expect(advanceNotificationState(state, sample, 110_000)).toBe(state);
    }
    expect(
      advanceNotificationState(state, snapshot(120_000), 120_000).pending,
    ).toEqual([]);
  });
  it('coalesces new decisions, removes resolved pending decisions and retains send time', () => {
    const next = { id: 'owner/repo#2', generation: 'needs-human' };
    const pending = advanceNotificationState(
      { ...baseline(), lastSentAt: 105_000 },
      snapshot(110_000, [decision, next]),
      110_000,
    );
    expect(pending.pending).toEqual([next]);
    expect(
      advanceNotificationState(pending, snapshot(120_000), 120_000),
    ).toMatchObject({ pending: [], lastSentAt: 105_000 });
  });
  it.each(['queue', 'activity'] as const)(
    'rejects a regressing %s source even when the other sources advance',
    (regressed) => {
      const state = advanceNotificationState(
        baseline(),
        {
          ...snapshot(regressed === 'activity' ? 120_000 : 100_000, []),
          sourceTimes: {
            queue: 130_000,
            activity: regressed === 'activity' ? 120_000 : 100_000,
            native: 140_000,
          },
        },
        150_000,
      );
      const sourceTimes = {
        queue: 140_000,
        activity: 140_000,
        native: 150_000,
      };
      sourceTimes[regressed] = state.sourceTimes[regressed] - 10_000;
      const mixed = { ...snapshot(110_000), sourceTimes };
      expect(advanceNotificationState(state, mixed, 150_000)).toBe(state);
      expect(state.pending).toEqual([]);
    },
  );
  it('rejects an all-equal vector and observes a native generation with unchanged GitHub sources', () => {
    const park = { id: 'work:01ABC', generation: 'work:01ABC/r1' };
    const state = advanceNotificationState(
      { ...emptyNotificationState(), enabled: true },
      snapshot(100_000, [park]),
      100_000,
    );
    const newRound = { ...park, generation: 'work:01ABC/r2' };
    expect(
      advanceNotificationState(state, snapshot(100_000, [newRound]), 110_000),
    ).toBe(state);
    expect(
      advanceNotificationState(
        state,
        {
          ...snapshot(100_000, [newRound]),
          sourceTimes: { queue: 100_000, activity: 100_000, native: 110_000 },
        },
        110_000,
      ).pending,
    ).toEqual([newRound]);
  });
  it('fails closed for corruption and oversized/duplicate decision sets', () => {
    expect(() => parseNotificationState('{broken')).toThrow();
    expect(() =>
      parseNotificationState(
        JSON.stringify({ ...emptyNotificationState(), lastSentAt: 'bad' }),
      ),
    ).toThrow();
    const state = baseline();
    expect(
      advanceNotificationState(
        state,
        snapshot(110_000, [decision, decision]),
        110_000,
      ),
    ).toBe(state);
    expect(
      advanceNotificationState(
        state,
        snapshot(
          110_000,
          Array.from({ length: 1001 }, (_, i) => ({
            id: `repo#${i}`,
            generation: 'x',
          })),
        ),
        110_000,
      ),
    ).toBe(state);
  });
  it('builds only internal Inbox links and never exposes user content', () => {
    expect(notificationHref([decision])).toBe('/inbox?item=owner%2Frepo%231');
    expect(
      notificationHref([{ id: '//evil.example/?x=secret', generation: 'x' }]),
    ).toBe('/inbox?item=%2F%2Fevil.example%2F%3Fx%3Dsecret');
    expect(notificationHref([decision, { id: 'b', generation: 'x' }])).toBe(
      '/inbox',
    );
  });
});
