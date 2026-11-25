import type { Run } from '@agent-lcars/orchestrator';
import type { CliSessionDoc, SessionDoc } from '@agent-lcars/telemetry';
import { agentEventDeliverySchema } from '@agent-lcars/work';
import { describe, expect, it, vi } from 'vitest';

import { routeAgentEvent } from './agent-event-routing';
import { MemoryAgentEventSubscriptionStore } from './agent-event-store';
import {
  type AgentEventsContext,
  agentEventSubscriptionId,
  createAgentEventsHandler,
  deliveryHost,
  MAX_SUBSCRIPTIONS_PER_SESSION,
  MAX_SUBSCRIPTIONS_PER_WORK,
  sessionEventId,
  sessionLiveOnHost,
  sessionReportedByHost,
} from './agent-event-subscriptions-router';
import { hashRunToken } from './run-token';
import type { WorkPrincipal } from './work-auth';

const NOW = new Date('2026-11-25T12:00:00.000Z');
const handler = createAgentEventsHandler();

function deliveryPrincipal(host: string): WorkPrincipal {
  return {
    principal: `svc:agent-events-${host}`,
    subject: `agent-events-${host}@agent-lcars.iam.gserviceaccount.com`,
    scopes: new Set(['events.deliver']),
    pipelines: ['goose'],
    via: 'google',
  };
}

function cliSession(
  sessionId: string,
  overrides: Partial<CliSessionDoc> = {},
): CliSessionDoc {
  return {
    sessionId,
    source: 'cli',
    host: 'pike',
    liveness: 'live',
    agent: 'claude-code',
    startedAt: '2026-11-25T11:00:00.000Z',
    lastActivityAt: '2026-11-25T11:59:00.000Z',
    turns: 3,
    toolCallCounts: {},
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    deliverables: {},
    ...overrides,
  } as CliSessionDoc;
}

function context(
  overrides: Partial<AgentEventsContext> & {
    sessions?: SessionDoc[];
  } = {},
): AgentEventsContext & { store: MemoryAgentEventSubscriptionStore } {
  const sessions = new Map(
    (overrides.sessions ?? [cliSession('session-a')]).map((doc) => [
      doc.sessionId,
      doc,
    ]),
  );
  return {
    githubRepositories: ['jlapenna/homelab', 'jlapenna/agent-lcars'],
    principal: deliveryPrincipal('pike'),
    store: new MemoryAgentEventSubscriptionStore(),
    readRun: async () => undefined,
    getSessionDoc: async (id) => sessions.get(id),
    now: () => NOW,
    ...overrides,
  } as AgentEventsContext & { store: MemoryAgentEventSubscriptionStore };
}

