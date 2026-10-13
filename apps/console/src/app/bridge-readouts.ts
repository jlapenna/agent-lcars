import type { ConsoleReadout } from './console-readouts';

export interface BridgeReadoutInput {
  /** Live runs in scope; ignored when the authoritative read failed. */
  liveRuns: readonly { pipeline: string }[];
  liveRunsAvailable: boolean;
  /** Active CLI sessions in scope, from a list that may be capped. */
  activeCliSessions: number;
  cliSessionsAvailable: boolean;
  /** The unscoped list hit its cap with every listed session active, so
   * more active sessions may exist than were returned. */
  cliSessionsTruncated: boolean;
  stopped: { count: number; hasMore: boolean; error?: string };
  waitingOnDeploy: number;
  blocked: number;
}

const UNAVAILABLE = '—';

/**
 * The Bridge's readout row. A failed or capped read is shown as unavailable
 * or as a lower bound, never as an exact figure: an outage must not read as
 * "no agents running".
 */
export function bridgeReadouts(input: BridgeReadoutInput): ConsoleReadout[] {
  const runsByPipeline = new Map<string, number>();
  for (const run of input.liveRuns) {
    runsByPipeline.set(
      run.pipeline,
      (runsByPipeline.get(run.pipeline) ?? 0) + 1,
    );
  }
  return [
    {
      id: 'stopped',
      label: 'Stopped work',
      value: input.stopped.error
        ? UNAVAILABLE
        : `${input.stopped.count}${input.stopped.hasMore ? '+' : ''}`,
      detail: input.stopped.error ? 'unavailable' : 'parked or failed',
    },
    {
      id: 'running',
      label: 'Agents running',
      value: input.liveRunsAvailable ? input.liveRuns.length : UNAVAILABLE,
      detail: input.liveRunsAvailable
        ? [...runsByPipeline]
            .map(([pipeline, count]) => `${pipeline} ${count}`)
            .join(' · ') || undefined
        : 'unavailable',
    },
    {
      id: 'cli',
      label: 'Active CLI sessions',
      value: input.cliSessionsAvailable
        ? `${input.activeCliSessions}${input.cliSessionsTruncated ? '+' : ''}`
        : UNAVAILABLE,
      detail: input.cliSessionsAvailable ? 'live or idle' : 'unavailable',
    },
    {
      id: 'waiting',
      label: 'Waiting',
      value: input.waitingOnDeploy + input.blocked,
      detail: `deploy ${input.waitingOnDeploy} · blocked ${input.blocked}`,
    },
  ];
}
