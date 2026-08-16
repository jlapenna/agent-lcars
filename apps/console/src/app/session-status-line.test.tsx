import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionStatusLine } from './session-status-line';

function renderLine(props: {
  status?: string;
  statusUpdatedAt?: string;
  liveness: 'live' | 'idle' | 'ended' | 'stale';
}) {
  return render(
    <MantineProvider>
      <SessionStatusLine {...props} />
    </MantineProvider>,
  );
}

describe('SessionStatusLine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the status and its age for a live session', () => {
    renderLine({
      status: 'waiting on CI for #1247',
      statusUpdatedAt: '2026-08-03T11:58:00Z',
      liveness: 'live',
    });

    expect(screen.getByTestId('session-status-line')).toBeTruthy();
    expect(screen.getByText('waiting on CI for #1247')).toBeTruthy();
    expect(screen.getByText(/2m ago/)).toBeTruthy();
  });

  it('renders nothing when liveness is ended, even with a fresh status', () => {
    renderLine({
      status: 'waiting on CI for #1247',
      statusUpdatedAt: '2026-08-03T11:59:00Z',
      liveness: 'ended',
    });

    expect(screen.queryByTestId('session-status-line')).toBeNull();
    expect(screen.queryByText('waiting on CI for #1247')).toBeNull();
  });

  it('renders nothing when there is no declared status', () => {
    renderLine({ liveness: 'live' });

    expect(screen.queryByTestId('session-status-line')).toBeNull();
  });

  it('renders nothing for an idle or stale session with no status either', () => {
    renderLine({ liveness: 'idle' });
    expect(screen.queryByTestId('session-status-line')).toBeNull();
    renderLine({ liveness: 'stale' });
    expect(screen.queryAllByTestId('session-status-line')).toHaveLength(0);
  });

  it('renders a stale status with its true (large) age rather than suppressing it', () => {
    // A status frozen for 40 minutes next to an otherwise-live session is
    // the "agent looks hung" signal this line exists to surface - see the
    // component's doc comment and #1257's design doc.
    renderLine({
      status: 'refactoring the parser',
      statusUpdatedAt: '2026-08-03T11:20:00Z',
      liveness: 'live',
    });

    expect(screen.getByText(/40m ago/)).toBeTruthy();
  });

  it('truncates a long status instead of growing the row', () => {
    const longStatus =
      'this is a deliberately very long agent-declared status line that ' +
      'goes on and on describing exactly what it is doing right now in ' +
      'far more detail than anyone asked for or needed to see';

    renderLine({
      status: longStatus,
      statusUpdatedAt: '2026-08-03T11:58:00Z',
      liveness: 'live',
    });

    const node = screen.getByText(longStatus);
    expect(node.getAttribute('data-truncate')).toBe('end');
  });

  it('still renders the status when statusUpdatedAt is missing, without an age', () => {
    renderLine({ status: 'blocked on review', liveness: 'live' });

    expect(screen.getByText('blocked on review')).toBeTruthy();
    expect(screen.queryByText(/ago/)).toBeNull();
  });
});
