import type { CliSessionDoc, SessionDoc } from '@agent-lcars/telemetry';
import { describe, expect, it } from 'vitest';

import { MemoryAgentEventSubscriptionStore } from './agent-event-store';
import {
  type AgentEventsContext,
  agentEventSubscriptionId,
  createAgentEventsHandler,
  deliveryHost,
  MAX_SUBSCRIPTIONS_PER_SESSION,
  sessionLiveOnHost,
} from './agent-event-subscriptions-router';
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
    principal: deliveryPrincipal('pike'),
    store: new MemoryAgentEventSubscriptionStore(),
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

  it('refuses a Work target clearly until #3570', async () => {
    const ctx = context();
    const { status, json } = await subscribe(ctx, {
      workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
      key: 'lcars:session:other',
    });
    expect(status).toBe(400);
    expect(json['message']).toBe(
      'Work targets are not supported yet (#3570); subscribe a session with sessionId',
    );
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
