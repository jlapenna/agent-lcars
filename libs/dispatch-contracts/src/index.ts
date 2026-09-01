/**
 * Shared dispatch contracts — the single published definition of the facts
 * more than one of #645's five systems needs to agree on.
 *
 * Import this, do not re-derive it. See ../README.md.
 */

export { formatAttemptId, formatClaimMarker } from './marker';
export type { DispatchOutcomeKind } from './outcomes';
export type { AgentPipeline, PipelineContract } from './pipelines';
export {
  AGENT_BOT_LOGINS,
  AGENT_LABELS,
  DISPATCH_PIPELINES,
  isDispatchPipeline,
  PIPELINE_CONTRACTS,
  pipelineContract,
  REPLY_COMMANDS,
  REVIEW_LABELS,
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
