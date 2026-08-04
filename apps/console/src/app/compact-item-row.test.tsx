import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, type Mock, vi } from 'vitest';

import type { ActionItem } from '../lib/action-items';
import { getWatchedRepos } from '../lib/github-client';
import { CompactItemRow } from './compact-item-row';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('../lib/github-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/github-client')>();
  return { ...actual, getWatchedRepos: vi.fn(actual.getWatchedRepos) };
});

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

describe('CompactItemRow repo badge', () => {
  // Closes the loop on the "quiet unless informative" design goal: every
  // unit test elsewhere asserts the badge stays hidden at the real default
  // (one watched repo, per RepoBadge's own doc comment) - this is the one
  // place that proves it actually renders once a second repo exists.
  it('shows nothing when only one repo is watched (default)', () => {
    render(
      <MantineProvider>
        <CompactItemRow item={makeItem()} hint="updated now" />
      </MantineProvider>,
    );
    expect(screen.queryByTestId('repo-badge')).toBeNull();
  });

  it('shows the repo badge once more than one repo is watched', () => {
    (getWatchedRepos as Mock).mockReturnValueOnce([
      { owner: 'org-a', name: 'repo-a' },
      { owner: 'org-b', name: 'repo-b' },
    ]);
    render(
      <MantineProvider>
        <CompactItemRow
          item={makeItem({ repo: { owner: 'org-b', name: 'repo-b' } })}
          hint="updated now"
        />
      </MantineProvider>,
    );
    const badge = screen.getByTestId('repo-badge');
    expect(badge.textContent).toBe('org-b/repo-b');
  });

  it('shows the configured alias instead of owner/name', () => {
    (getWatchedRepos as Mock).mockReturnValueOnce([
      { owner: 'org-a', name: 'repo-a' },
      { owner: 'org-b', name: 'repo-b', alias: 'Repo B' },
    ]);
    render(
      <MantineProvider>
        <CompactItemRow
          item={makeItem({ repo: { owner: 'org-b', name: 'repo-b' } })}
          hint="updated now"
        />
      </MantineProvider>,
    );
    const badge = screen.getByTestId('repo-badge');
    expect(badge.textContent).toBe('Repo B');
  });
});

describe('CompactItemRow second line (#169)', () => {
  it('always renders a second line, even with no author or labels', () => {
    render(
      <MantineProvider>
        <CompactItemRow item={makeItem()} hint="updated now" />
      </MantineProvider>,
    );
    expect(screen.getByTestId('compact-item-1')).toHaveTextContent(
      '#1 Fix the thing',
    );
    expect(screen.getByText('updated now')).toBeTruthy();
  });

  it('folds the author and labels into the second line when present', () => {
    render(
      <MantineProvider>
        <CompactItemRow
          item={makeItem({
            author: 'octocat',
            labels: ['agent:claude', 'bug'],
          })}
          hint="updated now"
        />
      </MantineProvider>,
    );
    expect(
      screen.getByText('updated now · by octocat · agent:claude, bug'),
    ).toBeTruthy();
  });
});
