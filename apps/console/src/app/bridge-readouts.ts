import type { AgentActivity } from '../lib/agent-activity';
import type { AutoscalerStatusResult } from '../lib/autoscaler-status';
import { runCountHistory } from '../lib/run-history';
import { fleetRunnerHistory } from '../lib/runner-history';
import type { SessionArchiveResult } from '../lib/session-archive';
import { repoKey } from '../lib/watched-repo';
import type { ConsoleReadout } from './console-readouts';
import { formatCost, formatDuration } from './format';

export interface BridgeReadoutInput {
  /** Fresh ARC runner counts; undefined when any lane is missing or stale. */
  fleet: { online?: number; busy?: number; capacity?: number };
  /** Live runs in scope; ignored when the authoritative read failed. */
  liveRuns: readonly {
    pipeline: string;
    status: 'queued' | 'running' | 'completed';
    elapsedSeconds: number;
  }[];
  liveRunsAvailable: boolean;
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
    /** The archive hit its session limit: the total is a lower bound. */
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
  now = Date.now(),
}: {
  activity: Pick<AgentActivity, 'fleet' | 'queue' | 'runHistory'>;
  /** Live runs in the page's repository scope. */
  liveRuns: AgentActivity['liveRuns'];
  /** That scope (`owner/name`), which the run history is narrowed to. */
  repo?: string;
  now?: number;
  autoscaler: Pick<AutoscalerStatusResult, 'lanes' | 'lanesIncomplete'>;
  spendArchive?: Pick<SessionArchiveResult, 'spend' | 'spendByRepository'>;
}): BridgeReadoutInput {
  const repoSpend = spendArchive?.spendByRepository;
  return {
    fleet: {
      online: activity.fleet?.online,
      busy: activity.fleet?.busy,
      // Set only with complete lanes; the same figure the rail shows.
      capacity: activity.fleet?.capacity,
    },
    liveRuns,
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

export function bridgeReadouts(input: BridgeReadoutInput): ConsoleReadout[] {
  const { online, busy, capacity } = input.fleet;
  const runningRuns = input.liveRuns.filter((run) => run.status === 'running');
  const byPipeline = new Map<string, number>();
  for (const run of runningRuns) {
    byPipeline.set(run.pipeline, (byPipeline.get(run.pipeline) ?? 0) + 1);
  }
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
        busy === undefined || online === undefined
          ? UNAVAILABLE
          : `${busy} / ${online}`,
      detail:
        busy === undefined || online === undefined
          ? 'runner status unavailable'
          : `${online === 0 ? 0 : Math.round((busy / online) * 100)}% utilisation · ${Math.max(0, online - busy)} idle`,
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
      value: input.liveRunsAvailable ? runningRuns.length : UNAVAILABLE,
      detail: input.liveRunsAvailable
        ? [...byPipeline]
            .map(([pipeline, count]) => `${pipeline} ${count}`)
            .join(' · ') || 'none running'
        : 'unavailable',
      spark: {
        label: 'Running agents, last 30 minutes',
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
            ? 'partial: session archive limit reached'
            : `since 00:00 UTC · no daily budget${input.spendToday?.estimated ? ' · est.' : ''}`,
      spark: {
        label: input.spendToday?.partial
          ? 'Spend per hour today, by last activity (lower bound)'
          : 'Spend per hour today, by last activity',
        values: input.spendToday?.byHourUsd,
      },
    },
  ];
}
