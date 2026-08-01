import { MantineProvider } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { ActionItem } from '../lib/action-items';
import {
  clearHumanNeeded,
  closeIssue,
  reassignPipeline,
  rebasePr,
} from './actions';
import { ItemOverflowMenu } from './item-overflow-menu';

// 'use server' actions - out of scope here, matching the pattern in
// action-items-board.test.tsx.
vi.mock('./actions', () => ({
  closeIssue: vi.fn(),
  clearHumanNeeded: vi.fn(),
  reassignPipeline: vi.fn(),
  rebasePr: vi.fn(),
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

const DEFAULT_REPO = { owner: 'supersprinklesracing', name: 'sprinkles' };

function makeItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    kind: 'issue',
    repo: DEFAULT_REPO,
    number: 42,
    title: 'Stale tracker',
    url: 'https://github.com/supersprinklesracing/sprinkles/issues/42',
    updatedAt: '2026-07-07T00:00:00Z',
    actionTypes: [],
    labels: [],
    assigneeLogins: [],
    ...overrides,
  };
}

function renderMenu(
  item: ActionItem,
  opts: { muted?: boolean; onToggleMute?: () => void } = {},
) {
  render(
    <MantineProvider>
      <ItemOverflowMenu
        item={item}
        muted={opts.muted}
        onToggleMute={opts.onToggleMute}
      />
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

  it('renders nothing for a PR that does not need a human', () => {
    renderMenu(makeItem({ kind: 'pr' }));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers only Close issue for an issue without needs-human state', async () => {
    renderMenu(makeItem());
    await openMenu();

    expect(screen.getByText('Close issue')).toBeTruthy();
    expect(screen.queryByText('Clear needs-human')).toBeNull();
  });

  it('offers only Clear needs-human for a PR in needs-human state', async () => {
    renderMenu(makeItem({ kind: 'pr', actionTypes: ['needs-human'] }));
    await openMenu();

    expect(screen.getByText('Clear needs-human')).toBeTruthy();
    expect(screen.queryByText('Close issue')).toBeNull();
  });

  it('closes the issue via confirm modal, then notifies', async () => {
    (closeIssue as Mock).mockResolvedValue({ ok: true });
    renderMenu(makeItem());
    await openMenu();

    fireEvent.click(screen.getByText('Close issue'));

    await waitFor(() =>
      expect(closeIssue).toHaveBeenCalledWith(DEFAULT_REPO, 42),
    );
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

  it('offers Mute when onToggleMute is passed, even with no other action', async () => {
    renderMenu(makeItem({ kind: 'pr' }), { onToggleMute: vi.fn() });
    await openMenu();

    expect(screen.getByText('Mute')).toBeTruthy();
    expect(screen.queryByText('Unmute')).toBeNull();
  });

  it('offers Unmute instead of Mute once muted is true', async () => {
    renderMenu(makeItem({ kind: 'pr' }), {
      muted: true,
      onToggleMute: vi.fn(),
    });
    await openMenu();

    expect(screen.getByText('Unmute')).toBeTruthy();
    expect(screen.queryByText('Mute')).toBeNull();
  });

  it('calls onToggleMute, with no confirm modal, when Mute is clicked', async () => {
    const onToggleMute = vi.fn();
    renderMenu(makeItem(), { onToggleMute });
    await openMenu();

    fireEvent.click(screen.getByText('Mute'));

    expect(onToggleMute).toHaveBeenCalledTimes(1);
    expect(modals.openConfirmModal).not.toHaveBeenCalled();
  });

  it('clears needs-human without a confirm modal', async () => {
    (clearHumanNeeded as Mock).mockResolvedValue({ ok: true });
    renderMenu(makeItem({ actionTypes: ['needs-human'] }));
    await openMenu();

    fireEvent.click(screen.getByText('Clear needs-human'));

    await waitFor(() =>
      expect(clearHumanNeeded).toHaveBeenCalledWith(DEFAULT_REPO, 42),
    );
    expect(modals.openConfirmModal).not.toHaveBeenCalled();
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Cleared needs-human on #42',
        color: 'green',
      }),
    );
  });

  it('offers Rebase onto base branch only for a PR with mergeableState behind', async () => {
    renderMenu(makeItem({ kind: 'pr', mergeableState: 'behind' }));
    await openMenu();

    expect(screen.getByText('Rebase onto base branch')).toBeTruthy();
  });

  it('does not offer Rebase for a PR with a different mergeableState', () => {
    renderMenu(makeItem({ kind: 'pr', mergeableState: 'dirty' }));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('does not offer Rebase for a behind issue (not a PR)', async () => {
    renderMenu(makeItem({ mergeableState: 'behind' }));
    await openMenu();

    expect(screen.queryByText('Rebase onto base branch')).toBeNull();
  });

  it('rebases the branch without a confirm modal, then notifies', async () => {
    (rebasePr as Mock).mockResolvedValue({ ok: true });
    renderMenu(makeItem({ kind: 'pr', mergeableState: 'behind' }));
    await openMenu();

    fireEvent.click(screen.getByText('Rebase onto base branch'));

    await waitFor(() =>
      expect(rebasePr).toHaveBeenCalledWith(DEFAULT_REPO, 42),
    );
    expect(modals.openConfirmModal).not.toHaveBeenCalled();
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '#42 updated with the base branch',
        color: 'green',
      }),
    );
  });

  it('surfaces a failed rebase as a red notification', async () => {
    (rebasePr as Mock).mockResolvedValue({
      ok: false,
      message: 'Merge conflict',
    });
    renderMenu(makeItem({ kind: 'pr', mergeableState: 'behind' }));
    await openMenu();

    fireEvent.click(screen.getByText('Rebase onto base branch'));

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Merge conflict', color: 'red' }),
      ),
    );
  });

  it('offers the other two pipelines to reassign a codex-labeled issue to', async () => {
    renderMenu(makeItem({ labels: ['agent:codex'] }));
    await openMenu();

    expect(screen.getByText('Reassign to claude')).toBeTruthy();
    expect(screen.getByText('Reassign to opencode')).toBeTruthy();
    expect(screen.queryByText('Reassign to codex')).toBeNull();
  });

  it('does not offer reassign for an issue with no pipeline label', async () => {
    renderMenu(makeItem());
    await openMenu();

    expect(screen.queryByText(/Reassign to/)).toBeNull();
  });

  it('does not offer reassign for a PR, even a pipeline-labeled one', async () => {
    renderMenu(
      makeItem({
        kind: 'pr',
        labels: ['agent:codex'],
        mergeableState: 'behind',
      }),
    );
    await openMenu();

    expect(screen.queryByText(/Reassign to/)).toBeNull();
  });

  it('reassigns to the clicked pipeline, then notifies', async () => {
    (reassignPipeline as Mock).mockResolvedValue({ ok: true });
    renderMenu(makeItem({ labels: ['agent:codex'] }));
    await openMenu();

    fireEvent.click(screen.getByText('Reassign to claude'));

    await waitFor(() =>
      expect(reassignPipeline).toHaveBeenCalledWith(DEFAULT_REPO, 42, 'claude'),
    );
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '#42 reassigned to claude',
        color: 'green',
      }),
    );
  });

  it('surfaces a failed reassign as a red notification', async () => {
    (reassignPipeline as Mock).mockResolvedValue({
      ok: false,
      message: 'Issue is already assigned to claude',
    });
    renderMenu(makeItem({ labels: ['agent:codex'] }));
    await openMenu();

    fireEvent.click(screen.getByText('Reassign to claude'));

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Issue is already assigned to claude',
          color: 'red',
        }),
      ),
    );
  });
});
