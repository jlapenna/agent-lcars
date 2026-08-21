import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ActionItem } from '../lib/action-items';
import type { BoardCard } from './board-card';
import { QueueItemRow } from './queue-item-row';

vi.mock('./item-overflow-menu', () => ({
  ItemOverflowMenu: ({ item }: { item: ActionItem }) => (
    <button aria-label={`More actions for #${item.number}`}>More</button>
  ),
}));

function makeItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    kind: 'issue',
    repo: { owner: 'agent', name: 'lcars' },
    number: 249,
    title: 'Responsive Inbox',
    url: 'https://github.com/agent/lcars/issues/249',
    updatedAt: '2026-07-30T00:00:00Z',
    actionTypes: [],
    labels: [],
    assigneeLogins: [],
    ...overrides,
  };
}

function makeCard(item: ActionItem): BoardCard {
  return { item };
}

function renderRow(
  props: {
    selected?: boolean;
    href?: string;
    loading?: boolean;
    onNavigate?: () => void;
  } = {},
) {
  render(
    <MantineProvider>
      <QueueItemRow
        card={makeCard(makeItem())}
        href={props.href ?? '/inbox?item=agent%2Flcars%23249'}
        selected={props.selected ?? false}
        loading={props.loading}
        onNavigate={props.onNavigate}
      />
    </MantineProvider>,
  );
}

describe('QueueItemRow', () => {
  it('renders a chevron affordance on the row link signalling tap-to-open detail', () => {
    renderRow();
    const link = screen.getByRole('link', { name: /Responsive Inbox/ });
    expect(link.querySelector('.queue-item-row__chevron')).not.toBeNull();
  });

  it('shows immediate progress while item details are loading', () => {
    const onNavigate = vi.fn();
    renderRow({ href: '#item', loading: true, onNavigate });

    const link = screen.getByRole('link', { name: /Responsive Inbox/ });
    expect(link).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByLabelText('Loading item details')).toBeTruthy();

    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it('does not show current-page progress for a modified click', () => {
    const onNavigate = vi.fn();
    renderRow({ href: '#item', onNavigate });

    fireEvent.click(screen.getByRole('link', { name: /Responsive Inbox/ }), {
      metaKey: true,
    });
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
