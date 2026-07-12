import { computeLiveness } from './liveness';

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
