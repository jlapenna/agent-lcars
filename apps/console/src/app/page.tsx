import { logger } from '@agent-lcars/logging';
import type { TaskListCursor } from '@agent-lcars/orchestrator';
import { PIPELINES } from '@agent-lcars/work';
import type { WorkSummary } from '@agent-lcars/work/derive';
import { Anchor } from '@mantine/core';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { assertAdmin } from '@/lib/auth-guards';
import { consoleLandingPath } from '@/lib/console-access';
import {
  excludeClosedGithubAnchors,
  listWorkSummaries,
} from '@/lib/work-summary';

import { auth } from '../auth';
import type { ActionItem } from '../lib/action-items';
import type { AgentRun } from '../lib/agent-activity';
import { getAutoscalerStatuses } from '../lib/autoscaler-status';
import { getCliSessions } from '../lib/cli-sessions';
import {
  getCachedAgentActivity,
  getCachedQueueItems,
  oldestFetchedAt,
} from '../lib/dashboard-data';
import {
  getWatchedRepos,
  parseRepoFilterParam,
  repoDisplayName,
  repoItemKey,
  repoKey,
  type WatchedRepo,
} from '../lib/github-client';
import { mergedLastDay, type MergedPullCount } from '../lib/merged-pulls';
import { getNativeInboxEvidence } from '../lib/native-inbox';
import { derivePrimaryAction } from '../lib/primary-action';
import { buildQueueView } from '../lib/queue-view';
import { indexSessionsByRunId } from '../lib/run-classification';
import { getRunnerSessionsByRunId } from '../lib/runner-sessions';
import {
  getSessionArchive,
  parseSessionArchiveQuery,
} from '../lib/session-archive';
import { filterSessionsForRepo } from '../lib/session-repo-filter';
import { fleetTokenRate } from '../lib/token-rate';
import { getTokenRateSnapshot } from '../lib/token-rate-data';
import { type BoardCard, BridgeSections } from './action-items-board';
import {
  FleetChip,
  isActiveCliSession,
  RECENT_OUTCOMES_LIMIT,
  type RunItemRef,
} from './agent-activity-panel';
import {
  AGENTS_WINDOWS,
  type AgentsViewFilters,
  matchesAgentsRun,
  matchesAgentsSession,
  matchesClaimedAgent,
  matchesFind,
  parseAgentsViewFilters,
} from './agents/agents-view-filters';
import { BridgeDetail } from './bridge-detail';
import { bridgeReadouts, fleetReadoutInput } from './bridge-readouts';
import { resolveBridgeDetail } from './bridge-rows';
import {
  bridgeSelectionHref,
  parseBridgeSelection,
  runKey,
  sessionKey,
} from './bridge-selection';
import { DataWarnings } from './console-header';
import { ConsoleReadouts } from './console-readouts';
import {
  ConsoleToolbar,
  ToolbarApply,
  ToolbarSearch,
  ToolbarSelect,
  ToolbarWindow,
} from './console-toolbar';
import { ConsoleWorkspace } from './console-workspace';
import { DataFreshness } from './data-freshness';
import { decisionRows } from './decision-rows';
import { DeckInboxSummary } from './deck-inbox-summary';
import { formatRelativeTime } from './format';
import { inboxCardAgent, inboxCardMetadata } from './inbox-card';
import { LiveDashboard } from './live-dashboard';
import {
  ActiveDispatchesPanel,
  CliSessionsPanel,
  DecisionInboxPanel,
  RecentCompletionsPanel,
  RunnerFleetPanel,
} from './ops-panels';
import { UNAVAILABLE } from './ops-primitives';
import { NavPageLoading, PageLoading } from './page-loading';
import { ParkedWorkPanel } from './parked-work-panel';
import { QueueConsoleUtilities } from './queue-console-utilities';
import { parseStoppedWorkCursor, stoppedWorkHref } from './stopped-work-query';
import { withConsolePageShell } from './with-console-page-shell';
import { cancelItem, redispatchItem } from './work/actions';
import { context as workContext } from './work/context';

