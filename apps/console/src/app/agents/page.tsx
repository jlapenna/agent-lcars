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
  getCachedActionItems,
  getCachedAgentActivity,
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
import type { RunItemRef } from '../agent-activity-panel';
import { ConsoleCommandUtilities } from '../console-command-utilities';
import { DataWarnings } from '../console-header';
import { repoScopedConsoleHrefs } from '../console-hrefs';
import { DataFreshness } from '../data-freshness';
import { formatRelativeTime } from '../format';
import { NavPageLoading, PageLoading } from '../page-loading';
import { withConsolePageShell } from '../with-console-page-shell';
import { ActiveAgentsSection } from './active-agents-section';
import { AgentsWorkspace } from './agents-workspace';
import { ClaimedIdleSection } from './claimed-idle-section';
import { FleetSnapshotBar } from './fleet-snapshot-bar';
import { RecentOutcomesSection } from './recent-outcomes-section';

interface PageProps {
  searchParams: Promise<{ repo?: string }>;
}

async function AgentsPageBody({
  repoFilter,
}: {
  repoFilter: WatchedRepo | undefined;
}) {
  const matchesFilter = (repo: { owner: string; name: string }) =>
    !repoFilter || repoKey(repo) === repoKey(repoFilter);

  const [
    {
      data: { items, warnings: itemWarnings },
      fetchedAt: itemsFetchedAt,
    },
    { data: activity, fetchedAt: activityFetchedAt },
    { sessions: cliSessions, warnings: cliSessionWarnings },
    { sessionsByRunId: runnerSessionsByRunId, warnings: runnerSessionWarnings },
  ] = await Promise.all([
    getCachedActionItems(),
    getCachedAgentActivity(),
    getCliSessions(),
    getRunnerSessionsByRunId(),
  ]);
  // Deduped the same way as the home page (page.tsx): parallel fetchers can
  // degrade the same way (e.g. one rate-limit hit per PR-join), and each
  // unique problem only needs saying once.
  const baseWarnings = Array.from(
    new Set([
      ...itemWarnings,
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

  // Same run<->item join as the home page (see its comment for why
  // issueNumber-first with a title fallback is correct) - kept local here
  // rather than shared, since it's a small, self-contained join and this
  // page's item set (all open items) differs from home's per-bucket view.
  const liveRunByNumber = new Map(
    activity.liveRuns
      .filter((run) => run.issueNumber !== undefined)
      .map((run) => [repoItemKey(run.repo, run.issueNumber as number), run]),
  );
  const liveRunByTitle = new Map(
    activity.liveRuns
      .filter((run) => run.issueNumber === undefined)
      .map((run) => [run.displayTitle, run]),
  );
  const liveRunFor = (item: ActionItem) =>
    liveRunByNumber.get(repoItemKey(item.repo, item.number)) ??
    liveRunByTitle.get(item.title);

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

  const claimedIdle = deriveClaimedIdle(
    items,
    (item) => Boolean(liveRunFor(item)),
    activeSessions,
  );

  // Applied last, after every cross-repo join above already ran against the
  // full, unfiltered data - see page.tsx's identical comment for why.
  const filteredItems = items.filter((item) => matchesFilter(item.repo));
  // A doc with no `repo` predates Phase 0's field - session-archive.ts and
  // Repo-less CLI sessions are host-scoped and do not belong to a
  // GitHub-repository filter (matching page.tsx's identical rule).
  const filteredActiveSessions = activeSessions.filter(
    (s) => s.repo && matchesFilter(s.repo),
  );
  const filteredCliSessions = cliSessions.filter(
    (s) => s.repo && matchesFilter(s.repo),
  );
  const filteredActivity = repoFilter
    ? {
        ...activity,
        liveRuns: activity.liveRuns.filter((run) => matchesFilter(run.repo)),
        recentRuns: activity.recentRuns.filter((run) =>
          matchesFilter(run.repo),
        ),
      }
    : activity;
  const filteredClaimedIdle = claimedIdle.filter((item) =>
    matchesFilter(item.repo),
  );

  const authoritative = await readAuthoritativeTaskStates([
    ...filteredItems.map((item) => ({
      repository: item.repo,
      issueNumber: item.number,
    })),
    ...filteredActivity.recentRuns.flatMap((run) =>
      run.issueNumber === undefined
        ? []
        : [{ repository: run.repo, issueNumber: run.issueNumber }],
    ),
  ]);
  const warnings = Array.from(
    new Set([...baseWarnings, ...authoritative.warnings]),
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

  return (
    <AgentsWorkspace
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
        <ActiveAgentsSection
          liveRuns={filteredActivity.liveRuns}
          itemsByRunId={itemsByRunId}
          activeSessions={filteredActiveSessions}
          items={filteredItems}
          sessionsByRunId={sessionsByRunId}
        />
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
  subtitle: string;
}

function AgentsViewContent({ repoFilter }: AgentsViewProps) {
  return (
    <Suspense fallback={<PageLoading rows={5} header={false} />}>
      <AgentsPageBody repoFilter={repoFilter} />
    </Suspense>
  );
}

const AgentsView = withConsolePageShell(
  AgentsViewContent,
  ({ watchedRepos, repoFilter, subtitle }) => {
    const repoFilterKey = repoFilter ? repoKey(repoFilter) : undefined;
    return {
      className: 'agents-page-shell',
      current: 'agents',
      title: 'Agent Status',
      repoFilter: repoFilterKey,
      subtitle: (
        <>
          {subtitle}
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
          <div className="agents-utilities agents-utilities--desktop">
            <ConsoleCommandUtilities
              watchedRepos={watchedRepos}
              initialRepoKey={repoFilterKey}
              bustsGithubCache
            />
          </div>
          <div className="agents-utilities agents-utilities--mobile">
            <ConsoleCommandUtilities
              watchedRepos={watchedRepos}
              initialRepoKey={repoFilterKey}
              bustsGithubCache
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
  const repoFilter = parseRepoFilterParam((await searchParams).repo);

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
      subtitle={subtitle}
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
          title="Agent Status"
          className="agents-page-shell"
          rows={5}
        />
      }
    >
      <AgentsPageShell searchParams={searchParams} />
    </Suspense>
  );
}
