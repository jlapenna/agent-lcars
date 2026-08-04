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
  it('shows the zero-padded count and links into the Inbox', () => {
    renderSummary(3, '/inbox?repo=agent%2Flcars');

    const tile = screen.getByTestId('deck-inbox-summary');
    expect(tile.textContent).toContain('03');
    expect(tile.textContent).toContain('items need your decision');
    expect(screen.getByRole('link', { name: 'Open Inbox →' })).toHaveAttribute(
      'href',
      '/inbox?repo=agent%2Flcars',
    );
    expect(tile).not.toHaveAttribute('data-empty');
  });

  it('uses singular phrasing for one item', () => {
    renderSummary(1);
    expect(screen.getByTestId('deck-inbox-summary').textContent).toContain(
      'item needs your decision',
    );
  });

  it('marks the clear state so the accent dims', () => {
    renderSummary(0);

    const tile = screen.getByTestId('deck-inbox-summary');
    expect(tile).toHaveAttribute('data-empty');
    expect(tile.textContent).toContain('the Inbox is clear');
    expect(screen.getByRole('link', { name: 'Open Inbox →' })).toBeTruthy();
  });

  it('avoids landmark/alert roles the Deck e2e contract forbids', () => {
    renderSummary(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('region')).toBeNull();
  });
});
