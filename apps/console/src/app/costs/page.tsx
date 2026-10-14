import { SESSION_AGENTS } from '@agent-lcars/telemetry';
import { Button, Text } from '@mantine/core';
import { cache, Suspense } from 'react';

import { assertAdmin } from '@/lib/auth-guards';

import { auth } from '../../auth';
import { getWatchedRepos, repoKey } from '../../lib/github-client';
import {
  archiveDaysParam,
  DEFAULT_ARCHIVE_DAYS,
  describeArchiveWindow,
  getSessionArchive,
  parseSessionArchiveQuery,
  type SessionArchiveQuery,
} from '../../lib/session-archive';
import { parseCostBudget } from '../../lib/session-spend';
import { windowOptions } from '../archive-window-options';
import { ConsoleCommandUtilities } from '../console-command-utilities';
import { DataWarnings } from '../console-header';
import { ConsoleReadouts } from '../console-readouts';
import {
  ConsoleToolbar,
  ToolbarApply,
  ToolbarSearch,
  ToolbarSelect,
  ToolbarWindow,
} from '../console-toolbar';
import { loadFleetReadouts } from '../fleet-readouts';
import { NavPageLoading, PageLoading } from '../page-loading';
import { parseViewFilters } from '../sessions/session-view-filters';
import { withConsolePageShell } from '../with-console-page-shell';
import { CostsWorkspace } from './costs-workspace';
import { LedgerTables } from './ledger-tables';
import { SpendBreakdowns } from './spend-breakdowns';
import { SpendByRepository } from './spend-by-repository';

// Request-scoped memoization, same reasoning as /sessions': `CostsCount` and
// `CostsBody` each await from their own Suspense boundary, and this keeps
// that one Firestore read from being paid twice per page load.
const getArchive = cache((query: SessionArchiveQuery) =>
  getSessionArchive(query, { includeSpend: true }),
);

