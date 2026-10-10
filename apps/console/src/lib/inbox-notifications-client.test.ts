import { afterEach, describe, expect, it, vi } from 'vitest';

import { readInboxNotificationSnapshot } from './inbox-notifications-client';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('optional Inbox read transport', () => {
  it('uses a private same-origin GET outside the Server Action queue', async () => {
    const snapshot = { principalId: 'viewer', decisions: [] };
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => snapshot });
    vi.stubGlobal('fetch', fetch);
    expect(await readInboxNotificationSnapshot()).toEqual(snapshot);
    expect(fetch).toHaveBeenCalledWith('/api/inbox-notifications', {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: expect.any(AbortSignal),
    });
  });
  it('aborts a hung optional request and releases its caller', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, options) => {
        signal = options.signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('Aborted')));
        });
      }),
    );
    const result = readInboxNotificationSnapshot().catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toEqual(new Error('Aborted'));
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not consume unavailable responses as decision snapshots', async () => {
    const json = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json }));
    await expect(readInboxNotificationSnapshot()).rejects.toThrow(
      'unavailable',
    );
    expect(json).not.toHaveBeenCalled();
  });
});
