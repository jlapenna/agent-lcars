import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AgentEventSubscriptionView } from '@agent-lcars/work';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  callEventsAgent,
  eventsSocketPath,
  type LocalResponse,
} from './local-protocol';
import {
  type EventsSocketServer,
  handleLocalRequest,
  serveEventsSocket,
} from './local-socket-server';
import type { SubscriptionForwarder } from './subscribe-forwarder';

const VIEW: AgentEventSubscriptionView = {
  id: '5f0c2a9e7b1d4c3a8e6f0b2d4c6a8e0f',
  key: 'lcars:session:other',
  source: 'lcars:session',
  kinds: ['ended'],
  until: 'ended',
  target: { type: 'session', sessionId: 's1', host: 'pike' },
  createdAt: '2026-11-25T12:00:00.000Z',
};

function forwarder(
  overrides: Partial<SubscriptionForwarder> = {},
): SubscriptionForwarder {
  return {
    subscribe: vi.fn(async () => ({ ok: true as const, value: VIEW })),
    list: vi.fn(async () => ({ ok: true as const, value: [VIEW] })),
    unsubscribe: vi.fn(async (id: string) => ({
      ok: true as const,
      value: { id },
    })),
    reportSession: vi.fn(async () => ({
      ok: true as const,
      value: { eventId: 'e', delivered: 0 },
    })),
    ...overrides,
  };
}

describe('eventsSocketPath', () => {
  it('prefers LCARS_EVENTS_SOCKET, then XDG_RUNTIME_DIR, then /run/user', () => {
    expect(eventsSocketPath({ LCARS_EVENTS_SOCKET: '/x.sock' }, 1000)).toBe(
      '/x.sock',
    );
    expect(eventsSocketPath({ XDG_RUNTIME_DIR: '/run/user/7' }, 1000)).toBe(
      '/run/user/7/agent-lcars/events.sock',
    );
    expect(eventsSocketPath({}, 1000, (dir) => dir === '/run/user/1000')).toBe(
      '/run/user/1000/agent-lcars/events.sock',
    );
    expect(eventsSocketPath({}, 1000, () => false)).toBeUndefined();
    expect(eventsSocketPath({}, null)).toBeUndefined();
  });
});

describe('handleLocalRequest', () => {
  it('refuses a malformed request, and one that names a host', async () => {
    const f = forwarder();
    for (const raw of [
      'text',
      { version: 2, op: 'list' },
      { version: 1, op: 'list', sessionId: 's1', host: 'pike' },
      { version: 1, op: 'subscribe', sessionId: 's1', key: 'x', host: 'p' },
      { version: 1, op: 'unsubscribe', id: '../x' },
    ]) {
      expect((await handleLocalRequest(raw, f)).response).toMatchObject({
        ok: false,
        error: 'invalid-request',
      });
    }
    expect(f.subscribe).not.toHaveBeenCalled();
  });

  it('validates a subscription against its source before forwarding', async () => {
    const f = forwarder();
    const { response } = await handleLocalRequest(
      {
        version: 1,
        op: 'subscribe',
        sessionId: 's1',
        key: 'lcars:session:other',
        kinds: ['merged'],
      },
      f,
    );
    expect(response).toEqual({
      ok: false,
      error: 'invalid-request',
      message: 'lcars:session has no kind merged; its kinds are idle, ended',
    });
    expect(f.subscribe).not.toHaveBeenCalled();
  });

  it('says not-configured without a forwarder', async () => {
    const { request, response } = await handleLocalRequest(
      { version: 1, op: 'unsubscribe', id: VIEW.id },
      undefined,
    );
    expect(request?.op).toBe('unsubscribe');
    expect(response).toMatchObject({ ok: false, error: 'not-configured' });
  });

  it('forwards each op and passes refusals through', async () => {
    const f = forwarder({
      unsubscribe: vi.fn(async () => ({
        ok: false as const,
        error: 'not-found' as const,
        message: 'no such subscription on this host',
        retryable: false,
      })),
    });
    expect(
      (
        await handleLocalRequest(
          {
            version: 1,
            op: 'subscribe',
            sessionId: 's1',
            key: VIEW.key,
            kinds: ['ended'],
            until: 'ended',
          },
          f,
        )
      ).response,
    ).toEqual({ ok: true, subscription: VIEW });
    expect(f.subscribe).toHaveBeenCalledWith('s1', {
      key: VIEW.key,
      kinds: ['ended'],
      until: 'ended',
    });
    expect(
      (await handleLocalRequest({ version: 1, op: 'list' }, f)).response,
    ).toEqual({ ok: true, subscriptions: [VIEW] });
    expect(f.list).toHaveBeenCalledWith(undefined);
    expect(
      (
        await handleLocalRequest(
          { version: 1, op: 'unsubscribe', id: 'abc' },
          f,
        )
      ).response,
    ).toEqual({
      ok: false,
      error: 'not-found',
      message: 'no such subscription on this host',
    });
  });
});

