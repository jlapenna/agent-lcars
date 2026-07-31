import { Container, Group, Text } from '@mantine/core';
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
import { ConsoleHeader, DataWarnings } from '../console-header';
import { PageLoading } from '../page-loading';
import { QueueUtilityMenu } from '../queue-utility-menu';
import { QuickTaskButton } from '../quick-task-button';
import { RefreshButton } from '../refresh-button';
import { SignOutButton } from '../sign-out-button';
import { CostsWorkspace } from './costs-workspace';
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
  const hasLedgerData = ledger.byIssue.length > 0 || ledger.byWeek.length > 0;

  return (
    <CostsWorkspace
      warnings={
        warnings.length > 0 ? <DataWarnings warnings={warnings} /> : undefined
      }
    >
      {hasLedgerData ? (
        <LedgerTables ledger={ledger} />
      ) : (
        <Text
          size="sm"
          c="dimmed"
          data-testid="session-ledger-empty"
          className="costs-workspace__empty"
        >
          No cost data in this window.
        </Text>
      )}
    </CostsWorkspace>
  );
}

function archiveHref(query: SessionArchiveQuery, path: string): string {
  const params = new URLSearchParams();
  if (query.days !== DEFAULT_ARCHIVE_DAYS) {
    params.set('days', String(query.days));
  }
  if (query.source) params.set('source', query.source);
  if (query.issueNumber !== undefined) {
    params.set('issue', String(query.issueNumber));
  }
  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
}

function CostsUtilities({
  watchedRepos,
  includeNavigation = false,
  navigationHrefs,
}: {
  watchedRepos: ReturnType<typeof getWatchedRepos>;
  includeNavigation?: boolean;
  navigationHrefs?: {
    sessions: string;
    costs: string;
  };
}) {
  return (
    <Group gap={4} wrap="nowrap">
      <QuickTaskButton watchedRepos={watchedRepos} size="compact-xs" />
      <RefreshButton compact />
      <QueueUtilityMenu
        includeNavigation={includeNavigation}
        navigationHrefs={navigationHrefs}
        signOutControl={<SignOutButton />}
      />
    </Group>
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
  const watchedRepos = getWatchedRepos();
  const mobileNavigationHrefs = {
    sessions: archiveHref(query, '/sessions'),
    costs: archiveHref(query, '/costs'),
  };

  return (
    <Container size="xl" py="xl" className="costs-page-shell">
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
        utilities={
          <>
            <div className="costs-utilities costs-utilities--desktop">
              <CostsUtilities watchedRepos={watchedRepos} />
            </div>
            <div className="costs-utilities costs-utilities--mobile">
              <CostsUtilities
                watchedRepos={watchedRepos}
                includeNavigation
                navigationHrefs={mobileNavigationHrefs}
              />
            </div>
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
