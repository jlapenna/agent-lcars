/**
 * Durable storage for `RecoveryObservation`s
 * (../../../../libs/dispatch-contracts/src/recovery-observation.ts) --
 * migration plan step 2's other half from
 * [#864](https://github.com/jlapenna/agent-lcars/issues/864): "write an
 * operation with a stable idempotency key before producing the side
 * effect."
 *
 * One primitive only: an idempotent create keyed on `operationKey`. The
 * first observation recorded for a key wins; every later duplicate (a
 * replayed webhook, a scheduled sweep independently seeing the same fact)
 * returns the existing record unchanged. That single property is what makes
 * "webhook replay, scheduled reconciliation, API polling, and operator
 * requests may all observe the same fact without duplicating its side
 * effect" (#864) a property of this port rather than something every caller
 * has to implement itself.
 *
 * This port does not decide what counts as "acted on", does not call
 * GitHub, and carries no resolution state machine. It backs `apps/console`'s
 * hosted ingestion endpoint (../../../console/src/app/api/control-plane/
 * recovery-observation/route.ts).
 */

import type { RecoveryObservation } from '@agent-lcars/dispatch-contracts';

/** One durable recovery operation record: the first observation recorded
 *  for `operationKey`. */
export interface RecordedRecoveryOperation {
  operationKey: string;
  /** The observation recorded for this key -- always the FIRST one seen,
   *  never overwritten by a later duplicate observation of the same fact
   *  (see `recordObservation`). */
  observation: RecoveryObservation;
  recordedAt: string;
}

export interface RecoveryOperationPort {
  /**
   * Record an observation under its `operationKey`. Idempotent: if a record
   * for this exact key already exists, returns the EXISTING record
   * unchanged.
   */
  recordObservation(
    observation: RecoveryObservation,
    now?: string,
  ): Promise<RecordedRecoveryOperation>;

  /** Read one operation by its key. */
  readRecoveryOperation(
    operationKey: string,
  ): Promise<RecordedRecoveryOperation | undefined>;
}
