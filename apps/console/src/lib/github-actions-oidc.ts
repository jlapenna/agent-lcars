import 'server-only';

import {
  COMPLETION_FINALIZER_WORKFLOW_PATH,
  COMPLETION_OIDC_AUDIENCE,
  WORKER_WORKFLOW_FILES,
} from '@agent-lcars/dispatch-contracts';
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';

import { controlPlaneRepository } from './deployment';

// Inlined from the now-deleted @agent-lcars/dispatch-reconcile (#1015 Wave
// 4: that lib's scan/discovery/dispatch machinery was only ever consumed by
// the deleted apps/console/src/lib/hosted-reconciler.ts -- these two
// constants were its only surviving live use, verifying the scheduled
// reconciler's OIDC identity for /api/control-plane/reconcile, now served
// by the orchestrator's handleReconcile).
const RECONCILE_OIDC_AUDIENCE = 'agent-lcars-dispatch-reconcile';
const RECONCILE_WORKFLOW_PATH = '.github/workflows/dispatch-reconcile.yml';

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

/**
 * The one shared, GitHub-hosted completion finalizer every onboarded repo's
 * worker calls as a reusable workflow (`workflow_call`) -- there is no
 * per-repo copy. For a cross-repo `workflow_call`, GitHub's OIDC token
 * claims `job_workflow_ref` from the CALLED workflow's own repo/path/ref
 * (this constant), while `repository`/`workflow_ref` continue to name the
 * CALLER. So this is pinned to the home repo regardless of which
 * allow-listed repository claimed the token -- derived from
 * {@link controlPlaneRepository}, not a second hardcoded string.
 */
function canonicalCompletionFinalizerWorkflowRef(): string {
  return `${controlPlaneRepository()}/${COMPLETION_FINALIZER_WORKFLOW_PATH}@refs/heads/main`;
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
  if (
    claims['job_workflow_ref'] !== canonicalCompletionFinalizerWorkflowRef()
  ) {
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

/**
 * Verifies signature/issuer/audience, then checks the *claimed* repository
 * (from the now-trusted payload) against the allow-list before running the
 * existing per-repo claim assertions with that claimed repository.
 *
 * This is #1190's generalization from a single pinned repository to an
 * allow-list. The `workflow_ref` half of
 * {@link assertCompletionOidcClaims}'s formula is still built from *that*
 * caller's own repository (a token claiming repo A can never be validated
 * against repo B's worker paths), but `job_workflow_ref` is pinned to the
 * one shared fleet finalizer in the home repo for every caller -- see
 * {@link canonicalCompletionFinalizerWorkflowRef}. With the default,
 * single-repo config the claimed repository IS the home repo, so the two
 * formulas coincide and nothing observably changes.
 */
export async function verifyCompletionOidcToken(
  token: string,
  allowedRepositories: string[],
): Promise<CompletionOidcIdentity> {
  const { payload } = await jwtVerify(token, githubActionsJwks, {
    issuer: GITHUB_ACTIONS_ISSUER,
    audience: COMPLETION_OIDC_AUDIENCE,
  });
  const claimedRepository = payload['repository'];
  if (
    typeof claimedRepository !== 'string' ||
    !allowedRepositories.includes(claimedRepository)
  ) {
    throw new Error(
      'OIDC repository claim is not an allow-listed control-plane repository',
    );
  }
  return assertCompletionOidcClaims(payload, claimedRepository);
}
