import { createHash } from 'node:crypto';

import { afterEach, expect, it, vi } from 'vitest';

import {
  refreshAgentCatalog,
  refreshAgentCatalogs,
} from './repository-agent-catalog';
import { agentKey } from './repository-agent-definition';
import type {
  AgentSource,
  AgentStore,
  CatalogAgent,
} from './repository-agent-store';

afterEach(() => {
  vi.unstubAllGlobals();
});

class MemoryAgentStore implements AgentStore {
  rows = new Map<string, CatalogAgent>();
  sourceRows = new Map<string, AgentSource>();
  async list() {
    return [...this.rows.values()];
  }
  async read(id: string) {
    return this.rows.get(id);
  }
  async sources() {
    return [...this.sourceRows.values()];
  }
  async recordAttempt(repository: string, at: string) {
    this.sourceRows.set(repository, {
      ...this.sourceRows.get(repository),
      repository,
      attemptedAt: at,
    });
  }
  async claimObservation(repository: string, at: string) {
    const observedAt = this.sourceRows.get(repository)?.observedAt;
    if (observedAt && Date.parse(observedAt) > Date.parse(at)) return false;
    this.sourceRows.set(repository, {
      ...this.sourceRows.get(repository),
      repository,
      observedAt: at,
    });
    return true;
  }
  async mutate(
    id: string,
    change: Parameters<AgentStore['mutate']>[1],
    fence?: Parameters<AgentStore['mutate']>[2],
  ) {
    const observedAt =
      fence && this.sourceRows.get(fence.repository)?.observedAt;
    if (fence && observedAt && Date.parse(observedAt) > Date.parse(fence.at))
      return {};
    const next = change(this.rows.get(id));
    if (next.agent) this.rows.set(id, structuredClone(next.agent));
    return next;
  }
}

type Files = Record<string, { content: string; mode?: string }>;
const blobSha = (content: string) =>
  createHash('sha1').update(content).digest('hex');

/** A default-branch source whose `.lcars/agents` holds `agents` (name →
 * files); undefined models a repository without `.lcars/agents`. */
function github(
  agents: Record<string, Files> | undefined,
  options: { fail?: boolean; extra?: object[] } = {},
) {
  const blobs = new Map<string, string>();
  return vi.fn(async (url: string) => {
    const path =
      /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/?(.*)$/u.exec(
        url,
      )![1]!;
    if (options.fail) return new Response('boom', { status: 500 });
    if (path === '') return Response.json({ default_branch: 'main' });
    if (path.startsWith('commits/'))
      return Response.json({
        sha: 'c'.repeat(40),
        commit: { tree: { sha: 'root' } },
      });
    const dir = (name: string, sha: string) => ({
      path: name,
      mode: '040000',
      type: 'tree',
      sha,
    });
    if (path === 'git/trees/root')
      return Response.json({ tree: agents ? [dir('.lcars', 'lcars')] : [] });
    if (path === 'git/trees/lcars')
      return Response.json({ tree: [dir('agents', 'agents')] });
    if (path === 'git/trees/agents?recursive=1')
      return Response.json({
        tree: [
          ...Object.entries(agents ?? {}).flatMap(([name, files]) => [
            dir(name, `${name}-tree`),
            ...Object.entries(files).map(([file, { content, mode }]) => {
              const sha = blobSha(content);
              blobs.set(sha, content);
              return {
                path: `${name}/${file}`,
                mode: mode ?? '100644',
                type: 'blob',
                sha,
                size: content.length,
              };
            }),
          ]),
          ...(options.extra ?? []),
        ],
      });
    if (path.startsWith('git/blobs/'))
      return new Response(blobs.get(path.slice('git/blobs/'.length))!);
    return new Response('Not Found', { status: 404 });
  });
}

const tokens = { tokenFor: async () => 'fixture' };
const now = new Date('2026-11-16T00:00:00Z');
function investigator(
  manifest = 'description: Read-only investigator.\n',
): Files {
  return {
    'agent.yaml': { content: manifest },
    'config.json': { content: '{}' },
    'approvals.json': { content: '{}' },
    'workspace/AGENTS.md': { content: '# Investigator' },
    'workspace/tools/probe': { content: '#!/bin/sh', mode: '100755' },
  };
}

it('catalogs and enables a valid agent with only a description, pinning every file by mode and blob', async () => {
  const store = new MemoryAgentStore();
  vi.stubGlobal('fetch', github({ investigator: investigator() }));
  await refreshAgentCatalog(store, 'owner/repo', tokens, now);
  const agent = store.rows.get(agentKey('owner/repo', 'investigator'))!;
  expect(agent).toMatchObject({
    repository: 'owner/repo',
    name: 'investigator',
    enabled: true,
    vetoedBy: null,
  });
  expect(agent.error).toBeUndefined();
  expect(agent.definition).toMatchObject({
    revision: 'c'.repeat(40),
    manifest: { description: 'Read-only investigator.' },
  });
  expect(agent.definition!.fileCount).toBe(5);
});

