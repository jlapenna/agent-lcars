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
 */

export {
  displayTitleMatchesAttempt,
  formatDispatchMarker,
  parseDispatchMarker,
} from './marker.js';
