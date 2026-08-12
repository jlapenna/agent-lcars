import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DeckInboxSummary } from './deck-inbox-summary';

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
    expect(
      screen.getByRole('link', { name: 'Open 3 decisions' }),
    ).toHaveAttribute('href', '/inbox?repo=agent%2Flcars');
    expect(tile).not.toHaveAttribute('data-empty');
  });

  it('uses singular phrasing for one item', () => {
    renderSummary(1);
    expect(screen.getByRole('link', { name: 'Open 1 decision' })).toBeTruthy();
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
});
