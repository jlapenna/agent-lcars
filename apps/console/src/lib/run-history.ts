import type {
  Run as OrchestratorRun,
  RunEvent,
} from '@agent-lcars/orchestrator';

import type { WatchedRepo } from './github-client';

/** How far back the Bridge readouts' sparklines reach, one sample a minute. */
export const RUN_HISTORY_MINUTES = 30;

/** One run's lifecycle, reduced to what a past state needs. */
export interface RunTimeline {
  repo: WatchedRepo;
  createdAt: string;
  /** State transitions in the order they were recorded. */
  transitions: readonly Pick<RunEvent, 'at' | 'to'>[];
  /** The run's state as of `updatedAt`; no transition can follow it. */
  state: OrchestratorRun['state'];
  updatedAt: string;
}

export function runTimeline(
  run: OrchestratorRun,
  repo: WatchedRepo,
): RunTimeline {
  return {
    repo,
    createdAt: run.createdAt,
    transitions: run.events.map(({ at, to }) => ({ at, to })),
    state: run.state,
    updatedAt: run.updatedAt,
  };
}

/**
 * The run's state at instant `t`, or undefined before it existed. A state
 * change always rewrites `updatedAt`, so from then on the recorded state is
 * exact even if the bounded event list dropped a transition.
 */
export function runStateAt(
  timeline: RunTimeline,
  t: number,
): OrchestratorRun['state'] | undefined {
  if (t < Date.parse(timeline.createdAt)) return undefined;
  if (t >= Date.parse(timeline.updatedAt)) return timeline.state;
  let state: OrchestratorRun['state'] = 'pending';
  for (const transition of timeline.transitions) {
    if (Date.parse(transition.at) > t) break;
    state = transition.to;
  }
  return state;
}

/**
 * Queue depth (pending runs, queued or claimed) and agents running, sampled
 * at the end of each of the last RUN_HISTORY_MINUTES minutes; the newest
 * sample is `now`, the same instant the readout's own figure describes.
 */
export function runCountHistory(
  timelines: readonly RunTimeline[],
  now: number,
): { queued: number[]; running: number[] } {
  const queued: number[] = [];
  const running: number[] = [];
  for (let i = RUN_HISTORY_MINUTES - 1; i >= 0; i -= 1) {
    const t = now - i * 60_000;
    let pending = 0;
    let active = 0;
    for (const timeline of timelines) {
      const state = runStateAt(timeline, t);
      if (state === 'pending') pending += 1;
      else if (state === 'running') active += 1;
    }
    queued.push(pending);
    running.push(active);
  }
  return { queued, running };
}
