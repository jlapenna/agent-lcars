/**
 * Classifies a completed worker attempt's typed lifecycle outcome
 * (`DispatchOutcomeKind`) into a `FailureClassification` (agent-lcars#813).
 *
 * Pure and side-effect free -- no GitHub I/O, no ledger write. This is the
 * ONE place that decides which outcome kinds mean "the attempt failed" and
 * how to classify each one; `projector.ts`'s `projectWorkerFailure` is the
 * only caller, and it does the actual comment/park I/O with whatever this
 * returns.
 *
 * Every classification here uses `retryDisposition: 'manual'`: a completed
 * worker attempt cannot be retried by this layer at all -- retrying means
 * dispatching a fresh generation, which is a maintainer decision (a new
 * `agent:*` label or an explicit redispatch), not something the projector or
 * controller does automatically. That is what makes `needsMaintainer()`
 * (`@agent-lcars/dispatch-contracts`) true for all three and therefore what
 * makes `projectNeedsHumanPark` always park a reported worker failure --
 * consistent with `report-failure.sh`'s prior unconditional park, just
 * routed through the one shared policy function instead of asserting the
 * label directly.
 */
import type {
  DispatchOutcomeKind,
  FailureClassification,
} from '@agent-lcars/dispatch-contracts';
import {
  classifyFailure,
  isFailureOutcomeKind,
} from '@agent-lcars/dispatch-contracts';

export function classifyWorkerFailureOutcome(
  outcome: DispatchOutcomeKind,
): FailureClassification | undefined {
  if (!isFailureOutcomeKind(outcome)) return undefined;
  switch (outcome) {
    case 'startup-failure':
      // The agent step's own name was absent or `skipped` in GitHub's job
      // metadata -- the finalizer's own trusted, callback-derived signal
      // (agent-fallback-finalize.yml's "Derive trusted completion
      // evidence"). Nothing finer is knowable from a completion callback
      // alone; the job's own log is where a maintainer finds whether it was
      // token-mint, checkout, or tool-setup specifically.
      return classifyFailure({
        phase: 'bootstrap',
        reason: 'worker_startup_failed',
        retryDisposition: 'manual',
        evidence:
          'Worker lifecycle outcome reported startup-failure: the agent step never ran',
      });
    case 'trajectory-failure':
      // The agent step itself ran and did not conclude success (a genuine
      // failure, a cancellation/timeout, or a post-agent gate step
      // that never got the chance to evaluate a deliverable).
      return classifyFailure({
        phase: 'agent_execution',
        reason: 'agent_exited_nonzero',
        retryDisposition: 'manual',
        evidence: 'Worker lifecycle outcome reported trajectory-failure',
      });
    case 'outcome-gate-failure':
      // The agent step concluded success, but verify-deliverable found no
      // evidence the attempt produced anything -- the finalizer system's own
      // phase and failure reason (docs/lifecycle-systems.md's Outcome
      // finalizer section).
      return classifyFailure({
        phase: 'validation',
        reason: 'deliverable_absent',
        retryDisposition: 'manual',
        evidence:
          'Worker lifecycle outcome reported outcome-gate-failure: no verifiable deliverable was found',
      });
    default:
      // Unreachable: isFailureOutcomeKind's guard above already narrowed to
      // exactly the three cases handled -- it is a plain boolean function,
      // not a type predicate, so the compiler cannot see that narrowing
      // itself. This default only satisfies exhaustiveness over the other
      // eight DispatchOutcomeKind values, which the guard already excluded.
      return undefined;
  }
}
