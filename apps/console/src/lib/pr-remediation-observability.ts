import 'server-only';

import { logger } from '@agent-lcars/logging';

/** What asked for the remediation check. */
export type PrRemediationTrigger =
  'webhook' | 'run-settled' | 'merge-sweep' | 'open-sweep';

export type PrRemediationOutcome =
  'remediated' | 'rereviewed' | 'approved' | 'skipped' | 'error';

/** GitHub answered the GraphQL read with errors instead of data (rate limit,
 *  permission, query). Carries GitHub's bounded error types, never a body. */
export class PrRemediationGraphqlError extends Error {
  constructor(readonly types: readonly string[]) {
    super(
      `PR remediation GraphQL read returned errors: ${types.join(',') || 'unknown'}`,
    );
    this.name = 'PrRemediationGraphqlError';
  }
}

/** Bounded reason for an `error` outcome. */
export function prRemediationErrorReason(error: unknown): string {
  if (error instanceof PrRemediationGraphqlError) return 'graphql-error';
  if (
    error instanceof Error &&
    /GraphQL read failed \(\d+\)/u.test(error.message)
  )
    return 'github-http-error';
  if (error instanceof Error && error.name === 'TimeoutError')
    return 'github-timeout';
  return 'exception';
}

/**
 * One bounded event per automatic PR remediation check. Homelab's
 * homelab-lcars-webhooks census counts these from Cloud Logging, so
 * remediation that keeps failing alerts instead of leaving PRs blocked
 * silently: merge conflicts and review threads no longer reach the Decision
 * Inbox. Metadata only: repository and number identify a public PR; no titles,
 * bodies, logins or tokens.
 */
export function recordPrRemediationOutcome(event: {
  trigger: PrRemediationTrigger;
  outcome: PrRemediationOutcome;
  reason: string;
  repo: string;
  number: number;
  graphqlErrorTypes?: readonly string[];
}): void {
  logger.structured(
    event.outcome === 'error' ? 'warn' : 'info',
    'LCARS PR remediation outcome',
    {
      component: 'lcars-pr-remediation',
      trigger: event.trigger,
      outcome: event.outcome,
      reason: event.reason,
      repo: event.repo,
      number: event.number,
      ...(event.graphqlErrorTypes === undefined
        ? {}
        : { graphqlErrorTypes: [...event.graphqlErrorTypes] }),
    },
    { enrich: false },
  );
}

/** Blocked PRs that nothing has touched for this long count as stalled. */
export const PR_REMEDIATION_STALL_AFTER_MS = 2 * 60 * 60 * 1000;

export interface PrRemediationCensus {
  /** False when projections or per-PR reads were truncated or failed; a
   *  partial census must never read as healthy. */
  complete: boolean;
  /** Open, eligible PRs with a merge conflict or unresolved review threads. */
  blocked: number;
  /** Blocked PRs with a live run on the PR anchor. */
  running: number;
  /** Blocked PRs a waiting delivery binding owns. */
  deliveryOwned: number;
  /** Blocked PRs with no live run, no delivery owner, and no PR or run
   *  activity for `PR_REMEDIATION_STALL_AFTER_MS`. */
  stalled: number;
  oldestStalledSeconds: number;
  /** Bounded sample for the operator; Homelab exports counts only. */
  stalledPullRequests: string[];
}

/** One event per maintenance sweep (five-minute ticker). Its absence means
 *  the sweep itself stopped. */
export function recordPrRemediationCensus(census: PrRemediationCensus): void {
  logger.structured(
    census.stalled > 0 || !census.complete ? 'warn' : 'info',
    'LCARS PR remediation census',
    {
      component: 'lcars-pr-remediation-census',
      complete: census.complete,
      blocked: census.blocked,
      running: census.running,
      deliveryOwned: census.deliveryOwned,
      stalled: census.stalled,
      oldestStalledSeconds: census.oldestStalledSeconds,
      stallAfterSeconds: PR_REMEDIATION_STALL_AFTER_MS / 1000,
      stalledPullRequests: census.stalledPullRequests.slice(0, 20),
    },
    { enrich: false },
  );
}
