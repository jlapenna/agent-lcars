import type { TrackerIssue } from '@agent-lcars/dispatch-contracts';
import {
  decidedRun,
  isRefusal,
  MemoryScheduleStore,
  MemoryStore,
  Orchestrator,
  taskSchema,
  WORK_PARAM_TEXT_MAX_BYTES,
  WORK_PAYLOAD_MAX_BYTES,
} from '@agent-lcars/orchestrator';
import type { SessionDoc } from '@agent-lcars/telemetry';
import { type ItemsContract, itemsContract } from '@agent-lcars/work';
import { createORPCClient } from '@orpc/client';
import type { RouterContractClient } from '@orpc/contract';
import { OpenAPILink } from '@orpc/openapi/fetch';
import { describe, expect, it, vi } from 'vitest';

import type { CliSession } from './cli-sessions';
import { readLifecycleCostMetrics } from './lifecycle-cost-metrics';
import { agentKey } from './repository-agent-definition';
import type { AgentStore, CatalogAgent } from './repository-agent-store';

vi.mock('./lifecycle-cost-metrics', () => ({
  readLifecycleCostMetrics: vi.fn(
    async () => 'lcars_product_session_cost_read_available 0\n',
  ),
}));
import { controlPlaneRepository } from './deployment';
import { drainOutbox } from './orchestrator-dispatch';
import { createWorkHandler, type WorkContext } from './work-router';

const ID = '01J5Z3K9QX8F0N2B4V6C8D1E3G';
const OTHER_ID = '01J5Z3K9QX8F0N2B4V6C8D1E3H';
const spec = {
  title: 't',
  description: 'd',
  pipeline: 'claude',
  target: { repo: 'jlapenna/agent-lcars' },
};
const admittedIssue = {
  reference: { tracker: 'github', repo: spec.target.repo, issue: 2502 },
  identifier: `${spec.target.repo}#2502`,
  url: `https://github.com/${spec.target.repo}/issues/2502`,
  title: 'Admitted issue',
  description: 'Original issue body',
  state: 'open',
  updatedAt: '2026-08-26T10:00:00.000Z',
  labels: [{ id: 'ready', name: 'ready' }],
  assignees: [{ id: '42', name: 'jlapenna' }],
} satisfies TrackerIssue;

const operator = {
  principal: 'user:jlapenna',
  subject: 'github:jlapenna',
  scopes: new Set(['work.operator'] as const),
  pipelines: ['claude'],
  via: 'session' as const,
};
const cronTick = {
  principal: 'svc:telemetry-writer',
  subject: 'telemetry-writer@agent-lcars.iam.gserviceaccount.com',
  scopes: new Set(['work.cron'] as const),
  pipelines: ['claude', 'codex', 'opencode'],
  via: 'google' as const,
};
const executorOnly = {
  principal: 'svc:autoscaler',
  subject: 'google:autoscaler@example.iam.gserviceaccount.com',
  scopes: new Set(['work.executor'] as const),
  pipelines: ['claude'],
  via: 'google' as const,
};
const reaperOnly = {
  principal: 'session:expiry',
  subject: 'session:expiry',
  scopes: new Set(['work.reaper'] as const),
  pipelines: [],
  via: 'oidc' as const,
};
const readerOnly = {
  principal: 'svc:work-reader',
  subject: 'work-reader@agent-lcars.iam.gserviceaccount.com',
  scopes: new Set(['work.reader'] as const),
  pipelines: ['claude', 'codex', 'opencode'],
  via: 'google' as const,
};
const githubActionsOperator = {
  principal: 'workflow:member-automation',
  subject: 'github-actions:jlapenna/agent-lcars',
  sourceRepository: 'jlapenna/agent-lcars',
  scopes: new Set(['work.operator'] as const),
  pipelines: ['claude', 'codex', 'opencode'],
  via: 'oidc' as const,
};

function context(over: Partial<WorkContext> = {}): WorkContext {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, {
    now: () => '2026-08-26T10:00:00.000Z',
  });
  return {
    principal: operator,
    runtime: {
      store,
      orchestrator,
      drain: async () => ({ dispatched: [], failed: [] }),
    } as unknown as WorkContext['runtime'],
    sessionsFor: async () => [],
    getSessionDoc: async () => undefined,
    sessionDocsForRuns: async () => [],
    cliSessions: async () => ({ sessions: [], warnings: [] }),
    scheduleStore: new MemoryScheduleStore(),
    grants: () => [],
    now: () => new Date('2026-08-26T10:00:00.000Z'),
    ...over,
  };
}

/** A minimal, valid `IssueAgentSessionDoc` for `getSessionDoc` stubs below --
 *  every field the type requires, none of the ones it doesn't. */
function sessionDoc(over: Partial<SessionDoc> = {}): SessionDoc {
  return {
    source: 'issue-agent',
    sessionId: 'sess_1',
    agent: 'claude-code',
    liveness: 'ended',
    startedAt: 't0',
    lastActivityAt: 't0',
    turns: 1,
    toolCallCounts: {},
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    deliverables: { prNumbers: [], commitShas: [] },
    ...over,
  };
}

async function call(
  ctx: WorkContext,
  method: string,
  path: string,
  body?: unknown,
) {
  const handler = createWorkHandler();
  const { response } = await handler.handle(
    new Request(`https://lcars.test/api/work/v1${path}`, {
      method,
      // Only set a content type when there IS a body: a POST carrying
      // `content-type: application/json` with an empty body is a malformed
      // JSON request, and oRPC (correctly) answers 400 rather than reaching
      // the procedure at all.
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    }),
    { prefix: '/api/work/v1', context: ctx },
  );
  return {
    status: response?.status,
    headers: response?.headers,
    json: response ? await response.json() : undefined,
  };
}

const clawAdmitter = {
  principal: 'user:jlapenna',
  subject: 'github:jlapenna',
  scopes: new Set(['work.claw.admit'] as const),
  pipelines: ['claw-default'],
  via: 'google' as const,
};
const clawZoneExecutor = {
  principal: 'svc:claw-homelab-ops',
  subject: 'claw-homelab-ops@agent-lcars.iam.gserviceaccount.com',
  scopes: new Set(['work.executor'] as const),
  pipelines: ['claw-investigator'],
  via: 'google' as const,
};

const definition = (
  manifest: Record<string, unknown> = { description: 'Reads things.' },
  name = 'investigator',
) => ({
  repository: 'owner/repo',
  name,
  revision: 'c'.repeat(40),
  digest: 'd'.repeat(64),
  manifest: manifest as { description: string },
  fileCount: 1,
});
function agents(
  rows: {
    name?: string;
    enabled?: boolean;
    manifest?: Record<string, unknown>;
    error?: string;
  }[],
): AgentStore {
  const map = new Map<string, CatalogAgent>();
  for (const row of rows) {
    const name = row.name ?? 'investigator';
    const id = agentKey('owner/repo', name);
    map.set(id, {
      id,
      repository: 'owner/repo',
      name,
      refreshedAt: '2026-08-26T10:00:00.000Z',
      enabled: row.enabled ?? true,
      ...(row.error ? { error: row.error } : {}),
      ...(row.enabled === false && !row.manifest
        ? {}
        : { definition: definition(row.manifest, name) }),
    });
  }
  return {
    list: async () => [...map.values()],
    read: async (id) => map.get(id),
    sources: async () => [],
    recordAttempt: async () => undefined,
    claimObservation: async () => true,
    recordSourceRead: async () => undefined,
    sourceHealth: async () => [],
    mutate: async () => ({}),
  };
}
const caller = {
  principal: 'svc:claw-operator',
  subject: 'claw-operator@agent-lcars.iam.gserviceaccount.com',
  scopes: new Set(['work.claw.admit'] as const),
  pipelines: ['claw-default', 'claw-homelab-ops'],
  via: 'google' as const,
};
const profiles = () => [
  {
    name: 'homelab-ops',
    runtime: 'claw-homelab-ops',
    repositories: ['owner/repo'],
  },
];

