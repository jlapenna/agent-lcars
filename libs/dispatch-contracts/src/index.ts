/**
 * Shared dispatch contracts — the single published definition of the facts
 * more than one of #645's five systems needs to agree on.
 *
 * Import this, do not re-derive it. See ../README.md.
 */

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
  HOSTED_TASK_STATE_PATH,
  HOSTED_TASK_STATE_URL,
} from './oidc';
export type { DispatchOutcomeKind } from './outcomes';
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
  GENERIC_REPLY_COMMAND,
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
  parseTerminalQuickTaskBody,
  QUICK_TASK_MARKER_RE,
  quickTaskDigest,
  quickTaskMarkerMatcher,
} from './quick-task';
