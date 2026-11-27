import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { RepoScopeBadge } from './repo-scope-badge';

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    prefetch,
    ...props
  }: {
    children: ReactNode;
    href: string;
    prefetch?: boolean | 'auto' | null;
  }) => (
    <a href={href} data-prefetch={String(prefetch)} {...props}>
      {children}
    </a>
  ),
}));

let mockPathname = '/';
let mockSearch = '';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

function renderBadge() {
  return render(
    <MantineProvider>
      <RepoScopeBadge repoKey="org-b/repo-b" display="repo-b" />
    </MantineProvider>,
  );
}

describe('RepoScopeBadge', () => {
  it('links the badge to the current page scoped to its repo', () => {
    mockPathname = '/inbox';
    mockSearch = '';
    renderBadge();

    const badge = screen.getByTestId('repo-badge');
    expect(badge).toHaveAttribute('href', '/inbox?repo=org-b%2Frepo-b');
    expect(badge).toHaveAttribute('data-prefetch', 'false');
    expect(badge).not.toHaveAttribute('data-active');
  });

  it('keeps long repository labels compact without losing the full name', () => {
    renderBadge();

    const badge = screen.getByTestId('repo-badge');
    expect(badge).toHaveStyle({ maxWidth: '112px' });
    expect(badge).toHaveAttribute('title', 'Show only repo-b');

    const label = badge.querySelector('.mantine-Badge-label');
    expect(label).toHaveStyle({
      minWidth: '0',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    });
  });

  it('drops a selected item when scoping, so a foreign selection cannot ride along', () => {
    mockPathname = '/inbox';
    mockSearch = 'item=org-a%2Frepo-a%237&sort=newest';
    renderBadge();

    const href = screen.getByTestId('repo-badge').getAttribute('href') ?? '';
    expect(href).not.toContain('item=');
    expect(href).toContain('sort=newest');
    expect(href).toContain('repo=org-b%2Frepo-b');
  });

  it('renders filled-active when its repo is the current scope, and clears on click', () => {
    mockPathname = '/';
    mockSearch = 'repo=org-b%2Frepo-b';
    renderBadge();

    const badge = screen.getByTestId('repo-badge');
    expect(badge).toHaveAttribute('data-active');
    expect(badge).toHaveAttribute('href', '/');
  });
});