describe('repository-owned agent runs', () => {
  const path = '/claw/agents/owner/repo/investigator/runs';

  it('admits an agent without a profile on the default runtime, pinning the definition and message', async () => {
    const ctx = context({
      principal: caller,
      agents: agents([{}]),
      agentProfiles: profiles,
    });
    const response = await call(ctx, 'POST', path, { message: 'Why?' });
    expect(response.status).toBe(202);
    const runs = await ctx.runtime.store.listRuns({ workId: response.json.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      pipeline: 'claw-default',
      params: { mode: 'claw' },
      sourceRevision: {
        input: {
          agent: 'owner/repo/investigator',
          revision: 'c'.repeat(40),
          digest: 'd'.repeat(64),
          requireToolEvidence: false,
          retry: 'finite',
          message: 'Why?',
        },
      },
    });
  });

  it('runs a profiled agent on its runtime and carries terminal retry', async () => {
    const ctx = context({
      principal: caller,
      agents: agents([
        {
          manifest: {
            description: 'Ops.',
            profile: 'homelab-ops',
            retry: 'terminal',
            requireToolEvidence: true,
          },
        },
      ]),
      agentProfiles: profiles,
    });
    const response = await call(ctx, 'POST', path, { message: 'Fix it' });
    expect(response.status).toBe(202);
    const [run] = await ctx.runtime.store.listRuns({
      workId: response.json.id,
    });
    expect(run).toMatchObject({
      pipeline: 'claw-homelab-ops',
      sourceRevision: {
        input: { requireToolEvidence: true, retry: 'terminal' },
      },
    });
  });

  it('pins a named harness and mode with the round, and nothing for a plain OpenClaw agent', async () => {
    const admit = async (manifest: Record<string, unknown>) => {
      const ctx = context({
        principal: {
          ...caller,
          pipelines: [...caller.pipelines, 'claw-coders'],
        },
        agents: agents([{ manifest: { description: 'x', ...manifest } }]),
        agentProfiles: () => [
          ...profiles(),
          {
            name: 'coders',
            runtime: 'claw-coders',
            repositories: ['owner/repo'],
            harnesses: ['claude' as const, 'openclaw' as const],
          },
        ],
      });
      const response = await call(ctx, 'POST', path, { message: 'Why?' });
      const [run] = await ctx.runtime.store.listRuns({
        workId: response.json.id,
      });
      return { status: response.status, input: run?.sourceRevision?.input };
    };
    expect(
      await admit({ profile: 'coders', harness: 'claude', mode: 'plan' }),
    ).toMatchObject({
      status: 202,
      input: { harness: 'claude', mode: 'plan' },
    });
    // A round for an agent that names no harness keeps the shape it had
    // before harnesses.
    const plain = await admit({});
    expect(plain.status).toBe(202);
    expect(plain.input).not.toHaveProperty('harness');
    expect(plain.input).not.toHaveProperty('mode');
    // A harness is pinned as the manifest names it, OpenClaw included:
    // naming one is how a definition asks for its `home/` settings.
    expect(await admit({ harness: 'openclaw' })).toMatchObject({
      status: 202,
      input: { harness: 'openclaw' },
    });
    // A harness the profile's runtime does not carry is refused at admission.
    expect((await admit({ harness: 'claude' })).status).toBe(403);
    expect((await admit({ profile: 'coders', harness: 'codex' })).status).toBe(
      403,
    );
  });

  it('returns the same round for the same message under one sourceKey', async () => {
    const ctx = context({
      principal: caller,
      agents: agents([{}]),
      agentProfiles: profiles,
    });
    const first = await call(ctx, 'POST', path, {
      message: 'Why?',
      sourceKey: 'k',
    });
    const again = await call(ctx, 'POST', path, {
      message: 'Why?',
      sourceKey: 'k',
    });
    expect(again.json.id).toBe(first.json.id);
    expect(
      await ctx.runtime.store.listRuns({ workId: first.json.id }),
    ).toHaveLength(1);
  });

  it('replays the admitted round after an unrelated commit moves the definition revision', async () => {
    const store = agents([{}]);
    const ctx = context({
      principal: caller,
      agents: store,
      agentProfiles: profiles,
    });
    const first = await call(ctx, 'POST', path, {
      message: 'Why?',
      sourceKey: 'k',
    });
    expect(first.status).toBe(202);
    // A commit outside the agent directory: same files and digest, new revision.
    const row = (await store.list())[0]!;
    row.definition = { ...row.definition!, revision: 'f'.repeat(40) };
    const again = await call(ctx, 'POST', path, {
      message: 'Why?',
      sourceKey: 'k',
    });
    expect(again.status).toBe(202);
    expect(again.json.id).toBe(first.json.id);
    const runs = await ctx.runtime.store.listRuns({ workId: first.json.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.sourceRevision?.input['revision']).toBe('c'.repeat(40));
  });

  it('replays an admitted request after the definition moves to a harness the profile does not run', async () => {
    const store = agents([{}]);
    const ctx = context({
      principal: caller,
      agents: store,
      agentProfiles: profiles,
    });
    const body = { message: 'Why?', requestId: 'lost-response' };
    const first = await call(ctx, 'POST', path, body);
    expect(first.status).toBe(202);
    // The catalog refreshes a Codex definition on the same OpenClaw-only
    // profile before the caller, whose response was lost, retries.
    const row = (await store.list())[0]!;
    row.definition = {
      ...row.definition!,
      manifest: { ...row.definition!.manifest, harness: 'codex' },
    };
    const again = await call(ctx, 'POST', path, body);
    expect(again.status).toBe(202);
    expect(again.json.id).toBe(first.json.id);
    const runs = await ctx.runtime.store.listRuns({ workId: first.json.id });
    expect(runs).toHaveLength(1);
    // The admitted round still pins what it was admitted with.
    expect(runs[0]!.sourceRevision?.input).not.toHaveProperty('harness');
    // A new round is still refused: this profile's runtime does not run
    // Codex. The refusal reserves nothing for the source key it named.
    expect(
      (
        await call(ctx, 'POST', path, {
          message: 'Why?',
          requestId: 'new',
          sourceKey: 'fresh',
        })
      ).status,
    ).toBe(403);
    expect(
      await ctx.runtime.store.readSourceWorkId(
        `agent:owner/repo/investigator:${caller.principal}:fresh`,
      ),
    ).toBeUndefined();
    // The same request id with another message conflicts, as on any replay.
    expect(
      (await call(ctx, 'POST', path, { ...body, message: 'Something else' }))
        .status,
    ).toBe(409);
  });

  it('replays an admitted round that never got a run, and answers a replay with the usual checks', async () => {
    const store = agents([
      { manifest: { description: 'x', profile: 'homelab-ops' } },
    ]);
    const ctx = context({
      principal: caller,
      agents: store,
      agentProfiles: profiles,
    });
    const admit = (requestId: string, message = requestId) =>
      call(ctx, 'POST', path, { message, requestId, sourceKey: 'k' });
    // B is coalesced away by C before it gets a run; only its admission
    // receipt remains.
    const a = await admit('A');
    expect(a.status).toBe(202);
    await admit('B');
    await admit('C');
    const row = (await store.list())[0]!;
    const moved = (manifest: Record<string, unknown>) => {
      row.definition = {
        ...row.definition!,
        manifest: { ...row.definition!.manifest, ...manifest },
      };
    };
    moved({ harness: 'codex' });
    const replay = await admit('B');
    expect(replay.status).toBe(202);
    expect(replay.json.id).toBe(a.json.id);
    // A replay never returns Work stored on another pipeline: the agent
    // moves to the default runtime, which the stored Work was not admitted
    // on.
    moved({ profile: undefined });
    expect((await admit('B')).status).toBe(409);
  });

  it('replays a round that was coalesced away before it ran, after an unrelated commit', async () => {
    const store = agents([{}]);
    const ctx = context({
      principal: caller,
      agents: store,
      agentProfiles: profiles,
    });
    const admit = (message: string) =>
      call(ctx, 'POST', path, { message, sourceKey: 'k' });
    const a = await admit('A');
    await admit('B');
    await admit('C');
    const row = (await store.list())[0]!;
    row.definition = { ...row.definition!, revision: 'f'.repeat(40) };
    const replay = await admit('B');
    expect(replay.status).toBe(202);
    expect(replay.json.id).toBe(a.json.id);
  });

  it.each([
    ['an unknown agent', [], 404],
    [
      'a cataloged profile refusal',
      [
        {
          enabled: false,
          manifest: { description: 'x', profile: 'nope' },
          error: 'Unknown agent profile nope',
        },
      ],
      403,
    ],
    [
      'a cataloged profile refusal whose reason changed',
      [
        {
          enabled: false,
          manifest: { description: 'x', profile: 'nope' },
          error: 'Profile nope does not admit owner/repo',
        },
      ],
      403,
    ],
    [
      'a removed definition with a revoked profile',
      [
        {
          enabled: false,
          manifest: { description: 'x', profile: 'nope' },
          error: 'Definition removed',
        },
      ],
      404,
    ],
    ['a disabled agent', [{ enabled: false, error: 'Invalid YAML' }], 404],
    [
      'a profile that does not exist',
      [{ manifest: { description: 'x', profile: 'nope' } }],
      403,
    ],
  ] as const)('refuses %s', async (_name, rows, status) => {
    const ctx = context({
      principal: caller,
      agents: agents([...rows]),
      agentProfiles: profiles,
    });
    expect((await call(ctx, 'POST', path, { message: 'Why?' })).status).toBe(
      status,
    );
  });

  it('refuses a profile that does not admit the repository, and a grant without the runtime', async () => {
    const elsewhere = () => [
      { ...profiles()[0]!, repositories: ['other/repo'] },
    ];
    const ctx = context({
      principal: caller,
      agents: agents([
        { manifest: { description: 'x', profile: 'homelab-ops' } },
      ]),
      agentProfiles: elsewhere,
    });
    expect((await call(ctx, 'POST', path, { message: 'Why?' })).status).toBe(
      403,
    );
    const narrow = { ...caller, pipelines: ['claw-homelab-ops'] };
    const ctx2 = context({
      principal: narrow,
      agents: agents([{}]),
      agentProfiles: profiles,
    });
    expect((await call(ctx2, 'POST', path, { message: 'Why?' })).status).toBe(
      403,
    );
  });

  it('lets only its admitting principal read the run', async () => {
    const ctx = context({
      principal: caller,
      agents: agents([{}]),
      agentProfiles: profiles,
    });
    const admitted = await call(ctx, 'POST', path, { message: 'Why?' });
    expect((await call(ctx, 'GET', `/items/${admitted.json.id}`)).status).toBe(
      200,
    );
    const other = { ...caller, principal: 'svc:someone-else' };
    expect(
      (
        await call(
          { ...ctx, principal: other },
          'GET',
          `/items/${admitted.json.id}`,
        )
      ).status,
    ).toBe(404);
  });
});

describe('claw work read and cancel rules', () => {
  const message = 'Why did the backup alert fire?';
  const clawContext = (principal: WorkContext['principal'] = clawAdmitter) =>
    context({ principal, agents: agents([{}]), agentProfiles: profiles });
  const admit = (ctx: WorkContext) =>
    call(ctx, 'POST', '/claw/agents/owner/repo/investigator/runs', {
      message,
    });

  it.each([
    ['an operator without the claw scope', operator, 401],
    ['the shared executor', executorOnly, 401],
    ['the claw zone executor', clawZoneExecutor, 401],
    [
      'an admitter whose grant omits the runtime',
      { ...clawAdmitter, pipelines: ['claude'] },
      403,
    ],
  ] as const)('refuses admission by %s', async (_name, principal, status) => {
    const ctx = clawContext(principal);
    expect((await admit(ctx)).status).toBe(status);
    expect(await ctx.runtime.store.listNativeTasks(10)).toHaveLength(0);
  });

  it('keeps public create rejecting the claw shape, even for an admitter with operator scope', async () => {
    const ctx = context({
      principal: {
        ...operator,
        scopes: new Set(['work.operator', 'work.claw.admit'] as const),
        pipelines: ['claude', 'claw-default'],
      },
    });
    const response = await call(ctx, 'PUT', `/items/${ID}`, {
      spec: {
        title: 'Agent owner/repo/investigator',
        description: message,
        pipeline: 'claw-default',
        priority: 'background',
        agent: 'owner/repo/investigator',
        sourceKey: 'alert:backup',
      },
    });
    expect(response.status).toBe(400);
    expect(await ctx.runtime.store.readTask({ workId: ID })).toBeUndefined();
  });

  it('lets its admitter cancel it, settling through LCARS, while update, redispatch and reply stay refused', async () => {
    const both = {
      ...operator,
      scopes: new Set(['work.operator', 'work.claw.admit'] as const),
      pipelines: ['claude', 'claw-default'],
    };
    const ctx = clawContext(both);
    const admitted = await admit(ctx);
    expect(admitted.status).toBe(202);
    const id = admitted.json.id as string;
    expect(
      (
        await call(ctx, 'PATCH', `/items/${id}`, {
          title: 'Changed',
          description: 'Changed',
        })
      ).status,
    ).toBe(409);
    expect((await call(ctx, 'POST', `/items/${id}/redispatch`)).status).toBe(
      409,
    );
    expect(
      (await call(ctx, 'POST', `/items/${id}/reply`, { text: 'more' })).status,
    ).toBe(403);

    // Neither a plain operator nor the zone executor may cancel claw work.
    expect(
      (
        await call(
          { ...ctx, principal: operator },
          'POST',
          `/items/${id}/cancel`,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          { ...ctx, principal: clawZoneExecutor },
          'POST',
          `/items/${id}/cancel`,
        )
      ).status,
    ).toBe(401);

    const canceled = await call(
      { ...ctx, principal: clawAdmitter },
      'POST',
      `/items/${id}/cancel`,
    );
    expect(canceled.status).toBe(200);
    expect(canceled.json.state).toBe('canceled');
    expect(canceled.json.runs[0].state).toBe('canceled');
    expect(await ctx.runtime.store.listRuns({ workId: id })).toHaveLength(1);
  });

  it('keeps cancel of other work operator-only, and is no existence oracle for a claw admitter', async () => {
    const ctx = context();
    expect((await call(ctx, 'PUT', `/items/${ID}`, { spec })).status).toBe(201);
    const asAdmitter = { ...ctx, principal: clawAdmitter };
    const existing = await call(asAdmitter, 'POST', `/items/${ID}/cancel`);
    const missing = await call(asAdmitter, 'POST', `/items/${OTHER_ID}/cancel`);
    expect(existing).toMatchObject({ status: 404 });
    expect(missing).toMatchObject({ status: 404 });
    expect(existing.json).toEqual(missing.json);
    expect((await call(ctx, 'POST', `/items/${ID}/cancel`)).status).toBe(200);
  });

  it("returns a run's evidence on the item's own read, and never on a listing", async () => {
    const ctx = context();
    expect((await call(ctx, 'PUT', `/items/${ID}`, { spec })).status).toBe(201);
    const { store } = ctx.runtime;
    const [run] = await store.listRuns({ workId: ID });
    const before = await call(ctx, 'GET', `/items/${ID}`);
    expect(before.json.runs[0]).not.toHaveProperty('evidence');
    const evidence = {
      source: 'acp' as const,
      harness: 'openclaw' as const,
      stopReason: 'end_turn' as const,
      toolCallCount: 1,
      toolCalls: [{ kind: 'execute' as const, status: 'completed' as const }],
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
      durationMs: 2_500,
      recordedAt: '2026-08-26T10:00:00.000Z',
    };
    // As its worker would have, under the claim it holds.
    const tokenHash = 'a'.repeat(64);
    const NOW = '2026-08-26T10:00:00.000Z';
    await store.enqueueRun({ runId: run!.runId, now: NOW });
    await ctx.runtime.orchestrator.confirmDispatch(run!.runId);
    await store.claimQueuedRun({
      pipelines: [run!.pipeline],
      now: NOW,
      claimedBy: 'runner-1',
      claimedBySubject: 'google:autoscaler@example.iam.gserviceaccount.com',
      tokenHash,
    });
    expect(
      await store.writeRunEvidence({
        runId: run!.runId,
        claimFingerprint: tokenHash,
        evidence,
      }),
    ).toBe(true);
    const read = await call(ctx, 'GET', `/items/${ID}`);
    expect(read.status).toBe(200);
    expect(read.json.runs[0].evidence).toEqual(evidence);
    const listed = await call(ctx, 'GET', '/items');
    expect(listed.status).toBe(200);
    // The listing has the item and its run, without the run's evidence.
    expect(JSON.stringify(listed.json)).toContain(run!.runId);
    expect(JSON.stringify(listed.json)).not.toContain('toolCallCount');

    // Evidence the store cannot read costs the item nothing but the evidence.
    let lookups = 0;
    const failing = {
      ...ctx,
      runtime: {
        ...ctx.runtime,
        store: new Proxy(store, {
          get(target, key) {
            if (key === 'readRunEvidence')
              return async () => {
                lookups++;
                throw new Error('evidence unavailable');
              };
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      },
    };
    const without = await call(failing, 'GET', `/items/${ID}`);
    expect(without.status).toBe(200);
    expect(without.json.runs[0]).not.toHaveProperty('evidence');

    expect(lookups).toBe(1);

    // A change answers without the lookup: the confirmation of what has
    // already committed never waits on evidence.
    const cancelled = await call(failing, 'POST', `/items/${ID}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.state).toBe('canceled');
    expect(cancelled.json.runs[0]).not.toHaveProperty('evidence');
    expect(lookups).toBe(1);
  });

  it('lets a claw admitter read its own run and report, and nothing else', async () => {
    const ctx = clawContext();
    const mine = await admit(ctx);
    const id = mine.json.id as string;
    const read = await call(ctx, 'GET', `/items/${id}`);
    expect(read.status).toBe(200);
    expect(read.json.id).toBe(id);
    expect(read.json.runs).toHaveLength(1);

    const operatorCtx = { ...ctx, principal: operator };
    expect(
      (await call(operatorCtx, 'PUT', `/items/${ID}`, { spec })).status,
    ).toBe(201);
    const other = await call(ctx, 'GET', `/items/${ID}`);
    const missing = await call(ctx, 'GET', `/items/${OTHER_ID}`);
    expect(other).toMatchObject({ status: 404 });
    expect(missing).toMatchObject({ status: 404 });
    expect(other.json).toEqual(missing.json);

    const gate = {
      ...clawAdmitter,
      principal: 'svc:alert-gate',
      subject: 'alert-gate@agent-lcars.iam.gserviceaccount.com',
    };
    const foreign = await call(
      { ...ctx, principal: gate },
      'GET',
      `/items/${id}`,
    );
    expect(foreign).toMatchObject({ status: 404 });
    expect(foreign.json).toEqual(missing.json);
    expect(JSON.stringify(foreign.json)).not.toContain(message);
    // Listing stays operator and reaper only.
    expect((await call(ctx, 'GET', '/items')).status).toBe(401);
    // A principal without any reading scope is still refused outright.
    expect(
      (
        await call(
          { ...ctx, principal: clawZoneExecutor },
          'GET',
          `/items/${id}`,
        )
      ).status,
    ).toBe(401);
  });

  it("never lets one claw admitter cancel or read another principal's run", async () => {
    const ctx = clawContext();
    const mine = await admit(ctx);
    const id = mine.json.id as string;
    const gate = {
      ...clawAdmitter,
      principal: 'svc:alert-gate',
      subject: 'alert-gate@agent-lcars.iam.gserviceaccount.com',
    };
    const foreign = await call(
      { ...ctx, principal: gate },
      'POST',
      `/items/${id}/cancel`,
    );
    const missing = await call(
      { ...ctx, principal: gate },
      'POST',
      `/items/${OTHER_ID}/cancel`,
    );
    expect(foreign).toMatchObject({ status: 404 });
    expect(foreign.json).toEqual(missing.json);
    expect(JSON.stringify(foreign.json)).not.toContain(message);
    // An operator who also admits claw work still cannot cancel another
    // principal's run.
    expect(
      (
        await call(
          {
            ...ctx,
            principal: {
              ...gate,
              scopes: new Set(['work.operator', 'work.claw.admit'] as const),
            },
          },
          'POST',
          `/items/${id}/cancel`,
        )
      ).status,
    ).toBe(403);
    const runs = await ctx.runtime.store.listRuns({ workId: id });
    expect(runs.map((run) => run.state)).toEqual(['pending']);
  });
});

describe('items routes', () => {
  it.each(['inbox-summary', 'handoff-summary'])(
    'exposes %s history while rejecting coding mutations',
    async (pipeline) => {
      const ctx = context();
      await ctx.runtime.orchestrator.request({
        taskId: { workId: ID },
        requestId: 'source-1',
        pipeline,
        work: {
          origin: { principal: 'svc:inbox-summary', channel: 'console' },
          spec: {
            title: 'Inbox summary',
            description: 'Reading aid',
            pipeline,
            priority: 'background',
            sourceKey: 'owner/repo#1',
          },
        },
        sourceRevision: {
          key: 'source-1',
          input: { context: 'Original question' },
        },
      });
      const read = await call(ctx, 'GET', `/items/${ID}`);
      expect(read.status).toBe(200);
      expect(read.json.spec.pipeline).toBe(pipeline);
      expect(read.json.runs[0].sourceRevision.input.context).toBe(
        'Original question',
      );
      expect((await call(ctx, 'POST', `/items/${ID}/cancel`)).status).toBe(409);
      expect((await call(ctx, 'POST', `/items/${ID}/redispatch`)).status).toBe(
        409,
      );
      expect(
        (
          await call(ctx, 'PATCH', `/items/${ID}`, {
            title: 'Changed',
            description: 'Changed',
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await call(ctx, 'POST', `/items/${ID}/reply`, {
            text: 'Do something else',
          })
        ).status,
      ).toBe(403);
      expect(await ctx.runtime.store.listRuns({ workId: ID })).toHaveLength(1);
    },
  );

  it.each(['urgent', 'normal', 'background'] as const)(
    'mints and exposes %s priority without changing authorization or idempotency',
    async (priority) => {
      const ctx = context();
      const body = { spec: { ...spec, priority } };
      const first = await call(ctx, 'PUT', `/items/${ID}`, body);
      expect(first.status).toBe(201);
      expect(first.json.spec.priority).toBe(priority);
      expect(first.json.runs[0].priority).toBe(priority);
      expect(await ctx.runtime.store.readRun(`work:${ID}/r1`)).toMatchObject({
        priority,
        pipeline: 'claude',
      });
      expect(
        (await call(ctx, 'PUT', `/items/${ID}`, body)).json.runs,
      ).toHaveLength(1);
      expect(
        (
          await call(ctx, 'PUT', `/items/${ID}`, {
            spec: {
              ...spec,
              priority: priority === 'urgent' ? 'background' : 'urgent',
            },
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await call(
            { ...ctx, principal: undefined },
            'PUT',
            `/items/${OTHER_ID}`,
            body,
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await call(
            { ...ctx, principal: { ...operator, pipelines: [] } },
            'PUT',
            `/items/${OTHER_ID}`,
            body,
          )
        ).status,
      ).toBe(403);
    },
  );

  it('treats omitted and explicit normal priority as the same immutable specification', async () => {
    const ctx = context();
    expect((await call(ctx, 'PUT', `/items/${ID}`, { spec })).status).toBe(201);
    const replay = await call(ctx, 'PUT', `/items/${ID}`, {
      spec: { ...spec, priority: 'normal' },
    });
    expect(replay.status).toBe(201);
    expect(replay.json.runs).toHaveLength(1);
    expect(replay.json.runs[0].priority).toBe('normal');
  });

  it('rejects unknown priority without minting work', async () => {
    const ctx = context();
    expect(
      (
        await call(ctx, 'PUT', `/items/${ID}`, {
          spec: { ...spec, priority: 'immediate' },
        })
      ).status,
    ).toBe(400);
    expect(await ctx.runtime.store.readTask({ workId: ID })).toBeUndefined();
  });
  it('gates the read-only metrics endpoint and preserves durable state across repeated exports', async () => {
    for (const principal of [undefined, executorOnly, reaperOnly])
      expect(
        (await call(context({ principal }), 'GET', '/metrics/lifecycle'))
          .status,
      ).toBe(401);
    for (const principal of [operator, cronTick]) {
      const ctx = context({ principal });
      const read = vi.spyOn(ctx.runtime.store, 'readLifecycleMetricRecords');
      const drain = vi.spyOn(ctx.runtime, 'drain');
      const first = await call(ctx, 'GET', '/metrics/lifecycle');
      const again = await call(ctx, 'GET', '/metrics/lifecycle');
      expect(first.status).toBe(200);
      expect(again.json).toEqual(first.json);
      expect(first.json).toMatchObject({ complete: true, windowSeconds: 3600 });
      expect(first.json.prometheus).toContain(
        'lcars_product_session_cost_read_available 0',
      );
      expect(first.json.prometheus).toContain('lcars_product_silent_loss_runs');
      expect(readLifecycleCostMetrics).toHaveBeenCalledWith(
        '2026-08-26T10:00:00.000Z',
      );
      expect(read).toHaveBeenCalledWith({
        since: '2026-08-26T09:00:00.000Z',
        until: '2026-08-26T10:00:00.000Z',
      });
      expect(drain).not.toHaveBeenCalled();
      expect(await ctx.runtime.store.listLiveRuns()).toEqual([]);
    }
  });
  it('returns explicit incompleteness without health series and sanitizes store failures', async () => {
    const ctx = context();
    vi.spyOn(ctx.runtime.store, 'readLifecycleMetricRecords').mockResolvedValue(
      { recentRuns: [], liveRuns: [], outstandingOutbox: [], complete: false },
    );
    const truncated = await call(ctx, 'GET', '/metrics/lifecycle');
    expect(truncated.status).toBe(200);
    expect(truncated.json).toMatchObject({ complete: false });
    expect(JSON.stringify(truncated.json)).not.toContain(
      'lcars_product_silent_loss_runs',
    );
    vi.spyOn(ctx.runtime.store, 'readLifecycleMetricRecords').mockRejectedValue(
      new Error('private-database-secret'),
    );
    const failed = await call(ctx, 'GET', '/metrics/lifecycle');
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.json)).not.toContain(
      'private-database-secret',
    );
  });
  it('refuses every route without a principal', async () => {
    const ctx = context({ principal: undefined });
    for (const [m, p, b] of [
      ['PUT', `/items/${ID}`, { spec }],
      ['GET', `/items/${ID}`],
      ['GET', '/items'],
      ['POST', `/items/${ID}/cancel`],
      ['POST', `/items/${ID}/redispatch`],
      ['POST', '/maintenance/tick', {}],
    ] as const) {
      const r = await call(ctx, m, p, b);
      expect(r.status, `${m} ${p}`).toBe(401);
    }
  });

  it('refuses a principal without the work.operator scope with 401', async () => {
    const ctx = context({
      principal: { ...operator, scopes: new Set<never>() },
    });

    expect((await call(ctx, 'GET', '/items')).status).toBe(401);
  });

  it('refuses every items route for a work.cron-only principal, which carries no work.operator scope', async () => {
    const ctx = context({ principal: cronTick });
    for (const [m, p, b] of [
      ['PUT', `/items/${ID}`, { spec }],
      ['GET', `/items/${ID}`],
      ['GET', '/items'],
      ['POST', `/items/${ID}/cancel`],
      ['POST', `/items/${ID}/redispatch`],
    ] as const) {
      const r = await call(ctx, m, p, b);
      expect(r.status, `${m} ${p}`).toBe(401);
    }
  });

  it('allows only work.cron to run bounded maintenance', async () => {
    const drain = vi.fn().mockResolvedValue({
      dispatched: [],
      reported: [],
      failed: [],
    });
    const ctx = context({
      principal: cronTick,
      runtime: { ...context().runtime, drain },
    });
    const response = await call(ctx, 'POST', '/maintenance/tick', {});
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      lost: [],
      retried: [],
      outboxProcessed: 0,
      outboxContinuationNeeded: false,
    });
    expect(drain).toHaveBeenCalledWith(30);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(response.json).not.toHaveProperty('credentialRecovery');
    expect(
      (await call(context(), 'POST', '/maintenance/tick', {})).status,
    ).toBe(401);
  });

  it.each([
    { name: 'empty', result: { recovered: [], unresolved: [] } },
    {
      name: 'nonempty',
      result: {
        recovered: ['codex-operation-completed'],
        unresolved: ['codex-operation-still-in-flight'],
      },
    },
  ])(
    'returns $name credential recovery through the actual maintenance HTTP adapter and executes each effect once',
    async ({ result }) => {
      const store = new MemoryStore();
      let now = '2026-08-26T10:00:00.000Z';
      const orchestrator = new Orchestrator(store, { now: () => now });
      await orchestrator.request({
        taskId: { workId: ID },
        requestId: 'maintenance-expiry-proof',
        pipeline: 'claude',
        work: {
          spec,
          origin: { principal: operator.principal, channel: 'console' },
        },
      });
      const original = await store.readActiveRun({ workId: ID });
      if (original === undefined)
        throw new Error('Expected seeded maintenance run');
      now = '2026-08-26T12:01:00.000Z';
      const recoverCredentialOperations = vi.fn().mockResolvedValue(result);
      const sweep = vi.spyOn(orchestrator, 'sweepExpired');
      const reroute = vi.spyOn(orchestrator, 'rerouteQueued');
      const drain = vi
        .fn()
        .mockResolvedValue({ dispatched: [], reported: [], failed: [] });
      const ctx = context({
        principal: cronTick,
        runtime: { store, orchestrator, drain, recoverCredentialOperations },
      });
      const response = await call(ctx, 'POST', '/maintenance/tick', {});
      expect(response.status).toBe(200);
      const retry = await store.readActiveRun({ workId: ID });
      if (retry === undefined)
        throw new Error('Expected durable maintenance retry');
      expect(response.json).toEqual({
        credentialRecovery: result,
        lost: [original.runId],
        retried: [{ lostRunId: original.runId, newRunId: retry.runId }],
        rerouted: [],
        dispatched: [],
        reported: [],
        outboxProcessed: 0,
        outboxContinuationNeeded: false,
      });
      expect((await store.readRun(original.runId))?.state).toBe('lost');
      expect(retry.runId).not.toBe(original.runId);
      expect(await store.listRuns({ workId: ID })).toHaveLength(2);
      for (const effect of [recoverCredentialOperations, sweep, reroute, drain])
        expect(effect).toHaveBeenCalledTimes(1);
      expect(drain).toHaveBeenCalledWith(30);
      expect(
        recoverCredentialOperations.mock.invocationCallOrder[0],
      ).toBeLessThan(sweep.mock.invocationCallOrder[0]!);
      expect(sweep.mock.invocationCallOrder[0]).toBeLessThan(
        reroute.mock.invocationCallOrder[0]!,
      );
      expect(reroute.mock.invocationCallOrder[0]).toBeLessThan(
        drain.mock.invocationCallOrder[0]!,
      );
    },
  );

  it.each([
    { name: 'missing unresolved array', result: { recovered: [] } },
    {
      name: 'nonarray recovered',
      result: { recovered: 'invalid', unresolved: [] },
    },
    {
      name: 'nonstring unresolved member',
      result: { recovered: [], unresolved: [7] },
    },
    {
      name: 'unknown recovery output key',
      result: { recovered: [], unresolved: [], unexpected: true },
    },
  ])(
    'refuses $name at the actual maintenance HTTP output boundary',
    async ({ result }) => {
      const base = context();
      const recoverCredentialOperations = vi.fn().mockResolvedValue(result);
      const drain = vi
        .fn()
        .mockResolvedValue({ dispatched: [], reported: [], failed: [] });
      const ctx = context({
        principal: cronTick,
        runtime: { ...base.runtime, drain, recoverCredentialOperations },
      });
      const response = await call(ctx, 'POST', '/maintenance/tick', {});
      expect(response.status).toBe(500);
      expect(recoverCredentialOperations).toHaveBeenCalledTimes(1);
      expect(drain).toHaveBeenCalledTimes(1);
      expect(response.json).not.toHaveProperty('credentialRecovery');
    },
  );

  it('keeps recovery and maintenance effects behind current work.cron authority', async () => {
    const base = context();
    const recoverCredentialOperations = vi
      .fn()
      .mockResolvedValue({ recovered: [], unresolved: [] });
    const sweep = vi.spyOn(base.runtime.orchestrator, 'sweepExpired');
    const reroute = vi.spyOn(base.runtime.orchestrator, 'rerouteQueued');
    const drain = vi
      .fn()
      .mockResolvedValue({ dispatched: [], reported: [], failed: [] });
    for (const principal of [undefined, operator, executorOnly, reaperOnly]) {
      const ctx = context({
        principal,
        runtime: { ...base.runtime, drain, recoverCredentialOperations },
      });
      expect((await call(ctx, 'POST', '/maintenance/tick', {})).status).toBe(
        401,
      );
    }
    for (const effect of [recoverCredentialOperations, sweep, reroute, drain])
      expect(effect).not.toHaveBeenCalled();
  });

  it('refuses every items route for a work.executor-only principal, which carries no work.operator scope', async () => {
    const ctx = context({ principal: executorOnly });
    for (const [m, p, b] of [
      ['PUT', `/items/${ID}`, { spec }],
      ['GET', `/items/${ID}`],
      ['GET', '/items'],
      ['POST', `/items/${ID}/cancel`],
      ['POST', `/items/${ID}/redispatch`],
    ] as const) {
      const r = await call(ctx, m, p, b);
      expect(r.status, `${m} ${p}`).toBe(401);
    }
  });

  describe('a work.reaper-only principal (the session-expiry workflow)', () => {
    it('refuses create/cancel/redispatch -- reaper is read-only', async () => {
      const ctx = context({ principal: reaperOnly });
      for (const [m, p, b] of [
        ['PUT', `/items/${ID}`, { spec }],
        ['POST', `/items/${ID}/cancel`],
        ['POST', `/items/${ID}/redispatch`],
      ] as const) {
        const r = await call(ctx, m, p, b);
        expect(r.status, `${m} ${p}`).toBe(401);
      }
    });

    it('accepts list and get, same as an operator', async () => {
      const ctx = context();
      await call(ctx, 'PUT', `/items/${ID}`, { spec });
      const reaperCtx = { ...ctx, principal: reaperOnly };

      expect((await call(reaperCtx, 'GET', '/items')).status).toBe(200);
      expect((await call(reaperCtx, 'GET', `/items/${ID}`)).status).toBe(200);
    });
  });

  it('creates an item, replays it idempotently, and derives running', async () => {
    const ctx = context();
    const first = await call(ctx, 'PUT', `/items/${ID}`, { spec });
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({
      id: ID,
      state: 'running',
      origin: { principal: 'user:jlapenna', channel: 'console' },
      spec,
    });
    expect((await ctx.runtime.store.readRun(`work:${ID}/r1`))?.params).toEqual({
      mode: 'implement',
    });

    // Idempotency is the guarantee, not the status code: the contract
    // declares `successStatus: 201` for create, so a replay answers 201
    // with the *existing* item rather than starting a second run.
    const again = await call(ctx, 'PUT', `/items/${ID}`, { spec });
    expect(again.status).toBe(201);
    expect(again.json.runs).toHaveLength(1);
  });

  describe('origin thread and channel (#1804)', () => {
    it('stores a caller-supplied thread on the created item origin', async () => {
      const ctx = context();
      const r = await call(ctx, 'PUT', `/items/${ID}`, {
        spec,
        thread: 'T0123/C0456/1788673935.123456',
      });
      expect(r.status).toBe(201);
      expect(r.json.origin).toMatchObject({
        thread: 'T0123/C0456/1788673935.123456',
      });
    });

    it('writes no thread key at all when the caller supplies none', async () => {
      const ctx = context();
      const r = await call(ctx, 'PUT', `/items/${ID}`, { spec });
      expect(r.status).toBe(201);
      expect(r.json.origin).not.toHaveProperty('thread');
    });

    it("uses the grant's declared channel on the created item origin", async () => {
      const ctx = context({
        principal: { ...operator, channel: 'slack' as const },
      });
      const r = await call(ctx, 'PUT', `/items/${ID}`, { spec });
      expect(r.status).toBe(201);
      expect(r.json.origin).toMatchObject({ channel: 'slack' });
    });

    // Regression pin: a grant with NO declared channel must behave exactly
    // as it did before this feature existed -- a session principal yields
    // `console`, a service/OIDC principal yields `api`.
    it('regression: a session principal with no declared channel still yields console', async () => {
      const ctx = context({ principal: operator });
      const r = await call(ctx, 'PUT', `/items/${ID}`, { spec });
      expect(r.status).toBe(201);
      expect(r.json.origin).toMatchObject({ channel: 'console' });
    });

    it('regression: a service principal with no declared channel still yields api', async () => {
      const ctx = context({ principal: githubActionsOperator });
      const r = await call(ctx, 'PUT', `/items/${ID}`, { spec });
      expect(r.status).toBe(201);
      expect(r.json.origin).toMatchObject({ channel: 'api' });
    });

    it('rejects a caller-supplied channel in the request body (strict input schema)', async () => {
      const ctx = context();
      const r = await call(ctx, 'PUT', `/items/${ID}`, {
        spec,
        channel: 'slack',
      });
      expect(r.status).toBe(400);
    });
  });

  it('refuses a replay whose spec differs from the stored one with 409', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/items/${ID}`, { spec });

    const r = await call(ctx, 'PUT', `/items/${ID}`, {
      spec: { ...spec, title: 'something else' },
    });
    expect(r.status).toBe(409);
  });

  it('atomically refuses an overlapping first create with a different immutable spec', async () => {
    const ctx = context();
    // Both requests finish the route-level absence check before either enters
    // the orchestrator transaction. The second transaction must compare the
    // stored Work rather than mint a run for its own different specification.
    const [left, right] = await Promise.all([
      call(ctx, 'PUT', `/items/${ID}`, { spec }),
      call(ctx, 'PUT', `/items/${ID}`, {
        spec: { ...spec, title: 'concurrent different work' },
      }),
    ]);
    const outcomes = [left, right];
    const created = outcomes.find((outcome) => outcome.status === 201);
    const conflict = outcomes.find((outcome) => outcome.status === 409);
    expect(created).toBeDefined();
    expect(conflict).toMatchObject({
      json: { message: `item ${ID} already exists with a different spec` },
    });
    expect(await ctx.runtime.store.listRuns({ workId: ID })).toHaveLength(1);
  });

  it('refuses a pipeline outside the grant with 403', async () => {
    const r = await call(context(), 'PUT', `/items/${ID}`, {
      spec: { ...spec, pipeline: 'codex' },
    });
    expect(r.status).toBe(403);
  });

  it('refuses a repository that is not admitted at all, with 403', async () => {
    const ctx = context();
    const r = await call(ctx, 'PUT', `/items/${ID}`, {
      spec: { ...spec, target: { repo: 'octo/example' } },
    });
    expect(r.status).toBe(403);
    // Exact wording: `forbiddenReason` (work-mint.ts) refuses at creation
    // rather than let the dispatch itself 422 later. `octo/example` is not
    // in `AGENT_LCARS_CONTROL_PLANE_REPOSITORIES` (unset here, so it
    // defaults to just `controlPlaneRepository()`) -- #1544 wave 2.
    expect(r.json).toMatchObject({
      message:
        'native work items can only target a control-plane repository ' +
        '(octo/example is not admitted)',
    });
    // No task minted for the refused create -- same context/store.
    expect((await call(ctx, 'GET', `/items/${ID}`)).status).toBe(404);
  });

  it('allows an admitted repository that is not the control-plane repo (#1544 wave 2)', async () => {
    // Wave 1 of #1544 landed a `work` `workflow_dispatch` input on every
    // consumer repo declared in `AGENT_LCARS_CONTROL_PLANE_REPOSITORIES` --
    // once a repo is on that allow-list, minting a native item against it
    // is no longer refused just for not being `controlPlaneRepository()`
    // itself.
    const otherRepo = 'other-org/other-repo';
    process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'] =
      `${controlPlaneRepository()},${otherRepo}`;
    process.env['AGENT_LCARS_WATCHED_REPOS'] = JSON.stringify([
      { owner: 'jlapenna', name: 'agent-lcars' },
      { owner: 'other-org', name: 'other-repo' },
    ]);
    try {
      const ctx = context();
      const r = await call(ctx, 'PUT', `/items/${ID}`, {
        spec: { ...spec, target: { repo: otherRepo } },
      });
      expect(r.status).toBe(201);
      expect(r.json).toMatchObject({ state: 'running' });
    } finally {
      delete process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'];
      delete process.env['AGENT_LCARS_WATCHED_REPOS'];
    }
  });

  it('accepts a Slack backlog, replays idempotently, and claims it after a long capacity wait', async () => {
    const ctx = context({ principal: { ...operator, channel: 'slack' } });
    const { store, orchestrator } = ctx.runtime;
    ctx.runtime.drain = () =>
      drainOutbox({
        store,
        orchestrator,
        now: () => '2026-08-26T10:00:00.000Z',
        tokens: {
          tokenFor: async () => {
            throw new Error('native intake needs no GitHub token');
          },
        },
      });
    // Exceed both the old production cap (2) and default cap (4). The
    // executor is full and does not claim until capacity becomes available.
    const ids = Array.from({ length: 6 }, (_, i) => ID.slice(0, -1) + i);
    for (const id of ids) {
      const result = await call(ctx, 'PUT', `/items/${id}`, {
        spec,
        thread: 'T1/C1/1789934929.792609',
      });
      expect(result.status).toBe(201);
      expect(result.json.origin).toMatchObject({
        channel: 'slack',
        thread: 'T1/C1/1789934929.792609',
      });
    }
    expect(await store.listQueuedRuns()).toHaveLength(6);
    expect((await call(ctx, 'PUT', `/items/${ids[0]}`, { spec })).status).toBe(
      201,
    );
    expect(await store.listRuns({ workId: ids[0]! })).toHaveLength(1);
    const later = '2026-08-26T14:00:00.000Z';
    expect(await store.listExpiredRuns(later)).toEqual([]);
    const claimedIds: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const claimed = await store.claimQueuedRun({
        pipelines: ['claude'],
        now: later,
        claimedBy: 'available-runner',
        claimedBySubject: 'executor@example.com',
        tokenHash: 'a'.repeat(64),
      });
      expect(claimed).toBeDefined();
      claimedIds.push(claimed!.runId);
      expect(claimed?.leaseExpiresAt).toBe('2026-08-26T16:00:00.000Z');
      await orchestrator.report(claimed!.runId, { ok: true, summary: 'done' });
    }
    expect(new Set(claimedIds)).toEqual(
      new Set(ids.map((id) => `work:${id}/r1`)),
    );
    expect(await store.listQueuedRuns()).toEqual([]);
    for (const id of ids) {
      expect(await store.readTask({ workId: id })).toMatchObject({
        task: { runCount: 1, consecutiveLost: 0 },
      });
    }
  });

  it.each(['redispatch', 'reply'])(
    'accepts %s while other native work is live',
    async (operation) => {
      const ctx = context();
      await call(ctx, 'PUT', `/items/${ID}`, { spec });
      await ctx.runtime.orchestrator.report(`work:${ID}/r1`, {
        ok: true,
        summary: 'park',
      });
      for (let i = 0; i < 5; i++) {
        expect(
          (
            await call(ctx, 'PUT', `/items/${OTHER_ID.slice(0, -1) + i}`, {
              spec,
            })
          ).status,
        ).toBe(201);
      }
      const result = await call(
        ctx,
        'POST',
        `/items/${ID}/${operation}`,
        operation === 'reply' ? { text: 'Continue' } : undefined,
      );
      expect(result.status).toBe(200);
      expect(await ctx.runtime.store.listRuns({ workId: ID })).toHaveLength(2);
    },
  );

  it('answers 404 for an unknown item', async () => {
    expect((await call(context(), 'GET', `/items/${ID}`)).status).toBe(404);
    expect((await call(context(), 'POST', `/items/${ID}/cancel`)).status).toBe(
      404,
    );
    expect(
      (await call(context(), 'POST', `/items/${ID}/redispatch`)).status,
    ).toBe(404);
  });

  it('cancels a running item and then refuses a second cancel', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/items/${ID}`, { spec });
    const c1 = await call(ctx, 'POST', `/items/${ID}/cancel`);
    expect(c1.status).toBe(200);
    expect(c1.json.state).toBe('canceled');
    expect((await call(ctx, 'POST', `/items/${ID}/cancel`)).status).toBe(409);
  });

  it('returns the full admitted run issue from cancel and detail, with display fields on the list', async () => {
    const ctx = context();
    const outcome = await ctx.runtime.orchestrator.request({
      taskId: { workId: ID },
      requestId: 'snapshot',
      pipeline: spec.pipeline,
      issue: admittedIssue,
      work: { origin: { principal: operator.principal, channel: 'api' }, spec },
    });
    if (isRefusal(outcome)) throw new Error('unexpected refusal in fixture');
    const detail = await call(ctx, 'GET', `/items/${ID}`);
    expect(detail.status).toBe(200);
    expect(detail.json.runs[0].issue).toEqual(admittedIssue);

    const list = await call(ctx, 'GET', '/items');
    expect(list.status).toBe(200);
    expect(list.json.items[0].runs[0].issue).toEqual({
      reference: admittedIssue.reference,
      identifier: admittedIssue.identifier,
      url: admittedIssue.url,
      title: admittedIssue.title,
      state: admittedIssue.state,
    });

    const canceled = await call(ctx, 'POST', `/items/${ID}/cancel`);
    expect(canceled.status).toBe(200);
    expect(canceled.json.runs[0].issue).toEqual(admittedIssue);
  });

  it.each([
    operator,
    githubActionsOperator,
    {
      ...operator,
      via: 'google' as const,
      principal: 'svc:authorized-operator',
    },
  ])(
    'records only the authenticated cancel principal for $via, without asserting human activity',
    async (principal) => {
      const ctx = context({ principal });
      await call(ctx, 'PUT', `/items/${ID}`, { spec });
      const forged = await call(ctx, 'POST', `/items/${ID}/cancel`, {
        intervention: { kind: 'work-api-cancel', principal: 'forged-user' },
      });
      expect(forged.status).toBe(400);
      expect((await ctx.runtime.store.readRun(`work:${ID}/r1`))?.state).toBe(
        'pending',
      );
      const canceled = await call(ctx, 'POST', `/items/${ID}/cancel`);
      expect(canceled.status).toBe(200);
      const stored = await ctx.runtime.store.readRun(`work:${ID}/r1`);
      expect(stored?.events.at(-1)).toMatchObject({
        by: 'operator',
        to: 'canceled',
        intervention: {
          kind: 'work-api-cancel',
          principal: principal.principal,
        },
      });
      const metrics = await call(ctx, 'GET', '/metrics/lifecycle');
      expect(metrics.status).toBe(200);
      expect(metrics.json.prometheus).toContain(
        'lcars_product_operational_interventions_window{pipeline="claude",kind="work-api-cancel"} 1\n',
      );
      expect(metrics.json.prometheus).toContain(
        'lcars_product_measurement_unknown_window{pipeline="claude",measurement="human_touch"} 1\n',
      );
      expect(metrics.json.prometheus).not.toContain(principal.principal);
      expect((await call(ctx, 'POST', `/items/${ID}/cancel`)).status).toBe(409);
      expect(
        (await ctx.runtime.store.readRun(`work:${ID}/r1`))?.events,
      ).toEqual(stored?.events);
    },
  );

  it('starts session expiry when it closes a parked item, but leaves a live run to the outbox', async () => {
    const expireItemSessions = vi.fn().mockResolvedValue(undefined);
    const base = context();
    const ctx = context({
      runtime: { ...base.runtime, expireItemSessions },
    });
    await call(ctx, 'PUT', `/items/${ID}`, { spec });
    // Live run: cancelling it settles the run, whose outbox outcome
    // dispatches the expiry (orchestrator-dispatch), not this handler.
    await call(ctx, 'POST', `/items/${ID}/cancel`);
    expect(expireItemSessions).not.toHaveBeenCalled();

    const parked = context({
      runtime: { ...context().runtime, expireItemSessions },
    });
    await call(parked, 'PUT', `/items/${ID}`, { spec });
    await parked.runtime.orchestrator.report(`work:${ID}/r1`, {
      ok: true,
      summary: 'park',
    });
    const closed = await call(parked, 'POST', `/items/${ID}/cancel`);
    expect(closed.json.state).toBe('canceled');
    expect(expireItemSessions).toHaveBeenCalledExactlyOnceWith(ID);
  });

  it('clears the close stamp when a failed item is redispatched or a done item gets a reply', async () => {
    const expireItemSessions = vi.fn().mockResolvedValue(undefined);
    const ctx = context({
      runtime: { ...context().runtime, expireItemSessions },
    });
    await call(ctx, 'PUT', `/items/${ID}`, { spec });
    await ctx.runtime.orchestrator.report(`work:${ID}/r1`, {
      ok: false,
      summary: 'blocked',
    });
    expect((await call(ctx, 'POST', `/items/${ID}/redispatch`)).status).toBe(
      200,
    );
    expect(expireItemSessions).toHaveBeenCalledExactlyOnceWith(ID);

    await ctx.runtime.orchestrator.report(`work:${ID}/r2`, { ok: true });
    expect((await call(ctx, 'GET', `/items/${ID}`)).json.state).toBe('done');
    const reply = await call(ctx, 'POST', `/items/${ID}/reply`, {
      text: 'one more thing',
    });
    expect(reply.status).toBe(200);
    expect(expireItemSessions).toHaveBeenCalledTimes(2);
  });

  it('creates an item with a long description and takes a long reply whole, refusing only past the byte budgets', async () => {
    const ctx = context();
    // Both past the retired 16,384-character cap.
    const description = '漢'.repeat(65_536);
    const created = await call(ctx, 'PUT', `/items/${ID}`, {
      spec: { ...spec, description },
    });
    expect(created.status).toBe(201);
    expect(created.json.spec.description).toBe(description);
    await ctx.runtime.orchestrator.report(`work:${ID}/r1`, {
      ok: true,
      summary: 'park',
    });

    const text = 'r'.repeat(65_536);
    const reply = await call(ctx, 'POST', `/items/${ID}/reply`, { text });
    expect(reply.status).toBe(200);
    expect(reply.json.runs.at(-1)?.reply).toBe(text);

    const tooLarge = await call(ctx, 'POST', `/items/${ID}/reply`, {
      text: 'r'.repeat(WORK_PARAM_TEXT_MAX_BYTES),
    });
    expect(tooLarge.status).toBe(400);
    const tooLargeItem = await call(ctx, 'PUT', `/items/${OTHER_ID}`, {
      spec: { ...spec, description: 'x'.repeat(WORK_PAYLOAD_MAX_BYTES) },
    });
    expect(tooLargeItem.status).toBe(400);
  });

  it('does not touch session expiry when a parked item is redispatched', async () => {
    const expireItemSessions = vi.fn().mockResolvedValue(undefined);
    const ctx = context({
      runtime: { ...context().runtime, expireItemSessions },
    });
    await call(ctx, 'PUT', `/items/${ID}`, { spec });
    await ctx.runtime.orchestrator.report(`work:${ID}/r1`, {
      ok: true,
      summary: 'park',
    });
    expect((await call(ctx, 'POST', `/items/${ID}/redispatch`)).status).toBe(
      200,
    );
    expect(expireItemSessions).not.toHaveBeenCalled();
  });

  it('redispatches only a parked item', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/items/${ID}`, { spec });
    expect((await call(ctx, 'POST', `/items/${ID}/redispatch`)).status).toBe(
      409,
    );
    await ctx.runtime.orchestrator.report(`work:${ID}/r1`, {
      ok: false,
      summary: 'blocked',
    });
    expect((await call(ctx, 'GET', `/items/${ID}`)).json.state).toBe('failed');
    const r = await call(ctx, 'POST', `/items/${ID}/redispatch`);
    expect(r.status).toBe(200);
    expect(r.json.runs).toHaveLength(2);
    expect(r.json.state).toBe('running');
    // No `resumeSessionId` in the request, but every admitted native run
    // still records its explicit dispatch behavior.
    const fresh = await ctx.runtime.store.readRun(`work:${ID}/r2`);
    expect(fresh?.params).toEqual({ mode: 'implement' });
  });

  it('redispatch creates a fresh run', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/items/${ID}`, { spec });
    await ctx.runtime.orchestrator.report(`work:${ID}/r1`, {
      ok: false,
      summary: 'blocked',
    });
    const r = await call(ctx, 'POST', `/items/${ID}/redispatch`);
    expect(r.status).toBe(200);
    expect(await ctx.runtime.store.readRun(`work:${ID}/r2`)).toMatchObject({
      state: 'pending',
    });
  });

  it.each([
    operator,
    {
      ...operator,
      principal: 'svc:authorized-automation',
      via: 'google' as const,
    },
  ])(
    'records only an accepted native redispatch from $principal',
    async (principal) => {
      const ctx = context({ principal });
      await call(ctx, 'PUT', `/items/${ID}`, { spec });
      const original = await ctx.runtime.store.readRun(`work:${ID}/r1`);
      expect(original?.events[0].intervention).toBeUndefined();
      await ctx.runtime.orchestrator.report(`work:${ID}/r1`, {
        ok: false,
        summary: 'blocked',
      });
      expect((await call(ctx, 'POST', `/items/${ID}/redispatch`)).status).toBe(
        200,
      );
      const accepted = await ctx.runtime.store.readRun(`work:${ID}/r2`);
      expect(accepted?.events[0]).toEqual({
        at: accepted?.createdAt,
        to: 'pending',
        by: 'request',
        intervention: {
          kind: 'work-api-redispatch',
          principal: principal.principal,
        },
      });
      const metrics = await call(ctx, 'GET', '/metrics/lifecycle');
      expect(metrics.status).toBe(200);
      expect(metrics.json.prometheus).toContain(
        'lcars_product_redispatch_interventions_window{pipeline="claude"} 1\n',
      );
      expect(metrics.json.prometheus).toContain(
        'lcars_product_intervened_tasks_window{kind="work-api-redispatch"} 1\n',
      );
      expect(metrics.json.prometheus).toContain(
        'lcars_product_reply_interventions_window{pipeline="claude"} 0\n',
      );
      expect(metrics.json.prometheus).not.toContain(principal.principal);
      // A subsequent request while this generation is live is refused, not
      // credited as another admission. Re-parking and redispatching later is
      // a separate accepted action, not an idempotent replay.
      expect((await call(ctx, 'POST', `/items/${ID}/redispatch`)).status).toBe(
        409,
      );
      expect(await ctx.runtime.store.readRun(`work:${ID}/r2`)).toEqual(
        accepted,
      );
      expect(await ctx.runtime.store.readRun(`work:${ID}/r3`)).toBeUndefined();
    },
  );

  it('refuses to redispatch an item whose repo is not admitted, with 403', async () => {
    const ctx = context();
    // Seeded straight through the orchestrator, because `create` would
    // refuse this repo today -- and that is precisely the situation under
    // test: an item somehow exists (e.g. minted before this check existed,
    // or hand-written) targeting a repo that is not (or is no longer)
    // admitted. Redispatch must re-check `forbiddenReason` as it stands
    // now, not inherit the permission the item was created with.
    await ctx.runtime.orchestrator.request({
      taskId: { workId: ID },
      requestId: ID,
      pipeline: 'claude',
      work: {
        origin: { principal: 'user:jlapenna', channel: 'console' },
        spec: { ...spec, target: { repo: 'octo/example' } },
      },
    });
    await ctx.runtime.orchestrator.report(`work:${ID}/r1`, { ok: false });
    expect((await call(ctx, 'GET', `/items/${ID}`)).json.state).toBe('failed');

    const r = await call(ctx, 'POST', `/items/${ID}/redispatch`);
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({
      message:
        'native work items can only target a control-plane repository ' +
        '(octo/example is not admitted)',
    });
    // Still parked: the refusal must not have minted a run.
    expect((await call(ctx, 'GET', `/items/${ID}`)).json.runs).toHaveLength(1);
  });

  it('refuses to redispatch a pipeline outside the grant, with 403', async () => {
    const ctx = context({
      principal: { ...operator, pipelines: ['codex'] },
    });
    await ctx.runtime.orchestrator.request({
      taskId: { workId: ID },
      requestId: ID,
      pipeline: 'claude',
      work: {
        origin: { principal: 'user:jlapenna', channel: 'console' },
        spec,
      },
    });
    await ctx.runtime.orchestrator.report(`work:${ID}/r1`, { ok: false });

    expect((await call(ctx, 'POST', `/items/${ID}/redispatch`)).status).toBe(
      403,
    );
  });

  describe('redispatch with resumeSessionId', () => {
    /** Parks `ID` with exactly one finished, `ok: false` run -- the
     *  precondition every case below shares -- and returns its run id, the
     *  same way `redispatches only a parked item` above does. */
    async function parkedItem(ctx: WorkContext): Promise<string> {
      await call(ctx, 'PUT', `/items/${ID}`, { spec });
      await ctx.runtime.orchestrator.report(`work:${ID}/r1`, {
        ok: false,
        summary: 'blocked',
      });
      return `work:${ID}/r1`;
    }

    it('threads params.resumeSessionId/resumeTranscriptGcsUri onto the fresh run', async () => {
      const ctx = context({
        getSessionDoc: async (id) =>
          id === 'sess_1'
            ? sessionDoc({
                sessionId: 'sess_1',
                intentId: `work:${ID}/r1`,
                transcriptGcsUri: 'gs://bucket/runs/x/claude-code/sess_1.jsonl',
              })
            : undefined,
      });
      await parkedItem(ctx);

      const r = await call(ctx, 'POST', `/items/${ID}/redispatch`, {
        resumeSessionId: 'sess_1',
      });
      expect(r.status).toBe(200);
      const fresh = await ctx.runtime.store.readRun(`work:${ID}/r2`);
      expect(fresh?.params).toEqual({
        mode: 'implement',
        resumeSessionId: 'sess_1',
        resumeTranscriptGcsUri: 'gs://bucket/runs/x/claude-code/sess_1.jsonl',
      });
    });

    it('refuses BAD_REQUEST for an unknown session id', async () => {
      const ctx = context({ getSessionDoc: async () => undefined });
      await parkedItem(ctx);

      const r = await call(ctx, 'POST', `/items/${ID}/redispatch`, {
        resumeSessionId: 'sess_missing',
      });
      expect(r.status).toBe(400);
      // Still parked: the refusal must not have minted a run.
      expect((await call(ctx, 'GET', `/items/${ID}`)).json.runs).toHaveLength(
        1,
      );
    });

    it('refuses BAD_REQUEST for a session belonging to a different item', async () => {
      const ctx = context({
        getSessionDoc: async () =>
          sessionDoc({
            sessionId: 'sess_2',
            intentId: `work:${OTHER_ID}/r1`,
            transcriptGcsUri: 'gs://bucket/x.jsonl',
          }),
      });
      await parkedItem(ctx);

      const r = await call(ctx, 'POST', `/items/${ID}/redispatch`, {
        resumeSessionId: 'sess_2',
      });
      expect(r.status).toBe(400);
      expect((await call(ctx, 'GET', `/items/${ID}`)).json.runs).toHaveLength(
        1,
      );
    });

    it('refuses CONFLICT for a same-item session with no archived transcript', async () => {
      const ctx = context({
        getSessionDoc: async () =>
          sessionDoc({
            sessionId: 'sess_3',
            intentId: `work:${ID}/r1`,
            // No transcriptGcsUri.
          }),
      });
      await parkedItem(ctx);

      const r = await call(ctx, 'POST', `/items/${ID}/redispatch`, {
        resumeSessionId: 'sess_3',
      });
      expect(r.status).toBe(409);
      expect((await call(ctx, 'GET', `/items/${ID}`)).json.runs).toHaveLength(
        1,
      );
    });
  });

  describe('reply', () => {
    it('answers only the displayed park and recovers the original click receipt', async () => {
      const ctx = contextWithSession();
      await parkedItemWithSession(ctx);
      const path = `/items/${ID}/reply`;
      const body = {
        text: 'Approved: Roll out to staging',
        requestId: 'decision-r1',
        expectedParkedRunId: `work:${ID}/r1`,
      };
      const first = await call(ctx, 'POST', path, body);
      expect(first.status).toBe(200);
      await ctx.runtime.orchestrator.report(first.json.admittedRunId, {
        ok: true,
        summary: 'park',
      });
      const replay = await call(ctx, 'POST', path, body);
      expect(replay.status).toBe(200);
      expect(replay.json.admittedRunId).toBe(first.json.admittedRunId);
      const stale = await call(ctx, 'POST', path, {
        ...body,
        requestId: 'another-click-for-r1',
      });
      expect(stale.status).toBe(409);
      expect(stale.json.message).toContain('decision changed');
      expect(await ctx.runtime.store.listRuns({ workId: ID })).toHaveLength(2);
    });

    it('refuses a click if a newer run parks while resume context is loading', async () => {
      const ctx = contextWithSession();
      await parkedItemWithSession(ctx);
      ctx.sessionDocsForRuns = async () => {
        const newer = await call(ctx, 'POST', `/items/${ID}/reply`, {
          text: 'A concurrent operator reply',
          resume: false,
        });
        expect(newer.status).toBe(200);
        await ctx.runtime.orchestrator.report(newer.json.admittedRunId, {
          ok: true,
          summary: 'park',
        });
        return [];
      };
      const response = await call(ctx, 'POST', `/items/${ID}/reply`, {
        text: 'Approved: Roll out to staging',
        requestId: 'decision-r1-raced',
        expectedParkedRunId: `work:${ID}/r1`,
      });
      expect(response.status).toBe(409);
      expect(response.json.message).toContain('decision changed');
      expect(await ctx.runtime.store.listRuns({ workId: ID })).toHaveLength(2);
    });

    it('round-trips the typed client through the actual HTTP handler for admission and conflict feedback', async () => {
      const ctx = contextWithSession();
      await parkedItemWithSession(ctx);
      const handler = createWorkHandler();
      const client: RouterContractClient<ItemsContract> = createORPCClient(
        new OpenAPILink(itemsContract, {
          origin: 'https://lcars.test',
          url: '/api/work/v1',
          fetch: async (input, init) => {
            const { response } = await handler.handle(
              new Request(input, init),
              { prefix: '/api/work/v1', context: ctx },
            );
            if (response === undefined)
              throw new Error('unmatched work request');
            return response;
          },
        }),
      );
      const body = { id: ID, text: 'continue', requestId: 'typed-roundtrip' };
      await expect(client.reply(body)).resolves.toMatchObject({
        admittedRunId: `work:${ID}/r2`,
        resumed: true,
      });
      await expect(client.reply(body)).resolves.toMatchObject({
        admittedRunId: `work:${ID}/r2`,
        resumed: true,
      });
      await expect(
        client.reply({ ...body, text: 'changed' }),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'request-id already used for a different reply',
      });
    });
    it('replays a caller key during execution and after later rounds without minting another run', async () => {
      const ctx = contextWithSession({
        principal: { ...operator, via: 'google' },
      });
      await parkedItemWithSession(ctx);
      const body = { text: 'fresh turn', requestId: 'my-turn', resume: false };
      const first = await call(ctx, 'POST', `/items/${ID}/reply`, body);
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({
        admittedRunId: `work:${ID}/r2`,
        resumed: false,
      });
      const during = await call(ctx, 'POST', `/items/${ID}/reply`, body);
      expect(during.status).toBe(200);
      expect(during.json.admittedRunId).toBe(first.json.admittedRunId);
      await ctx.runtime.orchestrator.report(first.json.admittedRunId, {
        ok: true,
        summary: 'park',
      });
      await call(ctx, 'POST', `/items/${ID}/reply`, {
        text: 'later',
        requestId: 'next-turn',
      });
      const later = await call(ctx, 'POST', `/items/${ID}/reply`, body);
      expect(later.status).toBe(200);
      expect(later.json).toMatchObject({
        admittedRunId: `work:${ID}/r2`,
        resumed: false,
      });
      expect(later.json.runs).toHaveLength(3);
      const stored = await ctx.runtime.store.readRun(first.json.admittedRunId);
      expect(stored?.events[0]).toEqual({
        at: '2026-08-26T10:00:00.000Z',
        to: 'pending',
        by: 'request',
        intervention: { kind: 'work-api-reply', principal: 'user:jlapenna' },
      });
      const metrics = await call(ctx, 'GET', '/metrics/lifecycle');
      expect(metrics.status).toBe(200);
      expect(metrics.json.prometheus).toContain(
        'lcars_product_reply_interventions_window{pipeline="claude"} 2\n',
      );
      expect(stored?.params).toMatchObject({
        replyPrincipal: 'user:jlapenna',
        replyChannel: 'api',
        replyRequestId: 'my-turn',
      });
    });

    it.each([{ text: 'different' }, { resume: false }, { pipeline: 'codex' }])(
      'refuses a caller key with changed input: %j',
      async (change) => {
        const ctx = contextWithSession({
          principal: { ...operator, pipelines: ['claude', 'codex'] },
        });
        await parkedItemWithSession(ctx);
        const body = { text: 'original', requestId: 'same-key' };
        const first = await call(ctx, 'POST', `/items/${ID}/reply`, body);
        const changed = await call(ctx, 'POST', `/items/${ID}/reply`, {
          ...body,
          ...change,
        });
        expect(first.status).toBe(200);
        expect(changed.status).toBe(409);
        expect(changed.json.message).toContain('different reply');
        expect(changed.json.message).not.toBe('task-busy');
        expect(await ctx.runtime.store.listRuns({ workId: ID })).toHaveLength(
          2,
        );
      },
    );

    it('does not deduplicate another principal and rechecks current pipeline grants on replay', async () => {
      const ctx = contextWithSession();
      await parkedItemWithSession(ctx);
      const body = { text: 'original', requestId: 'same-key' };
      const first = await call(ctx, 'POST', `/items/${ID}/reply`, body);
      ctx.principal = {
        ...operator,
        principal: 'user:other',
        subject: 'github:other',
      };
      expect((await call(ctx, 'POST', `/items/${ID}/reply`, body)).status).toBe(
        409,
      );
      await ctx.runtime.orchestrator.report(first.json.admittedRunId, {
        ok: true,
        summary: 'park',
      });
      const other = await call(ctx, 'POST', `/items/${ID}/reply`, body);
      expect(other.status).toBe(200);
      expect(other.json.admittedRunId).toBe(`work:${ID}/r3`);
      ctx.principal = { ...operator, pipelines: [] };
      expect((await call(ctx, 'POST', `/items/${ID}/reply`, body)).status).toBe(
        403,
      );
      ctx.principal = undefined;
      expect((await call(ctx, 'POST', `/items/${ID}/reply`, body)).status).toBe(
        401,
      );
    });

    it('deduplicates simultaneous same-key requests using the admitted resume binding', async () => {
      const ctx = contextWithSession();
      await parkedItemWithSession(ctx);
      const body = { text: 'continue', requestId: 'concurrent-key' };
      const both = await Promise.all([
        call(ctx, 'POST', `/items/${ID}/reply`, body),
        call(ctx, 'POST', `/items/${ID}/reply`, body),
      ]);
      for (const response of both) {
        expect(response.status).toBe(200);
        expect(response.json).toMatchObject({
          admittedRunId: `work:${ID}/r2`,
          resumed: true,
        });
      }
      expect(await ctx.runtime.store.listRuns({ workId: ID })).toHaveLength(2);
    });

    it('checks the actual pipeline of a concurrent duplicate winner against current grants', async () => {
      const ctx = contextWithSession();
      await parkedItemWithSession(ctx);
      const request = ctx.runtime.orchestrator.request.bind(
        ctx.runtime.orchestrator,
      );
      vi.spyOn(ctx.runtime.orchestrator, 'request').mockImplementationOnce(
        async (input) => {
          // The same principal can arrive through two credentials with different
          // grants. Admit the permitted explicit switch after the contender has
          // inferred claude, but before its atomic request reaches the store.
          const winner = await call(
            {
              ...ctx,
              principal: { ...operator, pipelines: ['claude', 'codex'] },
            },
            'POST',
            `/items/${ID}/reply`,
            {
              text: 'continue',
              requestId: 'pipeline-race',
              pipeline: 'codex',
            },
          );
          expect(winner.status).toBe(200);
          expect(winner.json.resumed).toBe(false);
          return request(input);
        },
      );
      const contender = await call(ctx, 'POST', `/items/${ID}/reply`, {
        text: 'continue',
        requestId: 'pipeline-race',
      });
      expect(contender.status).toBe(403);
      expect(await ctx.runtime.store.listRuns({ workId: ID })).toHaveLength(2);
    });

    it('refuses changed text even when two same-key requests race admission', async () => {
      const ctx = contextWithSession();
      await parkedItemWithSession(ctx);
      const both = await Promise.all(
        ['one', 'two'].map((text) =>
          call(ctx, 'POST', `/items/${ID}/reply`, {
            text,
            requestId: 'racing-key',
          }),
        ),
      );
      expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(both.find((r) => r.status === 409)?.json.message).toContain(
        'different reply',
      );
      expect(await ctx.runtime.store.listRuns({ workId: ID })).toHaveLength(2);
    });

    it('refuses a raced explicit provider for an implicit keyed contender even when both are authorized', async () => {
      const ctx = contextWithSession({
        principal: { ...operator, pipelines: ['claude', 'codex'] },
      });
      await parkedItemWithSession(ctx);
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      ctx.sessionDocsForRuns = async () => {
        enter();
        await barrier;
        return [];
      };
      const body = { text: 'continue', requestId: 'implicit-race' };
      const implicit = call(ctx, 'POST', `/items/${ID}/reply`, body);
      await entered;
      const explicit = await call(ctx, 'POST', `/items/${ID}/reply`, {
        ...body,
        pipeline: 'codex',
      });
      release();
      const contender = await implicit;
      expect(explicit.status).toBe(200);
      expect(contender.status).toBe(409);
      expect(contender.json.message).toContain('different reply');
      expect(await ctx.runtime.store.listRuns({ workId: ID })).toHaveLength(2);
      expect(
        await ctx.runtime.store.readRun(explicit.json.admittedRunId),
      ).toMatchObject({ pipeline: 'codex' });
    });

    it('keeps an implicit keyed receipt stable after later work switches provider', async () => {
      const ctx = contextWithSession({
        principal: { ...operator, pipelines: ['claude', 'codex'] },
      });
      await parkedItemWithSession(ctx);
      const body = {
        text: 'continue',
        requestId: 'implicit-history',
        resume: false,
      };
      const first = await call(ctx, 'POST', `/items/${ID}/reply`, body);
      expect(first.status).toBe(200);
      await ctx.runtime.orchestrator.report(first.json.admittedRunId, {
        ok: true,
        summary: 'park',
      });
      const later = await call(ctx, 'POST', `/items/${ID}/reply`, {
        text: 'switch now',
        requestId: 'later-provider',
        pipeline: 'codex',
      });
      expect(later.status).toBe(200);
      const retry = await call(ctx, 'POST', `/items/${ID}/reply`, body);
      expect(retry.status).toBe(200);
      expect(retry.json.admittedRunId).toBe(first.json.admittedRunId);
      const changed = await call(ctx, 'POST', `/items/${ID}/reply`, {
        ...body,
        pipeline: 'claude',
      });
      expect(changed.status).toBe(409);
      expect(await ctx.runtime.store.listRuns({ workId: ID })).toHaveLength(3);
    });

    it('recovers a canceled keyed reply receipt without reopening or dispatching, while refusing new work and revoked grants', async () => {
      const ctx = contextWithSession();
      await parkedItemWithSession(ctx);
      const body = {
        text: 'continue',
        requestId: 'cancel-receipt',
        resume: false,
      };
      const first = await call(ctx, 'POST', `/items/${ID}/reply`, body);
      expect(first.status).toBe(200);
      expect((await call(ctx, 'POST', `/items/${ID}/cancel`, {})).status).toBe(
        200,
      );
      const drain = vi.spyOn(ctx.runtime, 'drain');
      const retry = await call(ctx, 'POST', `/items/${ID}/reply`, body);
      expect(retry.status).toBe(200);
      expect(retry.json).toMatchObject({
        state: 'canceled',
        admittedRunId: first.json.admittedRunId,
        resumed: false,
      });
      const newReply = await call(ctx, 'POST', `/items/${ID}/reply`, {
        ...body,
        requestId: 'new-after-cancel',
      });
      expect(newReply.status).toBe(409);
      expect(newReply.json.message).toBe('task-closed');
      const changed = await call(ctx, 'POST', `/items/${ID}/reply`, {
        ...body,
        text: 'different',
      });
      expect(changed.status).toBe(409);
      ctx.principal = { ...operator, pipelines: [] };
      expect((await call(ctx, 'POST', `/items/${ID}/reply`, body)).status).toBe(
        403,
      );
      expect(drain).not.toHaveBeenCalled();
      expect(await ctx.runtime.store.listRuns({ workId: ID })).toHaveLength(2);
    });

    /** Parks `ID` with exactly one finished claude run carrying an
     *  archived session -- the precondition every "mints a reply run"
     *  case below shares. */
    async function parkedItemWithSession(ctx: WorkContext): Promise<void> {
      await call(ctx, 'PUT', `/items/${ID}`, { spec });
      await ctx.runtime.orchestrator.report(`work:${ID}/r1`, {
        ok: true,
        summary: 'park',
      });
    }

    function contextWithSession(over: Partial<WorkContext> = {}): WorkContext {
      return context({
        sessionDocsForRuns: async () => [
          sessionDoc({
            sessionId: 'sess-1',
            intentId: `work:${ID}/r1`,
            transcriptGcsUri: 'gs://bucket/runs/x/claude-code/sess-1.jsonl',
          }),
        ],
        ...over,
      });
    }

    it('mints a reply run carrying the text and the resume request', async () => {
      const ctx = contextWithSession();
      await parkedItemWithSession(ctx);

      const r = await call(ctx, 'POST', `/items/${ID}/reply`, {
        text: 'Use Firestore.',
      });
      expect(r.status).toBe(200);
      expect(r.json.resumed).toBe(true);
      const run = r.json.runs.at(-1);
      expect(run.reply).toBe('Use Firestore.');
      const stored = await ctx.runtime.store.readRun(run.runId);
      expect(stored?.params).toMatchObject({
        mode: 'reply',
        reply: 'Use Firestore.',
        replyChannel: 'console',
        resumeSessionId: 'sess-1',
      });
    });

    it('returns the admitted round identity even if another reply wins before the response history read', async () => {
      const ctx = contextWithSession();
      await parkedItemWithSession(ctx);
      ctx.runtime.drain = async () => {
        // This is the boundary between r2's admission and the handler's
        // current-item read. Settle r2 and admit a genuinely resumed r3.
        ctx.runtime.drain = async () => ({ dispatched: [], failed: [] });
        await ctx.runtime.orchestrator.report(`work:${ID}/r2`, {
          ok: true,
          summary: 'park',
        });
        const later = await call(ctx, 'POST', `/items/${ID}/reply`, {
          text: 'Resume for the other operator.',
        });
        expect(later.status).toBe(200);
        expect(later.json).toMatchObject({
          admittedRunId: `work:${ID}/r3`,
          resumed: true,
        });
        return { dispatched: [], failed: [] };
      };
      const first = await call(ctx, 'POST', `/items/${ID}/reply`, {
        text: 'Start a fresh round.',
        resume: false,
      });
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({
        admittedRunId: `work:${ID}/r2`,
        resumed: false,
        state: 'running',
      });
      expect(
        first.json.runs.map((run: { runId: string }) => run.runId),
      ).toEqual([`work:${ID}/r1`, `work:${ID}/r2`, `work:${ID}/r3`]);
      const accepted = await ctx.runtime.store.readRun(
        first.json.admittedRunId,
      );
      expect(accepted?.params?.['resumeSessionId']).toBeUndefined();
      const newer = await ctx.runtime.store.readRun(`work:${ID}/r3`);
      expect(newer?.params?.['resumeSessionId']).toBe('sess-1');
    });

    it('refuses a reply while a run is live', async () => {
      const ctx = context();
      await call(ctx, 'PUT', `/items/${ID}`, { spec });

      const r = await call(ctx, 'POST', `/items/${ID}/reply`, { text: 'hi' });
      expect(r.status).toBe(409);
      expect(r.json).toMatchObject({ message: 'task-busy' });
    });

    it('accepts a reply on a done item', async () => {
      const ctx = contextWithSession();
      await call(ctx, 'PUT', `/items/${ID}`, { spec });
      await ctx.runtime.orchestrator.report(`work:${ID}/r1`, { ok: true });
      expect((await call(ctx, 'GET', `/items/${ID}`)).json.state).toBe('done');

      const r = await call(ctx, 'POST', `/items/${ID}/reply`, {
        text: 'one more tweak',
      });
      expect(r.status).toBe(200);
    });

    it('omits the resume request when resume is false', async () => {
      const ctx = contextWithSession();
      await parkedItemWithSession(ctx);

      const r = await call(ctx, 'POST', `/items/${ID}/reply`, {
        text: 'fresh please',
        resume: false,
      });
      expect(r.status).toBe(200);
      expect(r.json.resumed).toBe(false);
      const run = r.json.runs.at(-1);
      const stored = await ctx.runtime.store.readRun(run.runId);
      expect(stored?.params?.['resumeSessionId']).toBeUndefined();
    });

    it('omits the resume request when the pipeline switches', async () => {
      const ctx = contextWithSession({
        principal: { ...operator, pipelines: ['claude', 'codex'] },
      });
      await parkedItemWithSession(ctx);

      const r = await call(ctx, 'POST', `/items/${ID}/reply`, {
        text: 'try codex',
        pipeline: 'codex',
      });
      expect(r.status).toBe(200);
      const run = r.json.runs.at(-1);
      const stored = await ctx.runtime.store.readRun(run.runId);
      expect(stored?.params?.['resumeSessionId']).toBeUndefined();
      expect(stored?.pipeline).toBe('codex');
    });
  });

  it('joins the sessions the context resolves for the item runs', async () => {
    const ctx = context({
      sessionsFor: async (runIds) =>
        runIds.map((runId) => ({
          sessionId: `s-${runId}`,
          runId,
          startedAt: '2026-08-26T10:00:00.000Z',
          lastActivityAt: '2026-08-26T10:01:00.000Z',
        })),
    });

    const expected = [
      {
        sessionId: `s-work:${ID}/r1`,
        runId: `work:${ID}/r1`,
        startedAt: '2026-08-26T10:00:00.000Z',
        lastActivityAt: '2026-08-26T10:01:00.000Z',
      },
    ];

    const created = await call(ctx, 'PUT', `/items/${ID}`, { spec });
    expect(created.json.sessions).toEqual(expected);
    expect((await call(ctx, 'GET', `/items/${ID}`)).json.sessions).toEqual(
      expected,
    );
    // The listing joins sessions too -- it builds the page first and only
    // then reaches the telemetry database, so this is the case that would
    // regress if that second pass were ever dropped.
    const listed = await call(ctx, 'GET', '/items');
    expect(listed.json.items[0].sessions).toEqual(expected);
  });

  it('lists native items only', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/items/${ID}`, { spec });
    await ctx.runtime.orchestrator.request({
      taskId: { repo: 'octo/example', issue: 7 },
      requestId: 'x',
      pipeline: 'claude',
    });
    const r = await call(ctx, 'GET', '/items');
    expect(r.status).toBe(200);
    expect(r.json.items.map((i: { id: string }) => i.id)).toEqual([ID]);
  });

  it('fails the list when a persisted task violates the current Work shape', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/items/${ID}`, { spec });
    // A corrupted Work record lacks its spec. Current records must not be
    // silently omitted from the control-plane response.
    await ctx.runtime.orchestrator.request({
      taskId: { workId: OTHER_ID },
      requestId: OTHER_ID,
      pipeline: 'claude',
      work: { origin: { principal: 'user:x', channel: 'api' } },
    });

    const r = await call(ctx, 'GET', '/items');
    expect(r.status).toBe(500);
  });

  it('narrows the listing by state, principal, and repo', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/items/${ID}`, { spec });
    await call(ctx, 'PUT', `/items/${OTHER_ID}`, { spec });
    await call(ctx, 'POST', `/items/${OTHER_ID}/cancel`);

    const running = await call(ctx, 'GET', '/items?state=running');
    expect(running.json.items.map((i: { id: string }) => i.id)).toEqual([ID]);

    const mine = await call(ctx, 'GET', '/items?principal=user%3Ajlapenna');
    expect(mine.json.items).toHaveLength(2);

    const elsewhere = await call(ctx, 'GET', '/items?repo=octo%2Fexample');
    expect(elsewhere.json.items).toEqual([]);

    const capped = await call(ctx, 'GET', '/items?limit=1');
    expect(capped.json.items).toHaveLength(1);
  });

  it('pages through matching state without loading runs for newer nonmatches', async () => {
    const ctx = context();
    const oldest = '01J5Z3K9QX8F0N2B4V6C8D1E3A';
    const middle = '01J5Z3K9QX8F0N2B4V6C8D1E3B';
    const newest = '01J5Z3K9QX8F0N2B4V6C8D1E3C';

    for (const id of [oldest, middle, newest]) {
      await call(ctx, 'PUT', `/items/${id}`, { spec });
    }
    await call(ctx, 'POST', `/items/${newest}/cancel`);

    const runs = vi.spyOn(ctx.runtime.store, 'listRunsForTasks');
    const first = await call(ctx, 'GET', '/items?state=running&limit=1');
    expect(first.json.items.map((item: { id: string }) => item.id)).toEqual([
      middle,
    ]);
    expect(first.json.nextCursor).toBe(middle);
    expect(runs).toHaveBeenNthCalledWith(1, [{ workId: middle }]);

    const second = await call(
      ctx,
      'GET',
      `/items?state=running&limit=1&cursor=${first.json.nextCursor}`,
    );
    expect(second.json.items.map((item: { id: string }) => item.id)).toEqual([
      oldest,
    ]);
    expect(runs).toHaveBeenNthCalledWith(2, [{ workId: oldest }]);
  });
});

