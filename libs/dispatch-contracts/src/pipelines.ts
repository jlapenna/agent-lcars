/**
 * The fleet's one definition of which coding-agent pipelines exist and how
 * each is named.
 *
 * Before this module the same five facts (control label, review label, reply
 * command, worker workflow file, bot login) were hand-copied into at least
 * six places that had no way to notice each other drifting: normalize.mjs's
 * `AGENT_LABELS`/`REVIEW_LABELS`/`COMMANDS`, github-api.mjs's
 * `workerConfigurations`/`WORKER_WORKFLOWS`/`RECONCILE_DISCOVERY_LABELS`,
 * broker.mjs's `PIPELINES`, the console's `DEFAULT_AGENT_INTEGRATIONS` and
 * `AGENT_AUTHOR_LOGINS`, and the four worker workflows' own `env:` blocks.
 * Adding a pipeline meant five correct edits or it would be recognized in
 * some systems and invisible in others.
 */

export type AgentPipeline = 'claude' | 'codex' | 'opencode';
export type DispatchPipeline = AgentPipeline | 'canary';

export interface PipelineContract {
  /** Stable identifier used as the ledger's
   *   `pipeline` value and the router's `pipeline` workflow input. */
  pipeline: DispatchPipeline;
  /** Whether this pipeline runs a real,
   *   paid agent (`agent`) or is #307's structurally-incapable no-op production
   *   canary (`canary`). */
  contract: 'agent' | 'canary';
  /** Worker workflow dispatched for this pipeline. */
  workflowFile: string;
  /** Human-facing name; the worker workflow's
   *   `AGENT_NAME` env value. */
  displayName: string;
  /** The workflow `run-name:` role text that
   *   follows `#<issue>: `. Stored rather than derived because the canary reads
   *   "worker", not "issue agent". */
  runNameLabel: string;
  /** Durable `agent:*` control label selecting this
   *   pipeline for implement mode. Absent for `canary`, which is unreachable by
   *   label on purpose. */
  label?: string;
  /** Durable `review:*` control label selecting
   *   this pipeline for review mode on a pull request. */
  reviewLabel?: string;
  /** Canonical comment command that hands a
   *   parked thread back to this pipeline. */
  replyTrigger?: string;
  /** Additional comment commands
   *   accepted as equivalent to `replyTrigger`. */
  replyTriggerAliases: readonly string[];
  /** The spelling used in human-facing
   *   failure comments (`report-failure`'s `REDISPATCH_COMMAND`). Deliberately
   *   allowed to differ from `replyTrigger`: opencode's console affordance offers
   *   the short `/oc` while its failure comments spell out `/opencode`. Both are
   *   accepted commands; this field records which one we print. */
  redispatchCommand?: string;
  /** REST-shaped login (docs/bot-identity-formats.md)
   *   this pipeline comments, reviews, and authors pull requests under. Not
   *   unique per pipeline — codex and opencode share `agent-lcars[bot]`, which is
   *   the acknowledged limitation behind `verify-deliverable`'s inability to tell
   *   their deliverables apart. */
  botLogin?: string;
}

export const PIPELINE_CONTRACTS: Readonly<
  Record<DispatchPipeline, PipelineContract>
> = Object.freeze({
  claude: Object.freeze({
    pipeline: 'claude',
    contract: 'agent',
    workflowFile: 'claude.yml',
    displayName: 'Claude',
    runNameLabel: 'Claude issue agent',
    label: 'agent:claude',
    reviewLabel: 'review:claude',
    replyTrigger: '@claude',
    replyTriggerAliases: Object.freeze([]),
    redispatchCommand: '@claude',
    botLogin: 'claude[bot]',
  }),
  codex: Object.freeze({
    pipeline: 'codex',
    contract: 'agent',
    workflowFile: 'codex.yml',
    displayName: 'Codex',
    runNameLabel: 'Codex issue agent',
    label: 'agent:codex',
    reviewLabel: 'review:codex',
    replyTrigger: '/codex',
    replyTriggerAliases: Object.freeze([]),
    redispatchCommand: '/codex',
    botLogin: 'agent-lcars[bot]',
  }),
  opencode: Object.freeze({
    pipeline: 'opencode',
    contract: 'agent',
    workflowFile: 'opencode.yml',
    displayName: 'OpenCode',
    runNameLabel: 'OpenCode issue agent',
    label: 'agent:opencode',
    reviewLabel: 'review:opencode',
    replyTrigger: '/oc',
    replyTriggerAliases: Object.freeze(['/opencode']),
    redispatchCommand: '/opencode',
    botLogin: 'agent-lcars[bot]',
  }),
  canary: Object.freeze({
    // #307's no-op production canary. It carries no label, no reply command,
    // and no bot login because nothing may ever select it from an issue: the
    // only way to produce a `canary` intent is normalize.mjs's dedicated
    // workflow_dispatch `kind: 'canary'` branch, fired exclusively by this
    // repo's own trusted dispatch-canary.yml/post-deploy-smoke.yml.
    pipeline: 'canary',
    contract: 'canary',
    workflowFile: 'agent-dispatch-canary.yml',
    displayName: 'Dispatch canary',
    runNameLabel: 'Dispatch canary worker',
    replyTriggerAliases: Object.freeze([]),
  }),
} as Record<DispatchPipeline, PipelineContract>);

/** Every pipeline the broker can dispatch, canary included. */
export const DISPATCH_PIPELINES = Object.freeze(
  Object.keys(PIPELINE_CONTRACTS) as DispatchPipeline[],
);

/** Pipelines that run a real agent — everything except the canary. */
export const AGENT_PIPELINES = Object.freeze(
  DISPATCH_PIPELINES.filter(
    (pipeline) => PIPELINE_CONTRACTS[pipeline].contract === 'agent',
  ) as AgentPipeline[],
);

