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
export * from './issue-tracker';
export {
  formatAttemptId,
  formatClaimMarker,
  parseRunGeneration,
} from './marker';
export type { AgentPipeline, PipelineContract } from './pipelines';
export {
  AGENT_BOT_LOGINS,
  AGENT_LABELS,
  DISPATCH_PIPELINES,
  isDispatchPipeline,
  PIPELINE_CONTRACTS,
  pipelineContract,
  PULL_REQUEST_AUTHOR_BOT_LOGIN,
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
  parseTerminalQuickTaskBody,
  quickTaskDigest,
  quickTaskMarkerMatcher,
} from './quick-task';
export type { RunEvidence, RunEvidenceReport } from './run-evidence';
export {
  plainRunEvidence,
  recordRunEvidence,
  RUN_EVIDENCE_TOOL_CALLS_MAX,
  runEvidenceReportSchema,
  runEvidenceSchema,
} from './run-evidence';
export {
  RUN_MESSAGE_MAX_BYTES,
  RUN_MESSAGE_PREVIEW_MAX,
  runMessageBytes,
} from './run-message';
export * from './work-budgets';
