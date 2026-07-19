import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ActionItem } from '../lib/action-items';
import type { PrimaryAction } from '../lib/primary-action';
import { ActionItemCard } from './action-item-card';

// actions.ts is 'use server' and pulls in auth/firestore/GitHub client -
// out of scope here, matching the pattern in action-items-board.test.tsx.
vi.mock('./actions', () => ({
  mergePr: vi.fn(),
  replyToItem: vi.fn(),
  dispatchUnstickPrs: vi.fn(),
}));
vi.mock('./cancel-run-button', () => ({
  CancelRunButton: () => null,
}));
vi.mock('./retrigger-button', () => ({
  RetriggerButton: ({ pipeline }: { pipeline?: string }) => (
    <div data-testid="retrigger-button" data-pipeline={pipeline ?? 'claude'} />
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

function renderCard(item: ActionItem, primaryAction?: PrimaryAction) {
  render(
    <MantineProvider>
      <ActionItemCard
        item={item}
        updatedAtLabel="now"
        primaryAction={primaryAction}
      />
    </MantineProvider>,
  );
}

describe('ActionItemCard', () => {
  it('keeps the header row wrapping instead of squeezing the title next to badges', () => {
    renderCard(
      makeItem({
        title: 'A title that should stay readable next to several badges',
        actionTypes: [
          'human-needed',
          'run-failed',
          'review-requested',
          'post-deploy-action',
        ],
      }),
    );

    const title = screen.getByRole('link', {
      name: /A title that should stay readable next to several badges/,
    });
    // The header Group must not force the title and badge row onto a
    // single non-wrapping line - that's what squeezes the title down to a
    // sliver when several action-type badges are present (#2745).
    const headerRow = title.closest('[class*="Group-root"]');
    expect(headerRow?.getAttribute('style')).not.toContain(
      '--group-wrap: nowrap',
    );

    for (const label of [
      'Needs a human',
      'CI run failed',
      'Review requested',
      'Awaiting next deploy',
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('keeps Approve & Merge clickable when blocked only on the pending approval this button submits (#2751)', () => {
    renderCard(
      makeItem({
        kind: 'pr',
        actionTypes: ['review-requested'],
        draft: false,
        mergeableState: 'blocked',
      }),
      { kind: 'approve-merge' },
    );

    const button = screen.getByRole('button', {
      name: 'Approve & Merge',
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(screen.queryByText(/Blocked/)).toBeNull();
  });

  it('disables Approve & Merge on real merge conflicts', () => {
    renderCard(
      makeItem({
        kind: 'pr',
        actionTypes: ['review-requested'],
        draft: false,
        mergeableState: 'dirty',
      }),
      { kind: 'approve-merge' },
    );

    const button = screen.getByRole('button', {
      name: 'Approve & Merge',
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Merge conflicts/)).toBeTruthy();
  });

  it('disables Approve & Merge while required checks are still running', () => {
    renderCard(
      makeItem({
        kind: 'pr',
        actionTypes: ['review-requested'],
        draft: false,
        mergeableState: 'blocked',
        ciRunning: true,
      }),
      { kind: 'approve-merge' },
    );

    const button = screen.getByRole('button', {
      name: 'Approve & Merge',
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('offers a per-card Unstick button on a PR with a failed run', () => {
    renderCard(
      makeItem({
        kind: 'pr',
        number: 42,
        title: 'Add the widget',
        actionTypes: ['run-failed'],
      }),
    );

    expect(screen.getByRole('button', { name: 'Unstick' })).toBeTruthy();
  });

  it('omits the Unstick button when the PR has no failed run', () => {
    renderCard(
      makeItem({
        kind: 'pr',
        actionTypes: ['review-requested'],
      }),
    );

    expect(screen.queryByRole('button', { name: 'Unstick' })).toBeNull();
  });

  it('omits the Unstick button on issues even with run-failed set', () => {
    renderCard(
      makeItem({
        kind: 'issue',
        actionTypes: ['run-failed'],
      }),
    );

    expect(screen.queryByRole('button', { name: 'Unstick' })).toBeNull();
  });

  it('renders the takeover command copy control as an icon button, not text (#2880)', () => {
    renderCard(
      makeItem({
        takeoverCommand: 'claude --resume abc123',
      }),
    );

    expect(
      screen.getByRole('button', { name: 'Copy takeover command' }),
    ).toBeTruthy();
    expect(screen.queryByText('Copy')).toBeNull();
  });

  describe('retrigger + reply pipeline routing (#3012)', () => {
    it('offers Retrigger, cycling claude, for a claude-labeled issue', () => {
      renderCard(makeItem({ kind: 'issue', labels: ['claude'] }));

      const button = screen.getByTestId('retrigger-button');
      expect(button.dataset.pipeline).toBe('claude');
    });

    it('offers Retrigger, cycling opencode, for an opencode-only issue', () => {
      renderCard(makeItem({ kind: 'issue', labels: ['opencode'] }));

      const button = screen.getByTestId('retrigger-button');
      expect(button.dataset.pipeline).toBe('opencode');
    });

    it('offers Retrigger, cycling claude, when an issue carries both labels', () => {
      renderCard(makeItem({ kind: 'issue', labels: ['claude', 'opencode'] }));

      const button = screen.getByTestId('retrigger-button');
      expect(button.dataset.pipeline).toBe('claude');
    });

    it('omits Retrigger for an issue with neither pipeline label', () => {
      renderCard(makeItem({ kind: 'issue', labels: ['human-needed'] }));

      expect(screen.queryByTestId('retrigger-button')).toBeNull();
    });

    it('omits Retrigger for a PR even with the claude label (issues only)', () => {
      renderCard(makeItem({ kind: 'pr', labels: ['claude'] }));

      expect(screen.queryByTestId('retrigger-button')).toBeNull();
    });

    it('shows the /oc reply placeholder for an opencode-only item', () => {
      renderCard(
        makeItem({ labels: ['opencode'] }),
        { kind: 'reply' }, // opens the reply input
      );

      expect(screen.getByPlaceholderText('Reply with /oc…')).toBeTruthy();
    });

    it('shows the @claude reply placeholder by default', () => {
      renderCard(makeItem({ labels: [] }), { kind: 'reply' });

      expect(screen.getByPlaceholderText('Reply with @claude…')).toBeTruthy();
    });
  });
});
