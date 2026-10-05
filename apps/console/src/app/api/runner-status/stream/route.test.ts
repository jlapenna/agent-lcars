import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/autoscaler-status', () => ({
  subscribeAutoscalerStatuses: mocks.subscribe,
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
});