it('changes the digest when any file changes, including its mode', async () => {
  const digest = async (files: Files) => {
    const store = new MemoryAgentStore();
    vi.stubGlobal('fetch', github({ investigator: files }));
    await refreshAgentCatalog(store, 'owner/repo', tokens, now);
    return [...store.rows.values()][0]!.definition!.digest;
  };
  const base = await digest(investigator());
  const edited = investigator();
  edited['workspace/AGENTS.md'] = { content: '# Changed' };
  const chmod = investigator();
  chmod['workspace/tools/probe'] = { content: '#!/bin/sh', mode: '100644' };
  expect(await digest(edited)).not.toBe(base);
  expect(await digest(chmod)).not.toBe(base);
  expect(await digest(investigator())).toBe(base);
});

it.each([
  ['an unknown manifest field', 'description: x\nretries: 3\n', /retries/u],
  ['a duplicate key', 'description: x\ndescription: y\n', /Invalid YAML/u],
  ['no description', 'retry: finite\n', /description/u],
])(
  'keeps an agent with %s visible and disabled',
  async (_, manifest, error) => {
    const store = new MemoryAgentStore();
    vi.stubGlobal('fetch', github({ investigator: investigator(manifest) }));
    await refreshAgentCatalog(store, 'owner/repo', tokens, now);
    const agent = [...store.rows.values()][0]!;
    expect(agent.enabled).toBe(false);
    expect(agent.definition).toBeUndefined();
    expect(agent.error).toMatch(error);
  },
);

it('rejects an agent missing a launcher file or holding a symlink', async () => {
  const store = new MemoryAgentStore();
  const missing = investigator();
  delete missing['approvals.json'];
  const linked = investigator();
  linked['workspace/link'] = { content: 'target', mode: '120000' };
  vi.stubGlobal('fetch', github({ missing, linked }));
  await refreshAgentCatalog(store, 'owner/repo', tokens, now);
  expect(store.rows.get(agentKey('owner/repo', 'missing'))).toMatchObject({
    enabled: false,
    error: 'Agent is missing approvals.json',
  });
  expect(store.rows.get(agentKey('owner/repo', 'linked'))).toMatchObject({
    enabled: false,
  });
  expect(store.rows.get(agentKey('owner/repo', 'linked'))!.error).toMatch(
    /regular files/u,
  );
});

it('keeps a vetoed agent disabled across refreshes', async () => {
  const store = new MemoryAgentStore();
  vi.stubGlobal('fetch', github({ investigator: investigator() }));
  await refreshAgentCatalog(store, 'owner/repo', tokens, now);
  const id = agentKey('owner/repo', 'investigator');
  store.rows.set(id, {
    ...store.rows.get(id)!,
    enabled: false,
    vetoedBy: 'user:joe',
  });
  await refreshAgentCatalog(
    store,
    'owner/repo',
    tokens,
    new Date(now.getTime() + 1000),
  );
  expect(store.rows.get(id)).toMatchObject({
    enabled: false,
    vetoedBy: 'user:joe',
  });
});

it('disables a removed agent and every agent when the source refresh fails', async () => {
  const store = new MemoryAgentStore();
  vi.stubGlobal(
    'fetch',
    github({ investigator: investigator(), other: investigator() }),
  );
  await refreshAgentCatalog(store, 'owner/repo', tokens, now);
  vi.stubGlobal('fetch', github({ investigator: investigator() }));
  await refreshAgentCatalog(
    store,
    'owner/repo',
    tokens,
    new Date(now.getTime() + 1000),
  );
  expect(store.rows.get(agentKey('owner/repo', 'other'))).toMatchObject({
    enabled: false,
    error: 'Definition removed',
  });
  vi.stubGlobal('fetch', github(undefined, { fail: true }));
  await expect(
    refreshAgentCatalog(
      store,
      'owner/repo',
      tokens,
      new Date(now.getTime() + 2000),
    ),
  ).rejects.toThrow();
  expect(store.rows.get(agentKey('owner/repo', 'investigator'))).toMatchObject({
    enabled: false,
    error: 'Source refresh failed',
  });
});

