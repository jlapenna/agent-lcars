'use client';

import { Badge } from '@mantine/core';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

/**
 * The clickable half of every repo badge: click to scope the current page
 * to that repo via `?repo=`, click again (filled state) to clear it. This
 * turns the previously URL-bar-only `?repo=` filter into something
 * discoverable - making page.tsx's "the repo badges throughout the board
 * link here" comment actually true. On drill-down pages that ignore
 * `?repo=` the link is harmless: the param rides along until the next nav
 * destination consumes it.
 */
export function RepoScopeBadge({
  repoKey,
  display,
}: {
  /** Canonical `owner/name` as lib/watched-repo's repoKey produces. */
  repoKey: string;
  display: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = searchParams.get('repo') === repoKey;

  const params = new URLSearchParams(searchParams);
  if (active) params.delete('repo');
  else params.set('repo', repoKey);
  // A selected item from another repo must not ride into the scoped view.
  params.delete('item');
  const query = params.toString();

  return (
    <Badge
      component={Link}
      href={query ? `${pathname}?${query}` : pathname}
      variant={active ? 'filled' : 'outline'}
      color="gray"
      size="xs"
      style={{ flexShrink: 0, cursor: 'pointer' }}
      data-testid="repo-badge"
      data-active={active ? '' : undefined}
      title={
        active
          ? `Showing only ${display} — click to show all repos`
          : `Show only ${display}`
      }
    >
      {display}
    </Badge>
  );
}
