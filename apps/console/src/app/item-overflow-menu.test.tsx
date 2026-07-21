import { MantineProvider } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { ActionItem } from '../lib/action-items';
import { clearHumanNeeded, closeIssue } from './actions';
import { ItemOverflowMenu } from './item-overflow-menu';

// 'use server' actions - out of scope here, matching the pattern in
// action-items-board.test.tsx.
vi.mock('./actions', () => ({
  closeIssue: vi.fn(),
  clearHumanNeeded: vi.fn(),
}));

// No ModalsProvider is mounted in these tests (only MantineProvider, matching
// the rest of this suite), so openConfirmModal is stubbed to invoke its
// onConfirm immediately - equivalent to the maintainer confirming.
vi.mock('@mantine/modals', () => ({
  modals: {
    openConfirmModal: vi.fn(({ onConfirm }) => onConfirm()),
  },
}));

vi.mock('@mantine/notifications', () => ({
  notifications: { show: vi.fn() },
}));

function makeItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    kind: 'issue',
    number: 42,
    title: 'Stale tracker',
    url: 'https://github.com/supersprinklesracing/members/issues/42',
    updatedAt: '2026-07-07T00:00:00Z',
    actionTypes: [],
    labels: [],
    assigneeLogins: [],
    ...overrides,
  };
}

function renderMenu(item: ActionItem) {
  render(
    <MantineProvider>
      <ItemOverflowMenu item={item} />
    </MantineProvider>,
  );
}

async function openMenu() {
  fireEvent.click(screen.getByRole('button'));
  await screen.findByRole('menu');
}

describe('ItemOverflowMenu', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing for a PR that is not human-needed', () => {
    renderMenu(makeItem({ kind: 'pr' }));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers only Close issue for an issue with no human-needed label', async () => {
    renderMenu(makeItem());
    await openMenu();

    expect(screen.getByText('Close issue')).toBeTruthy();
    expect(screen.queryByText('Clear needs-human')).toBeNull();
  });

  it('offers only Clear needs-human for a human-needed PR', async () => {
    renderMenu(makeItem({ kind: 'pr', actionTypes: ['human-needed'] }));
    await openMenu();

    expect(screen.getByText('Clear needs-human')).toBeTruthy();
    expect(screen.queryByText('Close issue')).toBeNull();
  });

  it('closes the issue via confirm modal, then notifies', async () => {
    (closeIssue as Mock).mockResolvedValue({ ok: true });
    renderMenu(makeItem());
    await openMenu();

    fireEvent.click(screen.getByText('Close issue'));

    await waitFor(() => expect(closeIssue).toHaveBeenCalledWith(42));
    expect(modals.openConfirmModal).toHaveBeenCalled();
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: '#42 closed', color: 'green' }),
    );
  });

  it('surfaces a failed close as a red notification', async () => {
    (closeIssue as Mock).mockResolvedValue({
      ok: false,
      message: 'Issue not found',
    });
    renderMenu(makeItem());
    await openMenu();

    fireEvent.click(screen.getByText('Close issue'));

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Issue not found', color: 'red' }),
      ),
    );
  });

  it('clears needs-human without a confirm modal', async () => {
    (clearHumanNeeded as Mock).mockResolvedValue({ ok: true });
    renderMenu(makeItem({ actionTypes: ['human-needed'] }));
    await openMenu();

    fireEvent.click(screen.getByText('Clear needs-human'));

    await waitFor(() => expect(clearHumanNeeded).toHaveBeenCalledWith(42));
    expect(modals.openConfirmModal).not.toHaveBeenCalled();
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Cleared needs-human on #42',
        color: 'green',
      }),
    );
  });
});
