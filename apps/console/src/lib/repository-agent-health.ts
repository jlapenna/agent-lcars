import type { RepositoryAgentObservation } from '@agent-lcars/work';

import type {
  AgentSource,
  AgentSourceHealth,
  CatalogAgent,
} from './repository-agent-store';

/** The refresh error rows that say why a definition cannot run because of
 * its source rather than its own content (repository-agent-catalog.ts). */
const SOURCE_FAILED = 'Source refresh failed';
const REMOVED = 'Definition removed';

/** At most this many repositories ride the maintenance reply: well inside
 * the executor's 200-source bound and its 64 KiB response cap (about 150
 * bytes each). Repositories beyond it are dropped in name order. */
export const OBSERVED_SOURCE_LIMIT = 100;

/** Catalog health for the maintenance reply: agents by admission state and
 * each refreshed repository's attempt, read success and read failure times.
 * Only repositories still refreshed (configured, or holding stored agents)
 * are reported. No agent names or errors leave. */
export function observeAgentCatalog(
  agents: readonly CatalogAgent[],
  attempts: readonly AgentSource[],
  health: readonly AgentSourceHealth[],
  configured: readonly string[],
  now: Date,
): RepositoryAgentObservation {
  const counts = {
    enabled: 0,
    vetoed: 0,
    invalid: 0,
    unavailable: 0,
    removed: 0,
  };
  for (const agent of agents) {
    if (agent.enabled) counts.enabled++;
    else if (agent.error === SOURCE_FAILED) counts.unavailable++;
    else if (agent.error === REMOVED) counts.removed++;
    else if (agent.definition === undefined) counts.invalid++;
    else counts.vetoed++;
  }
  const known = new Set(configured);
  for (const agent of agents) known.add(agent.repository);
  const attempted = new Map(attempts.map((row) => [row.repository, row]));
  const read = new Map(health.map((row) => [row.repository, row]));
  return {
    version: 1,
    observedAt: now.toISOString(),
    agents: counts,
    sources: [...known]
      .filter((repository) => attempted.has(repository) || read.has(repository))
      .sort()
      .slice(0, OBSERVED_SOURCE_LIMIT)
      .map((repository) => {
        const attemptedAt = attempted.get(repository)?.attemptedAt;
        const { succeededAt, failedAt } = read.get(repository) ?? {};
        return {
          repository,
          ...(attemptedAt === undefined ? {} : { attemptedAt }),
          ...(succeededAt === undefined ? {} : { succeededAt }),
          ...(failedAt === undefined ? {} : { failedAt }),
        };
      }),
  };
}
