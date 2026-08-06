/**
 * Failure classification: which system owns a failure, what phase it happened
 * in, why, and who is allowed to retry it.
 *
 * The problem this solves is misattribution, not missing logs. #645's opening
 * argument is that mixing every concern under "dispatch" makes failures lie:
 * a provider error looks like a dispatch failure, a reporting failure makes a
 * completed attempt look silent, a successful process looks like successful
 * work. Two dimensions — owning system and phase — are enough to stop
 * conflating them, and cheaper than pretending every phase is its own service.
 *
 * Before this module the only vocabulary was `addAnomaly(ledger, kind,
 * detail)`, where `kind` was a free-form string. Four literals were in use,
 * with no shared enum, no phase, no owning system, and retryability encoded
 * ad hoc as a boolean property on one error class.
 *
 * The rule that makes this worth having: **the owning system controls retry.**
 * A provider failure cannot be retried by the launcher, a projection retry
 * cannot re-run the agent, and a runner failure cannot be reported as agent
 * behavior.
 */

/**
 * The five operational systems. A failure belongs to exactly one — the system
 * whose state authority, credentials, or failure containment is implicated,
 * not merely the one that noticed.
 *
 * @typedef {'controller' | 'runner' | 'worker' | 'finalizer' | 'projector'} OwningSystem
 */

/** @type {readonly OwningSystem[]} */
export const OWNING_SYSTEMS = Object.freeze([
  'controller',
  'runner',
  'worker',
  'finalizer',
  'projector',
]);

/**
 * The lifecycle phase a failure occurred in. These are deliberately finer
 * than the systems: the ten-stage lifecycle the earlier draft described is
 * still worth naming, it just does not need ten deployments.
 *
 * @typedef {(typeof FAILURE_PHASES)[number]} FailurePhase
 */
export const FAILURE_PHASES = /** @type {const} */ ([
  'signal',
  'authorization',
  'intent',
  'scheduling',
  'launch',
  'runner_allocation',
  'bootstrap',
  'provider_admission',
  'provider_execution',
  'agent_execution',
  'validation',
  'reporting',
  'telemetry',
  'reconciliation',
]);

/**
 * Which system owns each phase. This is the mapping that stops a provider
 * error from being recorded as a dispatch failure — the phase is observable
 * at the point of failure, and the owner follows from it rather than from
 * whoever happened to catch the exception.
 *
 * @type {Readonly<Record<FailurePhase, OwningSystem>>}
 */
export const PHASE_OWNERS = Object.freeze(
  /** @type {Record<FailurePhase, OwningSystem>} */ ({
    signal: 'controller',
    authorization: 'controller',
    intent: 'controller',
    scheduling: 'controller',
    launch: 'controller',
    runner_allocation: 'runner',
    bootstrap: 'worker',
    provider_admission: 'worker',
    provider_execution: 'worker',
    agent_execution: 'worker',
    validation: 'finalizer',
    reporting: 'projector',
    telemetry: 'projector',
    // Every system reconciles the state it owns, so this phase alone cannot
    // name its owner from the phase. `classifyFailure` requires an explicit
    // owningSystem when the phase is `reconciliation`; this default is the
    // most common case, not an assumption the classifier is allowed to make
    // silently.
    reconciliation: 'controller',
  }),
);

/**
 * When a failure may be retried, and by whom.
 *
 * - `never` — retrying cannot help and may duplicate side effects.
 * - `immediate` — transient; retry now.
 * - `backoff` — transient under contention; retry with delay.
 * - `after_health_change` — blocked until a dependency reports healthy.
 * - `after_configuration_change` — blocked until a human changes config.
 * - `manual` — a human must decide.
 *
 * @typedef {(typeof RETRY_DISPOSITIONS)[number]} RetryDisposition
 */
export const RETRY_DISPOSITIONS = /** @type {const} */ ([
  'never',
  'immediate',
  'backoff',
  'after_health_change',
  'after_configuration_change',
  'manual',
]);

/**
 * Dispositions under which an automated retry is permitted at all. The
 * remaining three are gated on something outside the failing system changing
 * first, which is exactly the distinction that keeps a retry loop from
 * spinning against a condition it cannot affect.
 *
 * @type {ReadonlySet<string>}
 */
export const AUTOMATICALLY_RETRYABLE_DISPOSITIONS = new Set([
  'immediate',
  'backoff',
]);

/**
 * Stable reason codes. Stable is the operative word: these are joined on by
 * dashboards and alerts, so a code is never repurposed — a changed meaning
 * gets a new code.
 *
 * Seeded from the failures #645's audit table actually maps, so every row of
 * that table has a code to land on rather than a free-text string.
 *
 * @typedef {(typeof FAILURE_REASONS)[number]} FailureReason
 */
export const FAILURE_REASONS = /** @type {const} */ ([
  // controller / signal + reconciliation
  'signal_lost',
  'signal_evicted',
  'signal_unverifiable',
  'quick_task_digest_mismatch',
  'concurrency_group_unverifiable',
  // controller / authorization + intent + scheduling + launch
  'unauthorized_actor',
  'ambiguous_pipeline_selection',
  'intent_superseded',
  'launch_response_lost',
  'launch_rejected',
  // runner
  'runner_allocation_timeout',
  'runner_lost',
  // worker / bootstrap
  'work_token_mint_failed',
  'checkout_failed',
  'tool_setup_failed',
  // worker / provider + agent
  'provider_admission_denied',
  'provider_graph_allocation_failed',
  'provider_unavailable',
  'agent_turn_budget_exhausted',
  'agent_exited_nonzero',
  // finalizer
  'deliverable_absent',
  'deliverable_lookup_failed',
  'deliverable_unattributable',
  // projector
  'github_write_failed',
  'telemetry_upload_failed',
  'telemetry_absent',
  // any system
  'internal_error',
]);

