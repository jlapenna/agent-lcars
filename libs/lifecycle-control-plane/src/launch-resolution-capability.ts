import { createHash } from 'node:crypto';

import {
  type CanonicalTaskIdentity,
  utcDateTimeSchema,
} from '@agent-lcars/dispatch-contracts';

const SHA256 = /^[a-f0-9]{64}$/u;

const claimedWorks = new WeakSet<object>();
const resolutions = new WeakSet<object>();

function frozenClone<T>(value: T): T {
  const freeze = (child: unknown): unknown => {
    if (child !== null && typeof child === 'object') {
      for (const nested of Object.values(child)) freeze(nested);
      Object.freeze(child);
    }
    return child;
  };
  return freeze(structuredClone(value)) as T;
}

/** Storage-minted work; neither a client nor a worker may construct it. */
export interface VerifiedClaimedLaunchWork {
  readonly tenantId: string;
  readonly repositoryId: number;
  readonly task: CanonicalTaskIdentity;
  readonly attemptId: string;
  readonly operationId: string;
  readonly executionEpoch: number;
  readonly localAttemptMarker: string;
  readonly claimFence: number;
  readonly claimToken: string;
  /** A later fence may reconcile uncertainty, but never submit/accept again. */
  readonly permission: 'dispatch' | 'reconcile-unknown';
}

export type LaunchResolutionKind = 'accepted' | 'unknown';

export interface VerifiedLaunchResolution {
  readonly work: VerifiedClaimedLaunchWork;
  readonly kind: LaunchResolutionKind;
  /** Canonical one-way response/ambiguity identity; never raw provider data. */
  readonly responseSha256: string;
  readonly resolvedAt: string;
}

export interface LaunchResolutionClock {
  now(): string;
}

export interface TrustedLaunchResponseVerifier {
  resolve(input: {
    work: VerifiedClaimedLaunchWork;
  }): Promise<{ kind: LaunchResolutionKind; responseSha256: string }>;
}

export function isVerifiedClaimedLaunchWork(
  value: unknown,
): value is VerifiedClaimedLaunchWork {
  return value !== null && typeof value === 'object' && claimedWorks.has(value);
}

export function isVerifiedLaunchResolution(
  value: unknown,
): value is VerifiedLaunchResolution {
  return value !== null && typeof value === 'object' && resolutions.has(value);
}

/** Internal storage mint; deliberately absent from the package barrel. */
export function mintClaimedLaunchWork(
  input: VerifiedClaimedLaunchWork,
): VerifiedClaimedLaunchWork {
  const value = frozenClone(input);
  claimedWorks.add(value);
  return value;
}

/**
 * Injected response boundary. A fake can supply the result in tests; a future
 * provider adapter owns it in production. No response payload is persisted.
 */
export class LaunchResponseBoundary {
  constructor(
    private readonly verifier: TrustedLaunchResponseVerifier,
    private readonly clock: LaunchResolutionClock,
  ) {}

  async resolve(
    work: VerifiedClaimedLaunchWork,
  ): Promise<VerifiedLaunchResolution> {
    if (!isVerifiedClaimedLaunchWork(work)) {
      throw new Error('Launch work was not minted by storage');
    }
    const resolvedAt = utcDateTimeSchema.safeParse(this.clock.now());
    if (!resolvedAt.success) {
      throw new Error('Launch response clock is invalid');
    }
    const result = await this.verifier.resolve({ work });
    if (
      (result.kind !== 'accepted' && result.kind !== 'unknown') ||
      !SHA256.test(result.responseSha256)
    ) {
      throw new Error('Launch response boundary returned an invalid result');
    }
    const value = frozenClone({
      work,
      kind: result.kind,
      responseSha256: result.responseSha256,
      resolvedAt: resolvedAt.data,
    });
    resolutions.add(value);
    return value;
  }
}

/** Storage/coordinator-owned ambiguity for a later-fence abandoned dispatch. */
export function mintUnknownLaunchReconciliation(input: {
  work: VerifiedClaimedLaunchWork;
  resolvedAt: string;
}): VerifiedLaunchResolution {
  if (
    !isVerifiedClaimedLaunchWork(input.work) ||
    input.work.permission !== 'reconcile-unknown' ||
    !utcDateTimeSchema.safeParse(input.resolvedAt).success
  ) {
    throw new Error(
      'Unknown reconciliation needs storage-minted takeover work',
    );
  }
  const value = frozenClone({
    work: input.work,
    kind: 'unknown' as const,
    responseSha256: createHash('sha256')
      .update(
        JSON.stringify({
          attemptId: input.work.attemptId,
          operationId: input.work.operationId,
          executionEpoch: input.work.executionEpoch,
          claimFence: input.work.claimFence,
          claimToken: input.work.claimToken,
          ambiguity: 'abandoned-dispatch',
        }),
      )
      .digest('hex'),
    resolvedAt: input.resolvedAt,
  });
  resolutions.add(value);
  return value;
}

export function launchResolutionEventId(input: {
  attemptId: string;
  operationId: string;
  executionEpoch: number;
  kind: LaunchResolutionKind;
}): string {
  return `launch:${input.attemptId}:${input.operationId}:${input.executionEpoch}:${input.kind}`;
}