describe('GitHub-anchor dispatch route', () => {
  it('preserves an explicitly urgent GitHub API admission and redispatch', async () => {
    const ctx = context({ principal: githubActionsOperator });
    const first = await call(ctx, 'POST', '/dispatches/github', {
      ...input,
      spec: { ...input.spec, priority: 'urgent' },
    });
    expect(first.status).toBe(200);
    expect(await ctx.runtime.store.readRun(first.json.runId)).toMatchObject({
      priority: 'urgent',
    });
    await ctx.runtime.orchestrator.report(first.json.runId, { ok: true });
    const again = await call(ctx, 'POST', '/dispatches/github/redispatch', {
      anchor,
      mode: 'implement',
      requestId: 'urgent-redispatch',
    });
    expect(again.status).toBe(200);
    expect(await ctx.runtime.store.readRun(again.json.runId)).toMatchObject({
      priority: 'urgent',
    });
  });
  const anchor = { repo: 'jlapenna/agent-lcars', issue: 1633 };
  const input = {
    anchor,
    spec: {
      title: 'Migrate automation dispatch',
      description: 'Use the Work API route.',
      pipeline: 'codex',
      priority: 'normal',
      target: { repo: anchor.repo },
    },
    mode: 'implement' as const,
    reply: 'Please handle this.',
    runbook: 'automation-dispatch',
    context: 'phase-1',
    requestId: 'workflow-run:123:dispatch:1633',
  };

  it('requires work.operator before it parses or admits an anchor', async () => {
    const r = await call(
      context({ principal: undefined }),
      'POST',
      '/dispatches/github',
      input,
    );
    expect(r.status).toBe(401);
  });

  it('stores the explicit Work payload, parameters, and idempotency key through the normal orchestrator path', async () => {
    const ctx = context({ principal: githubActionsOperator });
    const first = await call(ctx, 'POST', '/dispatches/github', input);
    expect(first.status).toBe(200);
    expect(first.json).toEqual({
      outcome: 'accepted',
      runId: 'jlapenna/agent-lcars#1633/r1',
      dispatched: false,
    });

    const task = await ctx.runtime.store.readTask(anchor);
    expect(task?.task.work).toEqual({
      origin: { principal: 'workflow:member-automation', channel: 'api' },
      spec: input.spec,
    });
    const run = await ctx.runtime.store.readRun('jlapenna/agent-lcars#1633/r1');
    expect(run).toMatchObject({
      requestId: input.requestId,
      pipeline: 'codex',
      params: {
        mode: 'implement',
        reply: 'Please handle this.',
        runbook: 'automation-dispatch',
        context: 'phase-1',
      },
    });

    const retry = await call(ctx, 'POST', '/dispatches/github', input);
    expect(retry.status).toBe(200);
    expect(retry.json).toEqual({
      outcome: 'duplicate',
      runId: 'jlapenna/agent-lcars#1633/r1',
    });
  });

  it('redispatches from the stored immutable Work with fresh run parameters', async () => {
    const ctx = context({ principal: githubActionsOperator });
    const first = await call(ctx, 'POST', '/dispatches/github', input);
    await ctx.runtime.orchestrator.report(first.json.runId as string, {
      ok: true,
    });

    const redispatch = {
      anchor,
      mode: 'implement',
      reply: 'Verify the newly deployed revision.',
      runbook: 'verifying-post-deploy',
      context: 'deployed revision abc123',
      requestId: 'post-deploy:1633:abc123',
    };
    const second = await call(
      ctx,
      'POST',
      '/dispatches/github/redispatch',
      redispatch,
    );
    expect(second.status).toBe(200);
    expect(second.json).toEqual({
      outcome: 'accepted',
      runId: 'jlapenna/agent-lcars#1633/r2',
      dispatched: false,
    });
    expect((await ctx.runtime.store.readTask(anchor))?.task.work).toEqual({
      origin: { principal: 'workflow:member-automation', channel: 'api' },
      spec: input.spec,
    });
    expect(
      await ctx.runtime.store.readRun(second.json.runId as string),
    ).toMatchObject({
      pipeline: input.spec.pipeline,
      requestId: redispatch.requestId,
      params: {
        mode: redispatch.mode,
        reply: redispatch.reply,
        runbook: redispatch.runbook,
        context: redispatch.context,
      },
    });

    const duplicate = await call(
      ctx,
      'POST',
      '/dispatches/github/redispatch',
      redispatch,
    );
    expect(duplicate.json).toEqual({
      outcome: 'duplicate',
      runId: second.json.runId,
    });
    const busy = await call(ctx, 'POST', '/dispatches/github/redispatch', {
      ...redispatch,
      requestId: 'post-deploy:1633:def456',
    });
    expect(busy.json).toEqual({
      outcome: 'busy',
      runId: second.json.runId,
    });
  });

  it('requires prior admission and re-checks the signed repository and pipeline grant', async () => {
    const redispatch = {
      anchor,
      mode: 'implement' as const,
      requestId: 'post-deploy:1633:abc123',
    };
    expect(
      (
        await call(
          context({ principal: githubActionsOperator }),
          'POST',
          '/dispatches/github/redispatch',
          redispatch,
        )
      ).status,
    ).toBe(404);

    const ctx = context({ principal: githubActionsOperator });
    const first = await call(ctx, 'POST', '/dispatches/github', input);
    await ctx.runtime.orchestrator.report(first.json.runId as string, {
      ok: true,
    });
    const foreign = await call(
      context({
        runtime: ctx.runtime,
        principal: {
          ...githubActionsOperator,
          sourceRepository: 'octo/other',
        },
      }),
      'POST',
      '/dispatches/github/redispatch',
      redispatch,
    );
    expect(foreign.status).toBe(403);
    const denied = await call(
      context({
        runtime: ctx.runtime,
        principal: { ...githubActionsOperator, pipelines: ['claude'] },
      }),
      'POST',
      '/dispatches/github/redispatch',
      redispatch,
    );
    expect(denied.status).toBe(403);
  });

  it('preserves an under-bound GitHub body in the stored Work spec', async () => {
    const ctx = context({ principal: githubActionsOperator });
    const description = '  Preserve this exact GitHub body.\n';
    const r = await call(ctx, 'POST', '/dispatches/github', {
      ...input,
      spec: { ...input.spec, description },
      requestId: 'workflow-run:under-bound:1633',
    });

    expect(r.status).toBe(200);
    expect((await ctx.runtime.store.readTask(anchor))?.task.work).toMatchObject(
      {
        spec: { description },
      },
    );
  });

  it('stores a complete 65,536-character GitHub body whole', async () => {
    const ctx = context({ principal: githubActionsOperator });
    // GitHub's own body limit; the retired 16,384-character cap cut it.
    const description = 'x'.repeat(65_536);
    const r = await call(ctx, 'POST', '/dispatches/github', {
      ...input,
      spec: { ...input.spec, description },
      requestId: 'workflow-run:overlong:1633',
    });

    expect(r.status).toBe(200);
    expect((await ctx.runtime.store.readTask(anchor))?.task.work).toMatchObject(
      { spec: { description } },
    );
  });

  it("refuses a body past GitHub's 65,536-character limit", async () => {
    const ctx = context({ principal: githubActionsOperator });
    const r = await call(ctx, 'POST', '/dispatches/github', {
      ...input,
      spec: { ...input.spec, description: 'x'.repeat(65_537) },
      requestId: 'workflow-run:too-long:1633',
    });
    expect(r.status).toBe(400);
  });

  it('normalizes an empty body and keeps a complete multibyte body whole within the storage byte budget', async () => {
    const emptyCtx = context({ principal: githubActionsOperator });
    const empty = await call(emptyCtx, 'POST', '/dispatches/github', {
      ...input,
      spec: { ...input.spec, description: '' },
      requestId: 'workflow-run:empty:1633',
    });
    expect(empty.status).toBe(200);
    expect(
      (await emptyCtx.runtime.store.readTask(anchor))?.task.work,
    ).toMatchObject({
      spec: { description: '(no description)' },
    });

    const multibyteCtx = context({ principal: githubActionsOperator });
    const multibyte = await call(multibyteCtx, 'POST', '/dispatches/github', {
      ...input,
      spec: { ...input.spec, description: '漢'.repeat(65_536) },
      requestId: 'workflow-run:multibyte:1633',
    });
    expect(multibyte.status).toBe(200);
    const stored = await multibyteCtx.runtime.store.readTask(anchor);
    const storedDescription = (
      stored?.task.work as { spec?: { description?: string } } | undefined
    )?.spec?.description;
    expect(storedDescription).toBe('漢'.repeat(65_536));
    expect(
      new TextEncoder().encode(JSON.stringify(stored?.task.work)).length,
    ).toBeLessThanOrEqual(WORK_PAYLOAD_MAX_BYTES);
  });

  it('clamps only JSON-escaped GitHub text past the byte budget and reads the schema back', async () => {
    const ctx = context({ principal: githubActionsOperator });
    // A C0 control character serializes as a six-byte escape: 65,536 of
    // them are valid GitHub input yet exceed the serialized Work budget, the
    // only GitHub-sized body that still gets the visible clamp.
    const body = '\u0001'.repeat(65_536);
    const r = await call(ctx, 'POST', '/dispatches/github', {
      ...input,
      spec: { ...input.spec, description: body },
      requestId: 'workflow-run:escaped:1633',
    });

    expect(r.status).toBe(200);
    const stored = await ctx.runtime.store.readTask(anchor);
    expect(stored).toBeDefined();
    expect(taskSchema.parse(stored?.task)).toEqual(stored?.task);
    const storedDescription = (
      stored?.task.work as { spec?: { description?: string } } | undefined
    )?.spec?.description;
    expect(storedDescription).toContain('Read the full body');
    expect(
      new TextEncoder().encode(JSON.stringify(stored?.task.work)).length,
    ).toBeLessThanOrEqual(WORK_PAYLOAD_MAX_BYTES);
  });

  it.each([true, false])(
    'returns the original run when a request is replayed after it settles (%s)',
    async (ok) => {
      const ctx = context({ principal: githubActionsOperator });
      const first = await call(ctx, 'POST', '/dispatches/github', input);
      expect(first.json).toMatchObject({ outcome: 'accepted' });

      await ctx.runtime.orchestrator.report('jlapenna/agent-lcars#1633/r1', {
        ok,
      });

      const replay = await call(ctx, 'POST', '/dispatches/github', input);
      expect(replay.status).toBe(200);
      expect(replay.json).toEqual({
        outcome: 'duplicate',
        runId: 'jlapenna/agent-lcars#1633/r1',
      });
      expect(await ctx.runtime.store.listRuns(anchor)).toHaveLength(1);
    },
  );

  it('allows a different request ID after a prior request settles', async () => {
    const ctx = context({ principal: githubActionsOperator });
    await call(ctx, 'POST', '/dispatches/github', input);
    await ctx.runtime.orchestrator.report('jlapenna/agent-lcars#1633/r1', {
      ok: true,
    });

    const next = await call(ctx, 'POST', '/dispatches/github', {
      ...input,
      requestId: 'workflow-run:124:dispatch:1633',
    });
    expect(next.status).toBe(200);
    expect(next.json).toMatchObject({
      outcome: 'accepted',
      runId: 'jlapenna/agent-lcars#1633/r2',
    });
  });

  it('refuses a changed Work spec after the GitHub anchor settles', async () => {
    const ctx = context({ principal: githubActionsOperator });
    await call(ctx, 'POST', '/dispatches/github', input);
    await ctx.runtime.orchestrator.report('jlapenna/agent-lcars#1633/r1', {
      ok: true,
    });

    const changed = await call(ctx, 'POST', '/dispatches/github', {
      ...input,
      requestId: 'workflow-run:124:changed-pipeline:1633',
      spec: { ...input.spec, pipeline: 'claude' },
    });
    expect(changed.status).toBe(409);
    expect(await ctx.runtime.store.listRuns(anchor)).toHaveLength(1);
    expect((await ctx.runtime.store.readTask(anchor))?.task.work).toMatchObject(
      { spec: { pipeline: 'codex' } },
    );
  });

  it('preserves the signed caller-repository boundary and requires the Work target to equal the anchor', async () => {
    const ctx = context({ principal: githubActionsOperator });
    const foreign = await call(ctx, 'POST', '/dispatches/github', {
      ...input,
      anchor: { repo: 'other-org/other-repo', issue: 1 },
      spec: { ...input.spec, target: { repo: 'other-org/other-repo' } },
    });
    expect(foreign.status).toBe(403);

    const mismatched = await call(ctx, 'POST', '/dispatches/github', {
      ...input,
      spec: { ...input.spec, target: { repo: 'other-org/other-repo' } },
    });
    expect(mismatched.status).toBe(400);
  });

  it('uses the same pipeline grant check as other Work API admissions', async () => {
    const r = await call(
      context({
        principal: { ...githubActionsOperator, pipelines: ['claude'] },
      }),
      'POST',
      '/dispatches/github',
      input,
    );
    expect(r.status).toBe(403);
  });

  it.each(['claude', 'codex', 'opencode'] as const)(
    'admits %s through the same Work API and QueueExecutor request path',
    async (pipeline) => {
      const ctx = context({ principal: githubActionsOperator });
      const r = await call(ctx, 'POST', '/dispatches/github', {
        ...input,
        spec: { ...input.spec, pipeline },
        requestId: `workflow-run:123:${pipeline}:1633`,
      });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({
        outcome: 'accepted',
        runId: 'jlapenna/agent-lcars#1633/r1',
      });
      expect(
        await ctx.runtime.store.readRun('jlapenna/agent-lcars#1633/r1'),
      ).toMatchObject({
        pipeline,
        task: anchor,
      });
    },
  );
});