function toCard(item: ActionItem): BoardCard {
  return {
    item,
    primaryAction: derivePrimaryAction(item),
  };
}

/**
 * Reads a bounded page of the all-anchor work summary projection from the
 * orchestrator, rather than deriving parked state from a GitHub label or
 * limiting itself to native work ids. GitHub remains a detail enrichment
 * surface; it is not the state authority for this panel. The existing Work
 * operator grant gates it before native controls can render.
 *
 * Fetched in `IndexBody`'s own `Promise.all` (rather than a separately
 * Suspense-isolated slot) so the resolved items are also available to
 * `resolveBridgeDetail` - a "Stopped work" row's `?sel=` must resolve to the
 * *same* item the list renders, matching every other Bridge row kind.
 */
async function getParkedWork(
  repo?: string,
  rawCursor?: string,
): Promise<{
  items: WorkSummary[];
  hasMoreTasks: boolean;
  nextCursor?: TaskListCursor;
  error?: string;
}> {
  try {
    const work = await workContext();
    if (!work.principal?.scopes.has('work.operator')) {
      return { items: [], hasMoreTasks: false };
    }
    const page = await listWorkSummaries(work.runtime.store, {
      limit: 200,
      cursor: parseStoppedWorkCursor(rawCursor),
    });
    const items = await excludeClosedGithubAnchors(
      work.runtime.store,
      page.items.filter(
        (item) =>
          (item.state === 'parked' || item.state === 'failed') &&
          (!repo || item.spec.target.repo === repo),
      ),
    );
    return {
      items,
      hasMoreTasks: page.nextCursor !== undefined,
      nextCursor: page.nextCursor,
    };
  } catch (error) {
    // The Bridge must never fall to error.tsx because this panel's fetch
    // failed. Keep the rest of the Bridge available and disclose the failed
    // read with a reset link rather than presenting it as an empty queue.
    logger.error('agent-lcars: parked work panel unavailable:', error);
    return {
      items: [],
      hasMoreTasks: false,
      error:
        'Could not load stopped work. Retry or reset the stopped-work page.',
    };
  }
}

/** Recent completions' head, streamed once GitHub's count arrives. */
async function MergedLastDay({
  merged,
}: {
  merged: Promise<MergedPullCount | undefined>;
}) {
  const count = await merged;
  return count === undefined
    ? `${UNAVAILABLE} merged · 24h`
    : `${count.count}${count.partial ? '+' : ''} merged · 24h`;
}

/** All outcomes on Agents, in the Bridge's repository scope and view. */
function agentsScopedHref(
  repo: string | undefined,
  view: AgentsViewFilters,
): string {
  const query = new URLSearchParams();
  if (repo) query.set('repo', repo);
  if (view.agent) query.set('agent', view.agent);
  if (view.window) query.set('window', view.window);
  if (view.q) query.set('q', view.q);
  return query.size ? `/agents?${query}` : '/agents';
}

interface PageProps {
  searchParams: Promise<{
    repo?: string;
    agent?: string;
    window?: string;
    q?: string;
    sel?: string;
    stoppedCursor?: string;
  }>;
}

