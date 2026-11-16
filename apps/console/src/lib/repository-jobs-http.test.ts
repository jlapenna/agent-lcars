import { REPOSITORY_JOB_REQUEST_MAX_BYTES } from '@agent-lcars/work';
import { beforeEach, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

import { parseJobDefinition } from './repository-job-definition';
import type { CatalogJob, JobStore } from './repository-job-store';
import { RepositoryJobs } from './repository-jobs';
import { repositoryJobsHttp } from './repository-jobs-http';
import type { WorkPrincipal } from './work-auth';

const mocks = vi.hoisted(() => ({
  runtime: vi.fn(),
  jobs: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('./orchestrator-runtime', () => ({
  createOrchestratorRuntime: mocks.runtime,
}));
vi.mock('./repository-jobs-runtime', () => ({ repositoryJobs: mocks.jobs }));
vi.mock('./repository-job-catalog', () => ({
  refreshJobCatalog: mocks.refresh,
}));
vi.mock('./github-app-tokens', () => ({
  createDispatchTokenProvider: vi.fn(),
}));
vi.mock('./deployment', () => ({
  isControlPlaneRepository: (repo: string) =>
    ['octo/other', 'octo/source'].includes(repo),
}));

const allocation = { cpu: 2, memory: '6Gi', storage: '24Gi' };
const definition = parseJobDefinition(
  'octo/other',
  'a'.repeat(40),
  'audit',
  stringify({
    version: 1,
    description: 'Audit',
    triggers: { manual: true },
    execution: {
      recipe: './recipe.yaml',
      profile: 'audit',
      timeout: '10m',
      maxAttempts: 1,
      resources: { requests: { ...allocation }, limits: { ...allocation } },
    },
    inputs: {},
    concurrency: { maxRuns: 1, overlap: 'skip' },
    state: { previousSuccessfulResult: false },
    result: {
      contract: 'json-v1',
      requiredArtifacts: ['report.md', 'result.json'],
    },
  }),
  stringify({
    version: '1.0.0',
    title: 'Audit',
    description: 'Audit',
    prompt: 'Report',
    parameters: [
      {
        key: 'baseline',
        description: 'baseline',
        input_type: 'string',
        requirement: 'required',
      },
    ],
  }),
);
let catalog: CatalogJob;
const source: WorkPrincipal = {
  principal: 'shared-ci',
  subject: 'source',
  scopes: new Set(['work.operator']),
  pipelines: ['goose'],
  via: 'oidc',
  sourceRepository: 'OCTO/SOURCE',
};
const store: JobStore = {
  list: async () => [catalog],
  readOccurrence: async () => undefined,
  history: async () => [],
  sourceRefreshes: async () => new Map(),
  recordSourceRefresh: async () => undefined,
  mutate: async (_id, _occurrence, change) => change(catalog, undefined),
};
beforeEach(() => {
  vi.clearAllMocks();
  catalog = {
    id: 'b'.repeat(64),
    repository: 'octo/other',
    name: 'audit',
    definition,
    enabled: true,
    refreshedAt: new Date().toISOString(),
  };
  mocks.jobs.mockReturnValue({
    deps: {
      store,
      runtime: {},
      profiles: () => [],
      granted: () => true,
      now: () => new Date(),
    },
  });
});
function request(path: string, body: unknown) {
  return new Request(`https://console.example/api/work/v1/jobs${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
it('asks an unauthenticated caller to sign in instead of reporting a grant', async () => {
  const response = await repositoryJobsHttp(
    new Request(
      `https://console.example/api/work/v1/jobs/${'b'.repeat(64)}/profiles`,
    ),
    undefined,
  );
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: 'Sign in required' });
});
it.each(['invoke', 'enable'])(
  'rejects cross-repository hashed %s despite a shared grant',
  async (operation) => {
    const response = await repositoryJobsHttp(
      request(
        `/${catalog.id}/${operation}`,
        operation === 'enable'
          ? { digest: definition.digest, enabled: false }
          : { digest: definition.digest, requestId: 'event' },
      ),
      source,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Goose operator grant required',
    });
    expect(catalog.enabled).toBe(true);
  },
);
it('filters catalog and refuses cross-repository refresh', async () => {
  const response = await repositoryJobsHttp(
    new Request('https://console.example/api/work/v1/jobs'),
    source,
  );
  expect(await response.json()).toEqual([]);
  expect(
    (
      await repositoryJobsHttp(
        request('/refresh', { repository: 'octo/other' }),
        source,
      )
    ).status,
  ).toBe(409);
  expect(mocks.refresh).not.toHaveBeenCalled();
});
it('matches signed repository case-insensitively', async () => {
  const response = await repositoryJobsHttp(
    request('/refresh', { repository: 'octo/source' }),
    source,
  );
  expect(response.status).toBe(200);
  expect(mocks.refresh).toHaveBeenCalledOnce();
});

it('lists all registered jobs, including disabled and invalid definitions', async () => {
  const registered = [
    catalog,
    { ...catalog, id: 'c'.repeat(64), name: 'disabled', enabled: false },
    {
      ...catalog,
      id: 'd'.repeat(64),
      name: 'invalid',
      enabled: false,
      definition: undefined,
      error: 'Invalid YAML',
    },
  ];
  vi.spyOn(store, 'list').mockResolvedValueOnce(registered);
  const response = await repositoryJobsHttp(
    new Request('https://console.example/api/work/v1/jobs'),
    { ...source, sourceRepository: undefined },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(JSON.parse(JSON.stringify(registered)));
});

it('reads historical metadata after profile retirement without weakening repository authorization', async () => {
  const occurrence = {
    id: 'c'.repeat(64),
    definition,
    profile: { name: 'retired-profile', environment: 'skill-evals' },
  };
  vi.spyOn(store, 'readOccurrence').mockResolvedValue(occurrence as never);
  const operator: WorkPrincipal = {
    ...source,
    via: 'session',
    sourceRepository: undefined,
    principal: 'user:joe',
  };
  const response = await repositoryJobsHttp(
    new Request(
      `https://console.example/api/work/v1/jobs/occurrences/${occurrence.id}`,
    ),
    operator,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(occurrence);
  const denied = await repositoryJobsHttp(
    new Request(
      `https://console.example/api/work/v1/jobs/occurrences/${occurrence.id}`,
    ),
    source,
  );
  expect(denied.status).toBe(409);
});

it('accepts invoke bodies sized by the parameter budget, far above 16 KiB', async () => {
  const invoke = vi
    .spyOn(RepositoryJobs.prototype, 'invoke')
    .mockResolvedValue({ skipped: true } as never);
  const target = 'x'.repeat(200 * 1024);
  const response = await repositoryJobsHttp(
    request('/invoke', {
      repository: 'octo/source',
      name: 'audit',
      requestId: 'event',
      parameters: { target },
    }),
    source,
  );
  expect(await response.json()).toMatchObject({ outcome: 'busy' });
  expect(invoke.mock.calls[0]?.[4]).toEqual({ target });
  const oversized = await repositoryJobsHttp(
    request('/invoke', {
      repository: 'octo/source',
      name: 'audit',
      requestId: 'event',
      parameters: { target: 'x'.repeat(REPOSITORY_JOB_REQUEST_MAX_BYTES) },
    }),
    source,
  );
  expect(oversized.status).toBe(409);
  expect(await oversized.json()).toEqual({
    error: 'Job response/request too large',
  });
  invoke.mockRestore();
});
