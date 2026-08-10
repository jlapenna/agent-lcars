import 'server-only';

import type { RecoveryObservation } from '@agent-lcars/dispatch-contracts';
import { splitRepository } from '@agent-lcars/dispatch-controller/github-api';
import type { Octokit } from '@octokit/rest';

/**
 * Shadow-mode verification: #869's own last acceptance criterion,
 * "shadow-mode comparison records a mismatch without ever producing a live
 * side effect of its own." A `RecoveryObservation` is, structurally, the
 * same kind of thing `AgentResultClaim` already is elsewhere in this
 * codebase (`libs/dispatch-contracts/src/marker.ts`) -- an untrusted claim
 * from the worker/reporter that made it, never itself proof. The Outcome
 * finalizer does not trust an attempt-claim marker without independently
 * re-fetching the artifact it names; this module is the same discipline
 * applied to recovery observations: independently re-derive the claimed
 * fact from GitHub and compare, rather than recording whatever a caller
 * asserts as though recording it made it true.
 *
 * This is deliberately per-domain, not a generic comparator: what "verify
 * the claim" means is different for every `RecoveryDomain`, the same way
 * `AttemptOutcome` validation differs per artifact type. Only `ci_retry` has
 * a real caller today (`rerun-infra-killed-runs.yml`, #877) -- a verifier
 * for a domain nothing reports yet would be unused, untestable against a
 * real shape, and exactly the kind of speculative code this repo's own
 * engineering conventions warn against. Add the next domain's verifier when
 * that domain gets its own real caller, not before.
 */

export const VERIFICATION_OUTCOME_STATES = [
  /** The independently-fetched fact matches the observation's claim. */
  'confirmed',
  /** The independently-fetched fact contradicts the claim -- a genuine
   *  shadow-mode mismatch, recorded but never acted on. */
  'mismatch',
  /** Verification itself could not complete (a transient GitHub API
   *  failure, not a fact about the claim) -- distinct from `mismatch`
   *  because it says nothing about whether the claim is true. */
  'unavailable',
] as const;

export type VerificationOutcomeState =
  (typeof VERIFICATION_OUTCOME_STATES)[number];

export interface VerificationOutcome {
  state: VerificationOutcomeState;
  detail: string;
}

const CI_RETRY_EXACT_IDENTITY_RE = /^run:(\d+):(\d+)$/u;

/**
 * Verify a `ci_retry` observation: the claim is "GitHub run `runId` reached
 * attempt `runAttempt`", made by `rerun-infra-killed-runs` right after it
 * called the rerun-failed-jobs endpoint (main.ts). Independently re-fetch
 * the run and confirm GitHub's own `run_attempt` is at least the claimed
 * one -- exactly the same "was the run actually observed to have
 * concluded/exist, not merely asserted" posture `verify-deliverable.sh`
 * already applies to PR/comment/review claims.
 *
 * A 404 is a definitive contradiction (GitHub has no record of the run the
 * claim names), so it resolves `mismatch`, not `unavailable`. Any other
 * request failure (5xx, network, rate limit) says nothing about whether the
 * claim is true, so it resolves `unavailable` -- a caller should leave the
 * operation `pending` for that case rather than resolving it, the same
 * distinction `RecoveryOperationPort.resolveRecoveryOperation`'s own doc
 * draws between "never retried by this port" and a policy decision that
 * belongs to whoever calls it.
 */
export async function verifyCiRetryObservation(
  observation: RecoveryObservation,
  octokit: Octokit,
): Promise<VerificationOutcome> {
  const match = CI_RETRY_EXACT_IDENTITY_RE.exec(
    observation.target.exactIdentity,
  );
  if (!match) {
    return {
      state: 'mismatch',
      detail: `exactIdentity is not in the expected run:<id>:<attempt> shape: ${observation.target.exactIdentity}`,
    };
  }
  const runId = Number(match[1]);
  const claimedAttempt = Number(match[2]);
  const { owner, repo } = splitRepository(observation.target.repository);

  let runAttempt: number;
  try {
    const { data } = await octokit.rest.actions.getWorkflowRun({
      owner,
      repo,
      run_id: runId,
    });
    runAttempt = data.run_attempt ?? 0;
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (status === 404) {
      return {
        state: 'mismatch',
        detail: `GitHub has no run ${runId} in ${owner}/${repo}, but the observation claims it reached attempt ${claimedAttempt}`,
      };
    }
    return {
      state: 'unavailable',
      detail: `could not fetch run ${runId}: ${(error as Error).message}`,
    };
  }

  if (runAttempt < claimedAttempt) {
    return {
      state: 'mismatch',
      detail: `GitHub reports run ${runId} at attempt ${runAttempt}, but the observation claims attempt ${claimedAttempt} was already reached`,
    };
  }
  return {
    state: 'confirmed',
    detail: `GitHub confirms run ${runId} is at attempt ${runAttempt} (>= claimed ${claimedAttempt})`,
  };
}

/**
 * The only domain-to-verifier mapping that exists today -- see this
 * module's own header for why the others are deliberately absent, not
 * merely unimplemented.
 */
export function verifierForDomain(
  domain: RecoveryObservation['target']['domain'],
):
  | ((
      observation: RecoveryObservation,
      octokit: Octokit,
    ) => Promise<VerificationOutcome>)
  | undefined {
  return domain === 'ci_retry' ? verifyCiRetryObservation : undefined;
}
