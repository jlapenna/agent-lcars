/**
 * Pure repo-identity types/helpers, deliberately split out of
 * github-client.ts: that file imports `@repo/util-server` (env/secrets
 * access, `assertNotBrowser()`-guarded), so anything importing it - even
 * for just these types - gets pulled into a 'use client' component's
 * browser bundle and fails to build (Node-only deps like firebase-admin
 * can't bundle for the browser). This file has zero server dependencies
 * and is safe to import from client components.
 */

/** Coding-agent pipelines understood by the current console UI. */
export type AgentPipeline = 'claude' | 'codex' | 'opencode';

export interface AgentIntegration {
  /** Workflow dispatched through the repository's agent router. */
  workflowFile: string;
  /** Durable GitHub control label that selects this executor. */
  label: string;
  /** Command that hands a parked thread back to this executor. */
  replyTrigger: string;
  /** Additional commands recognized as equivalent replies. */
  replyTriggerAliases?: string[];
}

export const DEFAULT_AGENT_INTEGRATIONS: Record<
  AgentPipeline,
  AgentIntegration
> = {
  claude: {
    workflowFile: 'claude.yml',
    label: 'agent:claude',
    replyTrigger: '@claude',
  },
  codex: {
    workflowFile: 'codex.yml',
    label: 'agent:codex',
    replyTrigger: '/codex',
  },
  opencode: {
    workflowFile: 'opencode.yml',
    label: 'agent:opencode',
    replyTrigger: '/oc',
    replyTriggerAliases: ['/opencode'],
  },
};

export interface WatchedRepo {
  owner: string;
  name: string;
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

export function selectedAgentPipeline(
  repo: WatchedRepo,
  labels: string[],
): AgentPipeline | undefined {
  const matches = supportedAgentPipelines(repo).filter((pipeline) => {
    const integration = agentIntegration(repo, pipeline);
    return integration ? labels.includes(integration.label) : false;
  });
  // Contradictory multi-agent state has no implicit precedence. The routers
  // repair direct label changes; the console withholds an action until then.
  return matches.length === 1 ? matches[0] : undefined;
}

export function repoKey(repo: { owner: string; name: string }): string {
  return `${repo.owner}/${repo.name}`;
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
 * disambiguate within a single repo. GitHub Actions run ids are already
 * globally unique across repos and never need this. */
export function repoItemKey(
  repo: { owner: string; name: string },
  number: number,
): string {
  return `${repoKey(repo)}#${number}`;
}
