/**
 * ProjectionStatus: whether GitHub-facing state (comments, labels,
 * assignees, ...) has caught up with the ledger's own authoritative state.
 *
 * #645 Phase 4 §5 draws a hard line between two kinds of truth: the
 * ledger's `generations`/`control` (what actually happened — dispatch and
 * outcome authority, owned by the controller/finalizer) and the projector's
 * own convergence bookkeeping (whether GitHub has been made to reflect that
 * truth yet). Mixing the two is exactly what let a reporting failure look
 * like an outcome failure before this existed. `ProjectionStatus` is the
 * shared shape for the second kind, so "has GitHub caught up with the
 * outcome" is answerable by comparing two numbers instead of re-deriving it
 * per consumer.
 *
 * `desiredRevision`/`observedRevision` key off `DispatchLedger.revision`
 * (see ledger.ts's `mutate`) rather than minting a second counter: revision
 * already increments on every ledger write, controller- or projector-caused
 * alike, so it is already the right granularity for "how fresh is this
 * projection" without the projector needing its own clock.
 */

export const PROJECTION_CONVERGENCE_STATES = [
  /** No convergence attempt has been recorded yet. */
  'pending',
  /** `observedRevision === desiredRevision`: the last attempt's GitHub
   *  writes all succeeded. */
  'converged',
  /** The last convergence attempt failed; `observedRevision` still reflects
   *  the most recent revision that DID succeed (0 if there has never been
   *  one), not the failed attempt's target. */
  'diverged',
] as const;

export type ProjectionConvergenceState =
  (typeof PROJECTION_CONVERGENCE_STATES)[number];

/**
 * A convergence checkpoint. `desiredRevision` is the ledger revision the
 * projector was trying to catch GitHub up to; `observedRevision` is the
 * ledger revision GitHub has actually been made to reflect. Equal exactly
 * when `state === 'converged'`.
 */
export interface ProjectionStatus {
  desiredRevision: number;
  observedRevision: number;
  state: ProjectionConvergenceState;
  /** When this checkpoint was recorded. */
  observedAt: string;
}

const CONVERGENCE_STATES: ReadonlySet<string> = new Set(
  PROJECTION_CONVERGENCE_STATES,
);

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * Whether an arbitrary parsed value is a `ProjectionStatus` worth trusting.
 * Same posture as `isWellFormedFailureClassification`: a ledger comment is
 * hand-editable, so the read side re-validates against the same vocabulary
 * the write side (`recordProjectionStatus`, dispatch-broker's projector
 * module) is built from rather than trusting the shape blindly.
 */
export function isWellFormedProjectionStatus(
  value: unknown,
): value is ProjectionStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (!isNonNegativeInteger(candidate.desiredRevision)) return false;
  if (!isNonNegativeInteger(candidate.observedRevision)) return false;
  if (
    typeof candidate.state !== 'string' ||
    !CONVERGENCE_STATES.has(candidate.state)
  ) {
    return false;
  }
  if (
    typeof candidate.observedAt !== 'string' ||
    candidate.observedAt.length === 0
  ) {
    return false;
  }
  return true;
}
