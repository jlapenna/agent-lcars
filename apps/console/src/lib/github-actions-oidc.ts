import 'server-only';

import {
  COMPLETION_FINALIZER_WORKFLOW_PATH,
  COMPLETION_OIDC_AUDIENCE,
  RECOVERY_OBSERVATION_OIDC_AUDIENCE,
  WORKER_WORKFLOW_FILES,
} from '@agent-lcars/dispatch-contracts';
import {
  RECONCILE_OIDC_AUDIENCE,
  RECONCILE_WORKFLOW_PATH,
} from '@agent-lcars/dispatch-reconcile';
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';

const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';
const githubActionsJwks = createRemoteJWKSet(
  new URL(`${GITHUB_ACTIONS_ISSUER}/.well-known/jwks`),
);

export interface CompletionOidcIdentity {
  repository: string;
  repositoryId: number;
  runId: number;
  workflow: string;
}

export interface ReconcileOidcIdentity {
  repository: string;
  repositoryId: number;
  runId: number;
}

function positiveIntegerClaim(value: unknown, name: string): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`OIDC ${name} claim is not a positive safe integer`);
  }
  return parsed;
}

export function assertReconcileOidcClaims(
  claims: JWTPayload,
  repository: string,
): ReconcileOidcIdentity {
  const expectedWorkflowRef = `${repository}/${RECONCILE_WORKFLOW_PATH}@refs/heads/main`;
  if (claims['repository'] !== repository) {
    throw new Error('OIDC repository claim does not match the control plane');
  }
  if (claims['workflow_ref'] !== expectedWorkflowRef) {
    throw new Error('OIDC workflow_ref claim is not the reconciler on main');
  }
  if (claims['ref'] !== 'refs/heads/main') {
    throw new Error('OIDC ref claim is not main');
  }
  if (
    !['schedule', 'workflow_dispatch'].includes(String(claims['event_name']))
  ) {
    throw new Error('OIDC event_name claim is not an allowed reconciler event');
  }
  return {
    repository,
    repositoryId: positiveIntegerClaim(
      claims['repository_id'],
      'repository_id',
    ),
    runId: positiveIntegerClaim(claims['run_id'], 'run_id'),
  };
}

export async function verifyReconcileOidcToken(
  token: string,
  repository: string,
): Promise<ReconcileOidcIdentity> {
  const { payload } = await jwtVerify(token, githubActionsJwks, {
    issuer: GITHUB_ACTIONS_ISSUER,
    audience: RECONCILE_OIDC_AUDIENCE,
  });
  return assertReconcileOidcClaims(payload, repository);
}

export function assertCompletionOidcClaims(
  claims: JWTPayload,
  repository: string,
): CompletionOidcIdentity {
  if (claims['repository'] !== repository) {
    throw new Error('OIDC repository claim does not match the control plane');
  }
  if (claims['ref'] !== 'refs/heads/main') {
    throw new Error('OIDC ref claim is not main');
  }
  if (claims['event_name'] !== 'workflow_dispatch') {
    throw new Error('OIDC event_name claim is not workflow_dispatch');
  }
  const expectedFinalizerRef = `${repository}/${COMPLETION_FINALIZER_WORKFLOW_PATH}@refs/heads/main`;
  if (claims['job_workflow_ref'] !== expectedFinalizerRef) {
    throw new Error(
      'OIDC job_workflow_ref claim is not the trusted completion finalizer on main',
    );
  }
  const workflow = [...WORKER_WORKFLOW_FILES].find(
    (candidate) =>
      claims['workflow_ref'] ===
      `${repository}/.github/workflows/${candidate}@refs/heads/main`,
  );
  if (!workflow) {
    throw new Error('OIDC workflow_ref claim is not an allowed worker on main');
  }
  return {
    repository,
    repositoryId: positiveIntegerClaim(
      claims['repository_id'],
      'repository_id',
    ),
    runId: positiveIntegerClaim(claims['run_id'], 'run_id'),
    workflow,
  };
}

export async function verifyCompletionOidcToken(
  token: string,
  repository: string,
): Promise<CompletionOidcIdentity> {
  const { payload } = await jwtVerify(token, githubActionsJwks, {
    issuer: GITHUB_ACTIONS_ISSUER,
    audience: COMPLETION_OIDC_AUDIENCE,
  });
  return assertCompletionOidcClaims(payload, repository);
}

export type RecoveryObservationOidcIdentity = ReconcileOidcIdentity;

/**
 * Not pinned to one workflow path, unlike `assertReconcileOidcClaims`/
 * `assertCompletionOidcClaims` -- no workflow in this repository calls this
 * endpoint yet (see #869/#870), so there is no real caller to pin to. What
 * IS fixed, matching every other hosted endpoint here: the caller must be
 * `repository` itself on `main`. Extending trust to a consumer repository's
 * OIDC identity (`supersprinklesracing/sprinkles`, `jlapenna/homelab`) is a
 * deliberately separate, later change -- see #870 -- not something this
 * function does by broadening `repository` past a single exact match.
 */
export function assertRecoveryObservationOidcClaims(
  claims: JWTPayload,
  repository: string,
): RecoveryObservationOidcIdentity {
  if (claims['repository'] !== repository) {
    throw new Error('OIDC repository claim does not match the control plane');
  }
  if (claims['ref'] !== 'refs/heads/main') {
    throw new Error('OIDC ref claim is not main');
  }
  return {
    repository,
    repositoryId: positiveIntegerClaim(
      claims['repository_id'],
      'repository_id',
    ),
    runId: positiveIntegerClaim(claims['run_id'], 'run_id'),
  };
}

export async function verifyRecoveryObservationOidcToken(
  token: string,
  repository: string,
): Promise<RecoveryObservationOidcIdentity> {
  const { payload } = await jwtVerify(token, githubActionsJwks, {
    issuer: GITHUB_ACTIONS_ISSUER,
    audience: RECOVERY_OBSERVATION_OIDC_AUDIENCE,
  });
  return assertRecoveryObservationOidcClaims(payload, repository);
}
