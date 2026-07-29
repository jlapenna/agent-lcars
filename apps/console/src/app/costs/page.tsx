import { Box, Card, Container, Text } from '@mantine/core';
import { cache, Suspense } from 'react';

import { assertAdmin } from '@/lib/auth-guards';

import { auth } from '../../auth';
import {
  describeArchiveWindow,
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

// Request-scoped memoization, same reasoning as /sessions': `CostsCount` and
// `CostsBody` each await from their own Suspense boundary, and this keeps
// that one Firestore read from being paid twice per page load.
const getArchive = cache(getSessionArchive);

interface PageProps {
  searchParams: Promise<{
    days?: string;
    source?: string;
    issue?: string;
  }>;
}

/** The subtitle's session count, on its own narrow Suspense boundary so the
 * rest of the header renders without waiting on Firestore (#160's rule,
 * same as /sessions'). */
async function SessionCount({ query }: { query: SessionArchiveQuery }) {
  const { rows } = await getArchive(query);
  return (
    <>
      {rows.length} session{rows.length === 1 ? '' : 's'}
    </>
  );
}

async function CostsBody({ query }: { query: SessionArchiveQuery }) {
  const { ledger, warnings } = await getArchive(query);
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
        style={lcarsPanelStyle('gold')}
      >
        {hasLedgerData ? (
          <LedgerTables ledger={ledger} />
        ) : (
          <Text size="sm" c="dimmed" data-testid="session-ledger-empty">
            No cost data in this window.
          </Text>
        )}
      </Card>

      <ConsoleFooter
        generatedAt={generatedAt}
        refreshLabel={formatRelativeTime(generatedAt)}
      />
    </>
  );
}

/**
 * What the fleet costs, by issue and by week.
 *
 * A top-level destination rather than a section of /sessions: cost is a
 * question a maintainer arrives with ("what did this month run me"), not
 * one they stumble into while reading the session list, and #192 asked for
 * it as "a whole separate page, not embedded in sessions, even as a tab".
 * /sessions is back to being only a session list.
 *
 * Reads the same archive through the same `days`/`source`/`issue` query
 * params (`parseSessionArchiveQuery`), so `/costs?days=90` narrows this the
 * same way `/sessions?days=90` narrows that - one window, two views of it.
 */
async function CostsPageShell({ searchParams }: PageProps) {
  const session = await auth();
  assertAdmin(session, '/login');

  const query = parseSessionArchiveQuery(await searchParams);

  return (
    <Container size="xl" py="xl">
      <ConsoleHeader
        current="costs"
        archiveQuery={query}
        title="Cost Ledger"
        subtitle={
          <>
            {describeArchiveWindow(query)} ·{' '}
            <Suspense fallback="…">
              <SessionCount query={query} />
            </Suspense>
          </>
        }
      />

      <Suspense fallback={<PageLoading rows={6} header={false} />}>
        <CostsBody query={query} />
      </Suspense>
    </Container>
  );
}

// `cacheComponents` requires uncached data access to sit inside a Suspense
// boundary - see /sessions' page.tsx for the same shape and reasoning.
export default function CostsPage({ searchParams }: PageProps) {
  return (
    <Suspense fallback={<PageLoading rows={6} />}>
      <CostsPageShell searchParams={searchParams} />
    </Suspense>
  );
}
