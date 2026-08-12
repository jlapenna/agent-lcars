import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ActionItem } from '../lib/action-items';
import {
  type BoardCard,
  BridgeSections,
  DecisionInbox,
} from './action-items-board';

// This suite exercises the board's tiering only - ActionItemCard and
// RetriggerButton pull in the 'use server' actions module (auth, firestore,
// GitHub client), which is out of scope here and tested on its own.
vi.mock('./action-item-card', () => ({
  ActionItemCard: ({ item }: { item: { number: number; title: string } }) => (
    <div data-testid="full-card">{`#${item.number} ${item.title}`}</div>
  ),
}));
vi.mock('./queue-workspace', () => ({
  QueueWorkspace: ({
    cards,
  }: {
    cards: Array<{ item: { number: number; title: string } }>;
  }) =>
    cards.length > 0 ? (
      <>
        {cards.map(({ item }) => (
          <div key={item.number} data-testid="full-card">
            #{item.number} {item.title}
          </div>
        ))}
      </>
    ) : (
      <div>Nothing needs you right now.</div>
    ),
}));
function makeItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    kind: 'issue',
    repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
    number: 1,
    title: 'Fix the thing',
    url: 'https://github.com/supersprinklesracing/sprinkles/issues/1',
    updatedAt: '2026-07-07T00:00:00Z',
    actionTypes: [],
    labels: [],
    assigneeLogins: [],
    ...overrides,
  };
}

function card(item: ActionItem): BoardCard {
  return { item };
}

function renderBoard(waitingOnDeploy: ActionItem[] = []) {
  render(
    <MantineProvider>
      <BridgeSections waitingOnDeploy={waitingOnDeploy.map(card)} />
    </MantineProvider>,
  );
}

describe('Decision Inbox and Bridge surfaces', () => {
  it('does not add a low-value empty section when nothing is parked', () => {
    renderBoard();
    expect(screen.queryByTestId('parked-work')).toBeNull();
  });

  it('shows the empty-queue message when nothing needs the maintainer', () => {
    render(
      <MantineProvider>
        <DecisionInbox yourQueue={[]} />
      </MantineProvider>,
    );
    expect(screen.getByText('Nothing needs you right now.')).toBeTruthy();
  });

  it('keeps full decision cards on the Inbox surface', () => {
    render(
      <MantineProvider>
        <DecisionInbox
          yourQueue={[
            card(
              makeItem({
                number: 1,
                title: 'Answer me',
                actionTypes: ['needs-human'],
              }),
            ),
          ]}
        />
      </MantineProvider>,
    );

    expect(screen.getByTestId('full-card')).toHaveTextContent('#1 Answer me');
  });

  it('shows only parked deploy work on the Bridge', () => {
    renderBoard([
      makeItem({
        number: 2,
        title: 'Verify after deploy',
        actionTypes: ['post-deploy-action'],
      }),
    ]);

    expect(screen.queryByTestId('full-card')).toBeNull();
    expect(screen.getByTestId('parked-item-2')).toBeTruthy();
    expect(screen.queryByText(/Everything Else/)).toBeNull();
  });

  it('explains why parked work cannot move yet', () => {
    renderBoard([makeItem({ number: 5 }), makeItem({ number: 6 })]);

    expect(screen.getByRole('heading', { name: 'Parked Work' })).toBeTruthy();
    expect(
      screen.getByText(
        '2 items · Waiting for the next deploy before verification can continue.',
      ),
    ).toBeTruthy();
  });

  it('gives every parked item one direct, accurately labelled action', () => {
    renderBoard([
      makeItem({
        number: 7,
        title: 'Verify after deploy',
        actionTypes: ['post-deploy-action'],
      }),
      makeItem({
        number: 8,
        kind: 'pr',
        title: 'Verify merged change',
        url: 'https://github.com/o/r/pull/8',
      }),
    ]);

    expect(screen.getByRole('link', { name: 'Open issue ↗' })).toHaveAttribute(
      'href',
      'https://github.com/supersprinklesracing/sprinkles/issues/1',
    );
    expect(screen.getByRole('link', { name: 'Open PR ↗' })).toHaveAttribute(
      'href',
      'https://github.com/o/r/pull/8',
    );
  });
});
