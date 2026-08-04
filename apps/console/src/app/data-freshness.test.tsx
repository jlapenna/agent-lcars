import { MantineProvider } from '@mantine/core';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DataFreshness } from './data-freshness';

describe('DataFreshness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the age of the cached data as a <time>', () => {
    render(
      <MantineProvider>
        <DataFreshness
          fetchedAt="2026-08-03T11:59:40Z"
          initialLabel="just now"
        />
      </MantineProvider>,
    );

    const note = screen.getByTestId('data-freshness');
    expect(note.textContent).toBe('Data as of just now');
    expect(note.querySelector('time')).toHaveAttribute(
      'datetime',
      '2026-08-03T11:59:40Z',
    );
  });

  it('keeps the age honest while the tab stays open', () => {
    render(
      <MantineProvider>
        <DataFreshness
          fetchedAt="2026-08-03T11:59:40Z"
          initialLabel="just now"
        />
      </MantineProvider>,
    );

    act(() => {
      vi.advanceTimersByTime(3 * 60_000);
    });
    expect(screen.getByTestId('data-freshness').textContent).toBe(
      'Data as of 3 minutes ago',
    );
  });
});
