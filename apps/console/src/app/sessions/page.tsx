import { Anchor, Box, Card, Container, Group, Text } from '@mantine/core';
import { cache, Suspense } from 'react';

import { assertAdmin } from '@/lib/auth-guards';

import { auth } from '../../auth';
import { getWatchedRepos } from '../../lib/github-client';
import {
  DEFAULT_ARCHIVE_DAYS,
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
import { LedgerTables } from './ledger-tables';
import { SessionTable } from './session-table';

type SessionsView = 'flat' | 'by-issue';
type SessionsTab = 'sessions' | 'costs';

function parseView(searchParams: { view?: string }): SessionsView {
  return searchParams.view === 'by-issue' ? 'by-issue' : 'flat';
}

function parseTab(searchParams: { tab?: string }): SessionsTab {
  return searchParams.tab === 'costs' ? 'costs' : 'sessions';
}

/** Preserves the page's other query params while toggling `view` and/or
 * `tab` - kept next to parseView/parseTab rather than in session-archive.ts,
 * since both are purely display choices and never reach getSessionArchive's
 * Firestore query (unlike days/source/issue). */
function displayHref(
  query: SessionArchiveQuery,
  { view, tab }: { view: SessionsView; tab: SessionsTab },
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
  if (tab === 'costs') params.set('tab', 'costs');
  const qs = params.toString();
  return qs ? `?${qs}` : '?';
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

function describeWindow(query: {
  days: number;
  source?: string;
  issueNumber?: number;
}): string {
  const parts = [`last ${query.days} day${query.days === 1 ? '' : 's'}`];
  if (query.source) parts.push(`source=${query.source}`);
  if (query.issueNumber !== undefined)
    parts.push(`issue #${query.issueNumber}`);
  return parts.join(', ');
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
  tab,
}: {
  query: SessionArchiveQuery;
  view: SessionsView;
  tab: SessionsTab;
}) {
  const { rows, ledger, warnings } = await getArchive(query);
  const generatedAt = new Date().toISOString();
  const hasLedgerData = ledger.byIssue.length > 0 || ledger.byWeek.length > 0;

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
        {tab === 'costs' ? (
          hasLedgerData ? (
            <LedgerTables ledger={ledger} />
          ) : (
            <Text size="sm" c="dimmed" data-testid="session-ledger-empty">
              No cost data in this window.
            </Text>
          )
        ) : (
          <>
            <Group justify="flex-end" mb="sm">
              <ViewToggle query={query} view={view} tab={tab} />
            </Group>
            {view === 'by-issue' ? (
              <IssueGroupedSessions groups={groupSessionsByIssue(rows)} />
            ) : (
              <SessionTable rows={rows} />
            )}
          </>
        )}
      </Card>

      <ConsoleFooter
        generatedAt={generatedAt}
        refreshLabel={formatRelativeTime(generatedAt)}
      />
    </>
  );
}

/** The Sessions/Costs tab switch rendered in the header's `actions` slot - a
 * display choice, not a data filter, so it lives beside the title rather
 * than among the days/source/issue query params (#2694/#3019's "no filter
 * chrome" rule is about narrowing the fetched set, not this). Splits the
 * cost ledger (#186) out from the session list rather than stacking both in
 * the same card. */
function TabToggle({
  query,
  view,
  tab,
}: {
  query: SessionArchiveQuery;
  view: SessionsView;
  tab: SessionsTab;
}) {
  return (
    <Group gap={6} wrap="nowrap">
      {(['sessions', 'costs'] as const).map((candidate, i) => (
        <Group key={candidate} gap={6} wrap="nowrap">
          {i > 0 && (
            <Text size="sm" c="dimmed">
              ·
            </Text>
          )}
          {candidate === tab ? (
            <Text size="sm" fw={600}>
              {candidate === 'sessions' ? 'Sessions' : 'Costs'}
            </Text>
          ) : (
            <Anchor
              href={displayHref(query, { view, tab: candidate })}
              size="sm"
            >
              {candidate === 'sessions' ? 'Sessions' : 'Costs'}
            </Anchor>
          )}
        </Group>
      ))}
    </Group>
  );
}

/** The flat/by-issue toggle rendered above the session table, only shown on
 * the `sessions` tab - the cost ledger (`costs` tab) has no equivalent
 * view. */
function ViewToggle({
  query,
  view,
  tab,
}: {
  query: SessionArchiveQuery;
  view: SessionsView;
  tab: SessionsTab;
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
            <Anchor
              href={displayHref(query, { view: candidate, tab })}
              size="sm"
            >
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
 * (`days`/`source`/`issue`) - deliberately no filter chrome beyond that
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
  const tab = parseTab(rawParams);
  const watchedRepos = getWatchedRepos();

  return (
    <Container size="xl" py="xl">
      <ConsoleHeader
        current="sessions"
        title="Session Archive"
        subtitle={
          <>
            {describeWindow(query)} ·{' '}
            <Suspense fallback="…">
              <SessionCount query={query} />
            </Suspense>
          </>
        }
        actions={
          <>
            <QuickTaskButton watchedRepos={watchedRepos} />
            <TabToggle query={query} view={view} tab={tab} />
          </>
        }
      />

      <Suspense fallback={<PageLoading rows={6} header={false} />}>
        <SessionsBody query={query} view={view} tab={tab} />
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
