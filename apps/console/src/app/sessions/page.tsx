import { Anchor, Group } from '@mantine/core';
import { redirect } from 'next/navigation';
import { cache, Suspense } from 'react';

import { assertAdmin } from '@/lib/auth-guards';

import { auth } from '../../auth';
import { consoleRepositoryUrl } from '../../lib/deployment';
import {
  getWatchedRepos,
  repoDisplayName,
  repoKey,
} from '../../lib/github-client';
import {
  DEFAULT_ARCHIVE_DAYS,
  describeArchiveWindow,
  getSessionArchive,
  parseSessionArchiveQuery,
  type SessionArchiveQuery,
} from '../../lib/session-archive';
import { groupSessionsByIssue } from '../../lib/session-issue-groups';
import { ConsoleHeader, DataWarnings } from '../console-header';
import { ConsolePageShell } from '../console-page-shell';
import { NavPageLoading, PageLoading } from '../page-loading';
import { QueueUtilityMenu } from '../queue-utility-menu';
import { QuickTaskButton } from '../quick-task-button';
import { RefreshButton } from '../refresh-button';
import { SignOutButton } from '../sign-out-button';
import { IssueGroupedSessions } from './issue-grouped-sessions';
import { SessionTable } from './session-table';
import { SessionsWorkspace } from './sessions-workspace';
import { ViewToggle } from './view-toggle';

type SessionsView = 'flat' | 'by-issue';

function parseView(searchParams: { view?: string }): SessionsView {
  return searchParams.view === 'by-issue' ? 'by-issue' : 'flat';
}

/** Serializes the archive query back into a query string, preserving the
 * data params while toggling `view` and/or dropping the `repo` filter (the
 * "show all repos" link) - kept next to parseView rather than in
 * session-archive.ts, since `view` and the presence of `repo` in the link
 * itself are purely display choices that never reach getSessionArchive's
 * Firestore query in this form (unlike days/source/issue/repo on `query`
 * itself). `path` is '' for a same-page link and '/costs' for the cost
 * ledger, which reads the same three data params (but not `repo` - see
 * getSessionArchive). */
function displayHref(
  query: SessionArchiveQuery,
  { view, path = '' }: { view: SessionsView; path?: string },
): string {
  const params = new URLSearchParams();
  if (query.days !== DEFAULT_ARCHIVE_DAYS) {
    params.set('days', String(query.days));
  }
  if (query.source) params.set('source', query.source);
  if (query.issueNumber !== undefined) {
    params.set('issue', String(query.issueNumber));
  }
  if (query.repo) params.set('repo', repoKey(query.repo));
  if (view === 'by-issue') params.set('view', 'by-issue');
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path || '?';
}

// Request-scoped memoization (React's `cache`, not a `cacheLife`d Next.js
// cache - getSessionArchive stays uncached so the archive is always
// current, see dashboard-data.ts's `oldestFetchedAt` doc comment) so
// `SessionCount` and `SessionsBody` below, each awaited from its own
// Suspense boundary, share the one Firestore read instead of paying it
// twice per page load.
const getArchive = cache(getSessionArchive);

interface PageProps {
  searchParams: Promise<{
    days?: string;
    source?: string;
    issue?: string;
    repo?: string;
    view?: string;
    tab?: string;
  }>;
}

/** The subtitle's row count, split out so it can stream in on its own,
 * narrower Suspense boundary while the rest of the header (title, window
 * description, nav) renders eagerly - see `SessionsPageShell` (#160). */
async function SessionCount({ query }: { query: SessionArchiveQuery }) {
  const { rows } = await getArchive(query);
  return (
    <>
      {rows.length} session{rows.length === 1 ? '' : 's'}
    </>
  );
}

async function SessionsBody({
  query,
  view,
}: {
  query: SessionArchiveQuery;
  view: SessionsView;
}) {
  const { rows, warnings } = await getArchive(query);

  return (
    <SessionsWorkspace
      warnings={
        warnings.length > 0 ? <DataWarnings warnings={warnings} /> : undefined
      }
      toolbar={
        <ViewToggle
          view={view}
          flatHref={displayHref(query, { view: 'flat' })}
          byIssueHref={displayHref(query, { view: 'by-issue' })}
        />
      }
    >
      <div data-testid="sessions-archive-content">
        {view === 'by-issue' ? (
          <IssueGroupedSessions groups={groupSessionsByIssue(rows)} />
        ) : (
          <SessionTable rows={rows} />
        )}
      </div>
    </SessionsWorkspace>
  );
}

/** The flat/by-issue toggle rendered above the session table. The cost
 * ledger has no equivalent view, and since #192 it isn't on this page at
 * all - it's the top-level /costs destination. */

