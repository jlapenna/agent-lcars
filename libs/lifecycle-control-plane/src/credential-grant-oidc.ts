import { createHash } from 'node:crypto';

import type {
  CredentialGrantResult,
  RunBinding,
  TenantRef,
} from '@agent-lcars/dispatch-contracts';
import {
  credentialGrantRequestSchema,
  runBindingSchema,
  utcDateTimeSchema,
} from '@agent-lcars/dispatch-contracts';
import { z } from 'zod';

import type { LifecycleAuthorityStorage } from './authority-storage';
import { InstallationTokenMinterBoundary } from './mint-resolution';

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_COMMIT_SHA = /^[a-f0-9]{40}$/u;
const V1_MAX_ISSUANCES = 1;
const verifiedWorkerGrants = new WeakSet<object>();

export class CredentialGrantConflict extends Error {
  override name = 'CredentialGrantConflict';
}

/** Normalized signed facts only. Raw JWTs and headers never cross this API. */
const workerGrantOidcClaimsSchema = z
  .strictObject({
    issuer: z.string().min(1),
    audience: z.string().min(1),
    jtiSha256: z.string().regex(SHA256),
    expiresAt: utcDateTimeSchema,
    repositoryId: z.number().int().safe().positive(),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
    runId: z.number().int().safe().positive(),
    runAttempt: z.number().int().safe().positive(),
    checkRunId: z.number().int().safe().positive(),
    /** Raw GitHub `workflow_ref`: OWNER/REPO/PATH@REF. */
    workflowRef: z.string().min(1),
    workflowSha: z.string().regex(GIT_COMMIT_SHA),
    /** Raw reusable-workflow claims; present only as a complete pair. */
    jobWorkflowRef: z.string().min(1).optional(),
    jobWorkflowSha: z.string().regex(GIT_COMMIT_SHA).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.jobWorkflowRef === undefined) !==
      (value.jobWorkflowSha === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Reusable workflow ref and SHA must be present together',
      });
    }
  });
export type WorkerGrantOidcClaims = z.infer<typeof workerGrantOidcClaimsSchema>;

/** A future server-only JWT/JWKS adapter supplies this injected verifier. */
export interface WorkerGrantOidcVerifier {
  verify(raw: unknown): Promise<WorkerGrantOidcClaims>;
}

export interface ExpectedWorkerGrantOidcSource {
  issuer: string;
  audience: string;
  sourceId: string;
}

export interface VerifiedWorkerGrantOidc {
  readonly claims: WorkerGrantOidcClaims;
  readonly binding: RunBinding;
  readonly sourceId: string;
}

export function isVerifiedWorkerGrantOidc(
  value: unknown,
): value is VerifiedWorkerGrantOidc {
  return (
    value !== null &&
    typeof value === 'object' &&
    verifiedWorkerGrants.has(value)
  );
}

interface ParsedWorkflowRef {
  repository: string;
  workflowPath: string;
  workflowRef: string;
}

function parseWorkflowRef(value: unknown): ParsedWorkflowRef | undefined {
  if (typeof value !== 'string') return;
  const workflowMarker = '/.github/workflows/';
  const markerAt = value.indexOf(workflowMarker);
  const refAt = value.indexOf('@', markerAt + workflowMarker.length);
  if (markerAt <= 0 || refAt <= markerAt + workflowMarker.length) return;
  const repository = value.slice(0, markerAt);
  const workflowPath = value.slice(markerAt + 1, refAt);
  const workflowRef = value.slice(refAt + 1);
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
    !/^\.github\/workflows\/.+\.ya?ml$/u.test(workflowPath) ||
    workflowRef.length === 0
  )
    return;
  return { repository, workflowPath, workflowRef };
}

function exactBinding(claims: WorkerGrantOidcClaims): RunBinding | undefined {
  const workflow = parseWorkflowRef(claims.workflowRef);
  if (workflow === undefined) return;
  if (
    claims.jobWorkflowRef !== undefined &&
    parseWorkflowRef(claims.jobWorkflowRef) === undefined
  )
    return;
  const binding: RunBinding = {
    runId: claims.runId,
    runAttempt: claims.runAttempt,
    checkRunId: claims.checkRunId,
    workflowPath: workflow.workflowPath,
    workflowRef: workflow.workflowRef,
    workflowSha: claims.workflowSha,
    ...(claims.jobWorkflowRef === undefined
      ? {}
      : { jobWorkflowRef: claims.jobWorkflowRef }),
    ...(claims.jobWorkflowSha === undefined
      ? {}
      : { jobWorkflowSha: claims.jobWorkflowSha }),
  };
  return runBindingSchema.safeParse(binding).success ? binding : undefined;
}

