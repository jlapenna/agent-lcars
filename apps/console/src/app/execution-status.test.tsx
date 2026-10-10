import { type ExecutionRun } from '@agent-lcars/dispatch-contracts';
import { MantineProvider } from '@mantine/core';
import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { ExecutionStatus } from './execution-status';

const start = Date.parse('2026-10-10T12:00:00Z');
function run(at = start): ExecutionRun {
  return {
    state: 'running',
    queue: {
      state: 'claimed',
      placement: {
        phase: 'waiting-for-placement',
        reason: 'unschedulable',
        observedAt: new Date(at).toISOString(),
      },
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
});

it('expires placement in an open tab and immediately accepts newer source snapshots', () => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  const { rerender } = render(
    <MantineProvider>
      <ExecutionStatus run={run()} />
    </MantineProvider>,
  );
  expect(screen.getByTestId('execution-status').textContent).toContain(
    'Waiting for placement',
  );
  act(() => {
    vi.advanceTimersByTime(190_000);
  });
  expect(screen.getByTestId('execution-status').textContent).toContain(
    'Placement unavailable',
  );
  // Arrive between ticks: source time is newer than the previous render clock.
  vi.setSystemTime(start + 195_000);
  rerender(
    <MantineProvider>
      <ExecutionStatus run={run(start + 195_000)} />
    </MantineProvider>,
  );
  expect(screen.getByTestId('execution-status').textContent).toContain(
    'Waiting for placement',
  );
});

it('requires explicit provider spawn and never presents terminal attempts as executing', () => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  const claimed = run();
  const { rerender } = render(
    <MantineProvider>
      <ExecutionStatus run={claimed} />
    </MantineProvider>,
  );
  expect(screen.getByTestId('execution-status').textContent).not.toContain(
    'Provider process started',
  );
  const started: ExecutionRun = {
    ...claimed,
    queue: {
      ...claimed.queue!,
      state: 'claimed',
      firstHeartbeatAt: new Date(start).toISOString(),
      providerProcessStartedAt: new Date(start).toISOString(),
    },
  };
  rerender(
    <MantineProvider>
      <ExecutionStatus run={started} />
    </MantineProvider>,
  );
  expect(screen.getByTestId('execution-status').textContent).toContain(
    'Provider process started',
  );
  rerender(
    <MantineProvider>
      <ExecutionStatus run={{ ...started, state: 'lost' }} />
    </MantineProvider>,
  );
  expect(screen.queryByTestId('execution-status')).toBeNull();
});
