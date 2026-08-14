import 'server-only';

import { createHash } from 'node:crypto';

import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';

import type {
  WorkerGrantOidcClaims,
  WorkerGrantOidcVerifier,
} from './credential-grant-oidc';

export const GITHUB_ACTIONS_OIDC_ISSUER =
  'https://token.actions.githubusercontent.com';
export const CREDENTIAL_GRANT_OIDC_AUDIENCE = 'agent-lcars/credential-grant/v1';

const MAX_JWT_LENGTH = 16_384;
const MAX_JTI_LENGTH = 2_000;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const GIT_COMMIT_SHA = /^[a-f0-9]{40}$/u;
const githubActionsJwks = createRemoteJWKSet(
  new URL(`${GITHUB_ACTIONS_OIDC_ISSUER}/.well-known/jwks`),
);

type JwtVerificationKey = Parameters<typeof jwtVerify>[1];

export class WorkerGrantJwtVerificationError extends Error {
  constructor(message = 'GitHub WorkerGrant OIDC token is invalid') {
    super(message);
    this.name = 'WorkerGrantJwtVerificationError';
  }
}

function invalidClaim(name: string): never {
  throw new WorkerGrantJwtVerificationError(
    `GitHub WorkerGrant OIDC ${name} claim is invalid`,
  );
}

function stringClaim(
  payload: JWTPayload,
  name: string,
  maximumLength = 2_000,
): string {
  const value = payload[name];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    invalidClaim(name);
  }
  return value;
}

function positiveIntegerClaim(payload: JWTPayload, name: string): number {
  const value = payload[name];
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) invalidClaim(name);
  return parsed;
}

function audienceIncludesExpected(audience: JWTPayload['aud']): boolean {
  return typeof audience === 'string'
    ? audience === CREDENTIAL_GRANT_OIDC_AUDIENCE
    : Array.isArray(audience) &&
        audience.includes(CREDENTIAL_GRANT_OIDC_AUDIENCE);
}

function expiration(payload: JWTPayload): string {
  if (
    typeof payload.exp !== 'number' ||
    !Number.isSafeInteger(payload.exp) ||
    payload.exp <= 0
  ) {
    invalidClaim('exp');
  }
  try {
    return new Date(payload.exp * 1_000).toISOString();
  } catch {
    invalidClaim('exp');
  }
}

/**
 * Convert an already signature-verified GitHub JWT payload into the strict
 * normalized facts accepted by WorkerGrantOidcBoundary. Raw JWT/JTI material
 * deliberately does not survive this function.
 */
export function workerGrantClaimsFromJwtPayload(
  payload: JWTPayload,
): WorkerGrantOidcClaims {
  if (payload.iss !== GITHUB_ACTIONS_OIDC_ISSUER) invalidClaim('issuer');
  if (!audienceIncludesExpected(payload.aud)) invalidClaim('audience');

  const jti = stringClaim(payload, 'jti', MAX_JTI_LENGTH);
  const repository = stringClaim(payload, 'repository', 200);
  if (!REPOSITORY.test(repository)) invalidClaim('repository');
  const workflowSha = stringClaim(payload, 'workflow_sha', 40);
  if (!GIT_COMMIT_SHA.test(workflowSha)) invalidClaim('workflow_sha');

  const jobWorkflowRef = payload['job_workflow_ref'];
  const jobWorkflowSha = payload['job_workflow_sha'];
  if ((jobWorkflowRef === undefined) !== (jobWorkflowSha === undefined)) {
    invalidClaim('job_workflow_ref');
  }
  if (
    jobWorkflowRef !== undefined &&
    (typeof jobWorkflowRef !== 'string' ||
      jobWorkflowRef.length === 0 ||
      jobWorkflowRef.length > 2_000)
  ) {
    invalidClaim('job_workflow_ref');
  }
  if (
    jobWorkflowSha !== undefined &&
    (typeof jobWorkflowSha !== 'string' || !GIT_COMMIT_SHA.test(jobWorkflowSha))
  ) {
    invalidClaim('job_workflow_sha');
  }

  return {
    issuer: GITHUB_ACTIONS_OIDC_ISSUER,
    audience: CREDENTIAL_GRANT_OIDC_AUDIENCE,
    jtiSha256: createHash('sha256').update(jti).digest('hex'),
    expiresAt: expiration(payload),
    repositoryId: positiveIntegerClaim(payload, 'repository_id'),
    repository,
    runId: positiveIntegerClaim(payload, 'run_id'),
    runAttempt: positiveIntegerClaim(payload, 'run_attempt'),
    checkRunId: positiveIntegerClaim(payload, 'check_run_id'),
    workflowRef: stringClaim(payload, 'workflow_ref'),
    workflowSha,
    ...(jobWorkflowRef === undefined ? {} : { jobWorkflowRef }),
    ...(jobWorkflowSha === undefined ? {} : { jobWorkflowSha }),
  };
}

/**
 * Real GitHub signature adapter. It performs no HTTP routing, persistence,
 * tenant selection, or minting; createRemoteJWKSet fetches only GitHub's fixed
 * public signing keys when verification is invoked.
 */
export class GitHubWorkerGrantOidcVerifier implements WorkerGrantOidcVerifier {
  constructor(
    private readonly verificationKey: JwtVerificationKey = githubActionsJwks,
  ) {}

  async verify(raw: unknown): Promise<WorkerGrantOidcClaims> {
    if (
      typeof raw !== 'string' ||
      raw.length === 0 ||
      raw.length > MAX_JWT_LENGTH
    ) {
      throw new WorkerGrantJwtVerificationError();
    }
    try {
      const { payload } = await jwtVerify(raw, this.verificationKey, {
        issuer: GITHUB_ACTIONS_OIDC_ISSUER,
        audience: CREDENTIAL_GRANT_OIDC_AUDIENCE,
        algorithms: ['RS256'],
      });
      return workerGrantClaimsFromJwtPayload(payload);
    } catch {
      throw new WorkerGrantJwtVerificationError();
    }
  }
}