describe('GET /anchors/github/owner', () => {
  const REPO = 'jlapenna/agent-lcars';
  const anchor = { repo: REPO, issue: 2502 };
  const path = `/anchors/github/owner?repo=${REPO}&issue=2502`;

  function cliSession(over: Partial<CliSession> = {}): CliSession {
    return {
      sessionId: 'cli-1',
      liveness: 'live',
      agent: 'claude-code',
      host: 'laforge',
      branch: 'feat/issue-owner-query-2502',
      turns: 4,
      totalTokens: 10,
      startedAt: '2026-08-26T09:00:00.000Z',
      lastActivityAt: '2026-08-26T09:58:00.000Z',
      repo: { owner: 'jlapenna', name: 'agent-lcars' },
      ...over,
    };
  }

  async function admit(ctx: WorkContext, issue?: TrackerIssue) {
    const outcome = await ctx.runtime.orchestrator.request({
      taskId: anchor,
      requestId: 'first',
      pipeline: 'claude',
      ...(issue === undefined ? {} : { issue }),
      work: {
        origin: { principal: 'github:jlapenna', channel: 'github' },
        spec: { ...spec, target: { repo: REPO } },
      },
    });
    if (isRefusal(outcome)) throw new Error('unexpected refusal in fixture');
    return decidedRun(outcome).runId;
  }

  it('returns the full referenced run issue to a read-only caller', async () => {
    const ctx = context({ principal: readerOnly });
    await admit(ctx, admittedIssue);

    const owner = await call(ctx, 'GET', path);
    expect(owner.status).toBe(200);
    expect(owner.json.task.run.issue).toEqual(admittedIssue);
  });

  it('requires work.operator; reaper, executor, cron and anonymous are refused', async () => {
    for (const principal of [undefined, executorOnly, cronTick, reaperOnly]) {
      const cliSessions = vi.fn(async () => ({ sessions: [], warnings: [] }));
      expect(
        (await call(context({ principal, cliSessions }), 'GET', path)).status,
      ).toBe(401);
      expect(cliSessions).not.toHaveBeenCalled();
    }
    expect((await call(context(), 'GET', path)).status).toBe(200);
  });

  it('also answers a work.reader-only principal, within the same repository boundary', async () => {
    const cliSessions = vi.fn(async () => ({ sessions: [], warnings: [] }));
    const ctx = context({ principal: readerOnly, cliSessions });
    expect((await call(ctx, 'GET', path)).status).toBe(200);
    expect(cliSessions).toHaveBeenCalledTimes(1);
    expect(
      (
        await call(
          context({ principal: readerOnly, cliSessions }),
          'GET',
          '/anchors/github/owner?repo=octo/example&issue=1',
        )
      ).status,
    ).toBe(403);
    expect(cliSessions).toHaveBeenCalledTimes(1);
  });

  it('refuses a work.reader-only principal from every other items, schedules and dispatch route', async () => {
    const ctx = context();
    await call(ctx, 'PUT', `/items/${ID}`, { spec });
    await call(ctx, 'PUT', `/schedules/${ID}`, { cron: '0 * * * *', spec });
    const readerCtx = { ...ctx, principal: readerOnly };
    const request = vi.spyOn(ctx.runtime.orchestrator, 'request');
    for (const [m, p, b] of [
      ['GET', '/items'],
      ['GET', `/items/${ID}`],
      ['PUT', `/items/${ID}`, { spec }],
      ['PATCH', `/items/${ID}`, { spec }],
      ['POST', `/items/${ID}/cancel`],
      ['POST', `/items/${ID}/redispatch`],
      ['POST', `/items/${ID}/reply`, { text: 'continue' }],
      ['GET', '/metrics/lifecycle'],
      ['POST', '/maintenance/tick', {}],
      ['GET', '/schedules'],
      ['GET', `/schedules/${ID}`],
      ['PUT', `/schedules/${ID}`, { cron: '0 * * * *', spec }],
      [
        'PATCH',
        `/schedules/${ID}`,
        { expectedRevision: 1, cron: '0 * * * *', spec, enabled: false },
      ],
      ['DELETE', `/schedules/${ID}`, { expectedRevision: 1 }],
      ['POST', `/schedules/${ID}/enable`],
      ['POST', `/schedules/${ID}/disable`],
      ['POST', '/schedules/tick', {}],
      [
        'POST',
        '/dispatches/github',
        { anchor: { repo: REPO, issue: 2502 }, pipeline: 'claude' },
      ],
      [
        'POST',
        '/dispatches/github/redispatch',
        { anchor: { repo: REPO, issue: 2502 } },
      ],
    ] as const) {
      expect((await call(readerCtx, m, p, b)).status, `${m} ${p}`).toBe(401);
    }
    expect(request).not.toHaveBeenCalled();
    expect(
      (await ctx.runtime.store.readTask({ workId: ID }))?.task.runCount,
    ).toBe(1);
  });

  it('refuses repositories the caller may not read, before reading anything', async () => {
    const cliSessions = vi.fn(async () => ({ sessions: [], warnings: [] }));
    // Not a control-plane repository.
    expect(
      (
        await call(
          context({ cliSessions }),
          'GET',
          '/anchors/github/owner?repo=octo/example&issue=1',
        )
      ).status,
    ).toBe(403);
    // A GitHub Actions principal is bound to its own repository.
    expect(
      (
        await call(
          context({
            cliSessions,
            principal: {
              ...githubActionsOperator,
              sourceRepository: 'jlapenna/other',
            },
          }),
          'GET',
          path,
        )
      ).status,
    ).toBe(403);
    expect(cliSessions).not.toHaveBeenCalled();
    expect(
      (await call(context({ principal: githubActionsOperator }), 'GET', path))
        .status,
    ).toBe(200);
  });

  it('resolves a differently cased repository to the configured anchor', async () => {
    const cliSessions = vi.fn(async () => ({
      sessions: [
        cliSession({ repo: { owner: 'JLapenna', name: 'Agent-LCARS' } }),
      ],
      warnings: [],
    }));
    const ctx = context({ cliSessions });
    const runId = await admit(ctx);
    const result = await call(
      ctx,
      'GET',
      '/anchors/github/owner?repo=JLAPENNA/agent-lcars&issue=2502',
    );
    // The session read is scoped to the configured spelling of the anchor's
    // repository, never the caller's casing.
    expect(cliSessions).toHaveBeenCalledWith({
      owner: 'jlapenna',
      name: 'agent-lcars',
    });
    expect(result.json).toMatchObject({
      anchor,
      verdict: 'fleet-run',
      task: { activeRunId: runId },
      cliSessions: [{ sessionId: 'cli-1' }],
    });
  });

  it('rejects a malformed anchor before reading anything', async () => {
    const cliSessions = vi.fn(async () => ({ sessions: [], warnings: [] }));
    const ctx = context({ cliSessions });
    for (const bad of [
      '/anchors/github/owner?repo=not-a-repo&issue=1',
      `/anchors/github/owner?repo=${REPO}&issue=0`,
      `/anchors/github/owner?repo=${REPO}`,
    ])
      expect((await call(ctx, 'GET', bad)).status).toBe(400);
    expect(cliSessions).not.toHaveBeenCalled();
  });

  it('answers none when Console has no task and no session for the anchor', async () => {
    const result = await call(
      context({
        cliSessions: async () => ({
          sessions: [
            // Same number, other repo; and same repo, other number.
            cliSession({ repo: { owner: 'octo', name: 'example' } }),
            cliSession({ sessionId: 'cli-2', branch: 'feat/thing-25020' }),
          ],
          warnings: [],
        }),
      }),
      'GET',
      path,
    );
    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      anchor,
      observedAt: '2026-08-26T10:00:00.000Z',
      verdict: 'none',
      complete: true,
      warnings: [],
      cliSessions: [],
    });
  });

  it('reports a live fleet run as the owner, with run and session evidence', async () => {
    const sessionsFor = vi.fn(async (runIds: string[]) =>
      runIds.map((runId) => ({
        sessionId: 'worker-1',
        runId,
        startedAt: '2026-08-26T10:00:00.000Z',
        lastActivityAt: '2026-08-26T10:00:00.000Z',
      })),
    );
    const ctx = context({
      sessionsFor,
      cliSessions: async () => ({ sessions: [cliSession()], warnings: [] }),
    });
    const runId = await admit(ctx);

    const result = await call(ctx, 'GET', path);

    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({
      verdict: 'fleet-run',
      task: {
        state: 'running',
        pipeline: 'claude',
        runCount: 1,
        activeRunId: runId,
        run: { runId, pipeline: 'claude' },
        runSessions: [{ sessionId: 'worker-1', runId }],
      },
      // The interactive session is still evidence, even though the run
      // holds the task's mutex and so owns the verdict.
      cliSessions: [{ sessionId: 'cli-1', liveness: 'live' }],
    });
    expect(sessionsFor).toHaveBeenCalledWith([runId]);
  });

  it('reports a live CLI session when the task has no live run', async () => {
    const ctx = context({
      cliSessions: async () => ({
        sessions: [
          cliSession({ sessionId: 'old', liveness: 'ended' }),
          cliSession({
            sessionId: 'by-pr',
            liveness: 'idle',
            branch: 'main',
            pr: { number: 2502, url: 'https://github.com/x/pull/2502' },
          }),
        ],
        warnings: [],
      }),
    });
    const runId = await admit(ctx);
    await ctx.runtime.orchestrator.report(runId, { ok: true, summary: 'park' });

    const result = await call(ctx, 'GET', path);

    expect(result.json).toMatchObject({
      verdict: 'interactive-session',
      task: { state: 'parked', run: { runId, state: 'finished' } },
    });
    expect(result.json.task.activeRunId).toBeUndefined();
    // Active sessions first; an ended one is evidence, not ownership.
    expect(
      result.json.cliSessions.map(
        (session: { sessionId: string }) => session.sessionId,
      ),
    ).toEqual(['by-pr', 'old']);
  });

  it('marks the answer incomplete when CLI telemetry degraded', async () => {
    const result = await call(
      context({
        cliSessions: async () => ({
          sessions: [],
          warnings: [
            'CLI sessions unavailable (agent-telemetry store failed).',
          ],
        }),
      }),
      'GET',
      path,
    );
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({
      verdict: 'none',
      complete: false,
      warnings: ['CLI sessions unavailable (agent-telemetry store failed).'],
    });
  });
});

