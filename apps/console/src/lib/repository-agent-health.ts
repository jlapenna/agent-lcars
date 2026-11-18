import type { RepositoryAgentObservation } from '@agent-lcars/work';

import type { AgentSource, CatalogAgent } from './repository-agent-store';

/** The refresh error rows that say why a definition cannot run because of
 * its source rather than its own content (repository-agent-catalog.ts). */
const SOURCE_FAILED = 'Source refresh failed';
const REMOVED = 'Definition removed';

/** Catalog health for the maintenance reply: agents by admission state and
 * each repository's refresh timestamps. No agent names or errors leave. */
export function observeAgentCatalog(
  agents: readonly CatalogAgent[],
  sources: readonly AgentSource[],
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
  return {
    version: 1,
    observedAt: now.toISOString(),
    agents: counts,
    sources: [...sources]
      .sort((left, right) => left.repository.localeCompare(right.repository))
      .map(({ repository, attemptedAt, succeededAt, failedAt }) => ({
        repository,
        ...(attemptedAt === undefined ? {} : { attemptedAt }),
        ...(succeededAt === undefined ? {} : { succeededAt }),
        ...(failedAt === undefined ? {} : { failedAt }),
      })),
  };
}
