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
  // #1183: RetriggerButton no longer takes a `pipeline` prop - the
  // orchestrator resolves the dispatch pipeline itself from the task's own
  // run history (see backend-actions.ts's retriggerIssue).
  RetriggerButton: () => <div data-testid="retrigger-button" />,
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
          variant="workspace"
        />
      </MantineProvider>,
    );

    expect(screen.getByText('Human needed')).toBeTruthy();
    expect(screen.queryByText('Run failed')).toBeNull();
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
      'Human needed',
      'Run failed',
      'Review requested',
      'Awaiting deploy',
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

  // #538: the retro (#521) found ten green-checked, auto-merge-armed PRs
  // sitting unmergeable behind unresolved review threads with nothing on
  // the card explaining why - this badge is the fix.
  it('shows the unresolved review-thread count as the merge-blocked reason', () => {
    renderCard(
      makeItem({
        kind: 'pr',
        actionTypes: ['merge-blocked'],
        mergeableState: 'blocked',
        unresolvedReviewThreadCount: 3,
      }),
    );

    expect(screen.getByText('3 unresolved review threads')).toBeTruthy();
  });

  it('omits the thread-count badge for a merge-blocked PR whose reason is a behind base', () => {
    renderCard(
      makeItem({
        kind: 'pr',
        actionTypes: ['merge-blocked'],
        mergeableState: 'behind',
      }),
      { kind: 'approve-rebase' },
    );

    expect(screen.queryByText(/unresolved review thread/)).toBeNull();
  });

  it('shows the merge-blocked reason badge in workspace mode too', () => {
    render(
      <MantineProvider>
        <ActionItemCard
          item={makeItem({
            kind: 'pr',
            actionTypes: ['merge-blocked'],
            mergeableState: 'blocked',
            unresolvedReviewThreadCount: 1,
          })}
          variant="workspace"
        />
      </MantineProvider>,
    );

    expect(screen.getByText('1 unresolved review thread')).toBeTruthy();
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

  describe('retrigger + reply pipeline routing (#3012)', () => {
    it('offers Retrigger for a claude-labeled issue', () => {
      renderCard(makeItem({ kind: 'issue', labels: ['agent:claude'] }));

      expect(screen.getByTestId('retrigger-button')).toBeTruthy();
    });

    it('offers Retrigger for an opencode-only issue', () => {
      renderCard(makeItem({ kind: 'issue', labels: ['agent:opencode'] }));

      expect(screen.getByTestId('retrigger-button')).toBeTruthy();
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
          <ActionItemCard item={makeItem()} onToggleMute={onToggleMute} />
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

  // #949: the description preview reuses the same collapsible markdown
  // component as the last-comment preview above, so it needs its own
  // independent expand/collapse affordance instead of sharing state with it.
  describe('description preview', () => {
    it('renders the issue body through the markdown renderer', () => {
      renderCard(
        makeItem({
          body: '**bold** description with a [link](https://example.com)',
        }),
      );

      expect(screen.getByTestId('markdown-stub').textContent).toBe(
        '**bold** description with a [link](https://example.com)',
      );
    });

    it('renders nothing when the item has no description', () => {
      renderCard(makeItem({ body: '' }));

      expect(screen.queryByTestId('markdown-stub')).toBeNull();
    });

    it('renders both the description and the last comment independently', () => {
      const longBody = 'D'.repeat(500);
      const longComment = 'C'.repeat(500);
      renderCard(
        makeItem({
          body: longBody,
          lastCommentBody: longComment,
          lastCommentUrl: 'https://github.com/o/r/issues/1#issuecomment-1',
        }),
      );

      const stubs = screen.getAllByTestId('markdown-stub');
      expect(stubs.map((stub) => stub.textContent)).toEqual([
        longBody,
        longComment,
      ]);

      const [showDescription, showResponse] = screen.getAllByRole('button', {
        name: /Show full/,
      });
      expect(showDescription.textContent).toContain('Show full description');
      expect(showResponse.textContent).toContain('Show full response');

      // Expanding the description must not also expand the comment - each
      // preview owns its own collapsed/expanded state.
      fireEvent.click(showDescription);
      expect(screen.getByRole('button', { name: /Show less/ })).toBeTruthy();
      expect(
        screen.getByRole('button', { name: /Show full response/ }),
      ).toBeTruthy();
    });

    // #949 review: with both previews on the card, two "View on GitHub"
    // links with the same accessible name were indistinguishable to
    // assistive tech.
    it('gives the description and comment previews distinct accessible link names', () => {
      renderCard(
        makeItem({
          body: 'Some description text',
          lastCommentBody: 'Some comment text',
          lastCommentUrl: 'https://github.com/o/r/issues/1#issuecomment-1',
        }),
      );

      expect(
        screen.getByRole('link', { name: 'View description on GitHub ↗' }),
      ).toBeTruthy();
      expect(
        screen.getByRole('link', { name: 'View comment on GitHub ↗' }),
      ).toBeTruthy();
    });

    // #949 review: the Inbox detail pane reuses one ActionItemCard instance
    // across selections instead of remounting it per item (queue-workspace.tsx
    // renders it at a stable position with no `key`), so an expanded
    // description must not leak onto the next item selected.
    it('collapses on selecting a different item, even if the previous one was expanded', () => {
      const itemA = makeItem({ number: 1, body: 'D'.repeat(500) });
      const itemB = makeItem({ number: 2, body: 'E'.repeat(500) });

      const { rerender } = render(
        <MantineProvider>
          <ActionItemCard item={itemA} variant="workspace" />
        </MantineProvider>,
      );

      fireEvent.click(
        screen.getByRole('button', { name: /Show full description/ }),
      );
      expect(screen.getByRole('button', { name: /Show less/ })).toBeTruthy();

      rerender(
        <MantineProvider>
          <ActionItemCard item={itemB} variant="workspace" />
        </MantineProvider>,
      );

      expect(
        screen.getByRole('button', { name: /Show full description/ }),
      ).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Show less/ })).toBeNull();
    });
  });
});
