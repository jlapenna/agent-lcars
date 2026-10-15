import { describe, expect, it } from 'vitest';

import {
  RUN_HISTORY_MINUTES,
  runCountHistory,
  runStateAt,
  type RunTimeline,
} from './run-history';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const at = (minutesAgo: number) =>
  new Date(NOW - minutesAgo * 60_000).toISOString();
const repo = { owner: 'example', name: 'console' };

function timeline(
  createdMinutesAgo: number,
  transitions: [number, RunTimeline['state']][],
  state: RunTimeline['state'],
  updatedMinutesAgo: number,
): RunTimeline {
  return {
    repo,
    createdAt: at(createdMinutesAgo),
    transitions: [
      { at: at(createdMinutesAgo), to: 'pending' },
      ...transitions.map(([minutes, to]) => ({ at: at(minutes), to })),
    ],
    state,
    updatedAt: at(updatedMinutesAgo),
  };
}

describe('runStateAt', () => {
  const run = timeline(
    20,
    [
      [15, 'running'],
      [5, 'finished'],
    ],
    'finished',
    5,
  );

  it('walks the recorded transitions', () => {
    expect(runStateAt(run, NOW - 21 * 60_000)).toBeUndefined();
    expect(runStateAt(run, NOW - 18 * 60_000)).toBe('pending');
    expect(runStateAt(run, NOW - 10 * 60_000)).toBe('running');
    expect(runStateAt(run, NOW)).toBe('finished');
  });

  it('trusts the recorded state once updatedAt has passed', () => {
    // The running transition fell off the bounded event list.
    const truncated = { ...run, transitions: [], state: 'running' as const };
    expect(runStateAt({ ...truncated, updatedAt: at(10) }, NOW)).toBe(
      'running',
    );
  });
});

describe('runCountHistory', () => {
  it('samples queue depth and running agents once a minute up to now', () => {
    const history = runCountHistory(
      [
        timeline(
          40,
          [
            [25, 'running'],
            [10, 'finished'],
          ],
          'finished',
          10,
        ),
        timeline(12, [], 'pending', 1),
        timeline(8, [[6, 'running']], 'running', 0),
      ],
      NOW,
    );
    expect(history.queued).toHaveLength(RUN_HISTORY_MINUTES);
    expect(history.running).toHaveLength(RUN_HISTORY_MINUTES);
    // 29 minutes ago: only the first run, still waiting to start.
    expect([history.queued[0], history.running[0]]).toEqual([1, 0]);
    // 20 minutes ago: that run is running and nothing else exists yet.
    expect([history.queued[9], history.running[9]]).toEqual([0, 1]);
    // Now: one waiting, one running; the first finished 10 minutes ago.
    expect([history.queued.at(-1), history.running.at(-1)]).toEqual([1, 1]);
    // 7 minutes ago: two waiting (one is about to start), none running.
    expect([history.queued.at(-8), history.running.at(-8)]).toEqual([2, 0]);
  });
});
