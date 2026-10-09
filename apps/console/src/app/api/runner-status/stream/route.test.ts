import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/shuttlebay-status', () => ({
  subscribeShuttlebayStatus: mocks.subscribe,
}));

import { RUNNER_STATUS_STREAM_LIFETIME_MS } from '@/lib/runner-status-contract';

import { GET } from './route';

async function readFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  while (text.split('\n\n').length <= count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

describe('GET /api/runner-status/stream', () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  it('refuses non-admin sessions without opening a listener', async () => {
    mocks.auth.mockResolvedValue({ user: { isAdmin: false } });

    const response = await GET(new Request('http://console/stream'));

    expect(response.status).toBe(401);
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it('streams each pushed projection as a runner-status event and unsubscribes on disconnect', async () => {
    mocks.auth.mockResolvedValue({ user: { isAdmin: true } });
    let push: (result: unknown) => void = () => undefined;
    mocks.subscribe.mockImplementation(async (onResult) => {
      push = onResult;
      onResult({ statuses: [], warnings: [] });
      return mocks.unsubscribe;
    });
    const abort = new AbortController();

    const response = await GET(
      new Request('http://console/stream', { signal: abort.signal }),
    );
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const first = await readFrames(reader, 2);
    expect(first).toContain('retry: 1000');
    expect(first).toContain(
      'event: runner-status\ndata: {"statuses":[],"warnings":[]}',
    );

    push({ statuses: [], warnings: ['ARC lane status is stale.'] });
    expect(await readFrames(reader, 1)).toContain('ARC lane status is stale.');

    abort.abort();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    expect((await reader.read()).done).toBe(true);
  });

  it('ends the stream after its lifetime so the browser reconnects cleanly', async () => {
    vi.useFakeTimers();
    mocks.auth.mockResolvedValue({ user: { isAdmin: true } });
    mocks.subscribe.mockResolvedValue(mocks.unsubscribe);

    const response = await GET(new Request('http://console/stream'));
    const reader = response.body!.getReader();
    await reader.read(); // retry frame
    await vi.advanceTimersByTimeAsync(RUNNER_STATUS_STREAM_LIFETIME_MS);

    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    expect((await reader.read()).done).toBe(true);
  });

  it('never opens a listener for a request that already disconnected', async () => {
    mocks.auth.mockResolvedValue({ user: { isAdmin: true } });
    const abort = new AbortController();
    abort.abort();

    const response = await GET(
      new Request('http://console/stream', { signal: abort.signal }),
    );
    const reader = response.body!.getReader();

    expect((await reader.read()).done).toBe(true);
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it('unsubscribes at once when the client leaves before the listener opens', async () => {
    mocks.auth.mockResolvedValue({ user: { isAdmin: true } });
    let open: (unsubscribe: () => void) => void = () => undefined;
    mocks.subscribe.mockReturnValue(
      new Promise((resolve) => {
        open = resolve;
      }),
    );
    const abort = new AbortController();

    await GET(new Request('http://console/stream', { signal: abort.signal }));
    abort.abort();
    open(mocks.unsubscribe);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  });
});
