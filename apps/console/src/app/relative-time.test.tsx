import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RelativeTime } from './relative-time';

describe('RelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a semantic <time> with the compact label and a local title', () => {
    render(<RelativeTime iso="2026-08-03T11:58:00Z" variant="compact" />);

    const time = screen.getByText('2m ago');
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('datetime', '2026-08-03T11:58:00Z');
    expect(time.getAttribute('title')).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
    );
  });

  it('ticks the label forward while the tab stays open', () => {
    render(<RelativeTime iso="2026-08-03T11:59:30Z" variant="compact" />);
    expect(screen.getByText('now')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(screen.getByText('2m ago')).toBeTruthy();
  });

  it('defaults to the full wording', () => {
    render(<RelativeTime iso="2026-08-03T10:00:00Z" />);
    expect(screen.getByText('2 hours ago')).toBeTruthy();
  });

  it.each(['full', 'compact'] as const)(
    'ticks a future %s deadline through expiration without losing its timestamp',
    (variant) => {
      render(<RelativeTime iso="2026-08-03T12:02:00Z" variant={variant} />);
      const time = screen.getByText(
        variant === 'full' ? 'in 2 minutes' : 'in 2m',
      );
      expect(time).toHaveAttribute('datetime', '2026-08-03T12:02:00Z');
      const title = time.getAttribute('title');

      act(() => {
        vi.advanceTimersByTime(120_000);
      });
      expect(time).toHaveTextContent(variant === 'full' ? 'just now' : 'now');

      act(() => {
        vi.advanceTimersByTime(90_000);
      });
      expect(time).toHaveTextContent(
        variant === 'full' ? '1 minute ago' : '1m ago',
      );
      expect(time).toHaveAttribute('datetime', '2026-08-03T12:02:00Z');
      expect(time).toHaveAttribute('title', title);
    },
  );
});
