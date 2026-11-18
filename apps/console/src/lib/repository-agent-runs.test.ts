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
type Definition = Record<string, { content: string; mode: string }>;
const pin = (definition: Definition) =>
  Object.entries(definition).map(([path, { content, mode }]) => ({
    path,
    mode: mode as '100644' | '100755',
    sha: sha(content),
  }));
const pinned = pin(files);

function github(requested: string[] = [], definition: Definition = files) {
  const pinned = pin(definition);
  const blobs = new Map(
    Object.values(definition).map(({ content }) => [sha(content), content]),
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
  if (!('files' in brief)) throw new Error('expected an OpenClaw brief');
  const probe = brief.files.find(
    (file) => file.path === 'workspace/tools/probe',
  )!;
  expect(probe.mode).toBe('100755');
  expect(Buffer.from(probe.content, 'base64').toString()).toBe(
    '#!/bin/sh\necho ok\n',
  );
});

it('delivers a round that names a harness or a mode in a shape older launchers refuse', async () => {
  vi.stubGlobal('fetch', github());
  // An OpenClaw round in its default mode keeps the shape every launcher
  // reads.
  const plain = await agentRunBrief(round(), tokens);
  expect(plain).toHaveProperty('files');
  expect(plain).not.toHaveProperty('definition');
  expect(plain).not.toHaveProperty('harness');
  for (const selection of [
    { harness: 'codex' as const },
    { mode: 'read-only' },
    { harness: 'claude' as const, mode: 'plan' },
  ]) {
    const brief = await agentRunBrief({ ...round(), ...selection }, tokens);
    expect(brief).toMatchObject(selection);
    // No `files`: a launcher that knows no harnesses has nothing to run.
    expect(brief).not.toHaveProperty('files');
    expect(brief).toMatchObject({
      definition: expect.arrayContaining([
        expect.objectContaining({ path: 'workspace/tools/probe' }),
      ]),
    });
  }
});

it('delivers a definition with home settings in the shape older launchers refuse', async () => {
  // An older launcher would run this OpenClaw agent without its `home/`.
  const withHome = {
    ...files,
    'home/.config/tool.toml': { content: 'safe = true\n', mode: '100644' },
  };
  vi.stubGlobal('fetch', github([], withHome));
  const brief = await agentRunBrief(round(agentDigest(pin(withHome))), tokens);
  expect(brief).not.toHaveProperty('files');
  expect(brief).not.toHaveProperty('harness');
  expect(brief).toMatchObject({
    definition: expect.arrayContaining([
      expect.objectContaining({ path: 'home/.config/tool.toml' }),
    ]),
  });
});

it('runs a harness only on a profile whose runtime carries it', () => {
  const definition = (manifest: Record<string, unknown>) => ({
    repository: 'owner/repo',
    name: 'reviewer',
    revision,
    digest: 'd'.repeat(64),
    manifest: { description: 'x', ...manifest },
    fileCount: 1,
  });
  const profiles = [
    { name: 'ops', runtime: 'claw-ops', repositories: ['owner/repo'] },
    {
      name: 'coders',
      runtime: 'claw-coders',
      repositories: ['owner/repo'],
      harnesses: ['claude' as const, 'openclaw' as const],
    },
  ];
  const runtime = (manifest: Record<string, unknown>) =>
    resolveAgentRuntime(definition(manifest), 'user:x', profiles).pipeline;
  expect(runtime({})).toBe('claw-default');
  expect(runtime({ profile: 'ops' })).toBe('claw-ops');
  expect(runtime({ profile: 'coders', harness: 'claude' })).toBe('claw-coders');
  expect(runtime({ profile: 'coders' })).toBe('claw-coders');
  // The default runtime and a profile that lists nothing run OpenClaw only.
  expect(() => runtime({ harness: 'claude' })).toThrow(
    /default does not run claude agents/u,
  );
  expect(() => runtime({ profile: 'ops', harness: 'codex' })).toThrow(
    /ops does not run codex agents/u,
  );
  expect(() => runtime({ profile: 'coders', harness: 'codex' })).toThrow(
    /coders does not run codex agents/u,
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