async function IndexBody({
  repoFilter,
  repoFilterKey,
  view,
  watchedRepos,
  selectedKey,
  stoppedCursor,
  multiRepo,
}: {
  repoFilter: WatchedRepo | undefined;
  repoFilterKey?: string;
  /** The toolbar's agent, window and find, as on Agents. */
  view: AgentsViewFilters;
  watchedRepos: WatchedRepo[];
  selectedKey?: string;
  stoppedCursor?: string;
  multiRepo: boolean;
}) {
  const [
    {
      data: { items: rawItems },
      fetchedAt: itemsFetchedAt,
    },
    { data: activity, fetchedAt: activityFetchedAt },
    { sessions: cliSessions, warnings: cliSessionWarnings },
    { sessionsByRunId: runnerSessionsByRunId, warnings: runnerSessionWarnings },
    {
      items: parkedWorkItems,
      hasMoreTasks: hasMoreParkedTasks,
      nextCursor: stoppedNextCursor,
      error: stoppedError,
    },
    nativeInbox,
    autoscaler,
    spendArchive,
    tokenRateSnapshot,
  ] = await Promise.all([
    getCachedQueueItems(),
    getCachedAgentActivity(),
    getCliSessions(),
    getRunnerSessionsByRunId(),
    getParkedWork(repoFilterKey, stoppedCursor),
    getNativeInboxEvidence(async () => {
      const context = await workContext();
      return { store: context.runtime.store, principal: context.principal };
    }),
    getAutoscalerStatuses(),
    getSessionArchive(
      parseSessionArchiveQuery({ days: '1', repo: repoFilterKey }),
      {
        includeSpend: true,
      },
    ).catch((error: unknown) => {
      logger.error('agent-lcars: Bridge spend readout unavailable:', error);
      return undefined;
    }),
    getTokenRateSnapshot(),
  ]);
  // Not awaited with the reads above: a cold GitHub count can take its full
  // deadline, and only the Recent completions head shows it.
  const merged = mergedLastDay(repoFilterKey);
  // Deduped: independent authoritative reads can fail independently, and
  // each unique problem only needs saying once.
  const warnings = Array.from(
    new Set([
      ...activity.warnings,
      ...cliSessionWarnings,
      ...runnerSessionWarnings,
      ...nativeInbox.warnings,
    ]),
  );

  // run.id -> joined session doc, for every run this page renders (live and
  // recent alike) - powers the In Flight budget gauges and the Recent
  // Outcomes classification/diagnosis (see agent-activity-panel.tsx).
  const sessionsByRunId = indexSessionsByRunId(
    [...activity.liveRuns, ...activity.recentRuns],
    runnerSessionsByRunId,
  );

  const queueView = buildQueueView(rawItems, activity, runnerSessionsByRunId);

  // The reverse join: live runs annotated with the item they're working, so
  // the In Flight panel can link the issue instead of the raw run title.
  const itemsByRunId: Record<string, RunItemRef> = {};
  for (const item of queueView.items) {
    const run = queueView.liveRunByItemKey.get(
      repoItemKey(item.repo, item.number),
    );
    if (run) {
      itemsByRunId[run.id] = {
        number: item.number,
        title: item.title,
        url: item.url,
      };
    }
  }

  // Applied last, after every cross-repo join above (itemsByRunId,
  // liveRunFor, silent-error diagnoses) already ran against the full,
  // unfiltered data - a repo filter should narrow what's *displayed*, never
  // which items can see each other's runs/sessions. The repository selector
  // and scoped navigation share this same `?repo=` state.
  // The toolbar's agent, window and find narrow the same rows after it, as
  // on Agents; find also narrows the item lists by title and reference.
  const matchesFilter = (repo: { owner: string; name: string }) =>
    !repoFilter || repoKey(repo) === repoKey(repoFilter);
  const now = Date.now();
  const filteredActivity = {
    ...activity,
    liveRuns: activity.liveRuns.filter(
      (run) =>
        matchesFilter(run.repo) &&
        matchesAgentsRun(run, view, {
          finished: false,
          now,
          shownTitle: itemsByRunId[run.id]?.title,
        }),
    ),
    recentRuns: activity.recentRuns.filter(
      (run) =>
        matchesFilter(run.repo) &&
        matchesAgentsRun(run, view, { finished: true, now }),
    ),
  };
  const filteredCliSessions = filterSessionsForRepo(
    cliSessions,
    repoFilter,
  ).filter((session) => matchesAgentsSession(session, view));
  const matchesItem = (item: {
    repo: { owner: string; name: string };
    number: number;
    title: string;
  }) =>
    matchesFilter(item.repo) &&
    matchesFind([item.title, `${repoKey(item.repo)}#${item.number}`], view.q);

  const dataAsOf = oldestFetchedAt(itemsFetchedAt, activityFetchedAt);

  // Waiting items have no task record here, so their `agent:` label names
  // the agent, as for Agents' unrecorded claimed work.
  const matchesWaiting = (item: ActionItem) =>
    matchesItem(item) && matchesClaimedAgent(item, undefined, view.agent);
  const deployCards = queueView.waitingOnDeploy
    .filter(matchesWaiting)
    .map((item) => toCard(item));
  const blockedCards = queueView.blocked
    .filter(matchesWaiting)
    .map((item) => toCard(item));
  const stoppedItems = parkedWorkItems.filter(
    (item) =>
      (!view.agent || item.spec.pipeline === view.agent) &&
      matchesFind([item.spec.title, item.id, item.spec.target.repo], view.q),
  );

  // The right pane of the two-panel view (desktop ≥1024px). Resolved from the
  // `?sel=` key against the *same* records the left column actually renders -
  // the same recent-run slice and the same live/idle session filter the
  // operations panel uses - so a row that has scrolled out of the list (a
  // run past the outcome cutoff, a session that ended) resolves to the empty
  // state rather than lingering as detail with no row to select.
  const detail = resolveBridgeDetail({
    selectedKey,
    liveRuns: filteredActivity.liveRuns,
    recentRuns: filteredActivity.recentRuns.slice(0, RECENT_OUTCOMES_LIMIT),
    cliSessions: filteredCliSessions.filter(isActiveCliSession),
    waitingOnDeploy: deployCards,
    blocked: blockedCards,
    parkedWork: stoppedItems,
    itemsByRunId,
    sessionsByRunId,
    multiRepo,
  });
  // Base the mobile detail swap on whether a *resolved* row exists, not on the
  // raw `?sel=`: a stale, filtered-out, or malformed key must leave the mobile
  // list visible (its empty state carries no back control to recover to).
  const hasSelection = detail.kind !== 'none';

  // Agent and find narrow decisions exactly as the Inbox does, so the count
  // matches what "Review N decisions" opens. The window is the Inbox's own.
  const decisionCards = [
    ...queueView.yourQueue
      .filter((item) => matchesFilter(item.repo))
      .map((item) => toCard(item)),
    ...nativeInbox.cards.filter((card) =>
      matchesFilter(inboxCardMetadata(card).repo),
    ),
  ].filter(
    (card) =>
      (!view.agent || inboxCardAgent(card) === view.agent) &&
      matchesFind([inboxCardMetadata(card).search], view.q),
  );
  const inboxQuery = new URLSearchParams();
  if (repoFilterKey) inboxQuery.set('repo', repoFilterKey);
  if (view.agent) inboxQuery.set('agent', view.agent);
  if (view.q) inboxQuery.set('q', view.q);
  const inboxHref = inboxQuery.size ? `/inbox?${inboxQuery}` : '/inbox';
  const decisionCount = decisionCards.length;
  const readouts = bridgeReadouts(
    fleetReadoutInput({
      activity,
      liveRuns: filteredActivity.liveRuns,
      repo: repoFilterKey,
      autoscaler,
      spendArchive,
    }),
  );
  const selectRun = (run: AgentRun) =>
    bridgeSelectionHref(runKey(run), repoFilterKey, stoppedCursor, view);
  const outcomesHref = agentsScopedHref(repoFilterKey, view);

  return (
    <ConsoleWorkspace
      ariaLabel="Bridge"
      className="bridge-frame"
      warnings={<DataWarnings warnings={warnings} />}
      toolbar={
        <ConsoleToolbar
          action="/"
          preserve={{ sel: selectedKey }}
          primary={
            <DeckInboxSummary
              count={decisionCount}
              nativeAvailable={nativeInbox.available}
              inboxHref={inboxHref}
            />
          }
        >
          <ToolbarSelect
            name="repo"
            label="Repository"
            value={repoFilterKey ?? ''}
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
            value={view.agent ?? ''}
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
            value={view.window ?? ''}
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
            placeholder="issue, PR, session id"
            value={view.q}
          />
          {repoFilterKey && (
            <Anchor
              href={bridgeSelectionHref(undefined, undefined, undefined, view)}
              size="sm"
            >
              Clear repository
            </Anchor>
          )}
          <DataFreshness
            fetchedAt={dataAsOf}
            initialLabel={formatRelativeTime(dataAsOf)}
          />
          {/* Selects and the window submit on change; Apply shows only
              until they hydrate. */}
          <ToolbarApply label="Apply" />
        </ConsoleToolbar>
      }
    >
      <ConsoleReadouts label="Bridge readouts" readouts={readouts} />
      <section
        className="bridge-workspace"
        data-sel={hasSelection ? '' : undefined}
      >
        <div className="bridge-workspace__list bridge-cols">
          <div className="bridge-stack">
            <ActiveDispatchesPanel
              liveRuns={filteredActivity.liveRuns}
              updatedAt={activityFetchedAt}
              itemsByRunId={itemsByRunId}
              sessionsByRunId={sessionsByRunId}
              selectHrefFor={selectRun}
            />
            <RecentCompletionsPanel
              runs={filteredActivity.recentRuns.slice(0, RECENT_OUTCOMES_LIMIT)}
              merged={
                <Suspense fallback={`${UNAVAILABLE} merged · 24h`}>
                  <MergedLastDay merged={merged} />
                </Suspense>
              }
              sessionsByRunId={sessionsByRunId}
              selectHrefFor={selectRun}
              footer={
                <Anchor
                  href={outcomesHref}
                  size="sm"
                  className="operations-more-link"
                >
                  View all outcomes →
                </Anchor>
              }
            />
            <ParkedWorkPanel
              items={stoppedItems}
              hasMoreTasks={hasMoreParkedTasks}
              error={stoppedError}
              nextPageHref={
                stoppedNextCursor
                  ? stoppedWorkHref(repoFilterKey, stoppedNextCursor, view)
                  : undefined
              }
              firstPageHref={
                stoppedCursor || stoppedError
                  ? stoppedWorkHref(repoFilterKey, undefined, view)
                  : undefined
              }
              cancel={cancelItem}
              redispatch={redispatchItem}
              repoFilterKey={repoFilterKey}
              stoppedCursor={stoppedCursor}
              view={view}
            />
            <BridgeSections
              waitingOnDeploy={deployCards}
              blocked={blockedCards}
              repoFilterKey={repoFilterKey}
              stoppedCursor={stoppedCursor}
              view={view}
            />
          </div>
          <div className="bridge-stack">
            <DecisionInboxPanel
              rows={decisionRows(decisionCards, repoFilterKey)}
            />
            <RunnerFleetPanel
              lanes={autoscaler.lanes}
              lanesIncomplete={autoscaler.lanesIncomplete}
              executor={autoscaler.queueExecutor}
              chip={<FleetChip fleet={activity.fleet} />}
              tokenRate={fleetTokenRate(tokenRateSnapshot, {
                repo: repoFilterKey,
              })}
              workApiLatency={autoscaler.queueExecutor?.workApiLatency}
              hostInventory={autoscaler.hostInventory}
            />
            <CliSessionsPanel
              sessions={filteredCliSessions.filter(isActiveCliSession)}
              selectHrefFor={(session) =>
                bridgeSelectionHref(
                  sessionKey(session),
                  repoFilterKey,
                  stoppedCursor,
                  view,
                )
              }
            />
          </div>
        </div>

        {hasSelection && (
          <div className="bridge-workspace__detail">
            <BridgeDetail
              detail={detail}
              repoFilterKey={repoFilterKey}
              stoppedCursor={stoppedCursor}
              view={view}
              cancel={cancelItem}
              redispatch={redispatchItem}
            />
          </div>
        )}
      </section>
    </ConsoleWorkspace>
  );
}

