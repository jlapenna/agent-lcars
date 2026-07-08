import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';

import type { ActionItem } from '../lib/action-items';
import { ActionItemsBoard, type BoardCard } from './action-items-board';

// This suite exercises the board's filtering logic only - ActionItemCard
// pulls in the 'use server' actions module (auth, firestore, GitHub client),
// which is out of scope here and already untested on its own.
jest.mock('./action-item-card', () => ({
  ActionItemCard: ({ item }: { item: { number: number; title: string } }) => (
    <div>{`#${item.number} ${item.title}`}</div>
  ),
}));

function makeItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    kind: 'issue',
    number: 1,
    title: 'Fix the thing',
    url: 'https://github.com/supersprinklesracing/members/issues/1',
    updatedAt: '2026-07-07T00:00:00Z',
    actionTypes: [],
    labels: [],
    ...overrides,
  };
}

function card(item: ActionItem): BoardCard {
  return { item, updatedAtLabel: 'now' };
}

function renderBoard(needsAction: ActionItem[]) {
  render(
    <MantineProvider>
      <ActionItemsBoard
        needsAction={needsAction.map(card)}
        agentWorking={[]}
        waitingOnDeploy={[]}
        rest={[]}
      />
    </MantineProvider>,
  );
}

describe('ActionItemsBoard', () => {
  it('shows the true-empty message when the section has no items at all', () => {
    renderBoard([]);
    expect(screen.getByText('Nothing waiting on you right now.')).toBeTruthy();
  });

  it('filters by search text across number, title, and labels', () => {
    renderBoard([
      makeItem({ number: 1, title: 'Fix the thing', labels: ['bug'] }),
      makeItem({ number: 2, title: 'Add a feature', labels: ['enhancement'] }),
    ]);

    fireEvent.change(screen.getByPlaceholderText(/search by number/i), {
      target: { value: 'feature' },
    });

    expect(screen.queryByText('#1 Fix the thing')).toBeNull();
    expect(screen.getByText('#2 Add a feature')).toBeTruthy();
  });

  it('shows a distinct message when a filter hides every item in a non-empty section', () => {
    renderBoard([makeItem({ number: 1, title: 'Fix the thing' })]);

    fireEvent.change(screen.getByPlaceholderText(/search by number/i), {
      target: { value: 'nonexistent' },
    });

    expect(screen.getByText('No matches in this section.')).toBeTruthy();
    expect(screen.queryByText('Nothing waiting on you right now.')).toBeNull();
  });

  it('filters by label chip', () => {
    renderBoard([
      makeItem({ number: 1, title: 'Fix the thing', labels: ['bug'] }),
      makeItem({ number: 2, title: 'Add a feature', labels: ['enhancement'] }),
    ]);

    fireEvent.click(screen.getByRole('checkbox', { name: 'bug' }));

    expect(screen.getByText('#1 Fix the thing')).toBeTruthy();
    expect(screen.queryByText('#2 Add a feature')).toBeNull();
  });

  it('filters by kind', () => {
    renderBoard([
      makeItem({ number: 1, title: 'An issue', kind: 'issue' }),
      makeItem({ number: 2, title: 'A pull request', kind: 'pr' }),
    ]);

    fireEvent.click(screen.getByRole('radio', { name: 'PRs' }));

    expect(screen.queryByText('#1 An issue')).toBeNull();
    expect(screen.getByText('#2 A pull request')).toBeTruthy();
  });

  it('shows a clear-filters control only while a filter is active, and clearing restores everything', () => {
    renderBoard([makeItem({ number: 1, title: 'Fix the thing' })]);

    expect(screen.queryByText('Clear filters')).toBeNull();

    fireEvent.change(screen.getByPlaceholderText(/search by number/i), {
      target: { value: 'nonexistent' },
    });
    expect(screen.getByText('Clear filters')).toBeTruthy();
    expect(screen.queryByText('#1 Fix the thing')).toBeNull();

    fireEvent.click(screen.getByText('Clear filters'));
    expect(screen.queryByText('Clear filters')).toBeNull();
    expect(screen.getByText('#1 Fix the thing')).toBeTruthy();
  });
});
