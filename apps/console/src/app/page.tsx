import { logger } from '@agent-lcars/logging';
import type { TaskListCursor } from '@agent-lcars/orchestrator';
import { workRepository } from '@agent-lcars/work';
import { PIPELINES } from '@agent-lcars/work';
import type { WorkSummary } from '@agent-lcars/work/derive';
import { Anchor, Group } from '@mantine/core';
import { redirect } from 'next/navigation';

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
import { getNativeInboxEvidence } from '../lib/native-inbox';
import { derivePrimaryAction } from '../lib/primary-action';
import { buildQueueView } from '../lib/queue-view';
import { readTimings } from '../lib/read-timings';
import { indexSessionsByRunId } from '../lib/run-classification';
import { getRunnerSessionsByRunId } from '../lib/runner-sessions';
import { filterSessionsForRepo } from '../lib/session-repo-filter';
import { fleetTokenRate, TOKEN_RATE_READ_FAILED } from '../lib/token-rate';
import { getTokenRateSnapshot } from '../lib/token-rate-data';
import { type BoardCard, BridgeSections } from './action-items-board';
import {
  FleetChip,
  isActiveCliSession,
  type RunItemRef,
} from './agent-activity-panel';
import {
  type AgentsViewFilters,
  cliSessionsArchiveHref,
  matchesAgentsRun,
  matchesAgentsSession,
  matchesClaimedAgent,
  matchesFind,
  parseAgentsViewFilters,
} from './agents/agents-view-filters';
import { BridgeDetail } from './bridge-detail';
import {
  bridgeDestinationReadouts,
  bridgeWorkSummary,
  EVENT_WORK_PANEL_ERROR,
  loadBridgeEventWork,
  loadBridgeStoppedPages,
  STOPPED_WORK_PANEL_ERROR,
  WORK_SUMMARY_UNAVAILABLE_ERROR,
} from './bridge-readouts';
import { resolveBridgeDetail } from './bridge-rows';
import {
  bridgeSelectionHref,
  parseBridgeSelection,
  runKey,
  sessionKey,
} from './bridge-selection';
import { DataWarnings } from './console-header';
import { repoScopedConsoleHrefs } from './console-hrefs';
import { ConsoleReadouts } from './console-readouts';
import {
  ConsoleToolbar,
  ToolbarApply,
  ToolbarSearch,
  ToolbarSelect,
} from './console-toolbar';
import { ConsoleWorkspace } from './console-workspace';
import { DataFreshness } from './data-freshness';
import { decisionRows } from './decision-rows';
import { DeckInboxSummary } from './deck-inbox-summary';
import { formatRelativeTime } from './format';
import { inboxCardAgent, inboxCardMetadata } from './inbox-card';
import { LiveDashboard } from './live-dashboard';
import { NavSuspense } from './nav-suspense';
import {
  ActiveDispatchesPanel,
  CliSessionsPanel,
  DecisionInboxPanel,
  RunnerFleetPanel,
} from './ops-panels';
import { NavPageLoading, PageLoading } from './page-loading';
import { ParkedWorkPanel } from './parked-work-panel';
import { QueueConsoleUtilities } from './queue-console-utilities';
import { onlineRunnerCount } from './runner-rows';
import { stoppedWorkHref } from './stopped-work-query';
import { withConsolePageShell } from './with-console-page-shell';
import { cancelItem, redispatchItem } from './work/actions';
import { context as workContext } from './work/context';
import { workListHref } from './work/work-list-query';

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
const STOPPED_WORK_PAGE = 50;
const EVENT_WORK_READ = 50;

