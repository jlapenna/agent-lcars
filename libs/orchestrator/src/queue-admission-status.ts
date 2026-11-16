import { isLive, type Run } from './model';
import {
  type ProviderCooldown,
  providerIsCoolingDown,
} from './provider-cooldown';

/** Server-owned direct-runner admission ceilings. OpenCode protects the
 * shared inference backend; Codex has one subscription credential lease.
 * Claude remains bounded by host capacity. Each claw agent's ceiling is its
 * registry `maxLiveClaims` (unified-dataflow design, "`claw`"). */
export const QUEUE_PIPELINE_MAX_LIVE_CLAIMS: Readonly<
  Record<string, number | undefined>
> = Object.freeze({
  codex: 1,
  opencode: 1,
  'inbox-summary': 3,
  'handoff-summary': 1,
  'claw-investigator': 2,
});

/** Codex runs share one subscription login. A run claimed at time C cannot
 * still be executing after C + 1 h (the placement wait bound) + 2 h (the pod
 * deadline). When the login's access token expires later than C plus this
 * horizon (those 3 h plus 30 min covering Codex's 5-minute early refresh and
 * clock skew), the run can never meet a refresh: it reads a
 * refresh-token-free copy, needs no exclusive lease, and Codex is bounded
 * only by host capacity. Otherwise it takes the single exclusive lease the
 * refresh token requires. Claim admission and restore apply this to the same
 * claim time, so a run admitted without the ceiling always restores shared. */
export const CODEX_SHARED_HORIZON_MS = (3 * 60 + 30) * 60_000;

/** Whether a Codex run claimed at `claimedAt` shares the login. */
export function codexRunSharesLogin(
  refreshDueAt: string | undefined,
  claimedAt: string,
): boolean {
  return (
    refreshDueAt !== undefined &&
    Date.parse(refreshDueAt) - CODEX_SHARED_HORIZON_MS > Date.parse(claimedAt)
  );
}

/** When a provider's shared login next refreshes, recorded by the Console
 * credential broker from the authoritative lineage it reads. */
export interface ProviderCredentialWindow {
  pipeline: string;
  refreshDueAt: string;
  observedAt: string;
}

/** A missing or bad record is no evidence of a shared window: it keeps the
 * exclusive ceiling, never an unbounded one. */
export function parseCredentialWindow(
  value: unknown,
  pipeline: string,
): ProviderCredentialWindow | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (
    record['pipeline'] !== pipeline ||
    typeof record['refreshDueAt'] !== 'string' ||
    !Number.isFinite(Date.parse(record['refreshDueAt'])) ||
    typeof record['observedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(record['observedAt']))
  )
    return undefined;
  return {
    pipeline,
    refreshDueAt: record['refreshDueAt'],
    observedAt: record['observedAt'],
  };
}

/** The live-claim ceiling actually in force for a pipeline now. */
export function pipelineLiveClaimCeiling(
  pipeline: string,
  now: string | undefined,
  credentialWindow?: unknown,
): number | undefined {
  if (pipeline === 'codex' && now !== undefined) {
    const window = parseCredentialWindow(credentialWindow, pipeline);
    if (codexRunSharesLogin(window?.refreshDueAt, now)) return undefined;
  }
  return QUEUE_PIPELINE_MAX_LIVE_CLAIMS[pipeline];
}

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
    run.credentialOperation === undefined &&
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
  credentialWindows: Readonly<Record<string, unknown>> = {},
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
      const maxLiveClaims = pipelineLiveClaimCeiling(
        pipeline,
        now,
        credentialWindows[pipeline],
      );
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
