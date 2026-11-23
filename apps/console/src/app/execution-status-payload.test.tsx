import { render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { ExecutionStatus } from './execution-status';

const clock = vi.hoisted(() => vi.fn((_props: unknown) => null));
vi.mock('./execution-status-clock', () => ({
  ExecutionStatusClock: clock,
  EXECUTION_CLOCK_TICK_MS: 10_000,
}));

// A run record as callers hold it: the clock must never receive its result,
// evidence or transcript, since every client prop ships in the page payload.
const heavy = {
  id: 'r1',
  result: { summary: 'report', report: 'x'.repeat(10_000) },
  evidence: [{ finding: 'f', confidence: 'high' }],
};

it('sends the client clock only the fields the execution phase reads', () => {
  const queue = {
    state: 'claimed' as const,
    claimedAt: '2026-10-10T12:00:00Z',
  };
  render(<ExecutionStatus run={{ ...heavy, state: 'running', queue }} />);
  expect(clock).toHaveBeenCalledTimes(1);
  expect(clock.mock.calls[0][0]).toEqual({ run: { state: 'running', queue } });
});

it('sends nothing for a settled run', () => {
  clock.mockClear();
  const { container } = render(
    <ExecutionStatus run={{ ...heavy, state: 'succeeded' }} />,
  );
  expect(clock).not.toHaveBeenCalled();
  expect(container.innerHTML).toBe('');
});