async function getParkedWork(
  repo?: string,
  rawCursor?: string,
  view: AgentsViewFilters = {},
): Promise<{
  authorized: boolean;
  items: WorkSummary[];
  /** Uncursored first page of stopped native work for the Work destination
   *  card, kept independent of the Stopped work panel's cursor pagination. */
  summaryStoppedItems: WorkSummary[];
  summaryHasMoreStopped: boolean;
  summaryError?: string;
  eventItems: WorkSummary[];
  /** Event tasks read to find `eventItems`, and whether older ones exist. */
  eventWindow?: { size: number; windowed: boolean };
  eventError?: string;
  hasMoreTasks: boolean;
  nextCursor?: TaskListCursor;
  error?: string;
}> {
  let work: Awaited<ReturnType<typeof workContext>>;
  try {
    work = await workContext();
  } catch (error) {
    // The Bridge must never fall to error.tsx because this panel's fetch
    // failed. Keep the rest of the Bridge available and disclose the failed
    // read with a reset link rather than presenting it as an empty queue.
    logger.error('agent-lcars: parked work panel unavailable:', error);
    return {
      authorized: true,
      items: [],
      summaryStoppedItems: [],
      summaryHasMoreStopped: false,
      summaryError: WORK_SUMMARY_UNAVAILABLE_ERROR,
      eventItems: [],
      eventError: EVENT_WORK_PANEL_ERROR,
      hasMoreTasks: false,
      error: STOPPED_WORK_PANEL_ERROR,
    };
  }
  if (!work.principal?.scopes.has('work.operator')) {
    return {
      authorized: false,
      items: [],
      summaryStoppedItems: [],
      summaryHasMoreStopped: false,
      eventItems: [],
      hasMoreTasks: false,
    };
  }
  // Each read takes only tasks carrying the stored sort key (#3566): the
  // newest stopped tasks and the newest event tasks, instead of the newest
  // 200 tasks of every state filtered here. Panel cursor parsing / GitHub
  // projection enrichment, the Work card's uncursored native summary, and
  // event-driven activity each keep their own failure boundary.
  const [stopped, events] = await Promise.all([
    loadBridgeStoppedPages({
      rawCursor,
      repo,
      readPage: (pageCursor) =>
        listWorkSummaries(work.runtime.store, {
          limit: STOPPED_WORK_PAGE,
          cursor: pageCursor,
          sortKey: 'stoppedAt',
        }),
      excludeClosed: (candidates) =>
        excludeClosedGithubAnchors(work.runtime.store, candidates),
      onPanelError: (error) => {
        logger.error('agent-lcars: parked work panel unavailable:', error);
      },
      onSummaryError: (error) => {
        logger.error(
          'agent-lcars: bridge work summary readout unavailable:',
          error,
        );
      },
    }),
    loadBridgeEventWork({
      repo,
      view,
      readEvents: () =>
        listWorkSummaries(work.runtime.store, {
          limit: EVENT_WORK_READ,
          sortKey: 'eventAt',
        }),
      onEventError: (error) => {
        logger.error('agent-lcars: event work activity unavailable:', error);
      },
    }),
  ]);
  return {
    authorized: true,
    items: stopped.items,
    summaryStoppedItems: stopped.summaryStoppedItems,
    summaryHasMoreStopped: stopped.summaryHasMoreStopped,
    summaryError: stopped.summaryError,
    eventItems: events.eventItems,
    eventWindow: events.eventWindow,
    eventError: events.eventError,
    hasMoreTasks: stopped.hasMoreTasks,
    nextCursor: stopped.nextCursor,
    error: stopped.panelError,
  };
}

/** Agents in the Bridge's repository scope and view. */
function agentsScopedHref(
  repo: string | undefined,
  view: AgentsViewFilters,
): string {
  const query = new URLSearchParams();
  if (repo) query.set('repo', repo);
  if (view.agent) query.set('agent', view.agent);
  if (view.q) query.set('q', view.q);
  return query.size ? `/agents?${query}` : '/agents';
}

interface PageProps {
  searchParams: Promise<{
    repo?: string;
    agent?: string;
    q?: string;
    sel?: string;
    stoppedCursor?: string;
  }>;
}

