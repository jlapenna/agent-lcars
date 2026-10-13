import { PIPELINES } from '@agent-lcars/work';
import { Anchor } from '@mantine/core';
import { Suspense } from 'react';

import { assertAdmin } from '@/lib/auth-guards';

import { auth } from '../../auth';
import { type ActionItem } from '../../lib/action-items';
import { issueUrlForRun } from '../../lib/agent-activity';
import { readAuthoritativeTaskStates } from '../../lib/authoritative-task-state';
import { deriveClaimedIdle } from '../../lib/claimed-idle';
import { getCliSessions } from '../../lib/cli-sessions';
import {
  getCachedAgentActivity,
  getCachedQueueItems,
  oldestFetchedAt,
} from '../../lib/dashboard-data';
import {
  getWatchedRepos,
  parseRepoFilterParam,
  repoDisplayName,
  repoItemKey,
  repoKey,
  type WatchedRepo,
} from '../../lib/github-client';
import {
  deriveActivityMetrics,
  deriveLogicalWork,
  taskMetaFromItems,
} from '../../lib/logical-work';
import { indexSessionsByRunId } from '../../lib/run-classification';
import { getRunnerSessionsByRunId } from '../../lib/runner-sessions';
import { filterSessionsForRepo } from '../../lib/session-repo-filter';
import type { RunItemRef } from '../agent-activity-panel';
import { BridgeDetail } from '../bridge-detail';
import { resolveBridgeDetail } from '../bridge-rows';
import { parseBridgeSelection } from '../bridge-selection';
import { ConsoleCommandUtilities } from '../console-command-utilities';
import { DataWarnings } from '../console-header';
import { repoScopedConsoleHrefs } from '../console-hrefs';
import {
  ConsoleToolbar,
  ToolbarApply,
  ToolbarSearch,
  ToolbarSelect,
  ToolbarWindow,
} from '../console-toolbar';
import { DataFreshness } from '../data-freshness';
import { formatRelativeTime } from '../format';
import { LiveDashboard } from '../live-dashboard';
import { NavPageLoading, PageLoading } from '../page-loading';
import { withConsolePageShell } from '../with-console-page-shell';
import { ActiveAgentsSection } from './active-agents-section';
import {
  AGENTS_WINDOWS,
  type AgentsViewFilters,
  matchesAgentsRun,
  matchesAgentsSession,
  matchesClaimedAgent,
  matchesFind,
  parseAgentsViewFilters,
} from './agents-view-filters';
import { AgentsWorkspace } from './agents-workspace';
import { ClaimedIdleSection } from './claimed-idle-section';
import { FleetSnapshotBar } from './fleet-snapshot-bar';
import { RecentOutcomesSection } from './recent-outcomes-section';

interface PageProps {
  searchParams: Promise<{
    repo?: string;
    sel?: string;
    agent?: string | string[];
    window?: string | string[];
    q?: string | string[];
  }>;
}

