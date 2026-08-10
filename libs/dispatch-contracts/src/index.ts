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
export type {
  AgentResultClaim,
  AttemptMarker,
  ClaimArtifactType,
} from './marker';
export {
  displayTitleMatchesAttempt,
  formatAttemptId,
  formatClaimMarker,
  formatDispatchMarker,
  parseAttemptId,
  parseClaimMarker,
  parseDispatchMarker,
  textCarriesClaim,
} from './marker';
export {
  COMPLETION_FINALIZER_WORKFLOW_PATH,
  COMPLETION_OIDC_AUDIENCE,
  HOSTED_COMPLETION_PATH,
  HOSTED_COMPLETION_URL,
  HOSTED_RECOVERY_OBSERVATION_PATH,
  HOSTED_RECOVERY_OBSERVATION_URL,
  HOSTED_TASK_STATE_PATH,
  HOSTED_TASK_STATE_URL,
  RECOVERY_OBSERVATION_OIDC_AUDIENCE,
} from './oidc';
export type { DispatchOutcomeKind, DispatchOutcomeReference } from './outcomes';
export {
  DISPATCH_OUTCOME_KINDS,
  dispatchOutcomeKindSchema,
  dispatchOutcomeReferenceSchema,
  isDispatchOutcomeKind,
  isDispatchOutcomeReference,
} from './outcomes';
export type {
  AgentPipeline,
  DispatchPipeline,
  PipelineContract,
} from './pipelines';
export {
  AGENT_BOT_LOGINS,
  AGENT_LABELS,
  DISPATCH_LABELS,
  DISPATCH_PIPELINES,
  excludedPullRequestAuthors,
  GENERIC_REPLY_COMMAND,
  isDispatchPipeline,
  PIPELINE_CONTRACTS,
  pipelineContract,
  REPLY_COMMANDS,
  REVIEW_LABELS,
  WORKER_WORKFLOW_FILES,
  workerWorkflow,
} from './pipelines';
export type {
  ProjectionConvergenceState,
  ProjectionStatus,
} from './projection';
export {
  isWellFormedProjectionStatus,
  PROJECTION_CONVERGENCE_STATES,
  projectionConvergenceStateSchema,
  projectionStatusSchema,
} from './projection';
export type { QuickTaskIdentity } from './quick-task';
export {
  formatQuickTaskMarker,
  parseQuickTaskMarker,
  parseTerminalQuickTaskBody,
  QUICK_TASK_MARKER_RE,
  quickTaskDigest,
  quickTaskMarkerMatcher,
} from './quick-task';
export type { LaneReadinessFailure } from './readiness';
export { isLaneReadinessFailure, LANE_READINESS_FAILURES } from './readiness';
export type {
  ParsedRecoveryOperationKey,
  RecoveryDomain,
  RecoveryObservation,
  RecoveryOperationTarget,
  RecoverySourceKind,
} from './recovery-observation';
export {
  buildRecoveryObservation,
  formatOperationKey,
  isRecoveryDomain,
  isRecoverySourceKind,
  isWellFormedRecoveryObservation,
  parseOperationKey,
  RECOVERY_DOMAINS,
  RECOVERY_SOURCE_KINDS,
  recoveryDomainSchema,
  recoveryObservationSchema,
  recoveryOperationTargetSchema,
  recoverySourceKindSchema,
} from './recovery-observation';
export type { AuthoritativeTaskState } from './task-state';
export {
  AUTHORITATIVE_TASK_STATE_SCHEMA,
  isAuthoritativeTaskState,
  redactAuthoritativeTaskState,
} from './task-state';