async function IndexBody({
  repoFilter,
  repoFilterKey,
  view,
  selectedKey,
  stoppedCursor,
  multiRepo,
}: {
  repoFilter: WatchedRepo | undefined;
  repoFilterKey?: string;
  /** The toolbar's agent and find, as on Agents. */
  view: AgentsViewFilters;
  selectedKey?: string;
  stoppedCursor?: string;
  multiRepo: boolean;
}) {
  const timings = readTimings('bridge');
  const activityRead = timings.time('activity', getCachedAgentActivity());
  const [
    {
      data: { items: rawItems },
      fetchedAt: itemsFetchedAt,
    },
    { data: activity, fetchedAt: activityFetchedAt },
    { sessions: cliSessions, warnings: cliSessionWarnings },
    { sessionsByRunId: runnerSessionsByRunId, warnings: runnerSessionWarnings },
    {
      authorized: workAuthorized,
      items: parkedWorkItems,
      summaryStoppedItems,
      summaryHasMoreStopped,
      summaryError: workSummaryError,
      eventItems,
      eventWindow,
      eventError: eventWorkError,
      hasMoreTasks: hasMoreParkedTasks,
      nextCursor: stoppedNextCursor,
      error: stoppedError,
    },
    nativeInbox,
    autoscaler,
    tokenRateSnapshot,
  ] = await Promise.all([
    timings.time('queue', getCachedQueueItems()),
    activityRead,
    timings.time('cliSessions', getCliSessions()),
    activityRead.then(({ data }) =>
      timings.time(
        'runnerSessions',
        getRunnerSessionsByRunId([...data.liveRuns, ...data.recentRuns]),
      ),
    ),
    timings.time(
      'stoppedWork',
      getParkedWork(repoFilterKey, stoppedCursor, view),
    ),
    timings.time(
      'nativeInbox',
      getNativeInboxEvidence(async () => {
        const context = await workContext();
        return { store: context.runtime.store, principal: context.principal };
      }),
    ),
    timings.time('autoscaler', getAutoscalerStatuses()),
    timings.time('tokenRate', getTokenRateSnapshot()),
  ]);
  timings.log();
  // Deduped: independent authoritative reads can fail independently, and
  // each unique problem only needs saying once.
  const warnings = Array.from(
    new Set([
      ...activity.warnings,
      ...cliSessionWarnings,
      ...runnerSessionWarnings,
      ...nativeInbox.warnings,
      ...autoscaler.warnings,
      ...(tokenRateSnapshot ? [] : [TOKEN_RATE_READ_FAILED]),
    ]),
  );

  const sessionsByRunId = indexSessionsByRunId(
    activity.liveRuns,
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
  // The toolbar's agent and find narrow the same rows after it, as
  // on Agents; find also narrows the item lists by title and reference.
  const matchesFilter = (repo: { owner: string; name: string }) =>
    !repoFilter || repoKey(repo) === repoKey(repoFilter);
  const now = Date.now();
  const liveRuns = activity.liveRuns.filter(
    (run) =>
      matchesFilter(run.repo) &&
      matchesAgentsRun(run, view, {
        finished: false,
        now,
        shownTitle: itemsByRunId[run.id]?.title,
      }),
  );
  const filteredCliSessions = filterSessionsForRepo(
    cliSessions,
    repoFilter,
  ).filter((session) => matchesAgentsSession(session, view));
  const activeCliSessions = filteredCliSessions.filter(isActiveCliSession);
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
      matchesFind(
        [item.spec.title, item.id, workRepository(item.spec)],
        view.q,
      ),
  );

  // Resolve the selection against the rows still visible on Bridge.
  const detail = resolveBridgeDetail({
    selectedKey,
    liveRuns,
    cliSessions: activeCliSessions,
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
  // Finished reports are listed there too but are not decisions.
  const decisionCards = [
    ...queueView.yourQueue
      .filter((item) => matchesFilter(item.repo))
      .map((item) => toCard(item)),
    ...nativeInbox.cards.filter(
      (card) =>
        card.kind === 'decision' && matchesFilter(inboxCardMetadata(card).repo),
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
  const runners = autoscaler.hostInventory?.runners;
  const runnerCount = runners
    ? `${onlineRunnerCount(runners)} / ${runners.length}`
    : activity.fleet?.registered;
  const selectRun = (run: AgentRun) =>
    bridgeSelectionHref(runKey(run), repoFilterKey, stoppedCursor, view);
  const outcomesHref = agentsScopedHref(repoFilterKey, view);
  const workHref = workListHref({
    repo: repoFilterKey,
    agent: view.agent,
    window: view.window,
    q: view.q,
  });
  const eventWorkHref = workListHref({
    activity: 'events',
    repo: repoFilterKey,
    agent: view.agent,
    q: view.q,
  });

  return (
    <ConsoleWorkspace
      ariaLabel="Bridge"
      className="bridge-frame"
      warnings={<DataWarnings warnings={warnings} />}
      toolbar={
        <ConsoleToolbar
          action="/"
          preserve={{ repo: repoFilterKey, sel: selectedKey }}
          folded={view.agent ? 1 : 0}
          primary={
            <DeckInboxSummary
              compact
              count={decisionCount}
              nativeAvailable={nativeInbox.available}
              inboxHref={inboxHref}
            />
          }
        >
          {/* No repository select here: scope arrives from navigation and
              "Clear repository" below leaves it (#2533). */}
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
          {/* Controls apply on change; Apply is for browsers without JavaScript (<noscript>). */}
          <ToolbarApply label="Apply" />
        </ConsoleToolbar>
      }
    >
      <ConsoleReadouts
        label="Destination summaries"
        readouts={bridgeDestinationReadouts({
          agentsHref: outcomesHref,
          liveRunCount: liveRuns.length,
          liveRunsAvailable: activity.queue !== undefined,
          activeCliSessionCount: activeCliSessions.length,
          cliSessionsAvailable: cliSessionWarnings.length === 0,
          runnerCount,
          hasHostInventory: runners !== undefined,
          inboxHref,
          decisionCount,
          nativeInboxAvailable: nativeInbox.available,
          workHref,
          work: bridgeWorkSummary({
            authorized: workAuthorized,
            error: workSummaryError ?? eventWorkError,
            stoppedItems: summaryStoppedItems,
            hasMoreStopped: summaryHasMoreStopped,
            eventCount: eventItems.length,
            eventWindowed: eventWindow?.windowed ?? false,
            view,
            now,
          }),
        })}
      />
      <section
        className="bridge-workspace"
        data-sel={hasSelection ? '' : undefined}
      >
        <div className="bridge-workspace__list bridge-cols">
          <div className="bridge-stack">
            <ActiveDispatchesPanel
              liveRuns={liveRuns}
              updatedAt={activityFetchedAt}
              itemsByRunId={itemsByRunId}
              sessionsByRunId={sessionsByRunId}
              selectHrefFor={selectRun}
              footer={
                <Group gap="sm">
                  <Anchor
                    href={workHref}
                    size="sm"
                    className="operations-more-link"
                  >
                    Browse Work →
                  </Anchor>
                  <Anchor
                    href="/work/schedules"
                    size="sm"
                    className="operations-more-link"
                  >
                    View schedules →
                  </Anchor>
                  <Anchor
                    href={outcomesHref}
                    size="sm"
                    className="operations-more-link"
                  >
                    Run outcomes →
                  </Anchor>
                  <Anchor
                    href={eventWorkHref}
                    size="sm"
                    className="operations-more-link"
                  >
                    Event-driven work →
                  </Anchor>
                </Group>
              }
            />
            <BridgeSections
              waitingOnDeploy={deployCards}
              blocked={blockedCards}
              repoFilterKey={repoFilterKey}
              stoppedCursor={stoppedCursor}
              view={view}
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
          </div>
          <div className="bridge-stack">
            <DecisionInboxPanel
              rows={decisionRows(decisionCards, repoFilterKey)}
              inboxHref={
                repoScopedConsoleHrefs(repoFilterKey)?.inbox ?? '/inbox'
              }
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
              sessions={activeCliSessions}
              footer={
                <Anchor
                  href={cliSessionsArchiveHref(repoFilterKey, view.agent)}
                  size="sm"
                  className="operations-more-link"
                >
                  Browse CLI sessions →
                </Anchor>
              }
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
      <NavSuspense
        key={`${repoFilterKey ?? ''}:${view.agent ?? ''}:${view.q ?? ''}:${stoppedCursor ?? ''}`}
        fallback={<PageLoading rows={6} header={false} />}
      >
        <IndexBody
          repoFilter={repoFilter}
          repoFilterKey={repoFilterKey}
          view={view}
          selectedKey={selectedKey}
          stoppedCursor={stoppedCursor}
          multiRepo={multiRepo}
        />
      </NavSuspense>
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
  const view = parseAgentsViewFilters({ agent: params.agent, q: params.q });

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
    <NavSuspense
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
    </NavSuspense>
  );
}