describe('serveEventsSocket and callEventsAgent', () => {
  let root: string;
  let socketPath: string;
  let server: EventsSocketServer | undefined;
  const log = vi.fn();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-sock-'));
    socketPath = path.join(root, 'agent-lcars', 'events.sock');
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const echo = async (raw: unknown): Promise<LocalResponse> =>
    (await handleLocalRequest(raw, forwarder())).response;

  it('round-trips a request on a socket only this user can open', async () => {
    server = await serveEventsSocket(socketPath, echo, log);
    expect(fs.statSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(
      await callEventsAgent(socketPath, {
        version: 1,
        op: 'list',
        sessionId: 's1',
      }),
    ).toEqual({ ok: true, response: { ok: true, subscriptions: [VIEW] } });
  });

  it('tightens a directory others could enter', async () => {
    fs.mkdirSync(path.dirname(socketPath), { mode: 0o755 });
    fs.chmodSync(path.dirname(socketPath), 0o755);
    server = await serveEventsSocket(socketPath, echo, log);
    expect(fs.statSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700);
  });

  it('replaces a stale socket but never a live one or another file', async () => {
    // A socket file nothing listens on, as a crashed agent leaves it.
    fs.mkdirSync(path.dirname(socketPath), { mode: 0o700 });
    const stale = net.createServer();
    await new Promise<void>((resolve) => stale.listen(socketPath, resolve));
    // Keep the file past the server's own cleanup with a second link.
    const kept = `${socketPath}.kept`;
    fs.linkSync(socketPath, kept);
    await new Promise<void>((resolve) => stale.close(() => resolve()));
    fs.renameSync(kept, socketPath);
    expect(fs.lstatSync(socketPath).isSocket()).toBe(true);

    server = await serveEventsSocket(socketPath, echo, log);
    await expect(serveEventsSocket(socketPath, echo, log)).rejects.toThrow(
      'another events agent is listening',
    );
    await server.close();
    server = undefined;

    fs.writeFileSync(socketPath, 'not a socket');
    await expect(serveEventsSocket(socketPath, echo, log)).rejects.toThrow(
      'is not a socket',
    );
  });

  it('answers a request that is not JSON, and one that is too large', async () => {
    server = await serveEventsSocket(socketPath, echo, log);
    const raw = (payload: string) =>
      new Promise<string>((resolve) => {
        let answer = '';
        const socket = net.connect(socketPath, () => socket.write(payload));
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => (answer += chunk));
        socket.on('close', () => resolve(answer));
        socket.on('error', () => resolve(answer));
      });
    expect(JSON.parse(await raw('nope\n'))).toMatchObject({
      ok: false,
      error: 'invalid-request',
      message: 'request is not JSON',
    });
    expect(JSON.parse(await raw('x'.repeat(70 * 1024)))).toMatchObject({
      ok: false,
      message: 'request too large',
    });
  });

  it('answers unavailable when the handler crashes', async () => {
    server = await serveEventsSocket(
      socketPath,
      async () => {
        throw new Error('boom');
      },
      log,
    );
    expect(
      await callEventsAgent(socketPath, { version: 1, op: 'list' }),
    ).toMatchObject({
      ok: true,
      response: { ok: false, error: 'unavailable' },
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'local request crashed' }),
    );
  });

  it('reports an agent that is not running', async () => {
    expect(
      await callEventsAgent(socketPath, { version: 1, op: 'list' }),
    ).toEqual({ ok: false, reason: 'not-running' });
  });

  it('refuses a socket another user owns, or a file that is not one', async () => {
    server = await serveEventsSocket(socketPath, echo, log);
    const uid = process.getuid?.() ?? 0;
    expect(
      await callEventsAgent(
        socketPath,
        { version: 1, op: 'list' },
        { uid: uid + 1 },
      ),
    ).toEqual({ ok: false, reason: 'unsafe-socket' });
    const file = path.join(root, 'plain');
    fs.writeFileSync(file, '');
    expect(await callEventsAgent(file, { version: 1, op: 'list' })).toEqual({
      ok: false,
      reason: 'unsafe-socket',
    });
  });

  it('times out and rejects answers that are not responses', async () => {
    fs.mkdirSync(path.dirname(socketPath), { mode: 0o700 });
    let reply: string | undefined;
    const fake = net.createServer((socket) => {
      socket.on('data', () => {
        if (reply !== undefined) socket.end(reply);
      });
    });
    await new Promise<void>((resolve) => fake.listen(socketPath, resolve));
    try {
      expect(
        await callEventsAgent(
          socketPath,
          { version: 1, op: 'list' },
          { timeoutMs: 50 },
        ),
      ).toEqual({ ok: false, reason: 'timeout' });
      reply = '{"ok":true,"something":1}\n';
      expect(
        await callEventsAgent(socketPath, { version: 1, op: 'list' }),
      ).toEqual({ ok: false, reason: 'bad-response' });
    } finally {
      await new Promise<void>((resolve) => fake.close(() => resolve()));
    }
  });
});
