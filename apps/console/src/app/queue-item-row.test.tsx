import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
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
  } = {},
) {
  render(
    <MantineProvider>
      <QueueItemRow
        card={makeCard(makeItem())}
        href={props.href ?? '/inbox?item=agent%2Flcars%23249'}
        selected={props.selected ?? false}
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
});
