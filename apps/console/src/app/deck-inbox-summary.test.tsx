import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DeckInboxSummary } from './deck-inbox-summary';

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    prefetch,
    ...props
  }: {
    children: ReactNode;
    href: string;
    prefetch?: boolean | 'auto' | null;
  }) => (
    <a href={href} data-prefetch={String(prefetch)} {...props}>
      {children}
    </a>
  ),
}));

function renderSummary(count: number, inboxHref = '/inbox') {
  return render(
    <MantineProvider>
      <DeckInboxSummary count={count} inboxHref={inboxHref} />
    </MantineProvider>,
  );
}

describe('DeckInboxSummary', () => {
  it('leads with the decision count and labels the direct action', () => {
    renderSummary(3, '/inbox?repo=agent%2Flcars');

    const tile = screen.getByTestId('deck-inbox-summary');
    expect(tile.textContent).toContain('3');
    expect(tile.textContent).toContain('Decisions waiting');
    const action = screen.getByRole('link', { name: 'Review 3 decisions' });
    expect(action).toHaveAttribute('href', '/inbox?repo=agent%2Flcars');
    expect(action).toHaveAttribute('data-prefetch', 'false');
    expect(tile).not.toHaveAttribute('data-empty');
  });

  it('uses singular phrasing for one item', () => {
    renderSummary(1);
    expect(
      screen.getByRole('link', { name: 'Review 1 decision' }),
    ).toBeTruthy();
  });

  it('marks the clear state so the accent dims', () => {
    renderSummary(0);

    const tile = screen.getByTestId('deck-inbox-summary');
    expect(tile).toHaveAttribute('data-empty');
    expect(tile.textContent).toContain('No decisions waiting');
    expect(screen.getByRole('link', { name: 'Review queue' })).toBeTruthy();
  });

  it('avoids landmark/alert roles the Deck e2e contract forbids', () => {
    renderSummary(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('renders only the action in the toolbar', () => {
    render(
      <MantineProvider>
        <DeckInboxSummary count={3} inboxHref="/inbox" compact />
      </MantineProvider>,
    );
    expect(
      screen.getByRole('link', { name: 'Review 3 decisions' }),
    ).toBeTruthy();
    expect(screen.queryByText('Decisions waiting')).toBeNull();
  });
});
