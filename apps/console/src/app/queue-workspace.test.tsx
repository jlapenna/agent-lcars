import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ActionItem } from '../lib/action-items';
import type { BoardCard } from './board-card';
import { queueSelectionHref, QueueWorkspace } from './queue-workspace';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('repo=agent%2Flcars'),
}));
vi.mock('./action-item-card', () => ({
  ActionItemCard: ({ item }: { item: ActionItem }) => (
    <div data-testid="selected-detail">Detail #{item.number}</div>
  ),
}));
vi.mock('./item-overflow-menu', () => ({
  ItemOverflowMenu: ({ item }: { item: ActionItem }) => (
    <button aria-label={`More actions for #${item.number}`}>More</button>
  ),
}));
vi.mock('./quick-task-button', () => ({
  QuickTaskButton: () => <button>Quick task</button>,
}));
vi.mock('./refresh-button', () => ({
  RefreshButton: () => <button>Refresh</button>,
}));

function makeItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    kind: 'issue',
    repo: { owner: 'agent', name: 'lcars' },
    number: 249,
    title: 'Responsive Inbox',
    url: 'https://github.com/agent/lcars/issues/249',
    updatedAt: '2026-07-30T00:00:00Z',
    actionTypes: ['human-needed'],
    labels: [],
    assigneeLogins: [],
    ...overrides,
  };
}

function makeCard(overrides: Partial<ActionItem> = {}): BoardCard {
  return { item: makeItem(overrides), updatedAtLabel: 'now' };
}

function renderWorkspace(
  cards: BoardCard[],
  selectedItemKey?: string,
): ReturnType<typeof render> {
  return render(
    <MantineProvider>
      <QueueWorkspace
        cards={cards}
        selectedItemKey={selectedItemKey}
        watchedRepos={[{ owner: 'agent', name: 'lcars' }]}
        mobileUtilityMenu={<button>More console options</button>}
      />
    </MantineProvider>,
  );
}

describe('queueSelectionHref', () => {
  it('adds an encoded item while preserving the repo filter', () => {
    expect(
      queueSelectionHref(
        'repo=agent-lcars%2Fconsole',
        'agent-lcars/console#249',
      ),
    ).toBe(
      '/inbox?repo=agent-lcars%2Fconsole&item=agent-lcars%2Fconsole%23249',
    );
  });

  it('removes only item when returning to the Inbox', () => {
    expect(
      queueSelectionHref(
        'repo=agent-lcars%2Fconsole&item=agent-lcars%2Fconsole%23249',
      ),
    ).toBe('/inbox?repo=agent-lcars%2Fconsole');
  });

  it('returns the root route when no filters remain', () => {
    expect(queueSelectionHref('item=agent-lcars%2Fconsole%23249')).toBe(
      '/inbox',
    );
  });
});

describe('QueueWorkspace', () => {
  it('selects the first visible item locally and emits URL-backed row links', () => {
    renderWorkspace([
      makeCard(),
      makeCard({
        number: 250,
        title: 'Review the next item',
        actionTypes: ['review-requested'],
      }),
    ]);

    expect(screen.getByTestId('selected-detail')).toHaveTextContent(
      'Detail #249',
    );
    expect(
      screen.getByRole('link', { name: /Review the next item/ }),
    ).toHaveAttribute(
      'href',
      '/inbox?repo=agent%2Flcars&item=agent%2Flcars%23250',
    );
  });

  it('renders a recoverable state for an explicit stale selection', () => {
    renderWorkspace([makeCard()], 'agent/lcars#999');

    expect(
      screen.getByRole('heading', { name: 'Item unavailable' }),
    ).toBeTruthy();
    expect(screen.queryByTestId('selected-detail')).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to Inbox' })).toHaveAttribute(
      'href',
      '/inbox?repo=agent%2Flcars',
    );
  });

  it('filters the Inbox without adding another navigation layer', async () => {
    renderWorkspace([
      makeCard(),
      makeCard({
        number: 250,
        title: 'Review the next item',
        actionTypes: ['review-requested'],
      }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByText('Review requested'));

    expect(screen.queryByText('Responsive Inbox')).toBeNull();
    expect(screen.getByText('Review the next item')).toBeTruthy();
  });
});
