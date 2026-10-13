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
  /** Known spend of sessions active in the last day; undefined when the
   * archive read failed or no session could be priced. */
  spendToday?: {
    costUsd?: number;
    estimated: boolean;
    /** The archive hit its session limit: the total is a lower bound. */
    partial: boolean;
  };
  budgetUsd?: number;
}

const UNAVAILABLE = '—';

/**
 * The Bridge's readout row (design/fleet-console.html): runners online, busy,
 * queue depth, agents running, spend today. A failed or incomplete read is
 * shown as unavailable, never as an exact figure: an outage must not read as
 * "no agents running".
 */
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
    },
    {
      id: 'spend',
      label: 'Spend today',
      value:
        spend === undefined
          ? UNAVAILABLE
          : `${formatCost(spend)}${input.spendToday?.partial ? '+' : ''}`,
      detail:
        spend === undefined
          ? 'unavailable'
          : input.spendToday?.partial
            ? 'partial: session archive limit reached'
            : input.budgetUsd !== undefined
              ? `of ${formatCost(input.budgetUsd)} budget · ${Math.round((spend / input.budgetUsd) * 100)}%${input.spendToday?.estimated ? ' · est.' : ''}`
              : `sessions active today${input.spendToday?.estimated ? ' · est.' : ''}`,
    },
  ];
}
