import { afterEach, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

import {
  refreshJobCatalog,
  refreshJobCatalogs,
} from './repository-job-catalog';
import {
  jobKey,
  type JobProfile,
  parseJobDefinition,
} from './repository-job-definition';
import type { CatalogJob, JobStore } from './repository-job-store';
import { RepositoryJobs } from './repository-jobs';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const allocation = { cpu: 2, memory: '6Gi', storage: '24Gi' };
function catalogFiles(description = 'Audit', inputs = {}) {
  const manifest = stringify({
    version: 1,
    description,
    triggers: { manual: true },
    execution: {
      recipe: './recipe.yaml',
      profile: 'audit',
      timeout: '10m',
      maxAttempts: 1,
      resources: { requests: { ...allocation }, limits: { ...allocation } },
    },
    inputs,
    concurrency: { maxRuns: 1, overlap: 'skip' },
    state: { previousSuccessfulResult: false },
    result: {
      contract: 'json-v1',
      requiredArtifacts: ['report.md', 'result.json'],
    },
  });
  const recipe = stringify({
    version: '1.0.0',
    title: 'Audit',
    description: 'Audit',
    prompt: 'Report',
    parameters: [
      ...Object.keys(inputs).map((key) => ({
        key,
        description: key,
        input_type: 'string',
        requirement: 'required',
      })),
      {
        key: 'baseline',
        description: 'baseline',
        input_type: 'string',
        requirement: 'required',
      },
    ],
  });
  return { manifest, recipe };
}

class MemoryJobStore implements JobStore {
  rows = new Map<string, CatalogJob>();
  sources = new Map<string, string>();
  async list() {
    return [...this.rows.values()];
  }
  async readOccurrence() {
    return undefined;
  }
  async history() {
    return [];
  }
  async sourceRefreshes() {
    return new Map(this.sources);
  }
  async recordSourceRefresh(repository: string, refreshedAt: string) {
    this.sources.set(repository, refreshedAt);
  }
  async mutate(
    id: string,
    _: string | undefined,
    change: Parameters<JobStore['mutate']>[2],
  ) {
    const next = change(this.rows.get(id), undefined);
    if (next.job) this.rows.set(id, structuredClone(next.job));
    return next;
  }
}

/** A default-branch source: `jobs` maps job names to their files; undefined
 * models a repository without `.lcars/jobs`. Records each requested path. */
function github(
  sources: Record<
    string,
    Record<string, { manifest: string; recipe: string }> | undefined
  >,
  requested: string[] = [],
) {
  const blobs = new Map<string, string>();
  return vi.fn(async (url: string) => {
    const [, repository, path = ''] =
      /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/?(.*)$/u.exec(url)!;
    requested.push(`${repository} ${path}`);
    const jobs = sources[repository!];
    if (url.endsWith('/')) return new Response('Not Found', { status: 404 });
    if (path === '') return Response.json({ default_branch: 'main' });
    if (path.startsWith('commits/'))
      return Response.json({
        sha: 'a'.repeat(40),
        commit: { tree: { sha: 'root' } },
      });
    const tree = (entries: object[]) => Response.json({ tree: entries });
    const directory = (name: string) => ({
      path: name,
      mode: '040000',
      type: 'tree',
      sha: name.replace('.', ''),
    });
    if (path === 'git/trees/root')
      return tree([
        { path: 'README.md', mode: '100644', type: 'blob', sha: 'readme' },
        ...(jobs ? [directory('.lcars')] : []),
      ]);
    if (path === 'git/trees/lcars') return tree([directory('jobs')]);
    if (path === 'git/trees/jobs?recursive=1')
      return tree(
        Object.entries(jobs ?? {}).flatMap(([name, files]) =>
          (['manifest', 'recipe'] as const).map((kind) => {
            const sha = `${repository}:${name}:${kind}:${blobs.size}`;
            blobs.set(sha, files[kind]);
            return {
              path: `${name}/${kind === 'manifest' ? 'job' : 'recipe'}.yaml`,
              mode: '100644',
              type: 'blob',
              sha: encodeURIComponent(sha),
              size: Buffer.byteLength(files[kind]),
            };
          }),
        ),
      );
    if (path.startsWith('git/blobs/'))
      return Response.json({
        encoding: 'base64',
        content: Buffer.from(
          blobs.get(decodeURIComponent(path.slice('git/blobs/'.length)))!,
        ).toString('base64'),
      });
    return new Response('Not Found', { status: 404 });
  });
}

function automation(store: JobStore, principals = ['svc:scheduler']) {
  const profile: JobProfile = {
    name: 'audit',
    repositories: ['owner/jobs'],
    principals,
    allocation,
    inputSets: [{}],
  };
  const jobs = new RepositoryJobs({
    store,
    runtime: {} as never,
    profiles: () => [profile],
    granted: () => true,
    automationPrincipal: () => 'svc:scheduler',
    now: () => new Date(),
  });
  return (definition: Parameters<typeof jobs.automaticActivation>[0]) =>
    jobs.automaticActivation(definition);
}
const tokens = () => ({ tokenFor: async () => 'fixture' });

it('discovers jobs in a repository nobody installed and activates them on first sight', async () => {
  const store = new MemoryJobStore();
  const requested: string[] = [];
  vi.stubGlobal(
    'fetch',
    github(
      { 'owner/jobs': { audit: catalogFiles() }, 'owner/empty': undefined },
      requested,
    ),
  );
  const at = new Date();
  await refreshJobCatalogs(
    store,
    ['owner/jobs', 'owner/empty'],
    tokens,
    Date.now() + 45_000,
    automation(store),
  );
  const job = store.rows.get(jobKey('owner/jobs', 'audit'));
  expect(job).toMatchObject({
    enabled: true,
    enabledBy: 'svc:scheduler',
    vetoedBy: null,
  });
  expect(Date.parse(job!.activationFloor!)).toBeGreaterThanOrEqual(
    at.getTime(),
  );
  // A repository without `.lcars/jobs` is cheap, recorded, and not an error.
  expect(store.rows.size).toBe(1);
  expect(requested.filter((entry) => entry.startsWith('owner/empty '))).toEqual(
    ['owner/empty ', 'owner/empty commits/main', 'owner/empty git/trees/root'],
  );
  expect([...store.sources.keys()].sort()).toEqual([
    'owner/empty',
    'owner/jobs',
  ]);
});

it('re-activates a changed definition at a new floor but honors a sticky operator veto', async () => {
  const store = new MemoryJobStore();
  const activate = automation(store);
  const id = jobKey('owner/jobs', 'audit');
  const refresh = async (description: string, at: string) => {
    vi.stubGlobal(
      'fetch',
      github({ 'owner/jobs': { audit: catalogFiles(description) } }),
    );
    await refreshJobCatalog(
      store,
      'owner/jobs',
      tokens(),
      new Date(at),
      activate,
    );
    return store.rows.get(id)!;
  };
  const first = await refresh('v1', '2026-10-27T12:00:00.000Z');
  expect(first.activationFloor).toBe('2026-10-27T12:00:00.000Z');
  // An unchanged definition keeps its original floor.
  expect(
    (await refresh('v1', '2026-10-27T12:05:00.000Z')).activationFloor,
  ).toBe('2026-10-27T12:00:00.000Z');
  const changed = await refresh('v2', '2026-10-27T12:10:00.000Z');
  expect(changed.definition?.digest).not.toBe(first.definition?.digest);
  expect(changed).toMatchObject({
    enabled: true,
    enabledBy: 'svc:scheduler',
    activationFloor: '2026-10-27T12:10:00.000Z',
  });

  const operator = new RepositoryJobs({
    store,
    runtime: {} as never,
    profiles: () => [],
    granted: () => true,
    now: () => new Date('2026-10-27T12:12:00.000Z'),
  });
  await operator.enable(id, changed.definition!.digest, 'user:joe', false);
  const vetoed = await refresh('v3', '2026-10-27T12:15:00.000Z');
  expect(vetoed).toMatchObject({ enabled: false, vetoedBy: 'user:joe' });
  // An explicit enable clears the veto; later merges activate again.
  vi.stubGlobal('fetch', github({}));
  const profiled = new RepositoryJobs({
    ...operator.deps,
    profiles: () => [
      {
        name: 'audit',
        repositories: ['owner/jobs'],
        principals: ['user:joe'],
        allocation,
        inputSets: [{}],
      },
    ],
  });
  await profiled.enable(id, vetoed.definition!.digest, 'user:joe', true);
  expect(store.rows.get(id)).toMatchObject({ enabled: true, vetoedBy: null });
  expect(await refresh('v4', '2026-10-27T12:20:00.000Z')).toMatchObject({
    enabled: true,
    enabledBy: 'svc:scheduler',
    activationFloor: '2026-10-27T12:20:00.000Z',
  });
});

it('keeps legacy operator disables, but not source-failure disables, as vetoes', async () => {
  const store = new MemoryJobStore();
  const { manifest, recipe } = catalogFiles();
  const definition = parseJobDefinition(
    'owner/jobs',
    'a'.repeat(40),
    'audit',
    manifest,
    recipe,
  );
  for (const [name, error] of [
    ['audit', undefined],
    ['failed', 'Source refresh failed'],
  ] as const)
    store.rows.set(jobKey('owner/jobs', name), {
      id: jobKey('owner/jobs', name),
      repository: 'owner/jobs',
      name,
      definition,
      enabled: false,
      enabledBy: 'user:joe',
      refreshedAt: '2026-10-27T11:00:00.000Z',
      ...(error ? { error } : {}),
    });
  vi.stubGlobal(
    'fetch',
    github({
      'owner/jobs': { audit: catalogFiles(), failed: catalogFiles() },
    }),
  );
  await refreshJobCatalog(
    store,
    'owner/jobs',
    tokens(),
    new Date('2026-10-27T12:00:00.000Z'),
    automation(store),
  );
  expect(store.rows.get(jobKey('owner/jobs', 'audit'))).toMatchObject({
    enabled: false,
    vetoedBy: 'user:joe',
  });
  expect(store.rows.get(jobKey('owner/jobs', 'failed'))).toMatchObject({
    enabled: true,
    enabledBy: 'svc:scheduler',
    vetoedBy: null,
  });
});

it('leaves invalid and unauthorized definitions visible and disabled', async () => {
  const store = new MemoryJobStore();
  vi.stubGlobal(
    'fetch',
    github({
      'owner/jobs': {
        audit: catalogFiles('Unapproved inputs', { scope: 'all' }),
        broken: { manifest: 'version: [', recipe: 'title: x' },
      },
    }),
  );
  await refreshJobCatalog(
    store,
    'owner/jobs',
    tokens(),
    new Date(),
    automation(store),
  );
  const unauthorized = store.rows.get(jobKey('owner/jobs', 'audit'));
  expect(unauthorized?.definition).toBeDefined();
  expect(unauthorized).toMatchObject({ enabled: false, vetoedBy: null });
  expect(unauthorized?.enabledBy).toBeUndefined();
  const invalid = store.rows.get(jobKey('owner/jobs', 'broken'));
  expect(invalid?.error).toBeTruthy();
  expect(invalid?.enabled).toBe(false);
  // A profile that does not admit the scheduler never activates automatically.
  vi.stubGlobal('fetch', github({ 'owner/jobs': { audit: catalogFiles() } }));
  await refreshJobCatalog(
    store,
    'owner/jobs',
    tokens(),
    new Date(),
    automation(store, ['user:joe']),
  );
  expect(store.rows.get(jobKey('owner/jobs', 'audit'))?.enabled).toBe(false);
});

it('refreshes oldest repositories first within a bounded batch and advances on the next tick', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-27T12:00:00Z'));
  const now = Date.now();
  const store = new MemoryJobStore();
  const repositories = Array.from({ length: 6 }, (_, i) => `owner/repo${i}`);
  // repo5 has never been refreshed; repo0 is the most recent. A tie
  // between equally old sources falls back to repository name.
  for (let i = 0; i < 5; i++)
    store.sources.set(
      `owner/repo${i}`,
      new Date(now - (i + 1) * 60_000).toISOString(),
    );
  const requested: string[] = [];
  let active = 0;
  let peak = 0;
  const slow = () => ({
    tokenFor: async (repository: string) => {
      requested.push(repository);
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 19_000));
      active--;
      return 'fixture';
    },
  });
  vi.stubGlobal(
    'fetch',
    github(
      Object.fromEntries(
        repositories.map((repository) => [
          repository,
          { audit: catalogFiles() },
        ]),
      ),
    ),
  );
  const first = refreshJobCatalogs(
    store,
    repositories,
    slow,
    now + 35_000,
    () => undefined,
  );
  await vi.advanceTimersByTimeAsync(19_000);
  await first;
  expect(requested).toEqual([
    'owner/repo5',
    'owner/repo4',
    'owner/repo3',
    'owner/repo2',
  ]);
  expect(peak).toBe(4);
  expect(Date.now()).toBeLessThan(now + 30_000);
  const next = refreshJobCatalogs(
    store,
    repositories,
    slow,
    Date.now() + 35_000,
    () => undefined,
  );
  await vi.advanceTimersByTimeAsync(19_000);
  await next;
  expect(requested.slice(4)).toEqual([
    'owner/repo1',
    'owner/repo0',
    'owner/repo2',
    'owner/repo3',
  ]);
});