function SessionsUtilities({
  watchedRepos,
  repoFilter,
  includeNavigation = false,
  navigationHrefs,
}: {
  watchedRepos: ReturnType<typeof getWatchedRepos>;
  repoFilter?: SessionArchiveQuery['repo'];
  includeNavigation?: boolean;
  navigationHrefs?: {
    sessions: string;
    costs: string;
  };
}) {
  return (
    <Group gap={4} wrap="nowrap">
      <QuickTaskButton
        watchedRepos={watchedRepos}
        initialRepoKey={repoFilter ? repoKey(repoFilter) : undefined}
        size="compact-xs"
      />
      <RefreshButton compact />
      <QueueUtilityMenu
        repositoryUrl={consoleRepositoryUrl()}
        includeNavigation={includeNavigation}
        navigationHrefs={navigationHrefs}
        signOutControl={<SignOutButton />}
      />
    </Group>
  );
}

/**
 * The session archive: every CLI and issue-agent session (not just the last
 * 24h the dashboard shows), searchable by four plain query params
 * (`days`/`source`/`issue`/`repo`) - the first three are the same the /costs
 * page reads, so the two describe one window two ways; `repo` is
 * sessions-only (see getSessionArchive) - deliberately no filter chrome
 * beyond that (#2694/#3019's "no speculative widgets" rule still applies
 * here, even though this route can otherwise be denser than the dashboard).
 * `repo` matches the dashboard/`/agents` `?repo=owner/name` convention
 * (parseRepoFilterParam) and gets the same "show all repos" escape hatch
 * those pages show once it narrows the view. Query params are parsed
 * defensively by parseSessionArchiveQuery; there's no form to validate
 * against, a maintainer edits the URL bar directly.
 *
 * Unlike the dashboard/agents pages, the subtitle can't render eagerly in
 * full - it includes the fetched row count. Only that count sits behind its
 * own inline Suspense (`SessionCount`, falling back to an ellipsis); the
 * title, window description, and nav render as soon as `auth()` +
 * `searchParams` resolve, same as those other two pages (see #160).
 */
async function SessionsPageShell({ searchParams }: PageProps) {
  const session = await auth();
  assertAdmin(session, '/login');

  const rawParams = await searchParams;
  const query = parseSessionArchiveQuery(rawParams);
  const view = parseView(rawParams);
  const watchedRepos = getWatchedRepos();
  const sharedArchiveQuery = { ...query, repo: undefined };
  const mobileNavigationHrefs = {
    sessions: displayHref(sharedArchiveQuery, {
      view: 'flat',
      path: '/sessions',
    }),
    costs: displayHref(sharedArchiveQuery, {
      view: 'flat',
      path: '/costs',
    }),
  };

  // The cost ledger lived here behind `?tab=costs` until #192 moved it to
  // its own destination. Send those links (bookmarks, and anything already
  // pasted into an issue thread) to the page that now owns them rather than
  // silently dropping them onto the session list.
  if (rawParams.tab === 'costs') {
    redirect(displayHref(query, { view, path: '/costs' }));
  }

  return (
    <ConsolePageShell className="sessions-page-shell">
      <ConsoleHeader
        current="sessions"
        archiveQuery={query}
        title="Session Archive"
        subtitle={
          <>
            {query.repo && `${repoDisplayName(query.repo)} — `}
            {describeArchiveWindow(query)} ·{' '}
            <Suspense fallback="…">
              <SessionCount query={query} />
            </Suspense>
            {query.repo && (
              <>
                {' · '}
                <Anchor
                  href={displayHref({ ...query, repo: undefined }, { view })}
                  size="sm"
                >
                  show all repos
                </Anchor>
              </>
            )}
          </>
        }
        utilities={
          <>
            <div className="sessions-utilities sessions-utilities--desktop">
              <SessionsUtilities
                watchedRepos={watchedRepos}
                repoFilter={query.repo}
              />
            </div>
            <div className="sessions-utilities sessions-utilities--mobile">
              <SessionsUtilities
                watchedRepos={watchedRepos}
                repoFilter={query.repo}
                includeNavigation
                navigationHrefs={mobileNavigationHrefs}
              />
            </div>
          </>
        }
      />

      <Suspense fallback={<PageLoading rows={6} header={false} />}>
        <SessionsBody query={query} view={view} />
      </Suspense>
    </ConsolePageShell>
  );
}

// `cacheComponents` requires uncached data access to sit inside a Suspense
// boundary, so `SessionsPageShell` (auth() + searchParams, both fast)
// streams in behind a 6-row placeholder rather than blocking on those; its
// own nested Suspense boundaries (around the row count and around the body)
// cover the Firestore read separately, so the header never waits on it (see
// #160).
export default function SessionsPage({ searchParams }: PageProps) {
  return (
    <Suspense
      fallback={
        <NavPageLoading
          current="sessions"
          title="Session Archive"
          className="sessions-page-shell"
          rows={6}
        />
      }
    >
      <SessionsPageShell searchParams={searchParams} />
    </Suspense>
  );
}
