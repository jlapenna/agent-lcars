import type { TaskListCursor } from '@agent-lcars/orchestrator';
import { workRepository } from '@agent-lcars/work';
import type { WorkSummary } from '@agent-lcars/work/derive';

import type { AgentActivity } from '../lib/agent-activity';
import type { AutoscalerStatusResult } from '../lib/autoscaler-status';
import type { CliSession } from '../lib/cli-sessions';
import { runCountHistory } from '../lib/run-history';
import { fleetRunnerHistory } from '../lib/runner-history';
import type { SessionArchiveResult } from '../lib/session-archive';
import { repoKey } from '../lib/watched-repo';
import type { AgentsViewFilters } from './agents/agents-view-filters';
import type { ConsoleReadout } from './console-readouts';
import { formatCost, formatDuration } from './format';
import { matchesWorkView, parseWorkViewFilters } from './work/work-list-query';

export interface BridgeReadoutInput {
  /** Fresh ARC runner counts; undefined when any lane is missing or stale. */
  fleet: {
    online?: number;
    busy?: number;
    /** The lanes' registered runners: what `busy` (running jobs, also from
     * the lanes) is out of. */
    registered?: number;
    capacity?: number;
  };
  /** Live runs in scope; ignored when the authoritative read failed. */
  liveRuns: readonly {
    pipeline: string;
    status: 'queued' | 'running' | 'completed';
    elapsedSeconds: number;
  }[];
  liveRunsAvailable: boolean;
  /** Complete, scoped CLI telemetry; undefined means unavailable. Live and
   * idle sessions both represent processes still running on local hosts. */
  cliSessions?: readonly Pick<CliSession, 'sessionId' | 'agent' | 'liveness'>[];
  /** Authoritative lifecycle counts in the same scope as `liveRuns`;
   * undefined when the read failed. */
  queue?: { queued: number; claimed: number; running: number };
  /** Per-minute queue depth and running agents for the last 30 minutes, in
   * the same scope; undefined when the run history is unavailable. */
  history?: { queued: number[]; running: number[] };
  /** Fleet-wide runners online and busy per minute, last 30 minutes, from
   * the lanes' own windows; undefined while any lane lacks one. */
  runnerHistory?: {
    online: (number | undefined)[];
    busy: (number | undefined)[];
  };
  /** Known spend of sessions active since 00:00 UTC, the same figure as the
   * cost ledger's "Spend by repository"; undefined when the archive read
   * failed. */
  spendToday?: {
    costUsd?: number;
    /** `costUsd` split by the UTC hour of each session's last activity. */
    byHourUsd?: number[];
    estimated: boolean;
    /** Archive coverage is incomplete: the total is a lower bound. */
    partial: boolean;
  };
}

const UNAVAILABLE = '—';

/**
 * The Bridge's readout row (design/fleet-console.html): runners online, busy,
 * queue depth, agents running, spend today. A failed or incomplete read is
 * shown as unavailable, never as an exact figure: an outage must not read as
 * "no agents running".
 */
/** Maps the reads every readout row shares (fleet activity, autoscaler
 * lanes, today's archive) to `bridgeReadouts`' input, scoped to `liveRuns`.
 * The Bridge and the cost ledger both render the row from it. */
export function fleetReadoutInput({
  activity,
  liveRuns,
  repo,
  autoscaler,
  spendArchive,
  cliSessions,
  now = Date.now(),
}: {
  activity: Pick<AgentActivity, 'fleet' | 'queue' | 'runHistory'>;
  /** Live runs in the page's repository scope. */
  liveRuns: AgentActivity['liveRuns'];
  /** That scope (`owner/name`), which the run history is narrowed to. */
  repo?: string;
  now?: number;
  cliSessions?: BridgeReadoutInput['cliSessions'];
  autoscaler: Pick<AutoscalerStatusResult, 'lanes' | 'lanesIncomplete'>;
  spendArchive?: Pick<SessionArchiveResult, 'spend' | 'spendByRepository'>;
}): BridgeReadoutInput {
  const repoSpend = spendArchive?.spendByRepository;
  return {
    fleet: {
      online: activity.fleet?.online,
      busy: activity.fleet?.busy,
      registered: activity.fleet?.registered,
      // Set only with complete lanes; the same figure the rail shows.
      capacity: activity.fleet?.capacity,
    },
    liveRuns,
    cliSessions,
    liveRunsAvailable: activity.queue !== undefined,
    // Same scope as the runs: a repository filter narrows the counts too.
    queue: activity.queue && {
      queued: liveRuns.filter(
        (run) => run.status === 'queued' && run.queue?.state !== 'claimed',
      ).length,
      claimed: liveRuns.filter(
        (run) => run.status === 'queued' && run.queue?.state === 'claimed',
      ).length,
      running: liveRuns.filter((run) => run.status === 'running').length,
    },
    history:
      activity.queue && activity.runHistory
        ? runCountHistory(
            repo
              ? activity.runHistory.filter(
                  (timeline) => repoKey(timeline.repo) === repo,
                )
              : activity.runHistory,
            now,
          )
        : undefined,
    // Runner counts are fleet-wide, like the figures beside them.
    runnerHistory:
      autoscaler.lanesIncomplete || !autoscaler.lanes
        ? undefined
        : withCurrent(
            fleetRunnerHistory(autoscaler.lanes, now),
            activity.fleet,
          ),
    spendToday:
      spendArchive?.spend && repoSpend
        ? {
            costUsd: repoSpend.todayUsd,
            byHourUsd: repoSpend.todayByHourUsd,
            // Only today's sessions: the archive also holds yesterday's.
            estimated: repoSpend.todayEstimated,
            partial: spendArchive.spend.coverageLimited,
          }
        : undefined,
  };
}

