import { createHash } from 'node:crypto';

import {
  attemptIdSchema,
  type CanonicalTaskIdentity,
  canonicalTaskIdentitySchema,
  positiveSafeIntegerSchema,
  sha256Schema,
  utcDateTimeSchema,
} from '@agent-lcars/dispatch-contracts';
import { z } from 'zod';

const rejections = new WeakSet<object>();

function frozenClone<T>(value: T): T {
  const seen = new WeakSet<object>();
  const freeze = (child: unknown): unknown => {
    if (child !== null && typeof child === 'object') {
      if (seen.has(child)) return child;
      seen.add(child);
      for (const nested of Object.values(child)) freeze(nested);
      Object.freeze(child);
    }
    return child;
  };
  return freeze(structuredClone(value)) as T;
}

/**
 * A server-verified proof that the exact launch operation definitely did not
 * create a run. This is deliberately not a provider response assertion.
 */
export interface DefinitiveNoRunProof {
  readonly tenantId: string;
  readonly repositoryId: number;
  readonly task: CanonicalTaskIdentity;
  readonly attemptId: string;
  readonly operationId: string;
  readonly executionEpoch: number;
  /** One-way canonical proof digest; raw evidence never enters storage. */
  readonly proofSha256: string;
}

export interface DefinitiveNoRunProofVerifier {
  verify(input: unknown): Promise<DefinitiveNoRunProof>;
}

/** Opaque, deeply immutable transition accepted by the authority store. */
export interface VerifiedLaunchRejection {
  readonly proof: DefinitiveNoRunProof;
  readonly expectedAttemptRevision: number;
  readonly rejectedAt: string;
}

export interface LaunchRejectionClock {
  now(): string;
}

const definitiveNoRunProofSchema = z.strictObject({
  tenantId: canonicalTaskIdentitySchema.shape.tenantId,
  repositoryId: canonicalTaskIdentitySchema.shape.repositoryId,
  task: canonicalTaskIdentitySchema,
  attemptId: attemptIdSchema,
  operationId: attemptIdSchema,
  executionEpoch: positiveSafeIntegerSchema,
  proofSha256: sha256Schema,
});

export function isVerifiedLaunchRejection(
  value: unknown,
): value is VerifiedLaunchRejection {
  return value !== null && typeof value === 'object' && rejections.has(value);
}

/**
 * Server boundary for definitive no-run evidence. It is intentionally the
 * only public minting path; the storage helper remains direct-import-only.
 */
export class DefinitiveNoRunBoundary {
  constructor(
    private readonly verifier: DefinitiveNoRunProofVerifier,
    private readonly clock: LaunchRejectionClock,
  ) {}

  async verify(input: {
    proof: unknown;
    expectedAttemptRevision: number;
  }): Promise<VerifiedLaunchRejection> {
    try {
      if (
        !Number.isSafeInteger(input.expectedAttemptRevision) ||
        input.expectedAttemptRevision < 1
      ) {
        throw new Error('invalid revision');
      }
      const parsed = definitiveNoRunProofSchema.safeParse(
        await this.verifier.verify(input.proof),
      );
      if (
        !parsed.success ||
        parsed.data.task.tenantId !== parsed.data.tenantId ||
        parsed.data.task.repositoryId !== parsed.data.repositoryId
      ) {
        throw new Error('invalid proof');
      }
      const rejectedAt = utcDateTimeSchema.safeParse(this.clock.now());
      if (!rejectedAt.success) throw new Error('invalid clock');
      const value = frozenClone({
        proof: structuredClone(parsed.data),
        expectedAttemptRevision: input.expectedAttemptRevision,
        rejectedAt: rejectedAt.data,
      });
      rejections.add(value);
      return value;
    } catch {
      throw new Error('Definitive no-run proof is invalid');
    }
  }
}

/** Deterministic terminal-decision identity; callers cannot choose it. */
export function launchRejectionEventId(input: {
  attemptId: string;
  operationId: string;
  executionEpoch: number;
}): string {
  return `launch-rejected:${createHash('sha256')
    .update(
      JSON.stringify({
        attemptId: input.attemptId,
        operationId: input.operationId,
        executionEpoch: input.executionEpoch,
      }),
    )
    .digest('hex')}`;
}
