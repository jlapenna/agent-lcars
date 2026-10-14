import { PIPELINES } from '@agent-lcars/work';

import type { AgentPipeline } from '../../lib/agent-activity';

type RawParam = string | string[] | undefined;

/** Next hands a repeated parameter over as an array; the first value wins. */
function first(value: RawParam): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The Shuttlebay toolbar's filters (design/fleet-console.html). Runner
 * status is live or covers 30 minutes, so the window control offers only
 * 30m (see page.tsx) and narrows nothing here. */
export interface ShuttlebayFilters {
  /** `owner/name`. */
  repo?: string;
  agent?: AgentPipeline;
  q?: string;
}

export function parseShuttlebayFilters(params: {
  repo?: RawParam;
  agent?: RawParam;
  q?: RawParam;
}): ShuttlebayFilters {
  const repo = first(params.repo)?.trim();
  const agentParam = first(params.agent) ?? '';
  return {
    repo: repo && /^[\w.-]+\/[\w.-]+$/u.test(repo) ? repo : undefined,
    agent: (PIPELINES as readonly string[]).includes(agentParam)
      ? (agentParam as AgentPipeline)
      : undefined,
    q: first(params.q)?.trim().slice(0, 128) || undefined,
  };
}

/** A lane serves a repository when it registers on that repository or on
 * its owner (an organization-level runner group). */
export function laneServesRepo(registrationUrl: string, repo: string): boolean {
  let path: string;
  try {
    path = new URL(registrationUrl).pathname.replace(/\/+$/u, '');
  } catch {
    return false;
  }
  const [owner] = repo.split('/');
  const target = path.toLowerCase();
  return (
    target === `/${repo.toLowerCase()}` || target === `/${owner?.toLowerCase()}`
  );
}

export function laneMatches(
  lane: { lane: string; registrationUrl: string },
  filters: ShuttlebayFilters,
): boolean {
  if (filters.repo && !laneServesRepo(lane.registrationUrl, filters.repo)) {
    return false;
  }
  return (
    !filters.q || lane.lane.toLowerCase().includes(filters.q.toLowerCase())
  );
}

/** The direct executor serves every repository; find matches its name. */
export function executorMatches(filters: ShuttlebayFilters): boolean {
  return (
    !filters.q ||
    'direct agent executor queueexecutor'.includes(filters.q.toLowerCase())
  );
}
