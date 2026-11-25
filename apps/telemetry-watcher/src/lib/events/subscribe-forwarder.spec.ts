import { describe, expect, it, vi } from 'vitest';

import {
  IdTokenError,
  serviceAccountIdTokens,
  workApiSubscriptionForwarder,
} from './subscribe-forwarder';

const VIEW = {
  id: '5f0c2a9e7b1d4c3a8e6f0b2d4c6a8e0f',
  key: 'lcars:session:other',
  source: 'lcars:session',
  kinds: ['ended'],
  until: 'ended',
  target: { type: 'session', sessionId: 's1', host: 'pike' },
  createdAt: '2026-11-25T12:00:00.000Z',
};

interface Seen {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

function harness(
  respond: (seen: Seen) => Response | Promise<Response> = () =>
    Response.json(VIEW, { status: 201 }),
  idToken: () => Promise<string> = async () => 'id-token',
) {
  const seen: Seen[] = [];
  const fetchImpl = vi.fn(
    async (input: Request | string | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const text = await request.text();
      const entry = {
        method: request.method,
        url: request.url,
        authorization: request.headers.get('authorization'),
        body: text ? JSON.parse(text) : undefined,
      };
      seen.push(entry);
      return respond(entry);
    },
  );
  const forwarder = workApiSubscriptionForwarder({
    origin: 'https://lcars.test',
    fetch: fetchImpl as unknown as typeof fetch,
    idToken,
  });
  return { forwarder, seen };
}

const orpcError = (status: number, code: string, message: string) =>
  Response.json({ defined: true, code, status, message }, { status });

describe('workApiSubscriptionForwarder', () => {
  it('subscribes through the Work API with the host ID token and no host field', async () => {
    const { forwarder, seen } = harness();
    expect(
      await forwarder.subscribe('s1', {
        key: 'lcars:session:other',
        kinds: ['ended'],
        until: 'ended',
      }),
    ).toEqual({ ok: true, value: VIEW });
    expect(seen).toEqual([
      {
        method: 'POST',
        url: 'https://lcars.test/api/work/v1/events/subscriptions',
        authorization: 'Bearer id-token',
        body: {
          sessionId: 's1',
          key: 'lcars:session:other',
          kinds: ['ended'],
          until: 'ended',
        },
      },
    ]);
  });

  it('lists and unsubscribes', async () => {
    const { forwarder, seen } = harness(({ method }) =>
      method === 'GET'
        ? Response.json({ subscriptions: [VIEW] })
        : Response.json({ id: VIEW.id, deleted: true }),
    );
    expect(await forwarder.list('s1')).toEqual({ ok: true, value: [VIEW] });
    expect(await forwarder.list(undefined)).toEqual({
      ok: true,
      value: [VIEW],
    });
    expect(await forwarder.unsubscribe(VIEW.id)).toEqual({
      ok: true,
      value: { id: VIEW.id },
    });
    expect(seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'GET https://lcars.test/api/work/v1/events/subscriptions?sessionId=s1',
      'GET https://lcars.test/api/work/v1/events/subscriptions',
      `DELETE https://lcars.test/api/work/v1/events/subscriptions/${VIEW.id}`,
    ]);
  });

  it.each([
    [
      orpcError(400, 'BAD_REQUEST', 'malformed lcars:session id: x y'),
      {
        error: 'invalid-request',
        message: 'malformed lcars:session id: x y',
        retryable: false,
      },
    ],
    [
      orpcError(401, 'UNAUTHORIZED', 'events.deliver scope required'),
      { error: 'unauthorized', retryable: false },
    ],
    [
      orpcError(
        403,
        'FORBIDDEN',
        'Session s1 is not a live session reported by pike',
      ),
      {
        error: 'forbidden',
        message:
          'session s1 is not a live session that LCARS telemetry reports on this host (403)',
        retryable: false,
      },
    ],
    [
      // The Work API route's own refusal is not an oRPC error body.
      Response.json({ error: 'forbidden' }, { status: 403 }),
      { error: 'forbidden', retryable: false },
    ],
    [
      orpcError(409, 'CONFLICT', 'Session s1 already has 64 subscriptions'),
      {
        error: 'conflict',
        message: 'Session s1 already has 64 subscriptions',
        retryable: false,
      },
    ],
    [
      orpcError(500, 'INTERNAL_SERVER_ERROR', 'Internal server error'),
      { error: 'unavailable', retryable: true },
    ],
    [
      new Response('bad gateway', { status: 502 }),
      {
        error: 'unavailable',
        message: 'the LCARS console failed (HTTP 502)',
        retryable: true,
      },
    ],
  ] as const)(
    'maps a refusal to a local error (%#)',
    async (response, expected) => {
      const { forwarder } = harness(() => response.clone());
      expect(
        await forwarder.subscribe('s1', { key: 'lcars:session:other' }),
      ).toMatchObject({ ok: false, ...expected });
    },
  );

  it('maps 404 on unsubscribe', async () => {
    const { forwarder } = harness(() =>
      orpcError(404, 'NOT_FOUND', 'Not found'),
    );
    expect(await forwarder.unsubscribe(VIEW.id)).toMatchObject({
      ok: false,
      error: 'not-found',
      message: 'no such subscription on this host',
    });
  });

  it('reports an unreachable console as unavailable', async () => {
    const { forwarder } = harness(() => {
      throw new TypeError('fetch failed');
    });
    expect(await forwarder.list(undefined)).toMatchObject({
      ok: false,
      error: 'unavailable',
      retryable: true,
    });
  });

  it('reports a token that cannot be minted without calling the console', async () => {
    const { forwarder, seen } = harness(undefined, async () => {
      throw new IdTokenError('ENOENT: key file');
    });
    expect(await forwarder.list(undefined)).toMatchObject({
      ok: false,
      error: 'unauthorized',
      message: expect.stringContaining('could not mint an ID token'),
    });
    expect(seen).toEqual([]);
  });
});

describe('serviceAccountIdTokens', () => {
  it('creates one client for the key and audience, and reads its bearer token', async () => {
    const getRequestHeaders = vi.fn(
      async () => new Headers({ authorization: 'Bearer abc.def' }),
    );
    const create = vi.fn(async () => ({ getRequestHeaders }));
    const token = serviceAccountIdTokens('/k.json', 'agent-lcars-work', create);
    expect(await token()).toBe('abc.def');
    expect(await token()).toBe('abc.def');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith('/k.json', 'agent-lcars-work');
  });

  it('wraps a failure and tries a new client next time', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('no key'))
      .mockResolvedValueOnce({
        getRequestHeaders: async () => new Headers(),
      });
    const token = serviceAccountIdTokens('/k.json', 'aud', create);
    await expect(token()).rejects.toThrow(IdTokenError);
    await expect(token()).rejects.toThrow('no ID token');
    expect(create).toHaveBeenCalledTimes(2);
  });
});