it('treats a repository without .lcars/agents as having none, and never lets an older observation win', async () => {
  const store = new MemoryAgentStore();
  vi.stubGlobal('fetch', github(undefined));
  await refreshAgentCatalogs(
    store,
    ['owner/none'],
    () => tokens,
    Date.now() + 60_000,
  );
  expect(store.rows.size).toBe(0);
  vi.stubGlobal('fetch', github({ investigator: investigator() }));
  await refreshAgentCatalog(store, 'owner/repo', tokens, now);
  const id = agentKey('owner/repo', 'investigator');
  const newer = store.rows.get(id)!;
  vi.stubGlobal('fetch', github({}));
  await refreshAgentCatalog(
    store,
    'owner/repo',
    tokens,
    new Date(now.getTime() - 1000),
  );
  expect(store.rows.get(id)).toEqual(newer);
});

it('records a malformed agent name as its own error without disabling valid siblings', async () => {
  const store = new MemoryAgentStore();
  vi.stubGlobal(
    'fetch',
    github({ my_agent: investigator(), investigator: investigator() }),
  );
  await refreshAgentCatalog(store, 'owner/repo', tokens, now);
  expect(store.rows.get(agentKey('owner/repo', 'investigator'))).toMatchObject({
    enabled: true,
  });
  const malformed = store.rows.get(agentKey('owner/repo', 'my_agent'))!;
  expect(malformed.enabled).toBe(false);
  expect(malformed.error).toBeDefined();
});

it('never lets an older observation resurrect what a newer refresh removed', async () => {
  const store = new MemoryAgentStore();
  vi.stubGlobal('fetch', github({}));
  await refreshAgentCatalog(
    store,
    'owner/repo',
    tokens,
    new Date(now.getTime() + 1000),
  );
  vi.stubGlobal('fetch', github({ investigator: investigator() }));
  await refreshAgentCatalog(store, 'owner/repo', tokens, now);
  expect(store.rows.size).toBe(0);
});

it('reads a manifest larger than any response cap', async () => {
  const store = new MemoryAgentStore();
  const big = `# ${'x'.repeat(3 * 1024 * 1024)}\ndescription: Large.\n`;
  vi.stubGlobal('fetch', github({ investigator: investigator(big) }));
  await refreshAgentCatalog(store, 'owner/repo', tokens, now);
  expect([...store.rows.values()][0]).toMatchObject({ enabled: true });
});

it('refreshes the least recently attempted repositories first across ticks', async () => {
  const store = new MemoryAgentStore();
  const seen: string[] = [];
  const fetch = github({ investigator: investigator() });
  vi.stubGlobal('fetch', async (url: string) => {
    const repository = /repos\/([^/]+\/[^/]+)/u.exec(url)![1]!;
    if (!seen.includes(repository)) seen.push(repository);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return fetch(url);
  });
  const repositories = ['a/1', 'b/2', 'c/3', 'd/4', 'e/5'];
  // Room for exactly one batch of four per tick.
  const oneBatch = () => Date.now() + 25_002;
  await refreshAgentCatalogs(store, repositories, () => tokens, oneBatch());
  expect(seen.sort()).toEqual(['a/1', 'b/2', 'c/3', 'd/4']);
  seen.length = 0;
  await refreshAgentCatalogs(store, repositories, () => tokens, oneBatch());
  expect(seen).toContain('e/5');
});

it('sweeps a row an older refresh published while a newer refresh was reading', async () => {
  const store = new MemoryAgentStore();
  const older = github({ investigator: investigator() });
  const newer = github({});
  let olderRan = false;
  const interleaved = async (url: string): Promise<Response> => {
    if (!olderRan && url.endsWith('git/trees/agents?recursive=1')) {
      // The newer refresh is mid-read when the older one completes.
      olderRan = true;
      vi.stubGlobal('fetch', older);
      await refreshAgentCatalog(store, 'owner/repo', tokens, now);
      vi.stubGlobal('fetch', interleaved);
    }
    return newer(url);
  };
  vi.stubGlobal('fetch', interleaved);
  await refreshAgentCatalog(
    store,
    'owner/repo',
    tokens,
    new Date(now.getTime() + 1000),
  );
  expect(store.rows.get(agentKey('owner/repo', 'investigator'))).toMatchObject({
    enabled: false,
    error: 'Definition removed',
  });
});

it('reads a recursive agent tree larger than any response cap', async () => {
  const store = new MemoryAgentStore();
  const files = investigator();
  for (let index = 0; index < 3000; index++)
    files[`workspace/${'deep/'.repeat(120)}file-${index}.md`] = {
      content: `${index}`,
    };
  vi.stubGlobal('fetch', github({ investigator: files }));
  await refreshAgentCatalog(store, 'owner/repo', tokens, now);
  const agent = [...store.rows.values()][0]!;
  expect(agent.enabled).toBe(true);
  expect(agent.definition!.fileCount).toBeGreaterThan(3000);
  // The stored row stays small however many files the agent holds.
  expect(JSON.stringify(agent).length).toBeLessThan(64 * 1024);
});
