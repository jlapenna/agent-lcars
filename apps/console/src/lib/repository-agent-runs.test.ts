import { createHash } from 'node:crypto';

import { afterEach, expect, it, vi } from 'vitest';

import { agentDigest } from './repository-agent-definition';
import {
  agentProfiles,
  agentRunBrief,
  resolveAgentRuntime,
} from './repository-agent-runs';

afterEach(() => vi.unstubAllGlobals());

const revision = 'e'.repeat(40);
const files = {
  'agent.yaml': { content: 'description: x\n', mode: '100644' },
  'config.json': { content: '{}', mode: '100644' },
  'approvals.json': { content: '{}', mode: '100644' },
  'workspace/tools/probe': { content: '#!/bin/sh\necho ok\n', mode: '100755' },
} as const;
const sha = (content: string) =>
  createHash('sha1').update(content).digest('hex');
const pinned = Object.entries(files).map(([path, { content, mode }]) => ({
  path,
  mode,
  sha: sha(content),
}));

function github(requested: string[] = []) {
  const blobs = new Map(
    Object.values(files).map(({ content }) => [sha(content), content]),
  );
  return vi.fn(async (url: string) => {
    const path = /repos\/owner\/repo\/?(.*)$/u.exec(url)![1]!;
    requested.push(path);
    if (path === `commits/${revision}`)
      return Response.json({
        sha: revision,
        commit: { tree: { sha: 'root' } },
      });
    const dir = (name: string, tree: string) => ({
      path: name,
      mode: '040000',
      type: 'tree',
      sha: tree,
    });
    if (path === 'git/trees/root')
      return Response.json({ tree: [dir('.lcars', 'lcars')] });
    if (path === 'git/trees/lcars')
      return Response.json({ tree: [dir('agents', 'agents')] });
    if (path === 'git/trees/agents')
      return Response.json({ tree: [dir('investigator', 'inv')] });
    if (path === 'git/trees/inv?recursive=1')
      return Response.json({
        tree: [
          dir('workspace', 'ws'),
          ...pinned.map((file) => ({ ...file, type: 'blob' })),
        ],
      });
    if (path.startsWith('git/blobs/'))
      return new Response(blobs.get(path.slice('git/blobs/'.length))!);
    return new Response('Not Found', { status: 404 });
  });
}
const tokens = { tokenFor: async () => 'fixture' };
const round = (digest = agentDigest(pinned)) => ({
  agent: 'owner/repo/investigator',
  revision,
  digest,
  requireToolEvidence: true,
  retry: 'finite' as const,
  message: 'Why?',
});

it('serves the pinned files at the pinned revision, with git modes and base64 content', async () => {
  const requested: string[] = [];
  vi.stubGlobal('fetch', github(requested));
  const brief = await agentRunBrief(round(), tokens);
  expect(requested).not.toContain('');
  expect(brief).toMatchObject({
    agent: 'owner/repo/investigator',
    revision,
    requireToolEvidence: true,
    message: 'Why?',
  });
  const probe = brief.files.find(
    (file) => file.path === 'workspace/tools/probe',
  )!;
  expect(probe.mode).toBe('100755');
  expect(Buffer.from(probe.content, 'base64').toString()).toBe(
    '#!/bin/sh\necho ok\n',
  );
});

it('refuses a definition whose files no longer match the pinned digest', async () => {
  vi.stubGlobal('fetch', github());
  await expect(agentRunBrief(round('0'.repeat(64)), tokens)).rejects.toThrow(
    /pinned digest/u,
  );
});

it('parses operator profiles and keeps the default profile built in', () => {
  expect(
    agentProfiles({
      AGENT_LCARS_AGENT_PROFILES: JSON.stringify([
        { name: 'ops', runtime: 'claw-ops', repositories: ['owner/repo'] },
      ]),
    }),
  ).toHaveLength(1);
  expect(() =>
    agentProfiles({
      AGENT_LCARS_AGENT_PROFILES: JSON.stringify([
        { name: 'default', runtime: 'claw-x', repositories: ['owner/repo'] },
      ]),
    }),
  ).toThrow(/built in/u);
  expect(() =>
    agentProfiles({
      AGENT_LCARS_AGENT_PROFILES: JSON.stringify([
        { name: 'ops', runtime: 'not-claw', repositories: ['owner/repo'] },
      ]),
    }),
  ).toThrow();
});

it('refuses a profile that names other principals', () => {
  const definition = {
    repository: 'owner/repo',
    name: 'x',
    revision,
    digest: 'd'.repeat(64),
    manifest: { description: 'x', profile: 'ops' },
    files: pinned as never,
  };
  expect(() =>
    resolveAgentRuntime(definition, 'svc:me', [
      {
        name: 'ops',
        runtime: 'claw-ops',
        repositories: ['owner/repo'],
        principals: ['svc:other'],
      },
    ]),
  ).toThrow(/does not admit svc:me/u);
});

// The launcher (claw-image/claw-job.mjs agentDigest) recomputes this digest
// before running an agent; both suites pin the same golden value.
it('computes the definition digest the launcher verifies', () => {
  expect(
    agentDigest([
      { path: 'workspace/b', mode: '100755', sha: 'b'.repeat(40) },
      { path: 'agent.yaml', mode: '100644', sha: 'a'.repeat(40) },
      { path: 'Workspace/A', mode: '100644', sha: 'c'.repeat(40) },
    ]),
  ).toBe('e8fd4d424a05d79440bb16eba22fff84eec22941ae4bee19a0b5fa38be3264fa');
});