async function call(
  ctx: AgentEventsContext,
  method: string,
  path: string,
  body?: unknown,
) {
  const { matched, response } = await handler.handle(
    new Request(`https://lcars.test/api/work/v1${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    }),
    { prefix: '/api/work/v1', context: ctx },
  );
  expect(matched).toBe(true);
  return {
    status: response?.status,
    json: (await response?.json()) as Record<string, unknown>,
  };
}

const subscribe = (ctx: AgentEventsContext, body: Record<string, unknown>) =>
  call(ctx, 'POST', '/events/subscriptions', body);

describe('deliveryHost', () => {
  it('reads the host from a verified delivery service account', () => {
    expect(
      deliveryHost({
        subject: 'agent-events-pike@agent-lcars.iam.gserviceaccount.com',
        via: 'google',
      }),
    ).toBe('pike');
  });

  it.each([
    [
      'another service account',
      'work-reader@agent-lcars.iam.gserviceaccount.com',
      'google',
    ],
    ['a non-service-account email', 'agent-events-pike@example.com', 'google'],
    ['a session login', 'github:agent-events-pike', 'session'],
    [
      'a delivery email reached without a Google token',
      'agent-events-pike@agent-lcars.iam.gserviceaccount.com',
      'oidc',
    ],
  ] as const)('refuses %s', (_label, subject, via) => {
    expect(deliveryHost({ subject, via })).toBeUndefined();
  });
});

describe('sessionLiveOnHost', () => {
  it('accepts a live or idle CLI session reported by the host', () => {
    expect(sessionLiveOnHost(cliSession('a'), 'pike', NOW)).toBe(true);
    expect(
      sessionLiveOnHost(cliSession('a', { liveness: 'idle' }), 'pike', NOW),
    ).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['on another host', cliSession('a', { host: 'laforge' })],
    ['without a host', cliSession('a', { host: undefined })],
    ['ended', cliSession('a', { liveness: 'ended' })],
    ['stale', cliSession('a', { liveness: 'stale' })],
    [
      'quiet for hours with no observation',
      cliSession('a', { lastActivityAt: '2026-11-25T09:00:00.000Z' }),
    ],
    [
      'a dispatched run',
      { ...cliSession('a'), source: 'issue-agent' } as unknown as SessionDoc,
    ],
  ])('refuses a session that is %s', (_label, doc) => {
    expect(sessionLiveOnHost(doc, 'pike', NOW)).toBe(false);
  });
});

describe('POST /events/subscriptions', () => {
  it.each([
    { key: 'github:pr:outside/upstream#1' },
    { key: 'github:run:outside/upstream/42' },
    { key: 'github:issue:outside/upstream#1' },
    { key: 'outline:doc:12345678-1234-1234-1234-123456789abc' },
    { key: 'github:pr:jlapenna/homelab#3827', kinds: ['behind'] },
    { key: 'github:pr:jlapenna/homelab#3827', until: 'conflict' },
  ])('refuses a registration without a producer: %j', async (request) => {
    const ctx = context();
    const { status } = await subscribe(ctx, {
      sessionId: 'session-a',
      ...request,
    });
    expect(status).toBe(403);
    expect(await ctx.store.countForSession('session-a')).toBe(0);
  });

  it('reuses a pre-rollout default subscription without freezing its kinds', async () => {
    const ctx = context();
    const legacy = {
      key: 'github:pr:jlapenna/homelab#3827',
      source: 'github:pr' as const,
      target: {
        type: 'session' as const,
        sessionId: 'session-a',
        host: 'pike',
      },
      until: 'merged',
      createdAt: NOW.toISOString(),
    };
    const id = agentEventSubscriptionId(legacy);
    await ctx.store.create({ ...legacy, id });
    const result = await subscribe(ctx, {
      sessionId: 'session-a',
      key: legacy.key,
      until: 'merged',
    });
    expect(result.status).toBe(201);
    expect(result.json['id']).toBe(id);
    expect(result.json['kinds']).toBeUndefined();
    expect(await ctx.store.countForSession('session-a')).toBe(1);
  });

  it('subscribes a live session on the calling host', async () => {
    const ctx = context();
    const { status, json } = await subscribe(ctx, {
      sessionId: 'session-a',
      key: 'github:pr:JLapenna/Homelab#3827',
      kinds: ['review', 'merged'],
      until: 'merged',
    });
    expect(status).toBe(201);
    const target = { type: 'session', sessionId: 'session-a', host: 'pike' };
    expect(json).toEqual({
      id: agentEventSubscriptionId({
        key: 'github:pr:jlapenna/homelab#3827',
        kinds: ['review', 'merged'],
        until: 'merged',
        target: target as never,
      }),
      key: 'github:pr:jlapenna/homelab#3827',
      source: 'github:pr',
      kinds: ['review', 'merged'],
      until: 'merged',
      target,
      createdAt: NOW.toISOString(),
    });
    expect(ctx.store.documents.size).toBe(1);
  });

  it('returns the existing subscription for a repeated request', async () => {
    const ctx = context();
    const body = { sessionId: 'session-a', key: 'lcars:session:other' };
    const first = await subscribe(ctx, body);
    const later = context({
      store: ctx.store,
      now: () => new Date(NOW.getTime() + 60_000),
    });
    const second = await subscribe(later, body);
    expect(second.status).toBe(201);
    expect(second.json).toEqual(first.json);
    expect(ctx.store.documents.size).toBe(1);
  });

  it('takes the host from the identity, never the body', async () => {
    const ctx = context();
    const { status } = await subscribe(ctx, {
      sessionId: 'session-a',
      key: 'lcars:session:other',
      host: 'laforge',
    });
    expect(status).toBe(400);
    expect(ctx.store.documents.size).toBe(0);
  });

  it('refuses a session another host reports, with no hint that it exists', async () => {
    const ctx = context({
      principal: deliveryPrincipal('laforge'),
    });
    const { status, json } = await subscribe(ctx, {
      sessionId: 'session-a',
      key: 'lcars:session:other',
    });
    expect(status).toBe(403);
    expect(json['message']).toBe(
      'Session session-a is not a live session reported by laforge',
    );
    const missing = await subscribe(ctx, {
      sessionId: 'session-missing',
      key: 'lcars:session:other',
    });
    expect(missing.status).toBe(403);
    expect(ctx.store.documents.size).toBe(0);
  });

  it('refuses an ended session', async () => {
    const ctx = context({
      sessions: [cliSession('session-a', { liveness: 'ended' })],
    });
    const { status } = await subscribe(ctx, {
      sessionId: 'session-a',
      key: 'lcars:session:other',
    });
    expect(status).toBe(403);
  });

  it.each([
    [{ key: 'nope' }, 'not a key of the form'],
    [{ key: 'lcars:session:other', kinds: ['merged'] }, 'has no kind merged'],
    [
      { key: 'lcars:session:other', kinds: ['idle'], until: 'ended' },
      'is not one of the subscribed kinds',
    ],
  ])('refuses a malformed request %j', async (request, message) => {
    const ctx = context();
    const { status, json } = await subscribe(ctx, {
      sessionId: 'session-a',
      ...request,
    });
    expect(status).toBe(400);
    expect(String(json['message'])).toContain(message);
  });

  it('leaves Work targets to a dispatched run with its run token', async () => {
    const ctx = context();
    for (const extra of [
      { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G' },
      { runId: 'work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1' },
    ]) {
      const { status, json } = await subscribe(ctx, {
        sessionId: 'session-a',
        key: 'lcars:session:other',
        ...extra,
      });
      expect(status).toBe(400);
      expect(json['message']).toBe(
        'Work targets are subscribed by a dispatched run with its run token; subscribe a session with sessionId',
      );
    }
  });

  it('requires a sessionId', async () => {
    const { status, json } = await subscribe(context(), {
      key: 'lcars:session:other',
    });
    expect(status).toBe(400);
    expect(json['message']).toBe('sessionId is required');
  });

  it('caps subscriptions per session', async () => {
    const ctx = context();
    for (let n = 0; n < MAX_SUBSCRIPTIONS_PER_SESSION; n++)
      expect(
        (
          await subscribe(ctx, {
            sessionId: 'session-a',
            key: `lcars:session:other-${n}`,
          })
        ).status,
      ).toBe(201);
    const { status } = await subscribe(ctx, {
      sessionId: 'session-a',
      key: 'lcars:session:one-too-many',
    });
    expect(status).toBe(409);
    // A repeat of an existing subscription is still answered.
    expect(
      (
        await subscribe(ctx, {
          sessionId: 'session-a',
          key: 'lcars:session:other-0',
        })
      ).status,
    ).toBe(201);
  });
});

describe('authorization', () => {
  const operator: WorkPrincipal = {
    principal: 'user:jlapenna',
    subject: 'github:jlapenna',
    scopes: new Set(['work.operator', 'secrets.admin', 'work.claw.admit']),
    pipelines: ['claude'],
    via: 'session',
  };
  const misconfigured: WorkPrincipal = {
    ...deliveryPrincipal('pike'),
    subject: 'work-reader@agent-lcars.iam.gserviceaccount.com',
  };

  it.each([
    ['no principal', undefined],
    ['a Work operator', operator],
    ['events.deliver granted to a non-delivery identity', misconfigured],
  ])('answers 401 to %s before reading anything', async (_label, principal) => {
    const reads: string[] = [];
    const ctx = context({
      getSessionDoc: async (id) => {
        reads.push(id);
        return cliSession(id);
      },
    });
    if (principal === undefined) delete ctx.principal;
    else ctx.principal = principal;
    for (const [method, path, body] of [
      ['POST', '/events/subscriptions', { sessionId: 'session-a', key: 'x' }],
      ['GET', '/events/subscriptions', undefined],
      ['DELETE', '/events/subscriptions/abc', undefined],
    ] as const)
      expect((await call(ctx, method, path, body)).status).toBe(401);
    expect(reads).toEqual([]);
  });
});

describe('GET and DELETE /events/subscriptions', () => {
  async function seeded() {
    const store = new MemoryAgentEventSubscriptionStore();
    const sessions = [
      cliSession('session-a'),
      cliSession('session-b'),
      cliSession('session-c', { host: 'laforge' }),
    ];
    const pike = context({ store, sessions });
    const laforge = context({
      store,
      sessions,
      principal: deliveryPrincipal('laforge'),
    });
    const a = await subscribe(pike, {
      sessionId: 'session-a',
      key: 'lcars:session:x',
    });
    const b = await subscribe(pike, {
      sessionId: 'session-b',
      key: 'lcars:session:x',
    });
    const c = await subscribe(laforge, {
      sessionId: 'session-c',
      key: 'lcars:session:x',
    });
    return {
      store,
      pike,
      laforge,
      ids: [a, b, c].map(({ json }) => String(json['id'])),
    };
  }

  it("lists only the calling host's subscriptions, optionally one session's", async () => {
    const { pike, ids } = await seeded();
    const all = await call(pike, 'GET', '/events/subscriptions');
    expect(all.status).toBe(200);
    expect(
      (all.json['subscriptions'] as { id: string }[]).map(({ id }) => id),
    ).toEqual([ids[0], ids[1]].sort());
    const one = await call(
      pike,
      'GET',
      '/events/subscriptions?sessionId=session-b',
    );
    expect(
      (one.json['subscriptions'] as { id: string }[]).map(({ id }) => id),
    ).toEqual([ids[1]]);
  });

  it("deletes the calling host's subscription and hides another host's", async () => {
    const { store, pike, ids } = await seeded();
    const other = await call(pike, 'DELETE', `/events/subscriptions/${ids[2]}`);
    expect(other.status).toBe(404);
    expect(store.documents.has(ids[2]!)).toBe(true);

    const own = await call(pike, 'DELETE', `/events/subscriptions/${ids[0]}`);
    expect(own).toEqual({
      status: 200,
      json: { id: ids[0], deleted: true },
    });
    expect(store.documents.has(ids[0]!)).toBe(false);
    expect(
      (await call(pike, 'DELETE', `/events/subscriptions/${ids[0]}`)).status,
    ).toBe(404);
  });
});

describe('a dispatched run subscribing its Work (#3570)', () => {
  const WORK_ID = '01J5Z3K9QX8F0N2B4V6C8D1E3G';
  const OTHER_WORK = '01J5Z3K9QX8F0N2B4V6C8D1E3H';
  const RUN_ID = `work:${WORK_ID}/r1`;
  const TOKEN = 'run-token-1';

  function run(overrides: Partial<Run> = {}): Run {
    return {
      runId: RUN_ID,
      task: { workId: WORK_ID },
      state: 'running',
      pipeline: 'claude',
      priority: 'normal',
      requestId: 'req-1',
      requestSource: 'caller',
      params: { mode: 'implement' },
      queue: {
        state: 'claimed',
        claimedAt: '2026-11-25T11:50:00.000Z',
        tokenHash: hashRunToken(TOKEN),
      },
      leaseExpiresAt: '2026-11-25T13:00:00.000Z',
      events: [],
      createdAt: '2026-11-25T11:50:00.000Z',
      updatedAt: '2026-11-25T11:50:00.000Z',
      ...overrides,
    };
  }

  function runContext(runs: Run[] = [run()], token = TOKEN) {
    const byId = new Map(runs.map((r) => [r.runId, r]));
    const ctx = context({
      bearerToken: token,
      readRun: async (id) => byId.get(id),
    });
    delete ctx.principal;
    return ctx;
  }

  it('subscribes the run’s own Work, idempotently', async () => {
    const ctx = runContext();
    const first = await subscribe(ctx, {
      runId: RUN_ID,
      key: 'github:run:jlapenna/agent-lcars/42',
      until: 'completed',
    });
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({
      key: 'github:run:jlapenna/agent-lcars/42',
      until: 'completed',
      target: { type: 'work', workId: WORK_ID },
    });
    const again = await subscribe(ctx, {
      runId: RUN_ID,
      workId: WORK_ID,
      key: 'github:run:jlapenna/agent-lcars/42',
      until: 'completed',
    });
    expect(again.json['id']).toBe(first.json['id']);
    expect(ctx.store.documents.size).toBe(1);
  });

  it('refuses a run subscribing for another Work', async () => {
    const ctx = runContext();
    const { status, json } = await subscribe(ctx, {
      runId: RUN_ID,
      workId: OTHER_WORK,
      key: 'lcars:session:other',
    });
    expect(status).toBe(403);
    expect(json['message']).toBe('A run may subscribe only its own Work');
    expect(ctx.store.documents.size).toBe(0);
  });

  it.each([
    ['a wrong token', [run()], 'not-the-token'],
    ['a settled run', [run({ state: 'finished' })], TOKEN],
    [
      'an expired lease',
      [run({ leaseExpiresAt: '2026-11-25T11:59:59.000Z' })],
      TOKEN,
    ],
    ['an unknown run', [], TOKEN],
    ['an unclaimed run', [run({ queue: { state: 'queued' } })], TOKEN],
  ] as const)(
    'answers 401 to %s before reading anything else',
    async (_label, runs, token) => {
      const ctx = runContext([...runs], token);
      for (const [method, path, body] of [
        [
          'POST',
          '/events/subscriptions',
          { runId: RUN_ID, key: 'lcars:session:x' },
        ],
        [
          'GET',
          `/events/subscriptions?runId=${encodeURIComponent(RUN_ID)}`,
          undefined,
        ],
        // A DELETE carries its runId in the body, as the oRPC client sends it.
        ['DELETE', '/events/subscriptions/abc', { runId: RUN_ID }],
      ] as const)
        expect((await call(ctx, method, path, body)).status).toBe(401);
      expect(ctx.store.documents.size).toBe(0);
    },
  );

  it('needs the runId the token belongs to', async () => {
    const { status, json } = await subscribe(runContext(), {
      key: 'lcars:session:x',
    });
    expect(status).toBe(401);
    expect(json['message']).toBe(
      'events.deliver scope, or a run token with its runId, required',
    );
  });

  it.each([
    [
      'a run of issue work',
      run({
        runId: 'octo/example#7/r1',
        task: { repo: 'octo/example', issue: 7 },
      }),
      403,
      'Only a run of native Work can subscribe; LCARS already resumes issue and pull-request work on reviews and CI',
    ],
    [
      'a recipe run',
      run({ pipeline: 'goose', params: { mode: 'recipe' } }),
      403,
      'This run’s Work cannot be resumed by an event: only agent runs (claude, codex, opencode, agy) of coding Work can',
    ],
    [
      'a review run',
      run({ params: { mode: 'review' } }),
      403,
      'This run’s Work cannot be resumed by an event: only agent runs (claude, codex, opencode, agy) of coding Work can',
    ],
  ] as const)('refuses %s', async (_label, subscriber, status, message) => {
    const ctx = runContext([subscriber]);
    const result = await subscribe(ctx, {
      runId: subscriber.runId,
      key: 'lcars:session:x',
    });
    expect(result.status).toBe(status);
    expect(result.json['message']).toBe(message);
  });

  it('refuses a session target and the Work’s own state from a run', async () => {
    const ctx = runContext();
    expect(
      (
        await subscribe(ctx, {
          runId: RUN_ID,
          sessionId: 'session-a',
          key: 'lcars:session:x',
        })
      ).json['message'],
    ).toBe('A run subscribes its Work, not a session');
    expect(
      (await subscribe(ctx, { runId: RUN_ID, key: `lcars:work:${WORK_ID}` }))
        .json['message'],
    ).toBe('A Work cannot subscribe to its own state');
  });

  it('caps subscriptions per Work', async () => {
    const ctx = runContext();
    for (let n = 0; n < MAX_SUBSCRIPTIONS_PER_WORK; n++)
      expect(
        (await subscribe(ctx, { runId: RUN_ID, key: `lcars:session:s-${n}` }))
          .status,
      ).toBe(201);
    expect(
      (await subscribe(ctx, { runId: RUN_ID, key: 'lcars:session:too-many' }))
        .status,
    ).toBe(409);
  });

  it('lists and removes only its own Work’s subscriptions', async () => {
    const ctx = runContext();
    const own = await subscribe(ctx, { runId: RUN_ID, key: 'lcars:session:x' });
    const ownId = String(own.json['id']);
    const otherId = agentEventSubscriptionId({
      key: 'lcars:session:x',
      target: { type: 'work', workId: OTHER_WORK },
    });
    await ctx.store.create({
      id: otherId,
      key: 'lcars:session:x',
      source: 'lcars:session',
      target: { type: 'work', workId: OTHER_WORK },
      createdAt: NOW.toISOString(),
    });
    const sessionId = agentEventSubscriptionId({
      key: 'lcars:session:x',
      target: { type: 'session', sessionId: 'session-a', host: 'pike' },
    });
    await ctx.store.create({
      id: sessionId,
      key: 'lcars:session:x',
      source: 'lcars:session',
      target: { type: 'session', sessionId: 'session-a', host: 'pike' },
      createdAt: NOW.toISOString(),
    });
    const q = `runId=${encodeURIComponent(RUN_ID)}`;
    const listed = await call(ctx, 'GET', `/events/subscriptions?${q}`);
    expect(
      (listed.json['subscriptions'] as { id: string }[]).map(({ id }) => id),
    ).toEqual([ownId]);
    for (const id of [otherId, sessionId])
      expect(
        (
          await call(ctx, 'DELETE', `/events/subscriptions/${id}`, {
            runId: RUN_ID,
          })
        ).status,
      ).toBe(404);
    expect(
      (
        await call(ctx, 'DELETE', `/events/subscriptions/${ownId}`, {
          runId: RUN_ID,
        })
      ).json,
    ).toEqual({ id: ownId, deleted: true });

    // A host sees no Work subscriptions and cannot remove one.
    const host = context({ store: ctx.store });
    expect(
      (
        (await call(host, 'GET', '/events/subscriptions')).json[
          'subscriptions'
        ] as { id: string }[]
      ).map(({ id }) => id),
    ).toEqual([sessionId]);
    expect(
      (await call(host, 'DELETE', `/events/subscriptions/${otherId}`)).status,
    ).toBe(404);
  });

  it('may not report session events', async () => {
    const ctx = runContext();
    expect(
      (
        await call(ctx, 'POST', '/events/session', {
          sessionId: 'session-a',
          kind: 'ended',
          occurredAt: '2026-11-25T11:59:30.000Z',
        })
      ).status,
    ).toBe(401);
  });
});

describe('POST /events/session', () => {
  /** A context whose events are routed for real through its own store, to
   * a recording publisher. */
  function routed(overrides: Parameters<typeof context>[0] = {}) {
    const ctx = context({
      sessions: [cliSession('session-a'), cliSession('session-b')],
      ...overrides,
    });
    let n = 0;
    const publish = vi.fn(async () => `message-${++n}`);
    ctx.routeEvent = (event) =>
      routeAgentEvent(event, {
        store: ctx.store,
        publisher: { publish },
        resumeWork: async () => ({ outcome: 'queued' }),
      });
    return { ctx, publish };
  }

  const report = (ctx: AgentEventsContext, body: Record<string, unknown>) =>
    call(ctx, 'POST', '/events/session', body);

  it('routes an ended session to its subscribers once', async () => {
    const { ctx, publish } = routed();
    await subscribe(ctx, {
      sessionId: 'session-b',
      key: 'lcars:session:session-a',
      until: 'ended',
    });
    const body = {
      sessionId: 'session-a',
      kind: 'ended',
      occurredAt: '2026-11-25T11:59:30.000Z',
    };
    const first = await report(ctx, body);
    expect(first).toEqual({
      status: 200,
      json: {
        eventId: 'session.session-a.ended.2026-11-25T11:59:30.000Z',
        delivered: 1,
      },
    });
    const [data, attributes] = publish.mock.calls[0] as unknown as [
      Buffer,
      Record<string, string>,
    ];
    expect(attributes['host']).toBe('pike');
    const delivery = agentEventDeliverySchema.parse(
      JSON.parse(data.toString('utf8')),
    );
    expect(delivery).toMatchObject({
      target: { type: 'session', sessionId: 'session-b', host: 'pike' },
      event: {
        key: 'lcars:session:session-a',
        kind: 'ended',
        occurredAt: '2026-11-25T11:59:30.000Z',
      },
      ended: true,
    });
    // The until kind ended the subscription; a repeat routes nowhere.
    expect(ctx.store.documents.size).toBe(0);
    expect((await report(ctx, body)).json['delivered']).toBe(0);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('accepts an ended report for a session that is no longer live', async () => {
    const { ctx } = routed({
      sessions: [cliSession('session-a', { liveness: 'ended' })],
    });
    expect(
      (
        await report(ctx, {
          sessionId: 'session-a',
          kind: 'ended',
          occurredAt: '2026-11-25T11:59:30.000Z',
        })
      ).status,
    ).toBe(200);
  });

  it('routes idle only for a live session on the host', async () => {
    const live = routed();
    await subscribe(live.ctx, {
      sessionId: 'session-b',
      key: 'lcars:session:session-a',
      kinds: ['idle'],
    });
    const idle = {
      sessionId: 'session-a',
      kind: 'idle',
      occurredAt: '2026-11-25T11:59:50.000Z',
    };
    expect((await report(live.ctx, idle)).json['delivered']).toBe(1);
    // An idle subscription stays for the next one.
    expect(live.ctx.store.documents.size).toBe(1);

    const ended = routed({
      sessions: [cliSession('session-a', { liveness: 'ended' })],
    });
    const refused = await report(ended.ctx, idle);
    expect(refused.status).toBe(403);
    expect(refused.json['message']).toBe(
      'Session session-a is not a live session reported by pike',
    );
  });

  it("refuses another host's session, and a missing one, alike", async () => {
    const { ctx, publish } = routed({
      principal: deliveryPrincipal('laforge'),
    });
    for (const sessionId of ['session-a', 'session-missing']) {
      const { status, json } = await report(ctx, {
        sessionId,
        kind: 'ended',
        occurredAt: '2026-11-25T11:59:30.000Z',
      });
      expect(status).toBe(403);
      expect(json['message']).toBe(
        `Session ${sessionId} is not a session reported by laforge`,
      );
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'started' }],
    [{ occurredAt: 'yesterday' }],
    [{ occurredAt: '2026-11-25T12:10:00.000Z' }],
    [{ host: 'pike' }],
  ])('refuses a malformed report %j', async (change) => {
    const { ctx, publish } = routed();
    const { status } = await report(ctx, {
      sessionId: 'session-a',
      kind: 'ended',
      occurredAt: '2026-11-25T11:59:30.000Z',
      ...change,
    });
    expect(status).toBe(400);
    expect(publish).not.toHaveBeenCalled();
  });

  it('requires a host delivery identity', async () => {
    const { ctx } = routed({
      principal: { ...deliveryPrincipal('pike'), scopes: new Set() },
    });
    expect(
      (
        await report(ctx, {
          sessionId: 'session-a',
          kind: 'ended',
          occurredAt: '2026-11-25T11:59:30.000Z',
        })
      ).status,
    ).toBe(401);
  });
});

describe('session report helpers', () => {
  it('names the host of a CLI session, live or not', () => {
    expect(
      sessionReportedByHost(cliSession('a', { liveness: 'ended' }), 'pike'),
    ).toBe(true);
    expect(sessionReportedByHost(cliSession('a'), 'laforge')).toBe(false);
    expect(sessionReportedByHost(undefined, 'pike')).toBe(false);
  });

  it('derives a valid, stable event id', () => {
    expect(sessionEventId('s', 'idle', '2026-11-25T12:00:00.000Z')).toBe(
      'session.s.idle.2026-11-25T12:00:00.000Z',
    );
  });
});
