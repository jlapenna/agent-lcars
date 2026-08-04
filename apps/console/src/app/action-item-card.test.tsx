import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ActionItem } from '../lib/action-items';
import type { PrimaryAction } from '../lib/primary-action';
import { ActionItemCard } from './action-item-card';

// actions.ts is 'use server' and pulls in auth/firestore/GitHub client -
// out of scope here, matching the pattern in action-items-board.test.tsx.
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('./actions', () => ({
  mergePr: vi.fn(),
  approveAndRebase: vi.fn(),
  replyToItem: vi.fn(),
  dispatchUnstickPrs: vi.fn(),
}));
vi.mock('./retrigger-button', () => ({
  RetriggerButton: ({ pipeline }: { pipeline?: string }) => (
    <div data-testid="retrigger-button" data-pipeline={pipeline ?? 'claude'} />
  ),
}));
// react-markdown/remark-gfm are ESM-only (unified ecosystem) - stubbed here
// rather than added to the jest.config esmModules allowlist, matching the
// existing pattern in artifact-viewer.test.tsx.
vi.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => (
    <div data-testid="markdown-stub">{children}</div>
  ),
}));
vi.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));

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

function renderCard(
  item: ActionItem,
  primaryAction?: PrimaryAction,
  multiRepo?: boolean,
) {
  render(
    <MantineProvider>
      <ActionItemCard
        item={item}
        updatedAtLabel="now"
        primaryAction={primaryAction}
        multiRepo={multiRepo}
      />
    </MantineProvider>,
  );
}

