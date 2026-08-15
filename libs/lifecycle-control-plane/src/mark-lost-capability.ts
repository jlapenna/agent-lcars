import { createHash } from 'node:crypto';

import {
  canonicalDurableJson,
  utcDateTimeSchema,
} from '@agent-lcars/dispatch-contracts';

import {
  hasMarkLostEligibilityFence,
  isMarkLostEligibilityReceipt,
  type MarkLostEligibilityReceipt,
} from './mark-lost-eligibility';

const terminations = new WeakSet<object>();

/**
 * The structural part of a task lease that a mark-lost receipt is pinned to.
 * Declared locally so the capability never depends on the storage module it is
 * consumed by.
 */
export interface MarkLostLeaseIdentity {
  readonly taskKey: string;
  readonly ownerId: string;
  readonly fence: number;
}

export interface MarkLostClock {
  now(): string;
}

/**
 * Opaque, deeply immutable terminal decision accepted by the authority store.
 * Structural shape is never sufficient; only this module mints it.
 */
export interface VerifiedMarkLostTermination {
  readonly receipt: MarkLostEligibilityReceipt;
  readonly terminatedAt: string;
}

export function isVerifiedMarkLostTermination(
  value: unknown,
): value is VerifiedMarkLostTermination {
  return value !== null && typeof value === 'object' && terminations.has(value);
}

/**
 * The exact lease incarnation an eligibility receipt is pinned to. Eligibility
 * is validated under this token and the storage transaction recomputes it from
 * its own lease, so a receipt minted under one lease cannot commit under a
 * later one. The token is derived, never a recoverable lease secret.
 */
export function markLostLeaseFence(lease: MarkLostLeaseIdentity): string {
  return `mark-lost-fence:${createHash('sha256')
    .update(
      canonicalDurableJson({
        taskKey: lease.taskKey,
        ownerId: lease.ownerId,
        fence: lease.fence,
      }),
    )
    .digest('hex')}`;
}

/**
 * Server boundary for a verified loss decision. It is intentionally the only
 * public minting path; the storage transaction remains direct-import-only.
 */
export class MarkLostBoundary {
  constructor(private readonly clock: MarkLostClock) {}

  verify(input: {
    receipt: unknown;
    lease: MarkLostLeaseIdentity;
  }): VerifiedMarkLostTermination {
    try {
      const receipt = input.receipt;
      if (
        !isMarkLostEligibilityReceipt(receipt) ||
        !hasMarkLostEligibilityFence(receipt, markLostLeaseFence(input.lease))
      ) {
        throw new Error('invalid receipt');
      }
      const terminatedAt = utcDateTimeSchema.safeParse(this.clock.now());
      if (!terminatedAt.success) throw new Error('invalid clock');
      // ISO-8601 fractional precision varies, so loss can only be decided
      // after eligibility on the instant timeline, never lexically.
      const decidedAt = Date.parse(terminatedAt.data);
      const eligibleAt = Date.parse(receipt.eligibleAt);
      if (!Number.isFinite(decidedAt) || !Number.isFinite(eligibleAt))
        throw new Error('invalid clock');
      if (decidedAt < eligibleAt) throw new Error('clock regression');
      // The receipt is deliberately kept by reference: it is already
      // recursively frozen at its own boundary, and cloning it would discard
      // the nominal identity the storage transaction re-checks.
      const value = Object.freeze({ receipt, terminatedAt: terminatedAt.data });
      terminations.add(value);
      return value;
    } catch {
      throw new Error('Mark-lost eligibility receipt is invalid');
    }
  }
}

/**
 * Deterministic terminal-decision identity; callers cannot choose it. The
 * receipt identity participates so two distinct eligibility decisions for one
 * execution epoch can never collapse into one command.
 */
export function markLostEventId(input: {
  attemptId: string;
  launchOperationId: string;
  executionEpoch: number;
  receiptId: string;
}): string {
  return `mark-lost:${createHash('sha256')
    .update(
      JSON.stringify({
        attemptId: input.attemptId,
        launchOperationId: input.launchOperationId,
        executionEpoch: input.executionEpoch,
        receiptId: input.receiptId,
      }),
    )
    .digest('hex')}`;
}