/** The newest bar is the lanes' current count: their windows sample once a
 * minute, so the last entry can trail it. The series stays on the lanes'
 * registered runners throughout, even where the headline counts runner pods,
 * so a different measure never lands on its last bar. */
function withCurrent(
  history: ReturnType<typeof fleetRunnerHistory>,
  fleet: { registered?: number; busy?: number } | undefined,
): ReturnType<typeof fleetRunnerHistory> {
  if (!history || fleet?.registered === undefined || fleet.busy === undefined)
    return history;
  return {
    online: [...history.online.slice(0, -1), fleet.registered],
    busy: [...history.busy.slice(0, -1), fleet.busy],
  };
}

/** 24 hourly slots ending at the current hour; slots before UTC midnight
 * stay empty, so early in the day the few hours elapsed draw as bars rather
 * than one block, and the current hour stays the newest bar. */
export function dayOfHours(
  byHour: readonly number[] | undefined,
): (number | undefined)[] | undefined {
  if (byHour === undefined) return undefined;
  const pad = Math.max(0, 24 - byHour.length);
  return [...Array.from({ length: pad }, () => undefined), ...byHour];
}

export function bridgeReadouts(input: BridgeReadoutInput): ConsoleReadout[] {
  const { online, busy, capacity } = input.fleet;
  // Busy and its denominator come from one producer, the lanes; `online`
  // may count the inventory's pods, which can disagree with them.
  const busyOf = input.fleet.registered ?? online;
  const runningRuns = input.liveRuns.filter((run) => run.status === 'running');
  const byPipeline = new Map<string, number>();
  for (const run of runningRuns) {
    byPipeline.set(run.pipeline, (byPipeline.get(run.pipeline) ?? 0) + 1);
  }
  const activeCli = new Map(
    input.cliSessions
      ?.filter(
        (session) => session.liveness === 'live' || session.liveness === 'idle',
      )
      .map((session) => [session.sessionId, session]),
  );
  for (const session of activeCli.values()) {
    byPipeline.set(session.agent, (byPipeline.get(session.agent) ?? 0) + 1);
  }
  const runningAvailable =
    input.liveRunsAvailable && input.cliSessions !== undefined;
  const queuedRuns = input.liveRuns.filter((run) => run.status === 'queued');
  const oldestQueued = Math.max(0, ...queuedRuns.map((r) => r.elapsedSeconds));
  const spend = input.spendToday?.costUsd;

  return [
    {
      id: 'online',
      label: 'Runners online',
      value:
        online === undefined
          ? UNAVAILABLE
          : capacity === undefined
            ? String(online)
            : `${online} / ${capacity}`,
      detail: online === undefined ? 'runner status unavailable' : 'ARC lanes',
      spark: {
        label: 'Runners online, last 30 minutes',
        values: input.runnerHistory?.online,
      },
    },
    {
      id: 'busy',
      label: 'Busy',
      value:
        busy === undefined || busyOf === undefined
          ? UNAVAILABLE
          : `${busy} / ${busyOf}`,
      detail:
        busy === undefined || busyOf === undefined
          ? 'runner status unavailable'
          : `${busyOf === 0 ? 0 : Math.round((busy / busyOf) * 100)}% utilisation · ${Math.max(0, busyOf - busy)} idle`,
      spark: {
        label: 'Busy runners, last 30 minutes',
        values: input.runnerHistory?.busy,
      },
    },
    {
      id: 'queue',
      label: 'Queue depth',
      value: input.queue
        ? input.queue.queued + input.queue.claimed
        : UNAVAILABLE,
      detail: input.queue
        ? `${input.queue.claimed} claimed${queuedRuns.length > 0 ? ` · oldest ${formatDuration(oldestQueued)}` : ''}`
        : 'unavailable',
      spark: {
        label: 'Queue depth, last 30 minutes',
        values: input.history?.queued,
      },
    },
    {
      id: 'running',
      label: 'Agents running',
      value: runningAvailable
        ? runningRuns.length + activeCli.size
        : UNAVAILABLE,
      detail: runningAvailable
        ? [...byPipeline]
            .map(([pipeline, count]) => `${pipeline} ${count}`)
            .join(' · ') || 'none running'
        : 'unavailable',
      spark: {
        label: 'Dispatched agents running, last 30 minutes',
        values: input.history?.running,
      },
    },
    {
      id: 'spend',
      label: 'Spend today',
      value:
        spend === undefined
          ? UNAVAILABLE
          : `${formatCost(spend)}${input.spendToday?.partial ? '+' : ''}`,
      // The configured cost budget applies to a ledger window
      // (docs/cost-ledger.md), not a day, so today is not shown as a share.
      detail:
        spend === undefined
          ? 'unavailable'
          : input.spendToday?.partial
            ? 'partial: session archive coverage incomplete'
            : `since 00:00 UTC · no daily budget${input.spendToday?.estimated ? ' · est.' : ''}`,
      spark: {
        label: input.spendToday?.partial
          ? 'Spend per hour today, by last activity (lower bound)'
          : 'Spend per hour today, by last activity',
        values: dayOfHours(input.spendToday?.byHourUsd),
      },
    },
  ];
}

