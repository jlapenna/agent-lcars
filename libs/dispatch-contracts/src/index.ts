/**
 * Shared dispatch contracts — the single published definition of the facts
 * more than one of #645's five systems needs to agree on.
 *
 * Import this, do not re-derive it. See ../README.md.
 */

export type {
  FailureClassification,
  FailurePhase,
  FailureReason,
  OwningSystem,
  RetryDisposition,
} from './failure';
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
} from './failure';
export type {
  DispatchLedger,
  LedgerAnomaly,
  LedgerAuthorization,
  LedgerAuthorizationDecision,
  LedgerAuthorizationObservation,
  LedgerCommentExtraction,
  LedgerControl,
  LedgerGeneration,
  LedgerGenerationState,
  LedgerRunAttempt,
  LedgerSource,
  LedgerTaskRef,
} from './ledger';
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
} from './ledger';
export type { AttemptMarker, RouterGroupIdentity } from './marker';
export {
  displayTitleMatchesAttempt,
  formatAttemptId,
  formatDispatchMarker,
  formatRouterGroupMarker,
  parseAttemptId,
  parseDispatchMarker,
  parseRouterGroupMarker,
} from './marker';
export type {
  AgentPipeline,
  AgentPipelineContract,
  DispatchPipeline,
  PipelineContract,
} from './pipelines';
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
} from './pipelines';
export type { QuickTaskIdentity } from './quick-task';
export {
  formatQuickTaskMarker,
  parseQuickTaskMarker,
  QUICK_TASK_MARKER_RE,
  quickTaskDigest,
  quickTaskMarkerMatcher,
} from './quick-task';
