/**
 * Shared dispatch contracts — the single published definition of the facts
 * more than one of #645's five systems needs to agree on.
 *
 * Import this, do not re-derive it. See ../README.md.
 */

export * from './fleet-triage';
export {
  type HumanNeededActions,
  humanNeededActionsSchema,
} from './human-needed-actions';
export {
  formatAttemptId,
  formatClaimMarker,
  parseRunGeneration,
} from './marker';
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
export type { ExecutionPhase, ExecutionRun, RunPlacement } from './placement';
export {
  EXECUTION_PHASE_LABELS,
  executionPhase,
  PLACEMENT_STALENESS_MS,
} from './placement';
export { runPlacementSchema } from './placement-schema';
export { QUEUE_PRIORITIES, type QueuePriority } from './priority';
export { providerRoutingSchema } from './provider-routing';
export type { QuickTaskIdentity } from './quick-task';
export {
  formatQuickTaskMarker,
  parseQuickTaskMarker,
  parseTerminalQuickTaskBody,
  QUICK_TASK_MARKER_RE,
  quickTaskDigest,
  quickTaskMarkerMatcher,
} from './quick-task';
