import { Anchor, Box, Card, Container, Group, Text } from '@mantine/core';
import { redirect } from 'next/navigation';
import { cache, Suspense } from 'react';

import { assertAdmin } from '@/lib/auth-guards';

import { auth } from '../../auth';
import { getWatchedRepos } from '../../lib/github-client';
import {
  DEFAULT_ARCHIVE_DAYS,
  describeArchiveWindow,
  getSessionArchive,
  parseSessionArchiveQuery,
  type SessionArchiveQuery,
} from '../../lib/session-archive';
import { groupSessionsByIssue } from '../../lib/session-issue-groups';
import { ConsoleFooter } from '../console-footer';
import { ConsoleHeader, DataWarnings } from '../console-header';
import { formatRelativeTime } from '../format';
import { lcarsPanelStyle } from '../lcars';
import { PageLoading } from '../page-loading';
import { QuickTaskButton } from '../quick-task-button';
import { IssueGroupedSessions } from './issue-grouped-sessions';
import { SessionTable } from './session-table';

type SessionsView = 'flat' | 'by-issue';

function parseView(searchParams: { view?: string }): SessionsView {
  return searchParams.view === 'by-issue' ? 'by-issue' : 'flat';
}

/** Serializes the archive query back into a query string, preserving the
 * data params while toggling `view` - kept next to parseView rather than in
 * session-archive.ts, since `view` is a purely display choice that never
 * reaches getSessionArchive's Firestore query (unlike days/source/issue).
 * `path` is '' for a same-page link and '/costs' for the cost ledger, which
 * reads the same three data params. */
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
  const generatedAt = new Date().toISOString();

  return (
    <>
      {warnings.length > 0 && (
        <Box mb="xl">
          <DataWarnings warnings={warnings} />
        </Box>
      )}

      <Card
        withBorder
        radius="md"
        padding="md"
        className="lcars-panel"
        style={lcarsPanelStyle('teal')}
      >
        <Group justify="flex-end" mb="sm">
          <ViewToggle query={query} view={view} />
        </Group>
        {view === 'by-issue' ? (
          <IssueGroupedSessions groups={groupSessionsByIssue(rows)} />
        ) : (
          <SessionTable rows={rows} />
        )}
      </Card>

      <ConsoleFooter
        generatedAt={generatedAt}
        refreshLabel={formatRelativeTime(generatedAt)}
      />
    </>
  );
}

/** The flat/by-issue toggle rendered above the session table. The cost
 * ledger has no equivalent view, and since #192 it isn't on this page at
 * all - it's the top-level /costs destination. */
function ViewToggle({
  query,
  view,
}: {
  query: SessionArchiveQuery;
  view: SessionsView;
}) {
  return (
    <Group gap={6} wrap="nowrap">
      {(['flat', 'by-issue'] as const).map((candidate, i) => (
        <Group key={candidate} gap={6} wrap="nowrap">
          {i > 0 && (
            <Text size="sm" c="dimmed">
              ·
            </Text>
          )}
          {candidate === view ? (
            <Text size="sm" fw={600}>
              {candidate === 'flat' ? 'Flat' : 'By issue'}
            </Text>
          ) : (
            <Anchor href={displayHref(query, { view: candidate })} size="sm">
              {candidate === 'flat' ? 'Flat' : 'By issue'}
            </Anchor>
          )}
        </Group>
      ))}
    </Group>
  );
}

/**
 * The session archive: every CLI and issue-agent session (not just the last
 * 24h the dashboard shows), searchable by three plain query params
 * (`days`/`source`/`issue`) - the same three the /costs page reads, so the
 * two describe one window two ways - deliberately no filter chrome beyond that
 * (#2694/#3019's "no speculative widgets" rule still applies here, even
 * though this route can otherwise be denser than the dashboard). Query
 * params are parsed defensively by parseSessionArchiveQuery; there's no form
 * to validate against, a maintainer edits the URL bar directly.
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

  // The cost ledger lived here behind `?tab=costs` until #192 moved it to
  // its own destination. Send those links (bookmarks, and anything already
  // pasted into an issue thread) to the page that now owns them rather than
  // silently dropping them onto the session list.
  if (rawParams.tab === 'costs') {
    redirect(displayHref(query, { view, path: '/costs' }));
  }

  return (
    <Container size="xl" py="xl">
      <ConsoleHeader
        current="sessions"
        archiveQuery={query}
        title="Session Archive"
        subtitle={
          <>
            {describeArchiveWindow(query)} ·{' '}
            <Suspense fallback="…">
              <SessionCount query={query} />
            </Suspense>
          </>
        }
        actions={<QuickTaskButton watchedRepos={watchedRepos} />}
      />

      <Suspense fallback={<PageLoading rows={6} header={false} />}>
        <SessionsBody query={query} view={view} />
      </Suspense>
    </Container>
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
    <Suspense fallback={<PageLoading rows={6} />}>
      <SessionsPageShell searchParams={searchParams} />
    </Suspense>
  );
}
