import { afterEach, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

import {
  refreshEnabledJobCatalogs,
  refreshJobCatalog,
} from './repository-job-catalog';
import { jobKey, parseJobDefinition } from './repository-job-definition';
import type { CatalogJob, JobStore } from './repository-job-store';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function catalogFiles() {
  const allocation = { cpu: 2, memory: '6Gi', storage: '24Gi' };
  const manifest = stringify({
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
  });
  const recipe = stringify({
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
  });
  return { manifest, recipe };
}

it('refreshes oldest repositories first within a bounded batch and advances on the next tick', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-27T12:00:00Z'));
  const now = Date.now();
  const { manifest, recipe } = catalogFiles();
  const id = (i: number) => jobKey(`owner/repo${i}`, 'audit');
  const rows = new Map<string, CatalogJob>();
  for (let i = 0; i < 6; i++)
    rows.set(id(i), {
      id: id(i),
      repository: `owner/repo${i}`,
      name: 'audit',
      enabled: true,
      definition: parseJobDefinition(
        `owner/repo${i}`,
        'a'.repeat(40),
        'audit',
        manifest,
        recipe,
      ),
      refreshedAt: new Date(now - i * 60_000).toISOString(),
    });
  const store: JobStore = {
    list: async () => [...rows.values()],
    readOccurrence: async () => undefined,
    history: async () => [],
    mutate: async (id, _occurrence, change) => {
      const next = change(rows.get(id), undefined);
      if (next.job) rows.set(id, next.job);
      return next;
    },
  };
  const requested: string[] = [];
  let active = 0;
  let peak = 0;
  const tokens = () => ({
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
    vi.fn(async (url: string) =>
      Response.json(
        url.includes('git/trees')
          ? {
              tree: [
                {
                  path: '.lcars/jobs/audit/job.yaml',
                  mode: '100644',
                  type: 'blob',
                  sha: 'manifest',
                  size: Buffer.byteLength(manifest),
                },
                {
                  path: '.lcars/jobs/audit/recipe.yaml',
                  mode: '100644',
                  type: 'blob',
                  sha: 'recipe',
                  size: Buffer.byteLength(recipe),
                },
              ],
            }
          : url.includes('git/blobs/')
            ? {
                encoding: 'base64',
                content: Buffer.from(
                  url.endsWith('/manifest') ? manifest : recipe,
                ).toString('base64'),
              }
            : url.includes('commits/')
              ? {
                  sha: 'a'.repeat(40),
                  commit: { tree: { sha: 'b'.repeat(40) } },
                }
              : { default_branch: 'main' },
      ),
    ),
  );
  const first = refreshEnabledJobCatalogs(store, tokens, now + 35_000);
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
  expect(rows.get(id(1))?.enabled).toBe(true);
  const next = refreshEnabledJobCatalogs(store, tokens, Date.now() + 35_000);
  await vi.advanceTimersByTimeAsync(19_000);
  await next;
  expect(requested.slice(4)).toEqual([
    'owner/repo1',
    'owner/repo0',
    'owner/repo2',
    'owner/repo3',
  ]);
  expect([...rows.values()].every((row) => row.enabled)).toBe(true);
});

it.each(['success', 'removal', 'failure'] as const)(
  'preserves a newer reviewed catalog when an older refresh finishes with %s',
  async (outcome) => {
    const repository = 'owner/repo';
    const id = jobKey(repository, 'audit');
    const { manifest, recipe } = catalogFiles();
    const rows = new Map<string, CatalogJob>([
      [
        id,
        {
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
        },
      ],
    ]);
    const store: JobStore = {
      list: async () => [...rows.values()],
      readOccurrence: async () => undefined,
      history: async () => [],
      mutate: async (key, _occurrence, change) => {
        const next = change(rows.get(key), undefined);
        if (next.job) rows.set(key, next.job);
        return next;
      },
    };
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
        if (url.includes('git/trees')) {
          if (older) {
            olderWaiting = true;
            await olderRead;
            if (outcome === 'failure')
              return new Response('Unavailable', { status: 503 });
            if (outcome === 'removal') return Response.json({ tree: [] });
          }
          return Response.json({
            tree: [
              {
                path: '.lcars/jobs/audit/job.yaml',
                mode: '100644',
                type: 'blob',
                sha: 'manifest',
                size: Buffer.byteLength(manifest),
              },
              {
                path: '.lcars/jobs/audit/recipe.yaml',
                mode: '100644',
                type: 'blob',
                sha: 'recipe',
                size: Buffer.byteLength(recipe),
              },
            ],
          });
        }
        if (url.includes('git/blobs/'))
          return Response.json({
            encoding: 'base64',
            content: Buffer.from(
              url.endsWith('/manifest') ? manifest : recipe,
            ).toString('base64'),
          });
        if (url.includes('commits/'))
          return Response.json({
            sha: (older ? 'a' : 'b').repeat(40),
            commit: { tree: { sha: 'tree' } },
          });
        return Response.json({ default_branch: 'main' });
      }),
    );
    const older = refreshJobCatalog(
      store,
      repository,
      { tokenFor: async () => 'older' },
      new Date('2026-10-27T12:00:00.000Z'),
    );
    await vi.waitFor(() => expect(olderWaiting).toBe(true));
    await refreshJobCatalog(
      store,
      repository,
      { tokenFor: async () => 'newer' },
      new Date('2026-10-27T12:00:01.000Z'),
    );
    // An operator can review and enable the newer result before the older
    // request resumes; neither old source nor old errors may undo that state.
    await store.mutate(id, undefined, (job) => ({
      job: { ...job!, enabled: true, enabledBy: 'user:joe' },
    }));
    const reviewed = structuredClone(rows.get(id));
    releaseOlder();
    const error = await older.then(
      () => undefined,
      (reason: Error) => reason.message,
    );
    expect(error).toBe(
      outcome === 'failure' ? 'Catalog source HTTP 503' : undefined,
    );
    expect(rows.get(id)).toEqual(reviewed);
    expect(rows.get(id)?.definition?.revision).toBe('b'.repeat(40));
    expect(rows.get(id)?.enabled).toBe(true);
  },
);
