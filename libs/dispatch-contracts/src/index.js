/**
 * Shared dispatch contracts — the single published definition of the facts
 * more than one of #645's five systems needs to agree on.
 *
 * Import this, do not re-derive it. See ../README.md.
 */

export {
  AGENT_BOT_LOGINS,
  AGENT_LABELS,
  AGENT_PIPELINES,
  agentPipelineContract,
  DISPATCH_LABELS,
  DISPATCH_PIPELINES,
  excludedPullRequestAuthors,
  GENERIC_REPLY_COMMAND,
  isAgentPipeline,
  isDispatchPipeline,
  PIPELINE_CONTRACTS,
  pipelineContract,
  REPLY_COMMANDS,
  REVIEW_LABELS,
  WORKER_WORKFLOW_FILES,
  workerWorkflow,
} from './pipelines.js';

/**
 * Type-only re-exports. A JSDoc `@typedef` is not carried across a value
 * `export ... from`, so consumers that want the types by name get them here.
 *
 * @typedef {import('./pipelines.js').AgentPipeline} AgentPipeline
 * @typedef {import('./pipelines.js').DispatchPipeline} DispatchPipeline
 * @typedef {import('./pipelines.js').PipelineContract} PipelineContract
 * @typedef {import('./pipelines.js').AgentPipelineContract} AgentPipelineContract
 * @typedef {import('./marker.js').AttemptMarker} AttemptMarker
 * @typedef {import('./ledger.js').DispatchLedger} DispatchLedger
 * @typedef {import('./ledger.js').LedgerTaskRef} LedgerTaskRef
 * @typedef {import('./ledger.js').LedgerGeneration} LedgerGeneration
 * @typedef {import('./ledger.js').LedgerGenerationState} LedgerGenerationState
 * @typedef {import('./ledger.js').LedgerRunAttempt} LedgerRunAttempt
 * @typedef {import('./ledger.js').LedgerSource} LedgerSource
 * @typedef {import('./ledger.js').LedgerAnomaly} LedgerAnomaly
 * @typedef {import('./ledger.js').LedgerControl} LedgerControl
 * @typedef {import('./ledger.js').LedgerCommentExtraction} LedgerCommentExtraction
 * @typedef {import('./failure.js').OwningSystem} OwningSystem
 * @typedef {import('./failure.js').FailurePhase} FailurePhase
 * @typedef {import('./failure.js').FailureReason} FailureReason
 * @typedef {import('./failure.js').RetryDisposition} RetryDisposition
 * @typedef {import('./failure.js').FailureClassification} FailureClassification
 */

export {
  AUTOMATICALLY_RETRYABLE_DISPOSITIONS,
  classifyFailure,
  FAILURE_PHASES,
  FAILURE_REASONS,
  formatFailure,
  isAutomaticallyRetryable,
  isWellFormedFailureClassification,
  needsMaintainer,
  OWNING_SYSTEMS,
  PHASE_OWNERS,
  RETRY_DISPOSITIONS,
} from './failure.js';
export {
  extractLedgerComment,
  hasLedgerMarker,
  isPlainObject,
  isWellFormedAnomaly,
  isWellFormedGeneration,
  isWellFormedLedger,
  isWellFormedSource,
  LEDGER_ACTIVE_GENERATION_STATES,
  LEDGER_GENERATION_STATES,
  LEDGER_MARKER,
  LEDGER_SCHEMA,
  renderLedgerComment,
} from './ledger.js';
export {
  displayTitleMatchesAttempt,
  formatDispatchMarker,
  parseDispatchMarker,
} from './marker.js';