/** Mints the only runtime capability accepted by the inactive coordinator. */
export class WorkerGrantOidcBoundary {
  constructor(
    private readonly verifier: WorkerGrantOidcVerifier,
    private readonly expected: ExpectedWorkerGrantOidcSource,
    private readonly clock: { now(): string },
  ) {}

  async verify(raw: unknown): Promise<VerifiedWorkerGrantOidc> {
    const parsedClaims = workerGrantOidcClaimsSchema.safeParse(
      await this.verifier.verify(raw),
    );
    if (!parsedClaims.success) {
      throw new CredentialGrantConflict('Verified OIDC claims are invalid');
    }
    const claims = parsedClaims.data;
    const now = this.clock.now();
    const binding = exactBinding(claims);
    const workflow = parseWorkflowRef(claims.workflowRef);
    if (
      binding === undefined ||
      workflow === undefined ||
      workflow.repository.toLowerCase() !== claims.repository.toLowerCase() ||
      !utcDateTimeSchema.safeParse(now).success ||
      claims.issuer !== this.expected.issuer ||
      claims.audience !== this.expected.audience ||
      this.expected.sourceId.length === 0 ||
      Date.parse(claims.expiresAt) <= Date.parse(now)
    ) {
      throw new CredentialGrantConflict('Verified OIDC claims are invalid');
    }
    const verified = Object.freeze({
      claims: Object.freeze(structuredClone(claims)),
      binding: Object.freeze(structuredClone(binding)),
      sourceId: this.expected.sourceId,
    });
    verifiedWorkerGrants.add(verified);
    return verified;
  }
}

/** Server-owned mapping from signed numeric repository identity to a tenant. */
export interface GrantTenantResolver {
  resolve(repositoryId: number): Promise<TenantRef | undefined>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}

/** Stable digest for the exact OIDC proof plus persisted authority context. */
export function credentialGrantIdentityDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function sameBinding(left: RunBinding, right: RunBinding): boolean {
  return (
    left.runId === right.runId &&
    left.runAttempt === right.runAttempt &&
    left.checkRunId === right.checkRunId &&
    left.workflowPath === right.workflowPath &&
    left.workflowRef === right.workflowRef &&
    left.workflowSha === right.workflowSha &&
    left.jobWorkflowRef === right.jobWorkflowRef &&
    left.jobWorkflowSha === right.jobWorkflowSha
  );
}

function existingResult(
  issuance: Awaited<ReturnType<LifecycleAuthorityStorage['readMint']>>,
): CredentialGrantResult {
  if (issuance === undefined)
    throw new CredentialGrantConflict('Mint reservation disappeared');
  if (issuance.issuanceState === 'issued')
    return { kind: 'denied', code: 'already_issued_no_replay' };
  if (issuance.issuanceState === 'terminal')
    return { kind: 'terminal', terminalState: issuance.terminalState };
  if (
    issuance.issuanceState === 'denied' &&
    issuance.mintState === 'not-started'
  )
    return { kind: 'denied', code: issuance.denialCode };
  return {
    kind: 'denied',
    code:
      issuance.mintState === 'mint-unknown'
        ? 'mint_unknown'
        : 'mint_in_progress',
  };
}

/**
 * Inactive coordinator: no HTTP, JWT/JWKS, GitHub, secrets, or deployment.
 * The successful return is the sole ephemeral token-bearing value.
 */
export class CredentialGrantCoordinator {
  constructor(
    private readonly storage: LifecycleAuthorityStorage,
    private readonly tenants: GrantTenantResolver,
    private readonly minter: InstallationTokenMinterBoundary,
    private readonly clock: { now(): string },
  ) {}

