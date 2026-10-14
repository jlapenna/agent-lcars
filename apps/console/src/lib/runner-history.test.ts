import { describe, expect, it } from 'vitest';

import { fleetRunnerHistory, parseRunnerWindow } from './runner-history';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const at = (secondsAgo: number) =>
  new Date(NOW - secondsAgo * 1000).toISOString();

describe('parseRunnerWindow', () => {
  it('reads valid samples and rejects malformed windows', () => {
    expect(
      parseRunnerWindow({
        samples: [{ at: at(60), registered: 3, running: 1 }],
      }),
    ).toEqual([{ at: at(60), registered: 3, running: 1 }]);
    expect(parseRunnerWindow(undefined)).toBeUndefined();
    expect(
      parseRunnerWindow({
        samples: [{ at: 'soon', registered: 3, running: 1 }],
      }),
    ).toBeUndefined();
    expect(
      parseRunnerWindow({
        samples: [{ at: at(1), registered: -1, running: 0 }],
      }),
    ).toBeUndefined();
    expect(
      parseRunnerWindow({
        samples: Array.from({ length: 31 }, () => ({
          at: at(1),
          registered: 1,
          running: 0,
        })),
      }),
    ).toBeUndefined();
  });
});

describe('fleetRunnerHistory', () => {
  it("sums each lane's freshest sample per minute, ending at now", () => {
    const history = fleetRunnerHistory(
      [
        {
          runnerHistory: [
            { at: at(62), registered: 2, running: 1 },
            { at: at(3), registered: 3, running: 2 },
          ],
        },
        {
          runnerHistory: [
            { at: at(118), registered: 4, running: 0 },
            { at: at(58), registered: 4, running: 2 },
            { at: at(1), registered: 4, running: 4 },
          ],
        },
      ],
      NOW,
      3,
    );
    expect(history).toEqual({
      online: [undefined, 6, 7],
      busy: [undefined, 1, 6],
    });
  });

  it('leaves a minute empty when any lane missed its scrape', () => {
    const history = fleetRunnerHistory(
      [
        { runnerHistory: [{ at: at(2), registered: 2, running: 1 }] },
        // Last sample 200s old: stale for every slot shown.
        { runnerHistory: [{ at: at(200), registered: 4, running: 0 }] },
      ],
      NOW,
      2,
    );
    expect(history).toEqual({
      online: [undefined, undefined],
      busy: [undefined, undefined],
    });
  });

  it('has no history while a lane publishes no window', () => {
    expect(
      fleetRunnerHistory(
        [{ runnerHistory: [{ at: at(2), registered: 2, running: 1 }] }, {}],
        NOW,
      ),
    ).toBeUndefined();
    expect(fleetRunnerHistory([], NOW)).toBeUndefined();
  });
});