describe('ActionItemCard', () => {
  it('uses one reason badge and progressively discloses labels in workspace mode', () => {
    render(
      <MantineProvider>
        <ActionItemCard
          item={makeItem({
            actionTypes: ['run-failed', 'needs-human'],
            labels: ['agent:claude', 'type:bug', 'app:console', 'priority'],
          })}
          updatedAtLabel="now"
          variant="workspace"
        />
      </MantineProvider>,
    );

    expect(screen.getByText('Human needed')).toBeTruthy();
    expect(screen.queryByText('CI run failed')).toBeNull();
    expect(screen.getByText('type:bug')).toBeTruthy();
    expect(screen.getByText('app:console')).toBeTruthy();
    expect(screen.queryByText('priority')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Show 1 additional/ }));

    expect(screen.getByText('priority')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Hide additional labels' }),
    ).toBeTruthy();
  });

  it('shows no repo badge by default (multiRepo unset)', () => {
    renderCard(makeItem());
    expect(screen.queryByTestId('repo-badge')).toBeNull();
  });

  it('shows the repo badge when multiRepo is true', () => {
    renderCard(
      makeItem({ repo: { owner: 'org-a', name: 'repo-a' } }),
      undefined,
      true,
    );
    const badge = screen.getByTestId('repo-badge');
    expect(badge.textContent).toBe('org-a/repo-a');
  });

  it('shows the configured alias instead of owner/name', () => {
    renderCard(
      makeItem({
        repo: { owner: 'org-a', name: 'repo-a', alias: 'Repo A' },
      }),
      undefined,
      true,
    );
    const badge = screen.getByTestId('repo-badge');
    expect(badge.textContent).toBe('Repo A');
  });

  it('keeps the header row wrapping instead of squeezing the title next to badges', () => {
    renderCard(
      makeItem({
        title: 'A title that should stay readable next to several badges',
        actionTypes: [
          'needs-human',
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

  it('offers Approve & Rebase (not Approve & Merge) when the PR is behind base', () => {
    renderCard(
      makeItem({
        kind: 'pr',
        actionTypes: ['review-requested'],
        draft: false,
        mergeableState: 'behind',
      }),
      { kind: 'approve-rebase' },
    );

    const button = screen.getByRole('button', {
      name: 'Approve & Rebase',
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(
      screen.queryByRole('button', { name: 'Approve & Merge' }),
    ).toBeNull();
  });

  it('disables Approve & Rebase on a draft', () => {
    renderCard(
      makeItem({
        kind: 'pr',
        actionTypes: ['review-requested'],
        draft: true,
        mergeableState: 'behind',
      }),
      { kind: 'approve-rebase' },
    );

    const button = screen.getByRole('button', {
      name: 'Approve & Rebase',
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
      renderCard(makeItem({ kind: 'issue', labels: ['agent:claude'] }));

      const button = screen.getByTestId('retrigger-button');
      expect(button.dataset.pipeline).toBe('claude');
    });

    it('offers Retrigger, cycling opencode, for an opencode-only issue', () => {
      renderCard(makeItem({ kind: 'issue', labels: ['agent:opencode'] }));

      const button = screen.getByTestId('retrigger-button');
      expect(button.dataset.pipeline).toBe('opencode');
    });

    it('omits Retrigger when an issue carries contradictory agent labels', () => {
      renderCard(
        makeItem({
          kind: 'issue',
          labels: ['agent:claude', 'agent:opencode'],
        }),
      );

      expect(screen.queryByTestId('retrigger-button')).toBeNull();
    });

    it('omits Retrigger for an issue with neither pipeline label', () => {
      renderCard(makeItem({ kind: 'issue', labels: ['status:needs-human'] }));

      expect(screen.queryByTestId('retrigger-button')).toBeNull();
    });

    it('omits Retrigger for a PR even with the claude label (issues only)', () => {
      renderCard(makeItem({ kind: 'pr', labels: ['agent:claude'] }));

      expect(screen.queryByTestId('retrigger-button')).toBeNull();
    });

    it('shows the /oc reply placeholder for an opencode-only item', () => {
      renderCard(
        makeItem({ labels: ['agent:opencode'] }),
        { kind: 'reply' }, // opens the reply input
      );

      expect(screen.getByPlaceholderText('Reply with /oc…')).toBeTruthy();
    });

    it('shows a plain reply placeholder when no agent is selected', () => {
      renderCard(makeItem({ labels: [] }), { kind: 'reply' });

      expect(screen.getByPlaceholderText('Reply…')).toBeTruthy();
    });
  });

  describe('mute (#59)', () => {
    it('offers Mute in the overflow menu when onToggleMute is passed, and calls it on click', async () => {
      const onToggleMute = vi.fn();
      render(
        <MantineProvider>
          <ActionItemCard
            item={makeItem()}
            updatedAtLabel="now"
            onToggleMute={onToggleMute}
          />
        </MantineProvider>,
      );

      fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
      fireEvent.click(await screen.findByText('Mute'));

      expect(onToggleMute).toHaveBeenCalledTimes(1);
    });

    it('omits Mute from the overflow menu when no onToggleMute is passed', async () => {
      renderCard(makeItem());

      fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
      await screen.findByText('Close issue');

      expect(screen.queryByText('Mute')).toBeNull();
    });
  });

  describe('silent-error diagnosis', () => {
    it('shows the silent-error badge and diagnosis text when both are set', () => {
      renderCard(
        makeItem({
          actionTypes: ['silent-error'],
          silentErrorDiagnosis:
            'GitHub reported success, but the session shows a failure signature or recorded essentially no work.',
        }),
      );

      expect(screen.getByText('Silent error')).toBeTruthy();
      expect(screen.getByTestId('silent-error-diagnosis')).toHaveTextContent(
        'GitHub reported success, but the session shows a failure signature or recorded essentially no work.',
      );
    });

    it('renders no diagnosis line when the item has none', () => {
      renderCard(makeItem({ actionTypes: [] }));

      expect(screen.queryByTestId('silent-error-diagnosis')).toBeNull();
    });
  });

  describe('last-comment preview', () => {
    it('renders the comment body through the markdown renderer (#171)', () => {
      renderCard(
        makeItem({
          lastCommentBody: '**bold** and a [link](https://example.com)',
          lastCommentUrl: 'https://github.com/o/r/issues/1#issuecomment-1',
        }),
      );

      expect(screen.getByTestId('markdown-stub').textContent).toBe(
        '**bold** and a [link](https://example.com)',
      );
    });

    it('renders nothing when the item has no last comment', () => {
      renderCard(makeItem());

      expect(screen.queryByTestId('markdown-stub')).toBeNull();
    });
  });
});