/**
 * Auth-gate, title/subtitle, and nav render eagerly here - none of
 * it needs the slow GitHub/Firestore reads `IndexBody` fetches, so this
 * shell only has to wait on `auth()` and `searchParams` (both fast, no
 * network), not the ~30-request fleet activity fetch. That keeps the header
 * off the streamed placeholder `IndexBody`'s own Suspense boundary shows
 * while its data resolves - see #160.
 */
interface IndexViewProps {
  watchedRepos: ReturnType<typeof getWatchedRepos>;
  repoFilter: ReturnType<typeof parseRepoFilterParam>;
  repoFilterKey?: string;
  view: AgentsViewFilters;
  selectedKey?: string;
  stoppedCursor?: string;
  multiRepo: boolean;
  subtitle: string;
}

function IndexViewContent({
  watchedRepos,
  repoFilter,
  repoFilterKey,
  view,
  selectedKey,
  stoppedCursor,
  multiRepo,
}: IndexViewProps) {
  return (
    <>
      <LiveDashboard />
      <Suspense
        key={`${repoFilterKey ?? ''}:${view.agent ?? ''}:${view.window ?? ''}:${view.q ?? ''}:${stoppedCursor ?? ''}`}
        fallback={<PageLoading rows={6} header={false} />}
      >
        <IndexBody
          repoFilter={repoFilter}
          repoFilterKey={repoFilterKey}
          view={view}
          watchedRepos={watchedRepos}
          selectedKey={selectedKey}
          stoppedCursor={stoppedCursor}
          multiRepo={multiRepo}
        />
      </Suspense>
    </>
  );
}

