import { isLive, type Run } from './model';
import {
  type ProviderCooldown,
  providerIsCoolingDown,
} from './provider-cooldown';

/** Server-owned direct-runner admission ceilings. OpenCode protects the
 * shared inference backend; Codex has one subscription credential lease.
 * Claude remains bounded by host capacity. */
export const QUEUE_PIPELINE_MAX_LIVE_CLAIMS: Readonly<
  Record<string, number | undefined>
> = Object.freeze({ codex: 1, opencode: 1 });

/** Bound console reads at the datastore. Exceeding this bound is unavailable,
 * never a truncated count presented as the entire queue. */
export const QUEUE_ADMISSION_READ_LIMIT = 1000;

export interface ProviderQueueAdmissionStatus {
  pipeline: string;
  queued: number;
  deferred: number;
  liveClaims: number;
  eligible: number;
  maxLiveClaims?: number;
  cooldown?: ProviderCooldown;
}

export interface QueueAdmissionStatus {
  observedAt: string;
  provenance: 'orchestrator';
  providers: ProviderQueueAdmissionStatus[];
}

/** The same durable queue eligibility predicate used by claim selection.
 * Host capacity, executor grants and external credential/GitHub checks occur
 * later; an eligible run is not a promise that a worker has started. */
export function isQueueAdmissionCandidate(run: Run, now?: string): boolean {
  return (
    isLive(run.state) &&
    run.queue?.state === 'queued' &&
    (now === undefined ||
      run.queue.deferredUntil === undefined ||
      run.queue.deferredUntil <= now)
  );
}

/** A bad durable record cannot support a healthy-provider claim in the UI. */
export function parseProviderCooldown(
  value: unknown,
  pipeline: string,
): ProviderCooldown | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object')
    throw new Error('Invalid provider cooldown');
  const record = value as Record<string, unknown>;
  if (
    record['pipeline'] !== pipeline ||
    typeof record['runId'] !== 'string' ||
    !record['runId'] ||
    typeof record['observedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(record['observedAt'])) ||
    typeof record['expiresAt'] !== 'string' ||
    !Number.isFinite(Date.parse(record['expiresAt']))
  )
    throw new Error('Invalid provider cooldown');
  return {
    pipeline,
    runId: record['runId'],
    observedAt: record['observedAt'],
    expiresAt: record['expiresAt'],
  };
}

export function projectQueueAdmissionStatus(
  runs: readonly Run[],
  cooldowns: ReadonlyMap<string, ProviderCooldown>,
  pipelines: readonly string[],
  now: string,
): QueueAdmissionStatus {
  if (!Number.isFinite(Date.parse(now)))
    throw new Error('Invalid observation time');
  return {
    observedAt: now,
    provenance: 'orchestrator',
    providers: [...new Set(pipelines)].map((pipeline) => {
      const live = runs.filter(
        (run) => run.pipeline === pipeline && isLive(run.state),
      );
      const queued = live.filter((run) => run.queue?.state === 'queued');
      const candidates = queued.filter((run) =>
        isQueueAdmissionCandidate(run, now),
      );
      const liveClaims = live.filter(
        (run) => run.queue?.state === 'claimed',
      ).length;
      const maxLiveClaims = QUEUE_PIPELINE_MAX_LIVE_CLAIMS[pipeline];
      const cooldown = cooldowns.get(pipeline);
      return {
        pipeline,
        queued: queued.length,
        deferred: queued.length - candidates.length,
        liveClaims,
        eligible:
          providerIsCoolingDown(cooldown, now) ||
          (maxLiveClaims !== undefined && liveClaims >= maxLiveClaims)
            ? 0
            : candidates.length,
        ...(maxLiveClaims === undefined ? {} : { maxLiveClaims }),
        ...(cooldown === undefined ? {} : { cooldown }),
      };
    }),
  };
}