  async issue(input: {
    request: unknown;
    verified: VerifiedWorkerGrantOidc;
  }): Promise<CredentialGrantResult> {
    if (!isVerifiedWorkerGrantOidc(input.verified))
      throw new CredentialGrantConflict('OIDC capability was not minted here');
    const parsed = credentialGrantRequestSchema.safeParse(input.request);
    if (!parsed.success)
      throw new CredentialGrantConflict('Grant request is invalid');
    const request = parsed.data;
    const claims = input.verified.claims;
    const now = this.clock.now();
    if (!utcDateTimeSchema.safeParse(now).success) {
      throw new CredentialGrantConflict('CredentialGrant clock is invalid');
    }
    // A runtime capability does not extend the lifetime of the signed proof.
    if (Date.parse(claims.expiresAt) <= Date.parse(now)) {
      return { kind: 'denied', code: 'oidc_invalid' };
    }
    const tenant = await this.tenants.resolve(claims.repositoryId);
    if (tenant === undefined || tenant.repositoryId !== claims.repositoryId)
      return { kind: 'denied', code: 'tenant_mismatch' };
    const attempt = await this.storage.readAttempt({
      tenantId: tenant.tenantId,
      attemptId: request.attemptId,
    });
    if (
      attempt === undefined ||
      attempt.spec.tenant.tenantId !== tenant.tenantId ||
      attempt.spec.tenant.repositoryId !== tenant.repositoryId ||
      attempt.spec.tenant.installationId !== tenant.installationId
    )
      return { kind: 'denied', code: 'tenant_mismatch' };
    if (attempt.phase === 'terminal' && attempt.outcome !== undefined)
      return { kind: 'terminal', terminalState: attempt.outcome.terminalState };
    if (attempt.phase !== 'active')
      return { kind: 'denied', code: 'attempt_not_active' };
    if (Date.parse(now) >= Date.parse(attempt.spec.execution.renewalDeadline))
      return { kind: 'denied', code: 'renewal_deadline_elapsed' };
    const binding = input.verified.binding;
    if (attempt.binding === undefined || !sameBinding(attempt.binding, binding))
      return { kind: 'denied', code: 'binding_mismatch' };
    const credentialProfileId = attempt.spec.execution.credentialProfileId;
    const identity = {
      tenantId: tenant.tenantId,
      repositoryId: tenant.repositoryId,
      attemptId: request.attemptId,
      sourceIdentity: `${claims.issuer}:${claims.audience}:${input.verified.sourceId}`,
      binding,
      requestId: request.requestId,
      jtiSha256: claims.jtiSha256,
      canonicalDigest: credentialGrantIdentityDigest({
        requestId: request.requestId,
        attemptId: request.attemptId,
        issuer: claims.issuer,
        audience: claims.audience,
        sourceId: input.verified.sourceId,
        jtiSha256: claims.jtiSha256,
        expiresAt: claims.expiresAt,
        repositoryId: claims.repositoryId,
        repository: claims.repository.toLowerCase(),
        localAttemptMarker: attempt.spec.local.attemptMarker,
        binding,
        specDigest: attempt.specDigest,
        activation: attempt.spec.activation,
        credentialProfileId,
        tenantId: tenant.tenantId,
        tenantRepositoryId: tenant.repositoryId,
        installationId: tenant.installationId,
      }),
    };
    const reservation = await this.storage.lookupOrReserveMint({
      identity,
      credentialProfileId,
      maxIssuances: V1_MAX_ISSUANCES,
    });
    if (reservation.status === 'existing')
      return existingResult(reservation.grant);
    const grant = reservation.grant;
    if (
      grant.issuanceState !== 'pending' ||
      grant.mintState !== 'mint-in-progress' ||
      grant.mintStartedAt === undefined
    ) {
      throw new CredentialGrantConflict('Created mint reservation is invalid');
    }
    const plan = {
      installationId: tenant.installationId,
      repositoryId: tenant.repositoryId,
      credentialProfileId,
    };
    try {
      const minted = await this.minter.mint(
        plan,
        grant as Extract<typeof grant, { issuanceState: 'pending' }>,
      );
      await this.storage.resolveVerifiedMint({
        tenantId: tenant.tenantId,
        attemptId: request.attemptId,
        verified: minted,
      });
      if (
        minted.issuance.issuanceState !== 'issued' ||
        minted.token === undefined
      ) {
        return { kind: 'denied', code: 'service_unavailable' };
      }
      // The provider may finish after a request that began just before the
      // immutable deadline. Retain the known exposure, but never deliver the
      // now-out-of-policy token to the worker.
      if (
        Date.parse(minted.issuance.issuedAt) >=
        Date.parse(attempt.spec.execution.renewalDeadline)
      ) {
        return { kind: 'denied', code: 'renewal_deadline_elapsed' };
      }
      return {
        kind: 'issued',
        token: minted.token,
        grantId: grant.grantId,
        credentialProfileId,
        issuedAt: minted.issuance.issuedAt,
        tokenExpiresAt: minted.issuance.tokenExpiresAt,
        renewalDeadline: attempt.spec.execution.renewalDeadline,
        maxResidualTokenExpiry: minted.issuance.maxResidualTokenExpiry,
      };
    } catch {
      await this.storage.resolveMint({
        tenantId: tenant.tenantId,
        attemptId: request.attemptId,
        grant: {
          ...grant,
          issuanceState: 'denied',
          mintState: 'mint-unknown',
          denialCode: 'mint_unknown',
          maxResidualTokenExpiry: new Date(
            Date.parse(grant.mintStartedAt) + 60 * 60 * 1000,
          ).toISOString(),
        },
      });
      return { kind: 'denied', code: 'mint_unknown' };
    }
  }
}
