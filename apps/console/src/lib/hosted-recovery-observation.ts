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
 * Validate and durably record one recovery observation under App Hosting.
 * Recording is idempotent on `operationKey` -- a replayed webhook, a
 * scheduled sweep, or an operator independently reporting the same fact all
 * land on the same record (#864).
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
  // typo'd/forged numeric ID mint a second operationKey for what claims to
  // be the same fact, defeating the idempotency this endpoint exists to
  // provide.
  if (observation.target.repositoryId !== identity.repositoryId) {
    throw new HostedRecoveryObservationInputError(
      "Recovery observation target.repositoryId does not match the caller's " +
        'signed OIDC repository_id claim',
    );
  }

  return portFactory().recordObservation(observation);
}
