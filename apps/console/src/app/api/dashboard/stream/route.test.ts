import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  subscribe: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/dashboard-stream', () => ({
  subscribeDashboardChanges: mocks.subscribe,
}));

import {
  DASHBOARD_REFRESH_INTERVAL_MS,
  DASHBOARD_STREAM_LIFETIME_MS,
} from '@/lib/dashboard-stream-contract';

import { GET } from './route';

const decode = (value: Uint8Array | undefined) =>
  new TextDecoder().decode(value);

describe('authorized dashboard SSE lifecycle', () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  it.each([null, { user: { isAdmin: false } }])(
    'denies an unauthorized session without subscribing',
    async (session) => {
      mocks.auth.mockResolvedValue(session);
      expect((await GET(new Request('http://console/stream'))).status).toBe(
        401,
      );
      expect(mocks.subscribe).not.toHaveBeenCalled();
    },
  );

  it('coalesces changes, sends health without invalidating, and disposes on abort', async () => {
    vi.useFakeTimers();
    mocks.auth.mockResolvedValue({ user: { isAdmin: true } });
    let push = (_signal: { state: string; changed: boolean }) =>
      undefined as void;
    mocks.subscribe.mockImplementation((callback) => {
      push = callback;
      return mocks.stop;
    });
    const abort = new AbortController();
    const response = await GET(
      new Request('http://console/stream', { signal: abort.signal }),
    );
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    for (let i = 0; i < 20; i++) push({ state: 'live', changed: true });
    await vi.advanceTimersByTimeAsync(DASHBOARD_REFRESH_INTERVAL_MS);
    expect(decode((await reader.read()).value)).toContain('"changed":true');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(decode((await reader.read()).value)).toContain('"changed":false');
    push({ state: 'degraded', changed: false });
    expect(decode((await reader.read()).value)).toContain('"state":"degraded"');
    abort.abort();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect((await reader.read()).done).toBe(true);
    await vi.advanceTimersByTimeAsync(DASHBOARD_STREAM_LIFETIME_MS);
    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  it('expires and removes listeners even if setup is still pending', async () => {
    vi.useFakeTimers();
    mocks.auth.mockResolvedValue({ user: { isAdmin: true } });
    let opened = (_stop: () => void) => undefined as void;
    mocks.subscribe.mockReturnValue(
      new Promise((resolve) => {
        opened = resolve;
      }),
    );
    const response = await GET(new Request('http://console/stream'));
    const reader = response.body!.getReader();
    await vi.advanceTimersByTimeAsync(DASHBOARD_STREAM_LIFETIME_MS);
    opened(mocks.stop);
    await Promise.resolve();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect((await reader.read()).done).toBe(true);
  });

  it('does not subscribe after early abort and cancels a scheduled flush', async () => {
    vi.useFakeTimers();
    mocks.auth.mockResolvedValue({ user: { isAdmin: true } });
    const aborted = new AbortController();
    aborted.abort();
    await GET(new Request('http://console/stream', { signal: aborted.signal }));
    expect(mocks.subscribe).not.toHaveBeenCalled();
    mocks.subscribe.mockImplementation((push) => {
      push({ state: 'live', changed: true });
      return mocks.stop;
    });
    const response = await GET(new Request('http://console/stream'));
    await response.body!.cancel();
    await vi.advanceTimersByTimeAsync(DASHBOARD_STREAM_LIFETIME_MS);
    expect(mocks.stop).toHaveBeenCalledOnce();
  });
});
