import { MantineProvider } from '@mantine/core';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/inbox' }));
vi.mock('./refresh-action', () => ({ refreshDashboard: mocks.refresh }));

import { LiveDashboard } from './live-dashboard';

class Source {
  static instances: Source[] = [];
  onerror?: () => void;
  callback?: (event: MessageEvent) => void;
  close = vi.fn();
  constructor(readonly url: string) {
    Source.instances.push(this);
  }
  addEventListener(_name: string, callback: (event: MessageEvent) => void) {
    this.callback = callback;
  }
  signal(state = 'live', changed = true) {
    this.callback?.(
      new MessageEvent('dashboard', {
        data: JSON.stringify({ state, changed }),
      }),
    );
  }
}

function mount() {
  return render(
    <MantineProvider>
      <LiveDashboard />
    </MantineProvider>,
  );
}

describe('live dashboard invalidations', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', Source);
    Source.instances = [];
    mocks.refresh.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it('refreshes the existing scoped route, coalesces bursts and never refreshes for health frames', async () => {
    const view = mount();
    const source = Source.instances[0];
    await act(async () => {
      source.signal();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.refresh).toHaveBeenCalledWith('/inbox');
    await act(async () => {
      for (let i = 0; i < 20; i++) source.signal();
      source.signal('live', false);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    await act(async () => {
      source.signal('live', false);
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('live-dashboard-status')).toHaveTextContent(
      'Live updates connected',
    );
    view.unmount();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it('shows disconnect and stale state, doubles backoff, and cancels reconnect on unmount', async () => {
    const view = mount();
    act(() => Source.instances[0].onerror?.());
    expect(screen.getByTestId('live-dashboard-status')).toHaveTextContent(
      'Disconnected',
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(Source.instances).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    act(() => Source.instances[1].onerror?.());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(Source.instances).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    expect(screen.getByTestId('live-dashboard-status')).toHaveTextContent(
      'Stale',
    );
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(Source.instances).toHaveLength(3);
  });

  it('ignores queued events from a superseded connection', async () => {
    const view = mount();
    const old = Source.instances[0];
    act(() => old.onerror?.());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const recovered = Source.instances[1];
    act(() => {
      recovered.signal('live', false);
      old.onerror?.();
      old.signal('degraded', false);
    });
    expect(screen.getByTestId('live-dashboard-status')).toHaveTextContent(
      'Live updates connected',
    );
    expect(recovered.close).not.toHaveBeenCalled();
    view.unmount();
  });

  it('caps repeated failures at a 30-second reconnect interval', async () => {
    const view = mount();
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const count = Source.instances.length;
      act(() => Source.instances[count - 1].onerror?.());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay - 1);
      });
      expect(Source.instances).toHaveLength(count);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(Source.instances).toHaveLength(count + 1);
    }
    view.unmount();
  });

  it('serializes refreshes and catches a change received during an in-flight action', async () => {
    let finish = () => undefined as void;
    mocks.refresh.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const view = mount();
    act(() => Source.instances[0].signal());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    act(() => Source.instances[0].signal());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(mocks.refresh).toHaveBeenCalledOnce();
    await act(async () => {
      finish();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('keeps a refresh failure visible across healthy heartbeats', async () => {
    mocks.refresh.mockRejectedValue(new Error('Unauthorized'));
    mount();
    await act(async () => {
      Source.instances[0].signal();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    act(() => Source.instances[0].signal('live', false));
    expect(screen.getByTestId('live-dashboard-status')).toHaveTextContent(
      'Refresh failed',
    );
  });
});