/** Worker workflow files, for identity checks on a discovered run. */
export const WORKER_WORKFLOW_FILES: ReadonlySet<string> = Object.freeze(
  new Set(
    DISPATCH_PIPELINES.map(
      (pipeline) => PIPELINE_CONTRACTS[pipeline].workflowFile,
    ),
  ),
);

/**
 * `agent:*` label -> pipeline. Selects implement mode.
 */
export const AGENT_LABELS: ReadonlyMap<string, AgentPipeline> = new Map(
  AGENT_PIPELINES.map((pipeline): [string, AgentPipeline] => [
    PIPELINE_CONTRACTS[pipeline].label as string,
    pipeline,
  ]),
);

/**
 * `review:*` label -> pipeline. A pull request only: drives `mode: 'review'`
 * (leave a review, don't push), independent of and coexistable with `agent:*`
 * on the same PR, which drives `mode: 'implement'`. The two families are never
 * contradictory with each other — only within their own namespace.
 */
export const REVIEW_LABELS: ReadonlyMap<string, AgentPipeline> = new Map(
  AGENT_PIPELINES.map((pipeline): [string, AgentPipeline] => [
    PIPELINE_CONTRACTS[pipeline].reviewLabel as string,
    pipeline,
  ]),
);

/**
 * Every `agent:*`/`review:*` label a dispatch-capable issue or PR can carry.
 * GitHub's issues-list-by-label filter is an AND across a comma-separated
 * `labels` value, so reconcile discovery needs one query per label.
 */
export const DISPATCH_LABELS: readonly string[] = Object.freeze([
  ...AGENT_LABELS.keys(),
  ...REVIEW_LABELS.keys(),
]);

/**
 * Exact comment command -> pipeline, aliases included.
 */
export const REPLY_COMMANDS: ReadonlyMap<string, AgentPipeline> = new Map(
  AGENT_PIPELINES.flatMap((pipeline) => {
    const contract = PIPELINE_CONTRACTS[pipeline];
    return [
      contract.replyTrigger as string,
      ...contract.replyTriggerAliases,
    ].map((command): [string, AgentPipeline] => [command, pipeline]);
  }),
);

/**
 * The pipeline-agnostic command (#573). It does not name an integration: it
 * defers to whichever `agent:*` label the issue already carries at
 * comment-normalization time. Every other command keeps requiring an exact
 * match against that label — this only adds a second way to say "the one
 * that's already selected", it doesn't relax the existing ones.
 */
export const GENERIC_REPLY_COMMAND = '@agent';

/**
 * REST-shaped logins of every pipeline that opens pull requests or comments
 * under its own identity, deduplicated. Must equal the `AGENT_BOT_LOGINS` repo
 * variable that agent-automerge.yml reads — that variable is deployment
 * configuration and cannot import this module, so `pipelines.contract.test.mjs`
 * pins the two together instead.
 */
export const AGENT_BOT_LOGINS: readonly string[] = Object.freeze([
  ...new Set(
    AGENT_PIPELINES.map(
      (pipeline) => PIPELINE_CONTRACTS[pipeline].botLogin as string,
    ),
  ),
]);

/**
 * A pipeline that runs a real agent. Every optional field on
 * `PipelineContract` is present here: they are optional on the base type only
 * because the canary has none of them, and the canary is the one pipeline
 * nothing may select from an issue.
 */
export type AgentPipelineContract = PipelineContract &
  Required<
    Pick<
      PipelineContract,
      | 'label'
      | 'reviewLabel'
      | 'replyTrigger'
      | 'redispatchCommand'
      | 'botLogin'
    >
  >;

export function isDispatchPipeline(
  pipeline: string,
): pipeline is DispatchPipeline {
  return Object.hasOwn(PIPELINE_CONTRACTS, pipeline);
}

export function isAgentPipeline(pipeline: string): pipeline is AgentPipeline {
  return (
    isDispatchPipeline(pipeline) &&
    PIPELINE_CONTRACTS[pipeline].contract === 'agent'
  );
}

/**
 * The contract for a pipeline that runs a real agent, with the label, reply
 * command, and bot login narrowed to non-optional. Saves every consumer the
 * cast that reasoning "AGENT_PIPELINES excludes the canary, so these are
 * populated" would otherwise require.
 */
export function agentPipelineContract(
  pipeline: AgentPipeline,
): AgentPipelineContract {
  const contract = pipelineContract(pipeline);
  if (contract.contract !== 'agent') {
    throw new Error(`Not an agent pipeline: ${pipeline}`);
  }
  return contract as AgentPipelineContract;
}

export function pipelineContract(pipeline: DispatchPipeline): PipelineContract {
  const contract = PIPELINE_CONTRACTS[pipeline];
  if (!contract) throw new Error(`Unsupported worker pipeline: ${pipeline}`);
  return contract;
}

/**
 * The worker workflow file for a pipeline.
 */
export function workerWorkflow(pipeline: DispatchPipeline): string {
  return pipelineContract(pipeline).workflowFile;
}

/**
 * Bot logins a deliverable search must NOT credit to this pipeline — every
 * other agent pipeline's login. Codex and opencode share `agent-lcars[bot]`,
 * so neither can exclude the other; the result is empty of their shared login
 * by construction rather than by special case.
 */
export function excludedPullRequestAuthors(
  pipeline: DispatchPipeline,
): readonly string[] {
  const own = PIPELINE_CONTRACTS[pipeline]?.botLogin;
  return Object.freeze(AGENT_BOT_LOGINS.filter((login) => login !== own));
}