it('refreshes repositories with enabled jobs first and keeps stored repositories current', async () => {
  const store = new MemoryJobStore();
  const id = jobKey('owner/enabled', 'audit');
  const { manifest, recipe } = catalogFiles();
  store.rows.set(id, {
    id,
    repository: 'owner/enabled',
    name: 'audit',
    enabled: true,
    definition: parseJobDefinition(
      'owner/enabled',
      'a'.repeat(40),
      'audit',
      manifest,
      recipe,
    ),
    refreshedAt: '2026-10-27T11:00:00.000Z',
  });
  const dropped = jobKey('owner/dropped', 'audit');
  store.rows.set(dropped, {
    ...store.rows.get(id)!,
    id: dropped,
    repository: 'owner/dropped',
    enabled: false,
  });
  store.sources.set('owner/enabled', '2026-10-27T11:59:00.000Z');
  store.sources.set('owner/dropped', '2026-10-27T11:00:00.000Z');
  const order: string[] = [];
  const requested: string[] = [];
  vi.stubGlobal(
    'fetch',
    github({ 'owner/enabled': { audit: catalogFiles() } }, requested),
  );
  await refreshJobCatalogs(
    store,
    ['owner/a', 'owner/b', 'owner/c', 'owner/d', 'owner/enabled'],
    () => ({
      tokenFor: async (repository: string) => {
        order.push(repository);
        return 'fixture';
      },
    }),
    Date.now() + 45_000,
    automation(store),
  );
  // The recently refreshed enabled repository still leads the first batch.
  expect(order[0]).toBe('owner/enabled');
  expect(order).toHaveLength(6);
  // A repository outside the configured list with stored jobs is refreshed,
  // so its removed definition stops admission.
  expect(store.rows.get(dropped)).toMatchObject({
    enabled: false,
    error: 'Definition removed',
  });
});

