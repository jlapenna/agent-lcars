/**
 * Durable storage for `RecoveryObservation`s
 * (../../../../libs/dispatch-contracts/src/recovery-observation.ts) --
 * migration plan step 2's other half from
 * [#864](https://github.com/jlapenna/agent-lcars/issues/864): "write an
 * operation with a stable idempotency key before producing the side
 * effect."
 *
 * The shape mirrors `./port.ts`'s launch outbox deliberately, because the
 * recipe is the same one already proven there: record intent under an
 * idempotency key BEFORE the side effect, then resolve it after. What
 * `LaunchOutboxOperation` does for "did this attempt get dispatched",
 * `RecordedRecoveryOperation` does for "did this recovery domain's
 * observation get acted on" -- two instances of the same pattern, not two
 * designs. Unlike the launch outbox, a recovery operation is never
 * read-modify-written: the stored `observation` is whichever one arrived
 * FIRST for a given `operationKey` (see `recordObservation`), and only its
 * `status`/`detail` ever change afterward (`resolveRecoveryOperation`) --
 * which is also why this port needs no compare-and-swap precondition on
 * create, only a plain "does this key already exist" check.
 *
 * This port does not decide what counts as "acted on", does not call
 * GitHub, and is not wired into any live workflow yet. It is what
 * `apps/console`'s hosted ingestion endpoint (../../../console/src/app/api/
 * control-plane/recovery-observation/route.ts) is built on.
 */

import type { RecoveryObservation } from '@agent-lcars/dispatch-contracts';

export const RECOVERY_OPERATION_STATUSES = [
  /** Recorded; no resolution yet. */
  'pending',
  /** The owning domain's side effect ran because of this operation. */
  'executed',
  /** No side effect ran because an earlier operation already covered this
   *  exact key -- the dedup case #864 exists to guarantee. */
  'skipped_duplicate',
  /** The owning domain attempted the side effect and it failed; `detail`
   *  carries why. Still resolved, not pending -- a failed attempt is not
   *  silently retried by this port (see #645's "the owning system controls
   *  retry"; that policy belongs to whichever domain calls this port, not
   *  to the port itself). */
  'failed',
] as const;

export type RecoveryOperationStatus =
  (typeof RECOVERY_OPERATION_STATUSES)[number];

const RESOLVED_STATUSES: ReadonlySet<string> = new Set([
  'executed',
  'skipped_duplicate',
  'failed',
]);

/**
 * One durable recovery operation record: the first observation recorded for
 * `operationKey`, and how it was ultimately resolved.
 */
export interface RecordedRecoveryOperation {
  operationKey: string;
  /** The observation recorded for this key -- always the FIRST one seen,
   *  never overwritten by a later duplicate observation of the same fact
   *  (see `recordObservation`). */
  observation: RecoveryObservation;
  recordedAt: string;
  status: RecoveryOperationStatus;
  resolvedAt?: string;
  detail?: string;
}

/**
 * Thrown by `resolveRecoveryOperation` when `operationKey` was never
 * recorded -- resolving requires having recorded first, the same ordering
 * `./port.ts`'s `resolveLaunchOutcome` enforces for the same reason.
 */
export class RecoveryOperationNotRecordedError extends Error {
  constructor(public readonly operationKey: string) {
    super(
      `Cannot resolve recovery operation that was never recorded: ${operationKey}`,
    );
    this.name = 'RecoveryOperationNotRecordedError';
  }
}

/**
 * Thrown by `resolveRecoveryOperation` when `operationKey` is already
 * resolved to a DIFFERENT status/detail than requested. Idempotent when the
 * requested resolution matches the stored one exactly -- see that method's
 * own doc.
 */
export class RecoveryOperationAlreadyResolvedError extends Error {
  constructor(
    public readonly operationKey: string,
    public readonly existingStatus: RecoveryOperationStatus,
  ) {
    super(
      `Recovery operation ${operationKey} already resolved as ${existingStatus}; ` +
        'refusing to overwrite with a different resolution',
    );
    this.name = 'RecoveryOperationAlreadyResolvedError';
  }
}

export interface RecoveryOperationPort {
  /**
   * Record an observation under its `operationKey`. Idempotent: if a record
   * for this exact key already exists, returns the EXISTING record
   * unchanged -- the caller's new observation (a replayed webhook, a
   * scheduled sweep independently seeing the same fact) is evidence the
   * fact is still true, not a reason to overwrite who saw it first or reset
   * its resolution. This is what makes "webhook replay, scheduled
   * reconciliation, API polling, and operator requests may all observe the
   * same fact without duplicating its side effect" (#864) a property of
   * this port rather than something every caller has to implement itself.
   */
  recordObservation(
    observation: RecoveryObservation,
    now?: string,
  ): Promise<RecordedRecoveryOperation>;

  /**
   * Resolve a previously recorded operation. Throws
   * `RecoveryOperationNotRecordedError` if `operationKey` was never
   * recorded. Idempotent when the operation is already resolved to the
   * exact same `status`/`detail`; throws
   * `RecoveryOperationAlreadyResolvedError` if it is already resolved to a
   * different one, since a terminal resolution must never be silently
   * replaced.
   */
  resolveRecoveryOperation(
    operationKey: string,
    status: Exclude<RecoveryOperationStatus, 'pending'>,
    detail?: string,
    now?: string,
  ): Promise<RecordedRecoveryOperation>;

  /** Read one operation by its key. */
  readRecoveryOperation(
    operationKey: string,
  ): Promise<RecordedRecoveryOperation | undefined>;

  /** Every operation still `pending` -- recorded, never resolved. The
   *  primitive a reconciliation pass polls to find recovery observations
   *  that were accepted but never followed through on. This port does not
   *  implement that policy itself, matching `./port.ts`'s
   *  `listPendingLaunchOperations`. */
  listPendingRecoveryOperations(): Promise<RecordedRecoveryOperation[]>;
}

export function isResolvedStatus(status: RecoveryOperationStatus): boolean {
  return RESOLVED_STATUSES.has(status);
}