export interface BridgeWorkSummaryInput {
  authorized: boolean;
  error?: string;
  /** Preloaded uncursored first page of stopped work already scoped to the
   *  Bridge's active repository filter, independent of the panel cursor. Only
   *  native Work anchors (`'workId' in item.anchor`) are counted so the card
   *  matches what `/work` displays. */
  stoppedItems: readonly Pick<
    WorkSummary,
    'id' | 'anchor' | 'updatedAt' | 'spec' | 'origin' | 'runs'
  >[];
  /** Whether older stopped work exists past that uncursored first page. */
  hasMoreStopped: boolean;
  eventCount: number;
  eventWindowed: boolean;
  /** The same Bridge toolbar filters forwarded onto the Work destination link. */
  view: AgentsViewFilters;
  now?: number;
}

/**
 * Loads the Bridge's Stopped work panel page and, when that panel is paged
 * past page 1 (`cursor`), reads the uncursored first stopped page in parallel
 * so the Work destination card stays independent of panel pagination instead
 * of collapsing to a bare page-local count on the final cursor page.
 *
 * The panel keeps all anchors (dropping closed GitHub issues via
 * `excludeClosed`), while the Work destination summary keeps native Work
 * anchors only (`'workId' in item.anchor`) to match `/work`. On cursor-paged
 * requests, the uncursored summary read runs in its own failure path so a
 * summary-only failure marks only the Work card unavailable without discarding
 * the selected panel page or event activity.
 */
export async function loadBridgeStoppedPages(input: {
  cursor?: TaskListCursor;
  repo?: string;
  readPage: (cursor?: TaskListCursor) => Promise<{
    items: WorkSummary[];
    nextCursor?: TaskListCursor;
  }>;
  excludeClosed: (items: WorkSummary[]) => Promise<WorkSummary[]>;
  onSummaryError?: (error: unknown) => void;
}): Promise<{
  items: WorkSummary[];
  hasMoreTasks: boolean;
  nextCursor?: TaskListCursor;
  summaryStoppedItems: WorkSummary[];
  summaryHasMoreStopped: boolean;
  summaryError?: string;
}> {
  const filterForRepo = (raw: WorkSummary[]) =>
    raw.filter(
      (item) =>
        (item.state === 'parked' || item.state === 'failed') &&
        (!input.repo || workRepository(item.spec) === input.repo),
    );
  const nativeOnly = (items: WorkSummary[]) =>
    items.filter((item) => 'workId' in item.anchor);

  if (!input.cursor) {
    const page = await input.readPage(undefined);
    const items = await input.excludeClosed(filterForRepo(page.items));
    return {
      items,
      hasMoreTasks: page.nextCursor !== undefined,
      nextCursor: page.nextCursor,
      summaryStoppedItems: nativeOnly(items),
      summaryHasMoreStopped: page.nextCursor !== undefined,
    };
  }

  const loadSelectedPage = async () => {
    const page = await input.readPage(input.cursor);
    const items = await input.excludeClosed(filterForRepo(page.items));
    return {
      items,
      hasMoreTasks: page.nextCursor !== undefined,
      nextCursor: page.nextCursor,
    };
  };

  const loadSummaryPage = async (): Promise<
    | {
        ok: true;
        stoppedItems: WorkSummary[];
        hasMoreStopped: boolean;
      }
    | {
        ok: false;
        error: string;
      }
  > => {
    try {
      const summaryPage = await input.readPage(undefined);
      // Native items never use GitHub issue projections, so the Work card
      // summary skips `excludeClosed` and never shares its failure path.
      return {
        ok: true,
        stoppedItems: nativeOnly(filterForRepo(summaryPage.items)),
        hasMoreStopped: summaryPage.nextCursor !== undefined,
      };
    } catch (error) {
      input.onSummaryError?.(error);
      return {
        ok: false,
        error: 'Work summary unavailable',
      };
    }
  };

  const [selected, summary] = await Promise.all([
    loadSelectedPage(),
    loadSummaryPage(),
  ]);
  return {
    ...selected,
    summaryStoppedItems: summary.ok ? summary.stoppedItems : [],
    summaryHasMoreStopped: summary.ok ? summary.hasMoreStopped : false,
    ...(summary.ok ? {} : { summaryError: summary.error }),
  };
}