async function AgentsPageBody({
  repoFilter,
  filters,
  selectedKey,
  watchedRepos,
}: {
  repoFilter: WatchedRepo | undefined;
  filters: AgentsViewFilters;
  selectedKey?: string;
  watchedRepos: WatchedRepo[];
}) {
  const matchesFilter = (repo: { owner: string; name: string }) =>
    !repoFilter || repoKey(repo) === repoKey(repoFilter);

  const [
    {
      data: { items },
      fetchedAt: itemsFetchedAt,
    },
    { data: activity, fetchedAt: activityFetchedAt },
    { sessions: cliSessions, warnings: cliSessionWarnings },
    { sessionsByRunId: runnerSessionsByRunId, warnings: runnerSessionWarnings },
  ] = await Promise.all([
    getCachedQueueItems(),
    getCachedAgentActivity(),
    getCliSessions(),
    getRunnerSessionsByRunId(),
  ]);
  // Deduped the same way as the home page (page.tsx): parallel fetchers can
  // degrade the same way (e.g. one rate-limit hit per PR-join), and each
  // unique problem only needs saying once.
  const baseWarnings = Array.from(
    new Set([
      ...activity.warnings,
      ...cliSessionWarnings,
      ...runnerSessionWarnings,
    ]),
  );

  // run.id -> joined session doc, for every run this page renders (live and
  // recent alike) - powers Active Agents' budget gauges and Recent
  // Outcomes' classification/diagnosis (see agent-activity-panel.tsx).
  const sessionsByRunId = indexSessionsByRunId(
    [...activity.liveRuns, ...activity.recentRuns],
    runnerSessionsByRunId,
  );

  // Join only the exact GitHub identity; title equality cannot establish it.
  const liveRunByNumber = new Map(
    activity.liveRuns
      .filter((run) => !run.workId && run.issueNumber !== undefined)
      .map((run) => [repoItemKey(run.repo, run.issueNumber as number), run]),
  );
  const liveRunFor = (item: ActionItem) =>
    liveRunByNumber.get(repoItemKey(item.repo, item.number));

  const itemsByRunId: Record<string, RunItemRef> = {};
  for (const item of items) {
    const run = liveRunFor(item);
    if (run) {
      itemsByRunId[run.id] = {
        number: item.number,
        title: item.title,
        url: item.url,
      };
    }
  }

  const activeSessions = cliSessions.filter(
    (cliSession) =>
      cliSession.liveness === 'live' || cliSession.liveness === 'idle',
  );

  // Read before the repo filter below (over all `items` and every recent
  // run, not just this page's filtered view) because `deriveClaimedIdle`'s
  // `hasTaskRecord` needs it for every anchor the fleet might have claimed,
  // not only the ones the current repo filter happens to show.
  const authoritative = await readAuthoritativeTaskStates([
    ...items.map((item) => ({
      repository: item.repo,
      issueNumber: item.number,
    })),
    ...activity.recentRuns.flatMap((run) =>
      run.issueNumber === undefined
        ? []
        : [{ repository: run.repo, issueNumber: run.issueNumber }],
    ),
  ]);
  const warnings = Array.from(
    new Set([...baseWarnings, ...authoritative.warnings]),
  );

  const claimedIdle = deriveClaimedIdle(
    items,
    (item) => Boolean(liveRunFor(item)),
    activeSessions,
    (item) => authoritative.states.has(repoItemKey(item.repo, item.number)),
  );

  // Applied last, after every cross-repo join above already ran against the
  // full, unfiltered data - see page.tsx's identical comment for why.
  // The toolbar's agent, window and find narrow the same views after it.
  const now = Date.now();
  const filteredItems = items.filter((item) => matchesFilter(item.repo));
  const filteredActiveSessions = filterSessionsForRepo(
    activeSessions,
    repoFilter,
  ).filter((session) => matchesAgentsSession(session, filters));
  const filteredCliSessions = filterSessionsForRepo(cliSessions, repoFilter);
  const filteredActivity = {
    ...activity,
    liveRuns: activity.liveRuns.filter(
      (run) =>
        matchesFilter(run.repo) &&
        matchesAgentsRun(run, filters, { finished: false, now }),
    ),
    recentRuns: activity.recentRuns.filter(
      (run) =>
        matchesFilter(run.repo) &&
        matchesAgentsRun(run, filters, { finished: true, now }),
    ),
  };
  const filteredClaimedIdle = claimedIdle.filter(
    (item) =>
      matchesFilter(item.repo) &&
      matchesClaimedAgent(
        item,
        authoritative.states.get(repoItemKey(item.repo, item.number))?.spec
          .pipeline,
        filters.agent,
      ) &&
      matchesFind(
        [item.title, `${repoKey(item.repo)}#${item.number}`],
        filters.q,
      ),
  );

  // Logical tasks, authoritative Run occupancy, and physical runner capacity
  // are deliberately distinct measures. GitHub contributes title/URL metadata
  // only; lifecycle is projected from the control-plane records above.
  const logicalWorkItems = filteredItems.map((item) => ({
    ...item,
    humanNeeded: item.actionTypes.includes('needs-human'),
  }));
  const taskMeta = taskMetaFromItems(logicalWorkItems);
  // Closed anchors are absent from the open-item board. Seed their metadata
  // from the exact recent run so it is not rendered as an anonymous task.
  for (const run of filteredActivity.recentRuns) {
    if (run.issueNumber === undefined) continue;
    const key = repoItemKey(run.repo, run.issueNumber);
    if (!taskMeta.has(key)) {
      taskMeta.set(key, {
        repo: run.repo,
        issueNumber: run.issueNumber,
        title: run.displayTitle,
        url: issueUrlForRun(run) ?? run.url,
      });
    }
  }
  const allRuns = [
    ...filteredActivity.liveRuns,
    ...filteredActivity.recentRuns,
  ];
  const { work: logicalWork, unattributedRuns } = deriveLogicalWork({
    runs: allRuns,
    unavailableTaskKeys: authoritative.unavailableTaskKeys,
    taskMeta,
  });
  const activityMetrics = deriveActivityMetrics(
    logicalWork,
    [...logicalWork.flatMap((task) => task.runs), ...unattributedRuns],
    filteredActivity.fleet,
  );

  // Reuse the run inspector against every run this page actually renders,
  // including recent outcomes beyond the Bridge's five-row summary.
  const detail = resolveBridgeDetail({
    selectedKey,
    liveRuns: filteredActivity.liveRuns,
    recentRuns: filteredActivity.recentRuns,
    cliSessions: [],
    waitingOnDeploy: [],
    itemsByRunId,
    sessionsByRunId,
  });

  return (
    <AgentsWorkspace
      toolbar={
        <ConsoleToolbar action="/agents" preserve={{ sel: selectedKey }}>
          <ToolbarSelect
            name="repo"
            label="Repository"
            value={repoFilter ? repoKey(repoFilter) : ''}
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
            value={filters.agent ?? ''}
            options={[
              { value: '', label: 'All agents' },
              ...PIPELINES.map((pipeline) => ({
                value: pipeline,
                label: pipeline,
              })),
            ]}
          />
          <ToolbarWindow
            name="window"
            label="Window"
            value={filters.window ?? ''}
            options={[
              ...AGENTS_WINDOWS.map((window) => ({
                value: window,
                label: window,
              })),
              { value: '', label: 'all' },
            ]}
          />
          <ToolbarSearch
            name="q"
            label="Find"
            placeholder="issue, PR, run id"
            value={filters.q}
          />
          {/* Selects and the window submit on change; Apply shows only
              until they hydrate, then keeps its box. */}
          <ToolbarApply label="Apply" />
        </ConsoleToolbar>
      }
      warnings={
        warnings.length > 0 ? <DataWarnings warnings={warnings} /> : undefined
      }
      fleet={
        <>
          <DataFreshness
            fetchedAt={oldestFetchedAt(itemsFetchedAt, activityFetchedAt)}
            initialLabel={formatRelativeTime(
              oldestFetchedAt(itemsFetchedAt, activityFetchedAt),
            )}
          />
          <FleetSnapshotBar
            activity={filteredActivity}
            activeCliSessionCount={filteredActiveSessions.length}
            metrics={activityMetrics}
          />
        </>
      }
      active={
        <>
          {selectedKey && (
            <BridgeDetail
              detail={detail}
              backHref={
                repoScopedConsoleHrefs(
                  repoFilter ? repoKey(repoFilter) : undefined,
                )?.agents ?? '/agents'
              }
              repoFilterKey={repoFilter ? repoKey(repoFilter) : undefined}
            />
          )}
          <ActiveAgentsSection
            liveRuns={filteredActivity.liveRuns}
            itemsByRunId={itemsByRunId}
            activeSessions={filteredActiveSessions}
            items={filteredItems}
            sessionsByRunId={sessionsByRunId}
          />
        </>
      }
      hasSecondary={
        filteredClaimedIdle.length > 0 || filteredActivity.recentRuns.length > 0
      }
      claimedIdle={
        filteredClaimedIdle.length > 0 ? (
          <ClaimedIdleSection
            items={filteredClaimedIdle}
            cliSessions={filteredCliSessions}
            authoritativeStates={authoritative.states}
            unavailableTaskKeys={authoritative.unavailableTaskKeys}
          />
        ) : null
      }
      recentOutcomes={
        filteredActivity.recentRuns.length > 0 ? (
          <RecentOutcomesSection
            recentRuns={filteredActivity.recentRuns}
            sessionsByRunId={sessionsByRunId}
          />
        ) : null
      }
    />
  );
}

