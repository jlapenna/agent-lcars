/**
 * Pure repo-identity types/helpers, deliberately split out of
 * github-client.ts: that file imports `@agent-lcars/util-server` (env/secrets
 * access, `assertNotBrowser()`-guarded), so anything importing it - even
 * for just these types - gets pulled into a 'use client' component's
 * browser bundle and fails to build (Node-only deps like firebase-admin
 * can't bundle for the browser). This file has zero server dependencies
 * and is safe to import from client components - which is also why the
 * pipeline facts below come from `@agent-lcars/dispatch-contracts`
 * (itself zero-dependency, see its own header comment) rather than from
 * anything in this repo that touches the server.
 */

import {
  type AgentPipeline as SharedAgentPipeline,
  DISPATCH_PIPELINES,
  pipelineContract,
} from '@agent-lcars/dispatch-contracts';

/** Coding-agent pipelines understood by the current console UI. */
export type AgentPipeline = SharedAgentPipeline;

export interface AgentIntegration {
  /** Durable GitHub control label that selects this executor. */
  label: string;
  /** Command that hands a parked thread back to this executor. */
  replyTrigger: string;
  /** Additional commands recognized as equivalent replies. */
  replyTriggerAliases?: string[];
}

/** Builds the standard `AgentIntegration` for one pipeline from the shared
 * contract, omitting `replyTriggerAliases` entirely when the pipeline has
 * none rather than carrying an empty array - matches how the hand-written
 * table used to be shaped, and callers like `backend-actions.ts`'s
 * `replyTriggers` already treat "absent" and "empty" the same via `?? []`. */
function integrationFromContract(pipeline: AgentPipeline): AgentIntegration {
  const contract = pipelineContract(pipeline);
  return {
    label: contract.label,
    replyTrigger: contract.replyTrigger,
    ...(contract.replyTriggerAliases.length > 0
      ? { replyTriggerAliases: [...contract.replyTriggerAliases] }
      : {}),
  };
}

export const DEFAULT_AGENT_INTEGRATIONS: Record<
  AgentPipeline,
  AgentIntegration
> = Object.fromEntries(
  DISPATCH_PIPELINES.map((pipeline) => [
    pipeline,
    integrationFromContract(pipeline),
  ]),
) as Record<AgentPipeline, AgentIntegration>;

/** Canonical GitHub repository identity. Cosmetic configuration and agent
 * integration metadata never participate in identity. */
export interface RepositoryRef {
  owner: string;
  name: string;
}

/** Stable identity for one logical GitHub task across watched repositories. */
export interface TaskRef {
  repository: RepositoryRef;
  issueNumber: number;
}

export interface WatchedRepo extends RepositoryRef {
  /** Agent integrations available in this repository. Omit the whole map to
   * use the standard integrations; an empty map declares no agent support. */
  agents?: Partial<Record<AgentPipeline, AgentIntegration | null>>;
  /** Display name shown in the UI instead of `owner/name` (repoKey's
   * format) wherever a repo badge/title is rendered - e.g. a shorter label
   * for a long or noisy repo name. Purely cosmetic: never affects GitHub
   * API calls, URLs, or the identity keys `repoKey`/`repoItemKey` produce. */
  alias?: string;
}

export function agentIntegration(
  repo: WatchedRepo,
  pipeline: AgentPipeline,
): AgentIntegration | undefined {
  if (!repo.agents) return DEFAULT_AGENT_INTEGRATIONS[pipeline];
  return repo.agents[pipeline] ?? undefined;
}

export function supportedAgentPipelines(repo: WatchedRepo): AgentPipeline[] {
  return (Object.keys(DEFAULT_AGENT_INTEGRATIONS) as AgentPipeline[]).filter(
    (pipeline) => agentIntegration(repo, pipeline) !== undefined,
  );
}

/** Durable selector labels for every agent integration this repo supports. */
export function supportedAgentLabels(repo: WatchedRepo): string[] {
  return supportedAgentPipelines(repo).flatMap((pipeline) => {
    const integration = agentIntegration(repo, pipeline);
    return integration ? [integration.label] : [];
  });
}

/** Every supported pipeline whose durable label is present on `labels`, in
 * `supportedAgentPipelines` order. Callers that need to tell "no agent
 * assigned yet" (zero matches) apart from "contradictory multi-agent state"
 * (more than one match) - e.g. deciding whether a first-assignment action
 * applies - should use this instead of `selectedAgentPipeline`, which
 * collapses both cases to `undefined`. */
export function matchingAgentPipelines(
  repo: WatchedRepo,
  labels: string[],
): AgentPipeline[] {
  return supportedAgentPipelines(repo).filter((pipeline) => {
    const integration = agentIntegration(repo, pipeline);
    return integration ? labels.includes(integration.label) : false;
  });
}

export function selectedAgentPipeline(
  repo: WatchedRepo,
  labels: string[],
): AgentPipeline | undefined {
  const matches = matchingAgentPipelines(repo, labels);
  // Contradictory multi-agent state has no implicit precedence. The routers
  // repair direct label changes; the console withholds an action until then.
  return matches.length === 1 ? matches[0] : undefined;
}

export function repoKey(repo: RepositoryRef): string {
  return `${repo.owner}/${repo.name}`;
}

export function taskRefKey(task: TaskRef): string {
  return `${repoKey(task.repository)}#${task.issueNumber}`;
}

export function taskRefUrl(task: TaskRef): string {
  return `https://github.com/${repoKey(task.repository)}/issues/${task.issueNumber}`;
}

/** The name to render in the UI for a repo: its configured `alias` when
 * set, otherwise `repoKey`'s `owner/name`. Use this instead of `repoKey`
 * anywhere a repo name is *displayed*; keep using `repoKey` for identity
 * (keys, URLs, filter matching). */
export function repoDisplayName(repo: {
  owner: string;
  name: string;
  alias?: string;
}): string {
  return repo.alias && repo.alias.length > 0 ? repo.alias : repoKey(repo);
}

/** Cross-repo-safe join/dedupe key for issue and PR numbers, which only
 * disambiguate within a single repo. */
export function repoItemKey(repo: RepositoryRef, number: number): string {
  return taskRefKey({ repository: repo, issueNumber: number });
}
