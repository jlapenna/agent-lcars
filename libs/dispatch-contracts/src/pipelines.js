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
 *
 * Written as plain ESM JavaScript on purpose: `.github/actions/dispatch-broker`
 * runs under bare `node` with no build step (see ci.yml's
 * `node --test .github/actions/dispatch-broker/*.test.mjs`), so a TypeScript
 * source could not be a shared definition for it — only a re-derived copy,
 * which is the thing this module exists to retire. JSDoc carries the types so
 * TypeScript consumers still get full checking from this same file.
 */

/** @typedef {'claude' | 'codex' | 'opencode'} AgentPipeline */
/** @typedef {AgentPipeline | 'canary'} DispatchPipeline */

/**
 * @typedef {object} PipelineContract
 * @property {DispatchPipeline} pipeline Stable identifier used as the ledger's
 *   `pipeline` value and the router's `pipeline` workflow input.
 * @property {'agent' | 'canary'} contract Whether this pipeline runs a real,
 *   paid agent (`agent`) or is #307's structurally-incapable no-op production
 *   canary (`canary`).
 * @property {string} workflowFile Worker workflow dispatched for this pipeline.
 * @property {string} displayName Human-facing name; the worker workflow's
 *   `AGENT_NAME` env value.
 * @property {string} runNameLabel The workflow `run-name:` role text that
 *   follows `#<issue>: `. Stored rather than derived because the canary reads
 *   "worker", not "issue agent".
 * @property {string} [label] Durable `agent:*` control label selecting this
 *   pipeline for implement mode. Absent for `canary`, which is unreachable by
 *   label on purpose.
 * @property {string} [reviewLabel] Durable `review:*` control label selecting
 *   this pipeline for review mode on a pull request.
 * @property {string} [replyTrigger] Canonical comment command that hands a
 *   parked thread back to this pipeline.
 * @property {readonly string[]} replyTriggerAliases Additional comment commands
 *   accepted as equivalent to `replyTrigger`.
 * @property {string} [redispatchCommand] The spelling used in human-facing
 *   failure comments (`report-failure`'s `REDISPATCH_COMMAND`). Deliberately
 *   allowed to differ from `replyTrigger`: opencode's console affordance offers
 *   the short `/oc` while its failure comments spell out `/opencode`. Both are
 *   accepted commands; this field records which one we print.
 * @property {string} [botLogin] REST-shaped login (docs/bot-identity-formats.md)
 *   this pipeline comments, reviews, and authors pull requests under. Not
 *   unique per pipeline — codex and opencode share `agent-lcars[bot]`, which is
 *   the acknowledged limitation behind `verify-deliverable`'s inability to tell
 *   their deliverables apart.
 */

/**
 * @type {Readonly<Record<DispatchPipeline, PipelineContract>>}
 */
export const PIPELINE_CONTRACTS = Object.freeze(
  /** @type {Record<DispatchPipeline, PipelineContract>} */ ({
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
  }),
);

/** Every pipeline the broker can dispatch, canary included. */
export const DISPATCH_PIPELINES = Object.freeze(
  /** @type {DispatchPipeline[]} */ (Object.keys(PIPELINE_CONTRACTS)),
);

/** Pipelines that run a real agent — everything except the canary. */
export const AGENT_PIPELINES = Object.freeze(
  /** @type {AgentPipeline[]} */ (
    DISPATCH_PIPELINES.filter(
      (pipeline) => PIPELINE_CONTRACTS[pipeline].contract === 'agent',
    )
  ),
);

/** Worker workflow files, for identity checks on a discovered run. */
export const WORKER_WORKFLOW_FILES = Object.freeze(
  new Set(
    DISPATCH_PIPELINES.map(
      (pipeline) => PIPELINE_CONTRACTS[pipeline].workflowFile,
    ),
  ),
);

/**
 * `agent:*` label -> pipeline. Selects implement mode.
 * @type {ReadonlyMap<string, AgentPipeline>}
 */
export const AGENT_LABELS = new Map(
  AGENT_PIPELINES.map((pipeline) => [
    /** @type {string} */ (PIPELINE_CONTRACTS[pipeline].label),
    pipeline,
  ]),
);

