'use client';

import Link from 'next/link';

import { DEFAULT_ARCHIVE_DAYS } from '@/lib/archive-window';
import type { SessionArchiveQuery } from '@/lib/session-archive';

import { repoScopedConsoleHrefs } from './console-hrefs';
import {
  CONSOLE_DESTINATIONS,
  consoleDestinations,
  type NavKey,
} from './console-navigation';
import { useConsoleNavigationKeys } from './console-navigation-context';

function navHref(
  item: (typeof CONSOLE_DESTINATIONS)[number],
  archiveQuery: SessionArchiveQuery | undefined,
  repoFilter: string | undefined,
): string {
  const repoScopedHrefs = repoScopedConsoleHrefs(repoFilter);
  if (
    repoScopedHrefs &&
    (item.key === 'deck' || item.key === 'inbox' || item.key === 'agents')
  ) {
    return repoScopedHrefs[item.key];
  }

  if (!archiveQuery || (item.key !== 'sessions' && item.key !== 'costs')) {
    return item.href;
  }

  const params = new URLSearchParams();
  if (archiveQuery.days !== DEFAULT_ARCHIVE_DAYS) {
    params.set('days', String(archiveQuery.days));
  }
  if (archiveQuery.source) params.set('source', archiveQuery.source);
  if (archiveQuery.issueNumber !== undefined) {
    params.set('issue', String(archiveQuery.issueNumber));
  }
  const queryString = params.toString();
  return queryString ? `${item.href}?${queryString}` : item.href;
}

export function ConsoleNavRail({
  current,
  archiveQuery,
  repoFilter,
}: {
  /** Highlighted destination; drill-downs pass their logical parent. */
  current: NavKey;
  archiveQuery?: SessionArchiveQuery;
  repoFilter?: string;
}) {
  const allowedKeys = useConsoleNavigationKeys();
  return (
    <nav className="lcars-nav" aria-label="Console sections">
      {consoleDestinations(allowedKeys).map((item) => (
        <Link
          key={item.key}
          href={navHref(item, archiveQuery, repoFilter)}
          className="lcars-nav-pill"
          data-destination={item.key}
          data-accent={item.accent}
          data-active={item.key === current ? '' : undefined}
          aria-current={item.key === current ? 'page' : undefined}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
