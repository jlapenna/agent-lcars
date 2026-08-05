import { Anchor, Group, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';

import { DEFAULT_ARCHIVE_DAYS } from '@/lib/archive-window';
import type { SessionArchiveQuery } from '@/lib/session-archive';

import { repoScopedConsoleHrefs } from './console-hrefs';

export type NavKey = 'deck' | 'inbox' | 'agents' | 'sessions' | 'costs';
type Accent = 'amber' | 'blue' | 'periwinkle' | 'teal' | 'gold';

const NAV_ITEMS: Array<{
  key: NavKey;
  href: string;
  label: string;
  accent: Accent;
}> = [
  { key: 'deck', href: '/', label: 'Deck', accent: 'amber' },
  { key: 'inbox', href: '/inbox', label: 'Inbox', accent: 'blue' },
  { key: 'agents', href: '/agents', label: 'Agents', accent: 'periwinkle' },
  { key: 'sessions', href: '/sessions', label: 'Sessions', accent: 'teal' },
  { key: 'costs', href: '/costs', label: 'Costs', accent: 'gold' },
];

export interface ConsoleHeaderProps {
  current: NavKey;
  title: string;
  subtitle: ReactNode;
  archiveQuery?: SessionArchiveQuery;
  /** Active repository scope on Deck/Inbox; preserved between those routes. */
  repoFilter?: string;
  /** Optional route-level global actions. Keeping this a slot lets each route
   * move its reachable utilities into the command rail without forcing the
   * other routes into the first responsive-workspace slice. */
  utilities?: ReactNode;
}

function navHref(
  item: (typeof NAV_ITEMS)[number],
  archiveQuery: SessionArchiveQuery | undefined,
  repoFilter: string | undefined,
): string {
  const repoScopedHrefs = repoScopedConsoleHrefs(repoFilter);
  if (repoScopedHrefs && (item.key === 'deck' || item.key === 'inbox')) {
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

/**
 * Shared top-of-page chrome for the five console destinations (Command Deck,
 * Inbox, agents, sessions, costs): title/subtitle row and the LCARS pill nav rail
 * (the one page every page can jump from/to). The session detail page (a
 * drill-down, not a nav destination) keeps its own lighter back-link header
 * instead of this component.
 *
 * The title/subtitle row itself carries the swept-corner "elbow" accent
 * (`.lcars-header`, sized up from the same shape `.lcars-panel` uses for
 * cards - see global.css) plus a segmented signal bar in the nav rail's own
 * accent colors, so the marquee page title reads as LCARS chrome rather
 * than a plain heading sitting above the pill rail (#204).
 *
 * Title/subtitle/nav never depend on the slow GitHub/Firestore reads
 * `cacheComponents` requires a Suspense boundary for, so every page renders
 * this outside that boundary and renders `DataWarnings` itself once its data
 * resolves (see those pages' `*PageShell`/body components) - the header
 * then never sits behind the streamed content's placeholder. `sessions`'
 * subtitle needs one fetched value (the row count) that dashboard/agents
 * don't; it wraps just that value in its own inline Suspense rather than
 * passing anything data-dependent through here (see its `SessionCount`).
 *
 * The subtitle is forced to a single truncated line (#243): every page
 * builds its own subtitle text, and a subtitle that's free to wrap adds a
 * second line on whichever page's content happens to be longest that day,
 * making the header a different height depending which tab you're on. Keep
 * subtitle copy short - truncation hides the tail if a caller doesn't.
 */
export function ConsoleHeader({
  current,
  title,
  subtitle,
  archiveQuery,
  repoFilter,
  utilities,
}: ConsoleHeaderProps) {
  return (
    <Stack gap="md" mb="xl" className="console-header" data-current={current}>
      <div className="lcars-header">
        <Group justify="space-between" align="flex-start" gap="sm">
          <div>
            <Title order={1} className="lcars-header-title">
              {title}
            </Title>
            <Text c="dimmed" mt={4} truncate="end">
              {subtitle}
            </Text>
          </div>
        </Group>

        <div className="lcars-header-bar" aria-hidden="true">
          <span className="lcars-header-bar-segment" data-accent="amber" />
          <span className="lcars-header-bar-segment" data-accent="blue" />
          <span className="lcars-header-bar-segment" data-accent="periwinkle" />
          <span className="lcars-header-bar-segment" data-accent="gold" />
          <span className="lcars-header-bar-segment" data-accent="teal" />
        </div>
      </div>

      <div className="lcars-command-row">
        <ConsoleNavRail
          current={current}
          archiveQuery={archiveQuery}
          repoFilter={repoFilter}
        />
        {utilities && (
          <div className="lcars-command-utilities">{utilities}</div>
        )}
      </div>
    </Stack>
  );
}

/**
 * The five-destination pill rail on its own - ConsoleHeader composes it
 * under the title block, and the drill-down pages (session detail, task)
 * render it bare in place of what used to be a single hardcoded back
 * link, so they stop being navigation dead ends while keeping their
 * deliberately lighter no-title chrome.
 */
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
  return (
    <nav className="lcars-nav" aria-label="Console sections">
      {NAV_ITEMS.map((item) => (
        <Anchor
          key={item.key}
          href={navHref(item, archiveQuery, repoFilter)}
          underline="never"
          className="lcars-nav-pill"
          data-accent={item.accent}
          data-active={item.key === current ? '' : undefined}
          aria-current={item.key === current ? 'page' : undefined}
        >
          {item.label}
        </Anchor>
      ))}
    </nav>
  );
}

/** The data-warnings disclosure, factored out of `ConsoleHeader` so every
 * page (which all now split their header from their data-dependent body -
 * see `ConsoleHeader`'s doc comment) can render it once its data resolves,
 * directly below the nav rail. */
export function DataWarnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;

  return (
    <details data-testid="data-warnings">
      <summary style={{ cursor: 'pointer' }}>
        <Text size="sm" c="yellow" component="span">
          ⚠ {warnings.length} data warning{warnings.length === 1 ? '' : 's'} —
          some sections may be incomplete
        </Text>
      </summary>
      <Stack gap={4} mt="xs">
        {warnings.map((warning) => (
          <Text key={warning} size="xs" c="dimmed">
            {warning}
          </Text>
        ))}
      </Stack>
    </details>
  );
}
