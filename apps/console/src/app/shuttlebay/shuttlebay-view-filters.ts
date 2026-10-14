import { PIPELINES } from '@agent-lcars/work';

import type { AgentPipeline } from '../../lib/agent-activity';
import type { FleetRunner } from '../../lib/autoscaler-status';

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

/** A runner row matches the repository it is working for, or, while an ARC
 * runner waits for a job, the repositories its lane serves. The agent filter
 * narrows direct runners, the only ones running agents. A direct runner
 * whose run has not resolved yet, or an ARC runner whose lane is not
 * reporting, stays: it may be the one asked for. */
export function runnerMatches(
  runner: Pick<
    FleetRunner,
    'name' | 'kind' | 'lane' | 'host' | 'jobRepository' | 'jobName' | 'work'
  >,
  lanes: readonly { lane: string; registrationUrl: string }[],
  filters: ShuttlebayFilters,
): boolean {
  if (filters.repo) {
    const repo = filters.repo.toLowerCase();
    const working = runner.work?.repo ?? runner.jobRepository;
    if (working !== undefined) {
      if (working.toLowerCase() !== repo) return false;
    } else if (runner.kind === 'arc') {
      // A lane missing from a stale or incomplete inventory might be the
      // one asked for, so its runners stay.
      const lane = lanes.find((value) => value.lane === runner.lane);
      if (lane && !laneServesRepo(lane.registrationUrl, filters.repo))
        return false;
    }
  }
  if (filters.agent) {
    if (runner.kind === 'direct' && runner.work !== undefined) {
      if (runner.work.pipeline !== filters.agent) return false;
    }
  }
  if (!filters.q) return true;
  const q = filters.q.toLowerCase();
  return [
    runner.name,
    runner.lane,
    runner.host,
    runner.jobRepository,
    runner.jobName,
    runner.work?.label,
  ].some((value) => value?.toLowerCase().includes(q));
}