/**
 * `review:*` label -> pipeline. A pull request only: drives `mode: 'review'`
 * (leave a review, don't push), independent of and coexistable with `agent:*`
 * on the same PR, which drives `mode: 'implement'`. The two families are never
 * contradictory with each other — only within their own namespace.
 * @type {ReadonlyMap<string, AgentPipeline>}
 */
export const REVIEW_LABELS = new Map(
  AGENT_PIPELINES.map((pipeline) => [
    /** @type {string} */ (PIPELINE_CONTRACTS[pipeline].reviewLabel),
    pipeline,
  ]),
);

/**
 * Every `agent:*`/`review:*` label a dispatch-capable issue or PR can carry.
 * GitHub's issues-list-by-label filter is an AND across a comma-separated
 * `labels` value, so reconcile discovery needs one query per label.
 * @type {readonly string[]}
 */
export const DISPATCH_LABELS = Object.freeze([
  ...AGENT_LABELS.keys(),
  ...REVIEW_LABELS.keys(),
]);

/**
 * Exact comment command -> pipeline, aliases included.
 * @type {ReadonlyMap<string, AgentPipeline>}
 */
export const REPLY_COMMANDS = new Map(
  AGENT_PIPELINES.flatMap((pipeline) => {
    const contract = PIPELINE_CONTRACTS[pipeline];
    return [
      /** @type {string} */ (contract.replyTrigger),
      ...contract.replyTriggerAliases,
    ].map(
      (command) => /** @type {[string, AgentPipeline]} */ ([command, pipeline]),
    );
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
 * @type {readonly string[]}
 */
export const AGENT_BOT_LOGINS = Object.freeze([
  ...new Set(
    AGENT_PIPELINES.map(
      (pipeline) =>
        /** @type {string} */ (PIPELINE_CONTRACTS[pipeline].botLogin),
    ),
  ),
]);

/**
 * A pipeline that runs a real agent. Every optional field on
 * `PipelineContract` is present here: they are optional on the base type only
 * because the canary has none of them, and the canary is the one pipeline
 * nothing may select from an issue.
 *
 * @typedef {PipelineContract & Required<Pick<PipelineContract,
 *   'label' | 'reviewLabel' | 'replyTrigger' | 'redispatchCommand' | 'botLogin'
 * >>} AgentPipelineContract
 */

/**
 * @param {string} pipeline
 * @returns {pipeline is DispatchPipeline}
 */
export function isDispatchPipeline(pipeline) {
  return Object.hasOwn(PIPELINE_CONTRACTS, pipeline);
}

/**
 * @param {string} pipeline
 * @returns {pipeline is AgentPipeline}
 */
export function isAgentPipeline(pipeline) {
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
 *
 * @param {AgentPipeline} pipeline
 * @returns {AgentPipelineContract}
 */
export function agentPipelineContract(pipeline) {
  const contract = pipelineContract(pipeline);
  if (contract.contract !== 'agent') {
    throw new Error(`Not an agent pipeline: ${pipeline}`);
  }
  return /** @type {AgentPipelineContract} */ (contract);
}

/**
 * @param {DispatchPipeline} pipeline
 * @returns {PipelineContract}
 */
export function pipelineContract(pipeline) {
  const contract = PIPELINE_CONTRACTS[pipeline];
  if (!contract) throw new Error(`Unsupported worker pipeline: ${pipeline}`);
  return contract;
}

/**
 * The worker workflow file for a pipeline.
 * @param {DispatchPipeline} pipeline
 * @returns {string}
 */
export function workerWorkflow(pipeline) {
  return pipelineContract(pipeline).workflowFile;
}

/**
 * Bot logins a deliverable search must NOT credit to this pipeline — every
 * other agent pipeline's login. Codex and opencode share `agent-lcars[bot]`,
 * so neither can exclude the other; the result is empty of their shared login
 * by construction rather than by special case.
 * @param {DispatchPipeline} pipeline
 * @returns {readonly string[]}
 */
export function excludedPullRequestAuthors(pipeline) {
  const own = PIPELINE_CONTRACTS[pipeline]?.botLogin;
  return Object.freeze(AGENT_BOT_LOGINS.filter((login) => login !== own));
}
