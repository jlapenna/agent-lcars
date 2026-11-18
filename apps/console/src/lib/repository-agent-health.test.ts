import { repositoryAgentObservationSchema } from '@agent-lcars/work';
import { expect, it } from 'vitest';

import { observeAgentCatalog } from './repository-agent-health';
import type { CatalogAgent } from './repository-agent-store';

const at = '2026-11-18T10:00:00.000Z';
const definition = {} as NonNullable<CatalogAgent['definition']>;
const agent = (overrides: Partial<CatalogAgent>): CatalogAgent => ({
  id: 'a'.repeat(64),
  repository: 'owner/repo',
  name: 'agent',
  refreshedAt: at,
  enabled: false,
  ...overrides,
});

it('counts agents by admission state without naming any', () => {
  const observation = observeAgentCatalog(
    [
      agent({ enabled: true, definition }),
      agent({ definition, vetoedBy: 'user:joe' }),
      agent({ error: 'Invalid manifest: secret detail' }),
      agent({ error: 'Source refresh failed' }),
      agent({ error: 'Definition removed' }),
    ],
    [
      {
        repository: 'owner/b',
        attemptedAt: at,
        succeededAt: at,
        observedAt: at,
      },
      { repository: 'owner/a', attemptedAt: at, failedAt: at },
    ],
    new Date(at),
  );
  expect(observation).toEqual({
    version: 1,
    observedAt: at,
    agents: { enabled: 1, vetoed: 1, invalid: 1, unavailable: 1, removed: 1 },
    sources: [
      { repository: 'owner/a', attemptedAt: at, failedAt: at },
      { repository: 'owner/b', attemptedAt: at, succeededAt: at },
    ],
  });
  expect(repositoryAgentObservationSchema.parse(observation)).toEqual(
    observation,
  );
  expect(JSON.stringify(observation)).not.toContain('secret detail');
});