describe('exhausted delivery correction recovery', () => {
  async function lostCorrection(consecutiveLost = 3) {
    const ctx = context();
    expect((await call(ctx, 'PUT', `/items/${ID}`, { spec })).status).toBe(201);
    const anchor = { workId: ID };
    const original = (await ctx.runtime.store.readRun(`work:${ID}/r1`))!;
    const delivery = {
      runId: original.runId,
      repo: spec.target.repo,
      number: 12,
      baseRef: 'main',
      head: 'a'.repeat(40),
      state: 'waiting' as const,
      observedAt: original.createdAt,
      correctionRunId: `work:${ID}/r2`,
    };
    const result = {
      ok: true,
      summary: 'pull-request',
      ref: `https://github.com/${spec.target.repo}/pull/12`,
    };
    const snapshot = (await ctx.runtime.store.readTask(anchor))!;
    const { activeRunId: _activeRunId, ...withoutActiveRun } = snapshot.task;
    await ctx.runtime.store.apply({
      expectedRevision: snapshot.revision,
      decision: {
        task: { ...withoutActiveRun, runCount: 2, consecutiveLost, delivery },
        run: { ...original, state: 'finished', result, delivery },
        additionalRuns: [
          {
            ...original,
            runId: delivery.correctionRunId,
            requestId: 'delivery-correction',
            requestSource: 'delivery-correction',
            state: 'lost',
            createdAt: original.createdAt,
            params: { mode: 'implement', deliveryPredecessor: original.runId },
          },
        ],
        outbox: [],
      },
    });
    return { ctx, anchor, original, delivery, result };
  }
  it('reports exhausted loss as failed and permits authenticated reply recovery without dropping delivery ownership', async () => {
    const f = await lostCorrection();
    expect(await call(f.ctx, 'GET', `/items/${ID}`)).toMatchObject({
      status: 200,
      json: { state: 'failed' },
    });
    expect(
      await call(f.ctx, 'POST', `/items/${ID}/reply`, {
        text: 'Recover the lost correction.',
        requestId: 'lost-correction-recovery',
      }),
    ).toMatchObject({ status: 200, json: { admittedRunId: `work:${ID}/r3` } });
    const task = (await f.ctx.runtime.store.readTask(f.anchor))!.task;
    expect(task.delivery).toEqual(f.delivery);
    expect(task.activeRunId).toBe(`work:${ID}/r3`);
    expect(
      (await f.ctx.runtime.store.readRun(f.original.runId))!.result,
    ).toEqual(f.result);
    expect(await call(f.ctx, 'GET', `/items/${ID}`)).toMatchObject({
      status: 200,
      json: { state: 'running' },
    });
  });
  it('retains the ordinary same-Task redispatch barrier and refuses recovery after the pipeline grant is revoked', async () => {
    const f = await lostCorrection();
    expect((await call(f.ctx, 'POST', `/items/${ID}/redispatch`)).status).toBe(
      409,
    );
    const revoked = { ...f.ctx, principal: { ...operator, pipelines: [] } };
    expect(
      (
        await call(revoked, 'POST', `/items/${ID}/reply`, {
          text: 'Recover.',
          requestId: 'revoked-recovery',
        })
      ).status,
    ).toBe(403);
    expect(
      (await f.ctx.runtime.store.readTask(f.anchor))!.task.delivery,
    ).toEqual(f.delivery);
    expect(await f.ctx.runtime.store.readRun(`work:${ID}/r3`)).toBeUndefined();
  });
  it('admits authenticated reply recovery while the lost retry budget remains, since only the transaction guards the lock', async () => {
    // `settleLostAndRetry` mints the successor in the same Decision as the
    // loss, so a lost run with budget remaining always has a live successor
    // that `requestRun` refuses `task-busy` on. This fixture's shape -- lost,
    // budget remaining, no successor -- exists only here; the route no longer
    // re-derives a busy verdict from item state that would leave it with no
    // exit (redispatch needs `parked|failed`).
    const f = await lostCorrection(1);
    expect(await call(f.ctx, 'GET', `/items/${ID}`)).toMatchObject({
      status: 200,
      json: { state: 'running' },
    });
    expect(
      await call(f.ctx, 'POST', `/items/${ID}/reply`, {
        text: 'Recover the lost correction early.',
      }),
    ).toMatchObject({ status: 200, json: { admittedRunId: `work:${ID}/r3` } });
    const task = (await f.ctx.runtime.store.readTask(f.anchor))!.task;
    expect(task.delivery).toEqual(f.delivery);
    expect(task.activeRunId).toBe(`work:${ID}/r3`);
  });
});

