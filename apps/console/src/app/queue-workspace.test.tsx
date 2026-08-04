import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActionItem } from '../lib/action-items';
import type { BoardCard } from './board-card';
import {
  parseQueueFilter,
  parseQueueSort,
  queueSelectionHref,
  QueueWorkspace,
} from './queue-workspace';

let mockSearch = 'repo=agent%2Flcars';
// Identity-stable per value, matching the real hook: useSearchParams only
// returns a new object when the URL actually changes, and the workspace's
// resync effect keys off that identity.
let cachedParams: [string, URLSearchParams] | undefined;
vi.mock('next/navigation', () => ({
  useSearchParams: () => {
    if (!cachedParams || cachedParams[0] !== mockSearch) {
      cachedParams = [mockSearch, new URLSearchParams(mockSearch)];
    }
    return cachedParams[1];
  },
}));

afterEach(() => {
  mockSearch = 'repo=agent%2Flcars';
  cachedParams = undefined;
  vi.restoreAllMocks();
});
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
    actionTypes: ['needs-human'],
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
    expect(
      within(menu).getAllByRole('menuitem', { hidden: true }),
    ).toHaveLength(7);
    expect(
      within(menu).getByRole('menuitem', {
        name: 'All reasons',
        hidden: true,
      }),
    ).toHaveAttribute('aria-current', 'true');
    expect(
      within(menu).getByRole('menuitem', {
        name: 'Ready for agent',
        hidden: true,
      }),
    ).toBeTruthy();
    fireEvent.click(
      within(menu).getByRole('menuitem', {
        name: 'Review requested',
        hidden: true,
      }),
    );

    expect(screen.queryByText('Responsive Inbox')).toBeNull();
    expect(screen.getByText('Review the next item')).toBeTruthy();
  });

  it('initializes filter and sort from the URL and marks the active controls', () => {
    mockSearch = 'reason=review-requested&sort=newest';
    renderWorkspace([
      makeCard(),
      makeCard({
        number: 250,
        title: 'Review the next item',
        actionTypes: ['review-requested'],
      }),
    ]);

    expect(screen.queryByText('Responsive Inbox')).toBeNull();
    expect(screen.getByText('Review the next item')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Review requested' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Newest update' })).toBeTruthy();
  });

  it('writes filter changes to the URL and offers a reset from the empty state', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    renderWorkspace([makeCard()]);

    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const menu = await screen.findByRole('menu');
    fireEvent.click(
      within(menu).getByRole('menuitem', { name: 'Run failed', hidden: true }),
    );

    expect(replaceState).toHaveBeenCalledWith(
      null,
      '',
      expect.stringContaining('reason=run-failed'),
    );
    expect(screen.getByText('No “Run failed” items right now.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show all reasons' }));
    expect(screen.getByText('Responsive Inbox')).toBeTruthy();
    const lastUrl = replaceState.mock.calls.at(-1)?.[2] as string;
    expect(lastUrl).not.toContain('reason=');
  });
});

describe('URL resync', () => {
  it('re-reads filter/sort when the query changes after mount (back/forward)', () => {
    const view = renderWorkspace([
      makeCard(),
      makeCard({
        number: 250,
        title: 'Review the next item',
        actionTypes: ['review-requested'],
      }),
    ]);
    expect(screen.getByText('Responsive Inbox')).toBeTruthy();

    mockSearch = 'reason=review-requested';
    view.rerender(
      <MantineProvider>
        <QueueWorkspace
          cards={[
            makeCard(),
            makeCard({
              number: 250,
              title: 'Review the next item',
              actionTypes: ['review-requested'],
            }),
          ]}
          watchedRepos={[{ owner: 'agent', name: 'lcars' }]}
          mobileUtilityMenu={<button>More console options</button>}
        />
      </MantineProvider>,
    );

    expect(screen.queryByText('Responsive Inbox')).toBeNull();
    expect(screen.getByText('Review the next item')).toBeTruthy();
  });
});

describe('parseQueueFilter / parseQueueSort', () => {
  it('accepts known values and falls back on defaults for junk', () => {
    expect(parseQueueFilter('run-failed')).toBe('run-failed');
    expect(parseQueueFilter('nonsense')).toBe('all');
    expect(parseQueueFilter(null)).toBe('all');
    expect(parseQueueSort('newest')).toBe('newest');
    expect(parseQueueSort('nonsense')).toBe('priority');
    expect(parseQueueSort(null)).toBe('priority');
  });
});
