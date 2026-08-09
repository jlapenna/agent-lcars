import 'server-only';

import {
  isWellFormedRecoveryObservation,
  type RecoveryObservation,
} from '@agent-lcars/dispatch-contracts';
import { FirestoreRecoveryOperationPort } from '@agent-lcars/dispatch-controller/storage/recovery-firestore-port';
import type { RecordedRecoveryOperation } from '@agent-lcars/dispatch-controller/storage/recovery-port';
import { required } from '@agent-lcars/util-server';

import { controlPlaneRepository } from './deployment';
import type { RecoveryObservationOidcIdentity } from './github-actions-oidc';

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
 * Record one recovery observation under App Hosting. This is migration plan
 * step 2's ingestion half from
 * [#864](https://github.com/jlapenna/agent-lcars/issues/864)/
 * [#869](https://github.com/jlapenna/agent-lcars/issues/869): validate,
 * confirm the caller's OIDC identity matches the observation's own claimed
 * repository, and record it durably under its idempotency key. It does not
 * decide what "acted on" means for any recovery domain, does not call
 * GitHub, and does not itself run shadow-mode comparison -- see #869's own
 * scope note for what is deliberately not here yet.
 */
export async function recordHostedRecoveryObservation({
  identity,
  body,
  portFactory = defaultPortFactory,
}: {
  identity: RecoveryObservationOidcIdentity;
  body: unknown;
  portFactory?: () => FirestoreRecoveryOperationPort;
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
  return port.recordObservation(observation);
}
