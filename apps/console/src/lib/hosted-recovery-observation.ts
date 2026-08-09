import 'server-only';

import {
  isWellFormedRecoveryObservation,
  type RecoveryObservation,
} from '@agent-lcars/dispatch-contracts';
import { FirestoreRecoveryOperationPort } from '@agent-lcars/dispatch-controller/storage/recovery-firestore-port';
import type {
  RecordedRecoveryOperation,
  RecoveryOperationPort,
} from '@agent-lcars/dispatch-controller/storage/recovery-port';
import { RecoveryOperationAlreadyResolvedError } from '@agent-lcars/dispatch-controller/storage/recovery-port';
import { required } from '@agent-lcars/util-server';
import type { Octokit } from '@octokit/rest';

import { controlPlaneRepository } from './deployment';
import type { RecoveryObservationOidcIdentity } from './github-actions-oidc';
import { getGithubClient } from './github-client';
import type { VerificationOutcome } from './recovery-observation-verification';
import { verifierForDomain } from './recovery-observation-verification';

type RecoveryObservationVerifier = (
  observation: RecoveryObservation,
  octokit: Octokit,
) => Promise<VerificationOutcome>;

export class HostedRecoveryObservationInputError extends Error {}

/**
 * Same database `processHostedControllerEvent` (./hosted-controller.ts)
 * already writes controller authority to -- a new collection there, not a
 * new database. See recovery-firestore-port.ts's module header for why.
 */
function defaultPortFactory(): FirestoreRecoveryOperationPort {
  return new FirestoreRecoveryOperationPort({
    projectId: required('PROJECT_ID'),
    databaseId: required('DISPATCH_FIRESTORE_DATABASE_ID'),
  });
}

/**
 * Record one recovery observation under App Hosting, then shadow-verify it
 * when a verifier exists for its domain (#869's last acceptance criterion:
 * "shadow-mode comparison records a mismatch without ever producing a live
 * side effect of its own" -- see ./recovery-observation-verification.ts for
 * what "verify" means and why only `ci_retry` has one today).
 *
 * Verification runs whenever the recorded operation is still `pending` --
 * including on a REPLAYED observation for a key that was recorded earlier
 * but never resolved (a prior verification attempt that hit a transient
 * GitHub failure, say). That is not a special case this function adds: it
 * falls out directly of `recordObservation`'s own idempotence, the same way
 * #864 asks "webhook replay, scheduled reconciliation, API polling... may
 * all observe the same fact" to naturally retry whatever remains
 * unresolved, without this function needing its own retry policy.
 *
 * A verification failure (network error inside the verifier, a resolve
 * conflict from a concurrent duplicate) never fails this function or the
 * observation's own recording -- recording is the primary contract; a
 * verification result is best-effort on top of it, matching #645's "a
 * projection failure must never change outcome truth."
 */
export async function recordHostedRecoveryObservation({
  identity,
  body,
  portFactory = defaultPortFactory,
  // A factory, like portFactory, not a default-valued parameter: a default
  // VALUE (`octokit = getGithubClient()`) is evaluated at call time as part
  // of argument binding, before this function's own body -- including
  // every validation check above -- ever runs. That made every validation
  // failure in this function throw getGithubClient()'s
  // "AGENT_LCARS_GITHUB_TOKEN not defined" instead of
  // HostedRecoveryObservationInputError whenever a caller (a test, in
  // particular) omitted octokit, even though nothing in the invalid-input
  // path ever needed a GitHub client at all. A factory is only invoked once
  // shadow verification is actually about to run.
  octokitFactory = getGithubClient,
}: {
  identity: RecoveryObservationOidcIdentity;
  body: unknown;
  portFactory?: () => FirestoreRecoveryOperationPort;
  octokitFactory?: () => Octokit;
}): Promise<RecordedRecoveryOperation> {
  if (!isWellFormedRecoveryObservation(body)) {
    throw new HostedRecoveryObservationInputError(
      'Request body is not a well-formed RecoveryObservation',
    );
  }
  const observation = body as RecoveryObservation;

  const expectedRepository = controlPlaneRepository();
  if (identity.repository !== expectedRepository) {
    throw new HostedRecoveryObservationInputError(
      'Recovery observation repository does not match the control plane',
    );
  }
  if (observation.target.repository !== expectedRepository) {
    throw new HostedRecoveryObservationInputError(
      "Recovery observation target.repository does not match the caller's " +
        'own OIDC identity -- reporting an observation about a different ' +
        'repository than the one making the request is not yet supported ' +
        '(see #870)',
    );
  }
  // The signed OIDC repositoryId claim is the trusted identity;
  // target.repositoryId is caller-supplied data embedded in operationKey.
  // Checking only the repository slug string above would let a
  // typo'd/forged numeric ID (the slug can still read "jlapenna/agent-lcars"
  // while the ID does not) mint a second operationKey for what claims to be
  // the same fact, defeating the idempotency this endpoint exists to
  // provide, and would leave a stored record whose slug and ID disagree.
  if (observation.target.repositoryId !== identity.repositoryId) {
    throw new HostedRecoveryObservationInputError(
      "Recovery observation target.repositoryId does not match the caller's " +
        'signed OIDC repository_id claim',
    );
  }

  const port = portFactory();
  const recorded = await port.recordObservation(observation);
  if (recorded.status !== 'pending') {
    // Already resolved by an earlier request for this exact operationKey --
    // nothing left to verify.
    return recorded;
  }

  const verify = verifierForDomain(observation.target.domain);
  if (!verify) return recorded;

  return shadowVerifyAndResolve({
    port,
    recorded,
    verify,
    octokit: octokitFactory(),
  });
}

async function shadowVerifyAndResolve({
  port,
  recorded,
  verify,
  octokit,
}: {
  port: RecoveryOperationPort;
  recorded: RecordedRecoveryOperation;
  verify: RecoveryObservationVerifier;
  octokit: Octokit;
}): Promise<RecordedRecoveryOperation> {
  let outcome: VerificationOutcome;
  try {
    outcome = await verify(recorded.observation, octokit);
  } catch (error) {
    console.warn(
      `agent-lcars: shadow verification threw for ${recorded.operationKey}`,
      error,
    );
    return recorded;
  }
  if (outcome.state === 'unavailable') {
    // Says nothing about whether the claim is true -- leave pending for a
    // later replay/retry to pick up, per this function's own doc.
    console.warn(
      `agent-lcars: shadow verification unavailable for ${recorded.operationKey}: ${outcome.detail}`,
    );
    return recorded;
  }

  const status = outcome.state === 'confirmed' ? 'executed' : 'failed';
  try {
    return await port.resolveRecoveryOperation(
      recorded.operationKey,
      status,
      outcome.detail,
    );
  } catch (error) {
    // A concurrent duplicate request may have already resolved this
    // operation (to the same or a different resolution) between our record
    // and our resolve. Either way this request's own observation was
    // already durably recorded before we got here; losing a resolve race
    // is not a reason to fail it.
    if (!(error instanceof RecoveryOperationAlreadyResolvedError)) {
      console.warn(
        `agent-lcars: could not resolve ${recorded.operationKey} after shadow verification`,
        error,
      );
    }
    return recorded;
  }
}