it('records a failed refresh and disables admission until a successful one', async () => {
  const store = new MemoryJobStore();
  const id = jobKey('owner/jobs', 'audit');
  vi.stubGlobal('fetch', github({ 'owner/jobs': { audit: catalogFiles() } }));
  await refreshJobCatalog(
    store,
    'owner/jobs',
    tokens(),
    new Date(),
    automation(store),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('Unavailable', { status: 503 })),
  );
  await expect(
    refreshJobCatalog(
      store,
      'owner/jobs',
      tokens(),
      new Date(),
      automation(store),
    ),
  ).rejects.toThrow('Catalog source HTTP 503');
  expect(store.rows.get(id)).toMatchObject({
    enabled: false,
    error: 'Source refresh failed',
  });
  expect(store.sources.has('owner/jobs')).toBe(true);
  vi.stubGlobal('fetch', github({ 'owner/jobs': { audit: catalogFiles() } }));
  await refreshJobCatalog(
    store,
    'owner/jobs',
    tokens(),
    new Date(),
    automation(store),
  );
  expect(store.rows.get(id)).toMatchObject({ enabled: true });
  expect(store.rows.get(id)?.error).toBeUndefined();
});

it.each(['success', 'removal', 'failure'] as const)(
  'preserves a newer reviewed catalog when an older refresh finishes with %s',
  async (outcome) => {
    const repository = 'owner/repo';
    const id = jobKey(repository, 'audit');
    const { manifest, recipe } = catalogFiles();
    const store = new MemoryJobStore();
    store.rows.set(id, {
      id,
      repository,
      name: 'audit',
      enabled: true,
      definition: parseJobDefinition(
        repository,
        'a'.repeat(40),
        'audit',
        manifest,
        recipe,
      ),
      refreshedAt: '2026-10-27T11:59:00.000Z',
    });
    const source = github({ [repository]: { audit: catalogFiles() } });
    let releaseOlder!: () => void;
    let olderWaiting = false;
    const olderRead = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const older =
          new Headers(init.headers).get('Authorization') === 'Bearer older';
        if (url.includes('commits/'))
          return Response.json({
            sha: (older ? 'a' : 'b').repeat(40),
            commit: { tree: { sha: 'root' } },
          });
        if (older && url.includes('git/trees/jobs')) {
          olderWaiting = true;
          await olderRead;
          if (outcome === 'failure')
            return new Response('Unavailable', { status: 503 });
          if (outcome === 'removal') return Response.json({ tree: [] });
        }
        return source(url);
      }),
    );
    const older = refreshJobCatalog(
      store,
      repository,
      { tokenFor: async () => 'older' },
      new Date('2026-10-27T12:00:00.000Z'),
      () => undefined,
    );
    await vi.waitFor(() => expect(olderWaiting).toBe(true));
    await refreshJobCatalog(
      store,
      repository,
      { tokenFor: async () => 'newer' },
      new Date('2026-10-27T12:00:01.000Z'),
      () => undefined,
    );
    // An operator can review and enable the newer result before the older
    // request resumes; neither old source nor old errors may undo that state.
    await store.mutate(id, undefined, (job) => ({
      job: { ...job!, enabled: true, enabledBy: 'user:joe' },
    }));
    const reviewed = structuredClone(store.rows.get(id));
    releaseOlder();
    const error = await older.then(
      () => undefined,
      (reason: Error) => reason.message,
    );
    expect(error).toBe(
      outcome === 'failure' ? 'Catalog source HTTP 503' : undefined,
    );
    expect(store.rows.get(id)).toEqual(reviewed);
    expect(store.rows.get(id)?.definition?.revision).toBe('b'.repeat(40));
    expect(store.rows.get(id)?.enabled).toBe(true);
  },
);