const IndexView = withConsolePageShell(
  IndexViewContent,
  ({ watchedRepos, repoFilter, repoFilterKey, subtitle }) => ({
    className: 'deck-page-shell',
    current: 'deck',
    title: 'Bridge',
    repoFilter: repoFilterKey,
    subtitle: (
      <>
        Fleet overview · {subtitle}
        {repoFilter && (
          <>
            {' · '}
            <Anchor href="/" size="sm">
              show all repos
            </Anchor>
          </>
        )}
      </>
    ),
    utilities: (
      <>
        <div className="deck-utilities deck-utilities--desktop console-utilities--desktop">
          <QueueConsoleUtilities
            watchedRepos={watchedRepos}
            repoFilter={repoFilterKey}
          />
        </div>
        <div className="deck-utilities deck-utilities--mobile console-utilities--mobile">
          <QueueConsoleUtilities
            watchedRepos={watchedRepos}
            repoFilter={repoFilterKey}
            includeNavigation
          />
        </div>
      </>
    ),
  }),
);

async function IndexShell({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user?.isAdmin && consoleLandingPath(session) === '/work') {
    redirect('/work');
  }
  assertAdmin(session, '/login');

  const watchedRepos = getWatchedRepos();
  const params = await searchParams;

  const repoFilter = parseRepoFilterParam(params.repo);
  const repoFilterKey = repoFilter ? repoKey(repoFilter) : undefined;
  const selectedKey = parseBridgeSelection(params.sel);
  const view = parseAgentsViewFilters(params);

  const subtitle =
    watchedRepos.length <= 1
      ? repoDisplayName(watchedRepos[0])
      : repoFilter
        ? repoDisplayName(repoFilter)
        : `${watchedRepos.length} repos`;

  return (
    <IndexView
      watchedRepos={watchedRepos}
      repoFilter={repoFilter}
      repoFilterKey={repoFilterKey}
      view={view}
      selectedKey={selectedKey}
      stoppedCursor={params.stoppedCursor}
      multiRepo={watchedRepos.length > 1}
      subtitle={subtitle}
    />
  );
}

// `cacheComponents` requires uncached data access to sit inside a Suspense
// boundary, so `IndexShell` (auth() + searchParams, both fast) streams in
// behind a 6-row placeholder rather than blocking on those; its own nested
// Suspense around `IndexBody` covers the slow GitHub/Firestore reads
// separately, so the header never waits on those (see #160).
export default function Index({ searchParams }: PageProps) {
  return (
    <Suspense
      fallback={
        <NavPageLoading
          current="deck"
          title="Bridge"
          className="deck-page-shell"
          rows={6}
        />
      }
    >
      <IndexShell searchParams={searchParams} />
    </Suspense>
  );
}