describe('native cancel retires incomplete delivery recovery', () => {
  async function recovery(kind: 'correction' | 'reply') {
    const ctx = context();
    expect((await call(ctx, 'PUT', `/items/${ID}`, { spec })).status).toBe(201);
    const anchor = { workId: ID };
    const original = (await ctx.runtime.store.readRun(`work:${ID}/r1`))!;
    const dispatch = await ctx.runtime.orchestrator.confirmDispatch(
      original.runId,
    );
    if (isRefusal(dispatch)) throw Error(dispatch.reason);
    const result = {
      ok: true,
      summary: 'pull-request',
      ref: `https://github.com/${spec.target.repo}/pull/12`,
    };
    const binding = {
      runId: original.runId,
      repo: spec.target.repo,
      number: 12,
      baseRef: 'main',
      head: 'a'.repeat(40),
      state: 'waiting' as const,
      observedAt: original.createdAt,
    };
    const report = await ctx.runtime.orchestrator.report(
      original.runId,
      result,
      undefined,
      undefined,
      binding,
    );
    if (isRefusal(report)) throw Error(report.reason);
    const correction = await ctx.runtime.orchestrator.observeDelivery(
      original.runId,
      { kind: 'correction', head: binding.head, reason: 'review change' },
      () => true,
    );
    if (isRefusal(correction)) throw Error(correction.reason);
    let runId = correction.additionalRuns![0]!.runId;
    if (kind === 'reply') {
      const parked = await ctx.runtime.orchestrator.report(runId, {
        ok: true,
        summary: 'park',
      });
      if (isRefusal(parked)) throw Error(parked.reason);
      const reply = await call(ctx, 'POST', `/items/${ID}/reply`, {
        text: 'Recover.',
        requestId: 'cancel-recovery-reply',
      });
      if (reply.status !== 200) throw Error(`Reply refused: ${reply.status}`);
      runId = reply.json.admittedRunId;
    }
    return { ctx, anchor, original, result, runId };
  }
  it.each(['correction', 'reply'] as const)(
    'API native cancel retires active %s delivery ownership',
    async (kind) => {
      const f = await recovery(kind);
      const before = (await f.ctx.runtime.store.readTask(f.anchor))!.task
        .delivery;
      expect(await call(f.ctx, 'POST', `/items/${ID}/cancel`)).toMatchObject({
        status: 200,
        json: { state: 'canceled' },
      });
      const after = (await f.ctx.runtime.store.readTask(f.anchor))!.task;
      expect(after.closedAt).toBe(f.original.createdAt);
      expect(after.activeRunId).toBeUndefined();
      expect(after.delivery).toEqual(before);
      expect((await f.ctx.runtime.store.readRun(f.runId))!.state).toBe(
        'canceled',
      );
      expect(
        await f.ctx.runtime.orchestrator.observeDelivery(
          f.original.runId,
          {
            kind: 'merged',
            head: before!.head,
            mergeCommit: 'b'.repeat(40),
          },
          () => true,
        ),
      ).toMatchObject({ refused: true, reason: 'task-closed' });
      expect(
        (await f.ctx.runtime.store.readRun(f.original.runId))!.result,
      ).toEqual(f.result);
      expect((await call(f.ctx, 'POST', `/items/${ID}/cancel`)).status).toBe(
        409,
      );
    },
  );
  it('refuses native cancellation without current operator scope and retains recovery', async () => {
    const f = await recovery('correction');
    expect(
      (
        await call(
          { ...f.ctx, principal: readerOnly },
          'POST',
          `/items/${ID}/cancel`,
        )
      ).status,
    ).toBe(401);
    expect(
      (await f.ctx.runtime.store.readTask(f.anchor))!.task.activeRunId,
    ).toBe(f.runId);
    expect(
      (await f.ctx.runtime.store.readTask(f.anchor))!.task.closedAt,
    ).toBeUndefined();
  });
});

