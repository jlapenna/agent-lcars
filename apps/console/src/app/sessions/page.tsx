import { Box, Card, Container } from '@mantine/core';
import { cache, Suspense } from 'react';

import { assertAdmin } from '@/lib/auth-guards';

import { auth } from '../../auth';
import {
  getSessionArchive,
  parseSessionArchiveQuery,
  type SessionArchiveQuery,
} from '../../lib/session-archive';
import { ConsoleFooter } from '../console-footer';
import { ConsoleHeader, DataWarnings } from '../console-header';
import { formatRelativeTime } from '../format';
import { lcarsPanelStyle } from '../lcars';
import { PageLoading } from '../page-loading';
import { LedgerTables } from './ledger-tables';
import { SessionTable } from './session-table';

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

async function SessionsBody({ query }: { query: SessionArchiveQuery }) {
  const { rows, ledger, warnings } = await getArchive(query);
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
        <LedgerTables ledger={ledger} />

        <SessionTable rows={rows} />
      </Card>

      <ConsoleFooter
        generatedAt={generatedAt}
        refreshLabel={formatRelativeTime(generatedAt)}
      />
    </>
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
      />

      <Suspense fallback={<PageLoading rows={6} header={false} />}>
        <SessionsBody query={query} />
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
