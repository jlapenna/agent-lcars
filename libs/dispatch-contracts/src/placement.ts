import { z } from 'zod';

export const runPlacementSchema = z.strictObject({
  phase: z.enum(['waiting-for-placement', 'bootstrapping', 'unavailable']),
  // Allowlisted scheduler categories only; never raw node names/events.
  reason: z.enum([
    'pending',
    'unschedulable',
    'scheduled',
    'inventory-unavailable',
  ]),
  observedAt: z.iso.datetime({ offset: false }),
  jobCreatedAt: z.iso.datetime({ offset: false }).optional(),
});
export type RunPlacement = z.infer<typeof runPlacementSchema>;

/** Observation freshness follows the executor's existing three-heartbeat TTL.
 * Keep expiry on the source observation, never on a page refresh. */
export const PLACEMENT_STALENESS_MS = 180_000;

export type ExecutionPhase =
  | 'queued'
  | 'claimed'
  | 'waiting-for-placement'
  | 'bootstrapping'
  | 'provider-execution'
  | 'unavailable';

export interface ExecutionRun {
  state: string;
  queue?: {
    state: 'queued' | 'claimed';
    claimedAt?: string;
    startDeadlineAt?: string;
    firstHeartbeatAt?: string;
    providerProcessStartedAt?: string;
    placement?: RunPlacement;
  };
}

/** RunState remains the lifecycle/lease authority. Execution milestones are
 * separate; dispatch, a Job's active count and GitHub never prove execution. */
export function executionPhase(
  run: ExecutionRun,
  now = Date.now(),
): ExecutionPhase | undefined {
  if (run.state !== 'pending' && run.state !== 'running') return undefined;
  if (run.queue?.providerProcessStartedAt !== undefined)
    return 'provider-execution';
  if (run.queue?.firstHeartbeatAt !== undefined) return 'bootstrapping';
  if (run.queue === undefined)
    return run.state === 'pending' ? 'queued' : 'unavailable';
  if (run.queue.state === 'queued') return 'queued';
  const placement = run.queue.placement;
  if (placement === undefined) return 'claimed';
  const observed = Date.parse(placement.observedAt);
  if (
    !Number.isFinite(observed) ||
    now < observed ||
    now - observed > PLACEMENT_STALENESS_MS
  )
    return 'unavailable';
  return placement.phase;
}

export const EXECUTION_PHASE_LABELS: Record<ExecutionPhase, string> = {
  queued: 'Queued',
  claimed: 'Claimed · placement unavailable',
  'waiting-for-placement': 'Waiting for placement',
  bootstrapping: 'Bootstrapping',
  'provider-execution': 'Provider process started',
  unavailable: 'Placement unavailable',
};
