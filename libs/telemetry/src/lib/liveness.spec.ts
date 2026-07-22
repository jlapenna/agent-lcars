import { describe, expect, it } from 'vitest';

import { computeLiveness, displayLiveness } from './liveness';

const NOW = '2026-07-10T10:10:00.000Z';

describe('computeLiveness', () => {
  it('is live when the transcript was written within the last 2 minutes', () => {
    expect(
      computeLiveness({
        now: NOW,
        lastActivityAt: '2026-07-10T10:09:00.000Z',
        processAlive: true,
        heartbeatReceived: true,
      }),
    ).toBe('live');
  });

  it('is idle when the process is alive but writes are stale', () => {
    expect(
      computeLiveness({
        now: NOW,
        lastActivityAt: '2026-07-10T10:00:00.000Z',
        processAlive: true,
        heartbeatReceived: true,
      }),
    ).toBe('idle');
  });

  it('is ended when the process is gone, regardless of write recency', () => {
    expect(
      computeLiveness({
        now: NOW,
        lastActivityAt: '2026-07-10T10:09:59.000Z',
        processAlive: false,
        heartbeatReceived: true,
      }),
    ).toBe('ended');
  });

  it('is stale when no watcher heartbeat is received at all, even with a live process', () => {
    expect(
      computeLiveness({
        now: NOW,
        lastActivityAt: '2026-07-10T10:09:59.000Z',
        processAlive: true,
        heartbeatReceived: false,
      }),
    ).toBe('stale');
  });
});

describe('displayLiveness', () => {
  it('shows live for recent activity even when stored as ended (broken process check)', () => {
    expect(displayLiveness('ended', '2026-07-10T10:08:00.000Z', NOW)).toBe(
      'live',
    );
  });

  it('shows live for recent activity even when stored as stale', () => {
    expect(displayLiveness('stale', '2026-07-10T10:08:00.000Z', NOW)).toBe(
      'live',
    );
  });

  it('keeps a terminal stored state once activity is no longer recent', () => {
    expect(displayLiveness('ended', '2026-07-10T09:30:00.000Z', NOW)).toBe(
      'ended',
    );
    expect(displayLiveness('stale', '2026-07-10T09:30:00.000Z', NOW)).toBe(
      'stale',
    );
  });

  it('decays a stored live to idle when the transcript has gone quiet', () => {
    expect(displayLiveness('live', '2026-07-10T09:30:00.000Z', NOW)).toBe(
      'idle',
    );
  });

  it('decays a stored live/idle to ended after an hour without activity (frozen watcher)', () => {
    expect(displayLiveness('live', '2026-07-10T08:00:00.000Z', NOW)).toBe(
      'ended',
    );
    expect(displayLiveness('idle', '2026-07-10T08:00:00.000Z', NOW)).toBe(
      'ended',
    );
  });

  it('trusts a recent watcher observation for an idle running process', () => {
    expect(
      displayLiveness(
        'idle',
        '2026-07-10T08:00:00.000Z',
        NOW,
        '2026-07-10T10:05:00.000Z',
      ),
    ).toBe('idle');
  });

  it('decays again when the watcher observation is stale', () => {
    expect(
      displayLiveness(
        'idle',
        '2026-07-10T08:00:00.000Z',
        NOW,
        '2026-07-10T09:59:00.000Z',
      ),
    ).toBe('ended');
  });
});