describe('shared repository authority', () => {
  it('refuses native admission to another repository before creating a task', async () => {
    const ctx = context({
      principal: { ...githubActionsOperator, sourceRepository: 'octo/foreign' },
    });
    const result = await call(ctx, 'PUT', `/items/${ID}`, { spec });
    expect(result.status).toBe(403);
    expect(await ctx.runtime.store.readTask({ workId: ID })).toBeUndefined();
  });

  it('applies the same restriction to stored reads, writes and paginated lists', async () => {
    const ctx = context();
    expect((await call(ctx, 'PUT', `/items/${ID}`, { spec })).status).toBe(201);
    const before = await ctx.runtime.store.readTask({ workId: ID });
    ctx.principal = {
      ...githubActionsOperator,
      sourceRepository: 'octo/foreign',
    };
    for (const [method, suffix, body] of [
      ['GET', '', undefined],
      ['POST', '/cancel', undefined],
      ['PATCH', '', { title: 'changed', description: 'changed' }],
      ['POST', '/redispatch', undefined],
      ['POST', '/reply', { text: 'continue', requestId: 'denied' }],
    ] as const) {
      expect(
        (await call(ctx, method, `/items/${ID}${suffix}`, body)).status,
      ).toBe(403);
    }
    for (const filter of ['', '&state=running', '&state=done']) {
      const listed = await call(ctx, 'GET', `/items?limit=1${filter}`);
      expect(listed.status).toBe(200);
      expect(listed.json.items).toEqual([]);
      expect(listed.json.nextCursor).toBe(ID);
    }
    expect(await ctx.runtime.store.readTask({ workId: ID })).toEqual(before);
    ctx.principal = {
      ...githubActionsOperator,
      sourceRepository: 'JLAPENNA/AGENT-LCARS',
    };
    expect((await call(ctx, 'GET', `/items/${ID}`)).status).toBe(200);
  });
});

