import { MantineProvider } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { ActionItem } from '../lib/action-items';
import {
  approveAndRebase,
  assignPipeline,
  clearHumanNeeded,
  closeIssue,
  mergePr,
  reassignPipeline,
  rebasePr,
  updateIssueContent,
} from './actions';
import { ItemOverflowMenu } from './item-overflow-menu';

// 'use server' actions - out of scope here, matching the pattern in
// action-items-board.test.tsx.
vi.mock('./actions', () => ({
  approveAndRebase: vi.fn(),
  assignPipeline: vi.fn(),
  closeIssue: vi.fn(),
  mergePr: vi.fn(),
  clearHumanNeeded: vi.fn(),
  reassignPipeline: vi.fn(),
  rebasePr: vi.fn(),
  updateIssueContent: vi.fn(),
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

  it('offers Edit issue and Close issue for an otherwise plain issue', async () => {
    renderMenu(makeItem());
    await openMenu();

    expect(screen.getByText('Edit issue')).toBeTruthy();
    expect(screen.getByText('Close issue')).toBeTruthy();
    expect(screen.queryByText('Clear needs-human')).toBeNull();
  });

  it('edits an issue title and body from the shared overflow menu', async () => {
    (updateIssueContent as Mock).mockResolvedValue({ ok: true });
    renderMenu(makeItem({ body: 'Original body' }));
    await openMenu();

    fireEvent.click(screen.getByText('Edit issue'));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByLabelText(/^Title/)).toHaveValue('Stale tracker');
    expect(screen.getByLabelText('Body')).toHaveValue('Original body');

    fireEvent.change(screen.getByLabelText(/^Title/), {
      target: { value: 'Updated tracker' },
    });
    fireEvent.change(screen.getByLabelText('Body'), {
      target: { value: 'Updated body' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(updateIssueContent).toHaveBeenCalledWith(DEFAULT_REPO, 42, {
        title: 'Updated tracker',
        body: 'Updated body',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: '#42 updated', color: 'green' }),
    );
  });

  it('keeps the editor open and surfaces a failed issue update', async () => {
    (updateIssueContent as Mock).mockResolvedValue({
      ok: false,
      message: 'Validation Failed',
    });
    renderMenu(makeItem());
    await openMenu();

    fireEvent.click(screen.getByText('Edit issue'));
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText(/^Title/), {
      target: { value: 'Rejected title' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Validation Failed',
          color: 'red',
        }),
      ),
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('offers only Clear needs-human for a PR in needs-human state', async () => {
    renderMenu(makeItem({ kind: 'pr', actionTypes: ['needs-human'] }));
    await openMenu();

    expect(screen.getByText('Clear needs-human')).toBeTruthy();
    expect(screen.queryByText('Close issue')).toBeNull();
  });

  it('approves and merges a review-requested PR from the overflow menu', async () => {
    (mergePr as Mock).mockResolvedValue({ ok: true });
    renderMenu(
      makeItem({
        kind: 'pr',
        actionTypes: ['review-requested'],
        mergeableState: 'clean',
      }),
    );
    await openMenu();

    fireEvent.click(screen.getByText('Approve & Merge'));

    await waitFor(() => expect(mergePr).toHaveBeenCalledWith(DEFAULT_REPO, 42));
    expect(modals.openConfirmModal).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Merge #42?',
        labels: { confirm: 'Approve & Merge', cancel: 'Cancel' },
      }),
    );
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: '#42 merged', color: 'green' }),
    );
  });

  it('surfaces a failed overflow-menu approval as a red notification', async () => {
    (mergePr as Mock).mockResolvedValue({
      ok: false,
      message: 'Required check failed',
    });
    renderMenu(
      makeItem({
        kind: 'pr',
        actionTypes: ['review-requested'],
        mergeableState: 'clean',
      }),
    );
    await openMenu();

    fireEvent.click(screen.getByText('Approve & Merge'));

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Required check failed',
          color: 'red',
        }),
      ),
    );
  });

  it('uses approve and rebase for a behind review-requested PR', async () => {
    (approveAndRebase as Mock).mockResolvedValue({ ok: true });
    renderMenu(
      makeItem({
        kind: 'pr',
        actionTypes: ['review-requested'],
        mergeableState: 'behind',
      }),
    );
    await openMenu();

    expect(screen.queryByText('Rebase onto base branch')).toBeNull();
    fireEvent.click(screen.getByText('Approve & Rebase'));

    await waitFor(() =>
      expect(approveAndRebase).toHaveBeenCalledWith(DEFAULT_REPO, 42),
    );
    expect(mergePr).not.toHaveBeenCalled();
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '#42 approved, branch updated, auto-merge enabled',
        color: 'green',
      }),
    );
  });

  it('withholds review actions from a draft PR', () => {
    renderMenu(
      makeItem({
        kind: 'pr',
        actionTypes: ['review-requested'],
        mergeableState: 'draft',
        draft: true,
      }),
    );

    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each([
    ['CI runs', { mergeableState: 'clean' as const, ciRunning: true }],
    ['the branch conflicts', { mergeableState: 'dirty' as const }],
  ])('disables direct approval while %s', async (_reason, state) => {
    renderMenu(
      makeItem({
        kind: 'pr',
        actionTypes: ['review-requested'],
        ...state,
      }),
    );
    await openMenu();

    expect(
      screen.getByText('Approve & Merge').closest('button'),
    ).toBeDisabled();
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
        expect.objectContaining({
          message: 'Issue not found',
          color: 'red',
          autoClose: false,
          withCloseButton: true,
        }),
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

  it('offers first assignment for an issue with no pipeline label', async () => {
    renderMenu(makeItem());
    await openMenu();

    expect(screen.getByText('Assign to claude')).toBeTruthy();
    expect(screen.getByText('Assign to codex')).toBeTruthy();
  });

  it('assigns an unclaimed issue to the selected pipeline', async () => {
    (assignPipeline as Mock).mockResolvedValue({ ok: true });
    renderMenu(makeItem());
    await openMenu();
    fireEvent.click(screen.getByText('Assign to codex'));
    await waitFor(() =>
      expect(assignPipeline).toHaveBeenCalledWith(DEFAULT_REPO, 42, 'codex'),
    );
  });

  // selectedAgentPipeline() reports `undefined` both for "no agent label"
  // and for this contradictory "two agent labels" case. Offering every
  // "Assign to ..." option here would be a trap: assignPipeline's backend
  // check rejects any issue that already carries an agent label, so every
  // one of those actions would fail (#859 review).
  it('offers neither assign nor reassign for an issue with two agent labels', async () => {
    renderMenu(makeItem({ labels: ['agent:claude', 'agent:opencode'] }));
    await openMenu();

    expect(screen.queryByText(/Assign to/)).toBeNull();
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
      expect(reassignPipeline).toHaveBeenCalledWith(
        DEFAULT_REPO,
        42,
        'claude',
        // The console's own stable per-click idempotency key (#811) -
        // asserting a UUID shape here, not an exact value, matches how
        // retrigger-button.tsx's own createRandomId() call is exercised.
        expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        ),
      ),
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
