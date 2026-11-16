import { createHash } from 'node:crypto';

import { afterEach, expect, it, vi } from 'vitest';

import {
  refreshAgentCatalog,
  refreshAgentCatalogs,
} from './repository-agent-catalog';
import { agentKey } from './repository-agent-definition';
import type { AgentStore, CatalogAgent } from './repository-agent-store';

afterEach(() => {
  vi.unstubAllGlobals();
});

class MemoryAgentStore implements AgentStore {
  rows = new Map<string, CatalogAgent>();
  async list() {
    return [...this.rows.values()];
  }
  async read(id: string) {
    return this.rows.get(id);
  }
  async mutate(id: string, change: Parameters<AgentStore['mutate']>[1]) {
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
      return Response.json({
        encoding: 'base64',
        content: Buffer.from(
          blobs.get(path.slice('git/blobs/'.length))!,
        ).toString('base64'),
      });
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
  expect(agent.definition!.files.map((file) => [file.path, file.mode])).toEqual(
    [
      ['agent.yaml', '100644'],
      ['approvals.json', '100644'],
      ['config.json', '100644'],
      ['workspace/AGENTS.md', '100644'],
      ['workspace/tools/probe', '100755'],
    ],
  );
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