const codingPipelines = ['claude', 'codex', 'opencode', 'agy'] as const;
it.each([
  ['pending', 'goose', codingPipelines],
  ['parked', 'goose', codingPipelines],
  ['pending', 'claude', codingPipelines],
  ['parked', 'claude', codingPipelines],
  ['pending', 'claude', ['goose']],
  ['parked', 'claude', ['goose']],
] as const)(
  'requires Jobs and execution grants to cancel a %s repository job on %s with %j',
  async (state, pipeline, pipelines) => {
    const ctx = context({
      principal: {
        ...operator,
        principal: 'svc:work-reader',
        subject: 'work-reader@agent-lcars.iam.gserviceaccount.com',
        via: 'google',
        pipelines,
      },
    });
    await ctx.runtime.orchestrator.request({
      taskId: { workId: ID },
      requestId: 'recipe-1',
      pipeline,
      params: { jobOccurrence: 'a'.repeat(64) },
      work: {
        origin: { principal: githubActionsOperator.principal, channel: 'api' },
        spec: {
          ...spec,
          pipeline,
          priority: 'background',
          ...(pipeline === 'goose' ? { jobOccurrence: 'a'.repeat(64) } : {}),
        },
      },
    });
    const runId = `work:${ID}/r1`;
    if (state === 'parked') {
      await ctx.runtime.orchestrator.report(runId, {
        ok: true,
        summary: 'park',
      });
    }

    const item = await ctx.runtime.store.readTask({ workId: ID });
    const run = await ctx.runtime.store.readRun(runId);
    expect((await call(ctx, 'POST', `/items/${ID}/cancel`)).status).toBe(403);
    expect(await ctx.runtime.store.readTask({ workId: ID })).toEqual(item);
    expect(await ctx.runtime.store.readRun(runId)).toEqual(run);

    ctx.principal = {
      ...githubActionsOperator,
      pipelines: pipeline === 'goose' ? ['goose'] : ['goose', pipeline],
    };
    expect(await call(ctx, 'POST', `/items/${ID}/cancel`)).toMatchObject({
      status: 200,
      json: { state: 'canceled' },
    });
  },
);

it('lets a repository-bound caller read its Goose occurrence through the shared item API', async () => {
  const ctx = context({
    principal: { ...githubActionsOperator, pipelines: ['goose'] },
  });
  await ctx.runtime.orchestrator.request({
    taskId: { workId: ID },
    requestId: 'recipe-1',
    pipeline: 'goose',
    work: {
      origin: { principal: githubActionsOperator.principal, channel: 'api' },
      spec: {
        ...spec,
        pipeline: 'goose',
        priority: 'background',
        jobOccurrence: 'a'.repeat(64),
      },
    },
  });
  expect((await call(ctx, 'GET', `/items/${ID}`)).status).toBe(200);
  expect((await call(ctx, 'GET', '/items')).json.items).toHaveLength(1);
  ctx.principal = {
    ...githubActionsOperator,
    pipelines: ['goose'],
    sourceRepository: 'octo/foreign',
  };
  expect((await call(ctx, 'GET', `/items/${ID}`)).status).toBe(403);
  expect((await call(ctx, 'GET', '/items')).json.items).toEqual([]);
});

describe('item listing reads', () => {
  it('reads the listed items’ runs in one batch, not a query per item', async () => {
    const ctx = context();
    for (const id of [
      '01J5Z3K9QX8F0N2B4V6C8D1E3A',
      '01J5Z3K9QX8F0N2B4V6C8D1E3B',
      '01J5Z3K9QX8F0N2B4V6C8D1E3C',
    ])
      expect((await call(ctx, 'PUT', `/items/${id}`, { spec })).status).toBe(
        201,
      );
    const perTask = vi.spyOn(ctx.runtime.store, 'listRuns');
    const batched = vi.spyOn(ctx.runtime.store, 'listRunsForTasks');

    const listed = await call(ctx, 'GET', '/items');

    expect(listed.status).toBe(200);
    expect(listed.json.items).toHaveLength(3);
    expect(batched).toHaveBeenCalledOnce();
    expect(perTask).not.toHaveBeenCalled();
  });
});