const PHASES = /** @type {ReadonlySet<string>} */ (new Set(FAILURE_PHASES));
const REASONS = /** @type {ReadonlySet<string>} */ (new Set(FAILURE_REASONS));
const DISPOSITIONS = /** @type {ReadonlySet<string>} */ (
  new Set(RETRY_DISPOSITIONS)
);
const SYSTEMS = /** @type {ReadonlySet<string>} */ (new Set(OWNING_SYSTEMS));

/**
 * A classified failure.
 *
 * @typedef {object} FailureClassification
 * @property {OwningSystem} owningSystem
 * @property {FailurePhase} phase
 * @property {FailureReason} reason
 * @property {RetryDisposition} retryDisposition
 * @property {number} [retryBudget] Retries remaining. Absent means unbounded
 *   was never intended — a disposition that permits retry should carry one.
 * @property {string} [evidence] What makes a retry safe. #645 requires this
 *   alongside the disposition: "retry is fine" with no stated reason is how a
 *   retry at the wrong layer duplicates agent side effects.
 * @property {string} [detail] Free-text context. Never parsed.
 */

/**
 * Build a classified failure, deriving the owning system from the phase.
 *
 * Rejects unknown values rather than passing them through: a typo'd reason
 * code that silently reaches a dashboard is worse than no code at all,
 * because it reads as a real category nobody is alerting on.
 *
 * @param {object} input
 * @param {FailurePhase} input.phase
 * @param {FailureReason} input.reason
 * @param {RetryDisposition} input.retryDisposition
 * @param {OwningSystem} [input.owningSystem] Overrides the phase's default
 *   owner. Required when `phase` is `reconciliation`, which every system does
 *   for the state it owns.
 * @param {number} [input.retryBudget]
 * @param {string} [input.evidence]
 * @param {string} [input.detail]
 * @returns {FailureClassification}
 */
export function classifyFailure({
  phase,
  reason,
  retryDisposition,
  owningSystem,
  retryBudget,
  evidence,
  detail,
}) {
  if (!PHASES.has(phase)) {
    throw new Error(`Unknown failure phase: ${phase}`);
  }
  if (!REASONS.has(reason)) {
    throw new Error(`Unknown failure reason code: ${reason}`);
  }
  if (!DISPOSITIONS.has(retryDisposition)) {
    throw new Error(`Unknown retry disposition: ${retryDisposition}`);
  }
  if (owningSystem !== undefined && !SYSTEMS.has(owningSystem)) {
    throw new Error(`Unknown owning system: ${owningSystem}`);
  }
  if (phase === 'reconciliation' && owningSystem === undefined) {
    throw new Error(
      'Reconciliation failures must name their owning system: every system reconciles the state it owns',
    );
  }
  if (
    retryBudget !== undefined &&
    (!Number.isSafeInteger(retryBudget) || retryBudget < 0)
  ) {
    throw new Error(`Invalid retry budget: ${retryBudget}`);
  }
  return {
    owningSystem: owningSystem ?? PHASE_OWNERS[phase],
    phase,
    reason,
    retryDisposition,
    ...(retryBudget === undefined ? {} : { retryBudget }),
    ...(evidence === undefined ? {} : { evidence }),
    ...(detail === undefined ? {} : { detail }),
  };
}

/**
 * Whether this failure may be retried automatically right now.
 *
 * Both conditions matter and neither implies the other: a disposition can
 * permit retry while the budget is spent, and a budget can remain while the
 * disposition says a human or a health change must come first.
 *
 * @param {FailureClassification} failure
 * @returns {boolean}
 */
export function isAutomaticallyRetryable(failure) {
  if (!AUTOMATICALLY_RETRYABLE_DISPOSITIONS.has(failure.retryDisposition)) {
    return false;
  }
  return failure.retryBudget === undefined || failure.retryBudget > 0;
}

/**
 * Whether the ball is in the maintainer's court.
 *
 * This is the one condition that should set the `status:needs-human` label —
 * #645 is explicit that the label means `nextOwner=maintainer`, and that
 * mapping every infrastructure failure to it is a projector anti-pattern.
 * A retryable runner or provider incident stays owned by its own system.
 *
 * @param {FailureClassification} failure
 * @returns {boolean}
 */
export function needsMaintainer(failure) {
  return (
    failure.retryDisposition === 'manual' ||
    failure.retryDisposition === 'after_configuration_change' ||
    (failure.retryDisposition === 'never' &&
      failure.reason !== 'intent_superseded')
  );
}

/**
 * A single-line, greppable rendering for logs and GitHub Actions annotations.
 *
 * @param {FailureClassification} failure
 * @returns {string}
 */
export function formatFailure(failure) {
  const budget =
    failure.retryBudget === undefined ? '' : ` budget=${failure.retryBudget}`;
  return `[${failure.owningSystem}/${failure.phase}] ${failure.reason} retry=${failure.retryDisposition}${budget}`;
}
