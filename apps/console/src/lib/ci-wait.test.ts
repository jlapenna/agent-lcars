import { describe, expect, it } from 'vitest';

import { fleetCiWait } from './ci-wait';
import {
  histogramQuantile,
  type HistogramWindow,
  parseHistogramWindow,
} from './histogram-window';

const raw = {
  bounds: [1, 10, 60],
  startedAt: '2026-10-13T12:00:00Z',
  intervals: [
    { endedAt: '2026-10-13T12:01:00Z', counts: [0, 0, 0, 0] },
    { endedAt: '2026-10-13T12:02:00Z', counts: [1, 3, 4, 4] },
  ],
};

describe('parseHistogramWindow', () => {
  it('keeps only minutes with a job start, as nonzero buckets', () => {
    expect(parseHistogramWindow(raw)).toEqual({
      bounds: [1, 10, 60],
      startedAt: '2026-10-13T12:00:00Z',
      endedAt: '2026-10-13T12:02:00Z',
      minutes: [
        {
          endedAt: '2026-10-13T12:02:00Z',
          jobs: [
            [0, 1],
            [1, 2],
            [2, 1],
          ],
        },
      ],
    });
  });

  it.each([
    ['no intervals', { ...raw, intervals: [] }],
    ['unsorted bounds', { ...raw, bounds: [10, 1, 60] }],
    [
      'short counts',
      {
        ...raw,
        intervals: [{ endedAt: raw.intervals[1]?.endedAt, counts: [1] }],
      },
    ],
    [
      'not cumulative',
      {
        ...raw,
        intervals: [{ endedAt: '2026-10-13T12:02:00Z', counts: [3, 1, 4, 4] }],
      },
    ],
    ['out of order', { ...raw, intervals: [...raw.intervals].reverse() }],
    ['no start', { ...raw, startedAt: undefined }],
    ['start after an interval', { ...raw, startedAt: '2026-10-13T12:01:30Z' }],
    ['missing', undefined],
  ])('rejects %s', (_, value) => {
    expect(parseHistogramWindow(value)).toBeUndefined();
  });
});

describe('histogramQuantile', () => {
  it('interpolates within the bucket the rank falls in', () => {
    // 4 jobs: rank 2 lies in (1, 10], which holds jobs 2 and 3.
    expect(histogramQuantile(0.5, [1, 10, 60], [1, 3, 4, 4])).toBe(5.5);
  });

  it('starts the first bucket at zero', () => {
    expect(histogramQuantile(0.5, [2, 10], [4, 4, 4])).toBe(1);
  });

  it('reports a rank in +Inf as the highest finite bound', () => {
    expect(histogramQuantile(0.5, [1, 10], [0, 0, 3])).toBe(10);
  });

  it('is undefined with no observations', () => {
    expect(histogramQuantile(0.5, [1, 10], [0, 0, 0])).toBeUndefined();
  });
});

function window(
  endedAt: string,
  minutes: HistogramWindow['minutes'],
  startedAt = new Date(Date.parse(endedAt) - 30 * 60_000).toISOString(),
) {
  return { jobStartup: { bounds: [1, 10, 60], startedAt, endedAt, minutes } };
}

describe('fleetCiWait', () => {
  it('is unknown when no lane reports a window', () => {
    expect(fleetCiWait([{}, {}])).toBeUndefined();
  });

  it('sums lanes per minute counted back from the newest interval', () => {
    const wait = fleetCiWait([
      window('2026-10-13T12:30:00Z', [
        { endedAt: '2026-10-13T12:30:00Z', jobs: [[1, 1]] },
        // 31 minutes before the newest interval: outside the window.
        { endedAt: '2026-10-13T11:59:00Z', jobs: [[3, 9]] },
      ]),
      window(
        '2026-10-13T12:29:40Z',
        [
          { endedAt: '2026-10-13T12:29:40Z', jobs: [[1, 1]] },
          { endedAt: '2026-10-13T12:20:10Z', jobs: [[0, 2]] },
        ],
        '2026-10-13T11:59:40Z',
      ),
    ]);
    expect(wait?.jobs).toBe(4);
    // Jobs in buckets (0,1] x2 and (1,10] x2: rank 2 is the top of (0,1].
    expect(wait?.p50Seconds).toBe(1);
    expect(wait?.series).toHaveLength(30);
    expect(wait?.series[29]).toBe(5.5);
    // 9m50s before the newest interval is the 10th minute back.
    expect(wait?.series[19]).toBe(0.5);
    expect(wait?.series.filter((p50) => p50 !== undefined)).toHaveLength(2);
    expect(wait?.coveredMinutes).toBe(30);
    expect(wait?.partial).toBe(false);
  });

  it('keeps jittered intervals a little under a minute apart in their own bars', () => {
    const wait = fleetCiWait([
      window('2026-10-13T12:30:00.000Z', [
        { endedAt: '2026-10-13T12:30:00.000Z', jobs: [[1, 1]] },
        { endedAt: '2026-10-13T12:29:00.004Z', jobs: [[1, 1]] },
        { endedAt: '2026-10-13T12:28:00.009Z', jobs: [[1, 1]] },
      ]),
    ]);
    expect(wait?.series.slice(-3)).toEqual([5.5, 5.5, 5.5]);
  });

  it('reports a warming-up window as the minutes it covers, not 30', () => {
    const wait = fleetCiWait([
      window('2026-10-13T12:30:00Z', [], '2026-10-13T12:28:00Z'),
    ]);
    expect(wait).toMatchObject({ jobs: 0, coveredMinutes: 2, partial: false });
    expect(
      fleetCiWait([
        window('2026-10-13T12:30:00Z', []),
        window('2026-10-13T12:30:00Z', [], '2026-10-13T12:28:00Z'),
      ])?.partial,
    ).toBe(true);
  });

  it('reports a known quiet window as zero jobs with no p50', () => {
    const wait = fleetCiWait([window('2026-10-13T12:30:00Z', [])]);
    expect(wait).toMatchObject({ jobs: 0, partial: false });
    expect(wait?.p50Seconds).toBeUndefined();
  });

  it('marks lanes without a window or with other buckets as partial', () => {
    const other = {
      jobStartup: {
        bounds: [5],
        startedAt: '2026-10-13T12:00:00Z',
        endedAt: '2026-10-13T12:30:00Z',
        minutes: [{ endedAt: '2026-10-13T12:30:00Z', jobs: [[0, 7]] }],
      },
    } satisfies { jobStartup: HistogramWindow };
    const quiet = window('2026-10-13T12:30:00Z', []);
    expect(fleetCiWait([quiet, {}])?.partial).toBe(true);
    expect(fleetCiWait([quiet, other])).toMatchObject({
      jobs: 0,
      partial: true,
    });
  });
});