/**
 * Auth-gate, title/subtitle, and nav render eagerly here - none of it needs
 * the slow GitHub/Firestore reads `AgentsPageBody` fetches, so this shell
 * only has to wait on `auth()` and `searchParams` (both fast, no network),
 * not the ~30-request fleet activity fetch. That keeps the header off the
 * streamed placeholder `AgentsPageBody`'s own Suspense boundary shows while
 * its data resolves - see #160.
 */
interface AgentsViewProps {
  watchedRepos: ReturnType<typeof getWatchedRepos>;
  repoFilter: ReturnType<typeof parseRepoFilterParam>;
  filters: AgentsViewFilters;
  subtitle: string;
  selectedKey?: string;
}

function AgentsViewContent({
  repoFilter,
  filters,
  watchedRepos,
  selectedKey,
}: AgentsViewProps) {
  return (
    <>
      <LiveDashboard />
      <Suspense fallback={<PageLoading rows={5} header={false} />}>
        <AgentsPageBody
          repoFilter={repoFilter}
          filters={filters}
          selectedKey={selectedKey}
          watchedRepos={watchedRepos}
        />
      </Suspense>
    </>
  );
}

const AgentsView = withConsolePageShell(
  AgentsViewContent,
  ({ watchedRepos, repoFilter, subtitle }) => {
    const repoFilterKey = repoFilter ? repoKey(repoFilter) : undefined;
    return {
      className: 'agents-page-shell',
      current: 'agents',
      title: 'Agents',
      repoFilter: repoFilterKey,
      subtitle: (
        <>
          Active runs, claimed work and recent outcomes · {subtitle}
          {repoFilter && (
            <>
              {' · '}
              <Anchor href="/agents" size="sm">
                show all repos
              </Anchor>
            </>
          )}
        </>
      ),
      utilities: (
        <>
          <div className="agents-utilities agents-utilities--desktop console-utilities--desktop">
            <ConsoleCommandUtilities
              watchedRepos={watchedRepos}
              initialRepoKey={repoFilterKey}
              refreshesAuthoritativeQueue
            />
          </div>
          <div className="agents-utilities agents-utilities--mobile console-utilities--mobile">
            <ConsoleCommandUtilities
              watchedRepos={watchedRepos}
              initialRepoKey={repoFilterKey}
              refreshesAuthoritativeQueue
              includeNavigation
              navigationHrefs={repoScopedConsoleHrefs(repoFilterKey)}
            />
          </div>
        </>
      ),
    };
  },
);

