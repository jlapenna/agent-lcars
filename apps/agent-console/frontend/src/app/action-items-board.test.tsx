import { MantineProvider } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';

import type { ActionItem } from '../lib/action-items';
import { ActionItemsBoard, type BoardCard } from './action-items-board';

// This suite exercises the board's tiering only - ActionItemCard and
// RetriggerButton pull in the 'use server' actions module (auth, firestore,
// GitHub client), which is out of scope here and tested on its own.
jest.mock('./action-item-card', () => ({
  ActionItemCard: ({ item }: { item: { number: number; title: string } }) => (
    <div data-testid="full-card">{`#${item.number} ${item.title}`}</div>
  ),
}));
jest.mock('./retrigger-button', () => ({
  RetriggerButton: ({ issueNumber }: { issueNumber: number }) => (
    <button data-testid={`retrigger-${issueNumber}`}>Retrigger</button>
  ),
}));
jest.mock('./item-overflow-menu', () => ({
  ItemOverflowMenu: ({ item }: { item: { number: number } }) => (
    <button data-testid={`overflow-${item.number}`}>More actions</button>
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

function renderBoard({
  yourQueue = [],
  handedBack = [],
  waitingOnDeploy = [],
  rest = [],
}: {
  yourQueue?: ActionItem[];
  handedBack?: ActionItem[];
  waitingOnDeploy?: ActionItem[];
  rest?: ActionItem[];
}) {
  render(
    <MantineProvider>
      <ActionItemsBoard
        yourQueue={yourQueue.map(card)}
        handedBack={handedBack.map(card)}
        waitingOnDeploy={waitingOnDeploy.map(card)}
        rest={rest.map(card)}
      />
    </MantineProvider>,
  );
}

describe('ActionItemsBoard', () => {
  it('shows the empty-queue message when nothing needs the maintainer', () => {
    renderBoard({});
    expect(screen.getByText('Nothing needs you right now.')).toBeTruthy();
  });

  it('renders full cards only for Your Queue; other tiers get compact rows', () => {
    renderBoard({
      yourQueue: [
        makeItem({
          number: 1,
          title: 'Answer me',
          actionTypes: ['human-needed'],
        }),
      ],
      waitingOnDeploy: [
        makeItem({
          number: 2,
          title: 'Verify after deploy',
          actionTypes: ['post-deploy-action'],
        }),
      ],
      rest: [makeItem({ number: 3, title: 'Background item' })],
    });

    const fullCards = screen.getAllByTestId('full-card');
    expect(fullCards).toHaveLength(1);
    expect(fullCards[0].textContent).toContain('#1 Answer me');
    expect(screen.getByTestId('compact-item-2')).toBeTruthy();
    expect(screen.getByTestId('compact-item-3')).toBeTruthy();
  });

  it('hides the handed-back and deploy tiers entirely when empty', () => {
    renderBoard({ yourQueue: [makeItem()] });
    expect(screen.queryByText(/Handed Back/)).toBeNull();
    expect(screen.queryByText(/Waiting on Next Deploy/)).toBeNull();
    expect(screen.queryByText(/Everything Else/)).toBeNull();
  });

  it('offers Retrigger on handed-back claude issues but not on other rows', () => {
    renderBoard({
      handedBack: [
        makeItem({
          number: 4,
          title: 'Answered question',
          actionTypes: ['human-needed'],
          labels: ['claude'],
        }),
        makeItem({
          number: 5,
          title: 'Answered non-agent question',
          actionTypes: ['human-needed'],
        }),
      ],
    });

    const claudeRow = screen.getByTestId('compact-item-4');
    expect(within(claudeRow).getByTestId('retrigger-4')).toBeTruthy();
    const plainRow = screen.getByTestId('compact-item-5');
    expect(within(plainRow).queryByTestId('retrigger-5')).toBeNull();
  });

  it('offers the overflow menu on every compact row', () => {
    renderBoard({
      handedBack: [
        makeItem({
          number: 4,
          title: 'Answered question',
          actionTypes: ['human-needed'],
        }),
      ],
      waitingOnDeploy: [
        makeItem({
          number: 7,
          title: 'Verify after deploy',
          actionTypes: ['post-deploy-action'],
        }),
      ],
      rest: [makeItem({ number: 6, title: 'Background item' })],
    });

    expect(screen.getByTestId('overflow-4')).toBeTruthy();
    expect(screen.getByTestId('overflow-7')).toBeTruthy();
    expect(screen.getByTestId('overflow-6')).toBeTruthy();
  });

  it('keeps Everything Else collapsed by default with its rows still reachable', () => {
    renderBoard({ rest: [makeItem({ number: 6, title: 'Background item' })] });

    const details = screen.getByTestId('everything-else');
    expect(details).not.toHaveProperty('open', true);
    expect(screen.getByText(/Everything Else \(1\)/)).toBeTruthy();
    expect(
      within(details as HTMLElement).getByTestId('compact-item-6'),
    ).toBeTruthy();
  });
});