interface PageProps {
  searchParams: Promise<{
    days?: string;
    source?: string;
    issue?: string;
    repo?: string;
    agent?: string;
    q?: string;
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

function CostsToolbar({
  query,
  watchedRepos,
}: {
  query: SessionArchiveQuery;
  watchedRepos: ReturnType<typeof getWatchedRepos>;
}) {
  return (
    <ConsoleToolbar
      action="/costs"
      preserve={{
        issue:
          query.issueNumber === undefined
            ? undefined
            : String(query.issueNumber),
      }}
      primary={
        <Button
          component="a"
          href={archiveHref(query, '/costs/export')}
          download
          size="sm"
        >
          Export ledger
        </Button>
      }
    >
      <ToolbarSelect
        name="repo"
        label="Repository"
        value={query.repo ? repoKey(query.repo) : ''}
        options={[
          { value: '', label: `All repositories (${watchedRepos.length})` },
          ...watchedRepos.map((repo) => ({
            value: repoKey(repo),
            label: repoKey(repo),
          })),
        ]}
      />
      <ToolbarSelect
        name="agent"
        label="Agent"
        value={query.agent ?? ''}
        options={[
          { value: '', label: 'All agents' },
          ...SESSION_AGENTS.map((agent) => ({ value: agent, label: agent })),
        ]}
      />
      <ToolbarWindow
        name="days"
        label="Window"
        value={archiveDaysParam(query.days)}
        options={windowOptions(query.days)}
      />
      <ToolbarSearch
        name="q"
        label="Find"
        placeholder="issue, PR, session id"
        value={query.q}
      />
      <ToolbarSelect
        name="source"
        label="Source"
        value={query.source ?? ''}
        options={[
          { value: '', label: 'All sources' },
          { value: 'cli', label: 'CLI' },
          { value: 'issue-agent', label: 'Dispatched agent' },
        ]}
      />
      {/* Selects and the window submit on change; Apply shows only until
          they hydrate (the mockup's toolbar has none). */}
      <ToolbarApply label="Apply" />
    </ConsoleToolbar>
  );
}

async function CostsBody({
  query,
  watchedRepos,
}: {
  query: SessionArchiveQuery;
  watchedRepos: ReturnType<typeof getWatchedRepos>;
}) {
  const [{ ledger, warnings, spend, spendByRepository }, readouts] =
    await Promise.all([
      getArchive(query),
      loadFleetReadouts(query.repo ? repoKey(query.repo) : undefined),
    ]);
  const hasLedgerData = ledger.byIssue.length > 0 || ledger.byWeek.length > 0;
  const budget = parseCostBudget(
    process.env['AGENT_LCARS_COST_BUDGET_USD'],
    process.env['AGENT_LCARS_COST_WARNING_PERCENT'],
  );

  return (
    <CostsWorkspace
      warnings={
        warnings.length > 0 ? <DataWarnings warnings={warnings} /> : undefined
      }
      toolbar={<CostsToolbar query={query} watchedRepos={watchedRepos} />}
    >
      <ConsoleReadouts label="Fleet readouts" readouts={readouts} />
      {spendByRepository && <SpendByRepository spend={spendByRepository} />}
      {spend && <SpendBreakdowns spend={spend} budget={budget} />}
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
    params.set('days', archiveDaysParam(query.days));
  }
  if (query.source) params.set('source', query.source);
  if (query.issueNumber !== undefined) {
    params.set('issue', String(query.issueNumber));
  }
  if (query.repo) params.set('repo', repoKey(query.repo));
  if (query.agent) params.set('agent', query.agent);
  if (query.q) params.set('q', query.q);
  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
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
interface CostsViewProps {
  query: SessionArchiveQuery;
  watchedRepos: ReturnType<typeof getWatchedRepos>;
  mobileNavigationHrefs: { sessions: string; costs: string };
}

function CostsViewContent({ query, watchedRepos }: CostsViewProps) {
  return (
    <Suspense fallback={<PageLoading rows={6} header={false} />}>
      <CostsBody query={query} watchedRepos={watchedRepos} />
    </Suspense>
  );
}

const CostsPageView = withConsolePageShell(
  CostsViewContent,
  ({ query, watchedRepos, mobileNavigationHrefs }) => ({
    className: 'costs-page-shell',
    current: 'costs',
    archiveQuery: query,
    title: 'Costs',
    subtitle: (
      <>
        Cost ledger · {describeArchiveWindow(query)} ·{' '}
        <Suspense fallback="…">
          <SessionCount query={query} />
        </Suspense>
      </>
    ),
    utilities: (
      <>
        <div className="costs-utilities costs-utilities--desktop console-utilities--desktop">
          <ConsoleCommandUtilities watchedRepos={watchedRepos} />
        </div>
        <div className="costs-utilities costs-utilities--mobile console-utilities--mobile">
          <ConsoleCommandUtilities
            watchedRepos={watchedRepos}
            includeNavigation
            navigationHrefs={mobileNavigationHrefs}
          />
        </div>
      </>
    ),
  }),
);

async function CostsPageShell({ searchParams }: PageProps) {
  const session = await auth();
  assertAdmin(session, '/login');

  const params = await searchParams;
  // FIND narrows the sessions the ledger sums, as it narrows /sessions' rows.
  const { q } = parseViewFilters(params);
  const query = { ...parseSessionArchiveQuery(params), ...(q && { q }) };
  const watchedRepos = getWatchedRepos();
  const mobileNavigationHrefs = {
    sessions: archiveHref(query, '/sessions'),
    costs: archiveHref(query, '/costs'),
  };

  return (
    <CostsPageView
      query={query}
      watchedRepos={watchedRepos}
      mobileNavigationHrefs={mobileNavigationHrefs}
    />
  );
}

// `cacheComponents` requires uncached data access to sit inside a Suspense
// boundary - see /sessions' page.tsx for the same shape and reasoning.
export default function CostsPage({ searchParams }: PageProps) {
  return (
    <Suspense
      fallback={
        <NavPageLoading
          current="costs"
          title="Costs"
          className="costs-page-shell"
          rows={6}
        />
      }
    >
      <CostsPageShell searchParams={searchParams} />
    </Suspense>
  );
}