async function AgentsPageShell({ searchParams }: PageProps) {
  const session = await auth();
  assertAdmin(session, '/login');

  const watchedRepos = getWatchedRepos();
  const params = await searchParams;
  const repoFilter = parseRepoFilterParam(params.repo);
  const selectedKey = parseBridgeSelection(params.sel);
  const filters = parseAgentsViewFilters(params);

  const subtitle =
    watchedRepos.length <= 1
      ? repoDisplayName(watchedRepos[0])
      : repoFilter
        ? repoDisplayName(repoFilter)
        : `${watchedRepos.length} repos`;

  return (
    <AgentsView
      watchedRepos={watchedRepos}
      repoFilter={repoFilter}
      filters={filters}
      subtitle={subtitle}
      selectedKey={selectedKey}
    />
  );
}

// `cacheComponents` requires uncached data access to sit inside a Suspense
// boundary, so `AgentsPageShell` (auth() + searchParams, both fast) streams
// in behind a 5-row placeholder rather than blocking on those; its own
// nested Suspense around `AgentsPageBody` covers the slow GitHub/Firestore
// reads separately, so the header never waits on those (see #160).
export default function AgentsPage({ searchParams }: PageProps) {
  return (
    <Suspense
      fallback={
        <NavPageLoading
          current="agents"
          title="Agents"
          className="agents-page-shell"
          rows={5}
        />
      }
    >
      <AgentsPageShell searchParams={searchParams} />
    </Suspense>
  );
}
