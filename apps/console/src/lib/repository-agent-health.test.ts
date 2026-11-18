import { repositoryAgentObservationSchema } from '@agent-lcars/work';
import { expect, it } from 'vitest';

import {
  observeAgentCatalog,
  OBSERVED_SOURCE_LIMIT,
} from './repository-agent-health';
import type { CatalogAgent } from './repository-agent-store';

const at = '2026-11-18T10:00:00.000Z';
const definition = {} as NonNullable<CatalogAgent['definition']>;
const agent = (overrides: Partial<CatalogAgent>): CatalogAgent => ({
  id: 'a'.repeat(64),
  repository: 'owner/a',
  name: 'agent',
  refreshedAt: at,
  enabled: false,
  ...overrides,
});

it('counts agents by admission state and reports refreshed repositories without naming agents', () => {
  const observation = observeAgentCatalog(
    [
      agent({ enabled: true, definition }),
      agent({ definition, vetoedBy: 'user:joe' }),
      agent({ error: 'Invalid manifest: secret detail' }),
      agent({ error: 'Source refresh failed' }),
      agent({ error: 'Definition removed' }),
    ],
    [
      { repository: 'owner/b', attemptedAt: at, observedAt: at },
      { repository: 'owner/a', attemptedAt: at },
      { repository: 'owner/gone', attemptedAt: at },
    ],
    [
      { repository: 'owner/b', succeededAt: at },
      { repository: 'owner/a', failedAt: at },
      { repository: 'owner/gone', failedAt: at },
    ],
    ['owner/b'],
    new Date(at),
  );
  expect(observation).toEqual({
    version: 1,
    observedAt: at,
    agents: { enabled: 1, vetoed: 1, invalid: 1, unavailable: 1, removed: 1 },
    // owner/a holds stored agents; owner/gone is neither configured nor stored.
    sources: [
      { repository: 'owner/a', attemptedAt: at, failedAt: at, unavailable: 1 },
      {
        repository: 'owner/b',
        attemptedAt: at,
        succeededAt: at,
        unavailable: 0,
      },
    ],
  });
  expect(repositoryAgentObservationSchema.parse(observation)).toEqual(
    observation,
  );
  expect(JSON.stringify(observation)).not.toContain('secret detail');
});

it('bounds the reported repositories to fit the maintenance reply', () => {
  const repositories = Array.from(
    { length: OBSERVED_SOURCE_LIMIT + 50 },
    (_, index) =>
      `owner/repository-with-a-long-name-${String(index).padStart(3, '0')}`,
  );
  const observation = observeAgentCatalog(
    [],
    repositories.map((repository) => ({ repository, attemptedAt: at })),
    repositories.map((repository) => ({
      repository,
      succeededAt: at,
      failedAt: at,
    })),
    repositories,
    new Date(at),
  );
  expect(observation.sources).toHaveLength(OBSERVED_SOURCE_LIMIT);
  expect(JSON.stringify(observation).length).toBeLessThan(32 * 1024);
});