/**
 * Derives the Work destination readout's stopped count from the preloaded
 * uncursored stopped rows using only native Work anchors and the exact Work
 * destination view filter (`agent`, `window`, `q`), matching what clicking the
 * Work card opens.
 */
export function bridgeWorkSummary(
  input: BridgeWorkSummaryInput,
): BridgeDestinationReadoutsInput['work'] {
  const workView = parseWorkViewFilters(input.view);
  const now = input.now ?? Date.now();
  const stoppedCount = input.stoppedItems.filter(
    (item) => 'workId' in item.anchor && matchesWorkView(item, workView, now),
  ).length;
  return {
    authorized: input.authorized,
    error: input.error,
    stoppedCount,
    hasMoreStopped: input.hasMoreStopped,
    eventCount: input.eventCount,
    eventWindowed: input.eventWindowed,
  };
}

export interface BridgeDestinationReadoutsInput {
  agentsHref: string;
  liveRunCount: number;
  liveRunsAvailable: boolean;
  activeCliSessionCount: number;
  cliSessionsAvailable: boolean;
  runnerCount?: string | number;
  hasHostInventory: boolean;
  inboxHref: string;
  decisionCount: number;
  nativeInboxAvailable: boolean;
  workHref: string;
  work: {
    authorized: boolean;
    error?: string;
    stoppedCount: number;
    hasMoreStopped: boolean;
    eventCount: number;
    eventWindowed: boolean;
  };
}

/**
 * The Bridge's destination-summary row (design/fleet-console.html): four
 * linked summaries (Agents, Shuttlebay, Inbox, Work) drawn solely from reads
 * the Bridge already holds. Any failed or unauthorized source reports `—`
 * rather than zero.
 */
export function bridgeDestinationReadouts(
  input: BridgeDestinationReadoutsInput,
): ConsoleReadout[] {
  const workAvailable = input.work.authorized && !input.work.error;
  return [
    {
      id: 'agents',
      label: 'Agents',
      href: input.agentsHref,
      value: input.liveRunsAvailable ? input.liveRunCount : UNAVAILABLE,
      detail: input.cliSessionsAvailable
        ? `Live runs · ${input.activeCliSessionCount} active CLI sessions`
        : 'Live runs · CLI sessions unavailable',
    },
    {
      id: 'shuttlebay',
      label: 'Shuttlebay',
      href: '/shuttlebay',
      value: input.runnerCount ?? UNAVAILABLE,
      detail:
        input.runnerCount === undefined
          ? 'Runner inventory unavailable'
          : input.hasHostInventory
            ? 'Runners online · fleet-wide'
            : 'ARC runners registered · fleet-wide',
    },
    {
      id: 'inbox',
      label: 'Inbox',
      href: input.inboxHref,
      value: input.nativeInboxAvailable ? input.decisionCount : UNAVAILABLE,
      detail: input.nativeInboxAvailable
        ? 'Decisions waiting'
        : 'Native decisions unavailable',
    },
    {
      id: 'work',
      label: 'Work',
      href: input.workHref,
      value: workAvailable
        ? input.work.hasMoreStopped
          ? `${input.work.stoppedCount}+`
          : input.work.stoppedCount
        : UNAVAILABLE,
      detail: input.work.error
        ? 'Work summary unavailable'
        : !input.work.authorized
          ? 'Work grant required'
          : `Stopped work · ${input.work.eventCount}${input.work.eventWindowed ? '+' : ''} event-driven`,
    },
  ];
}
