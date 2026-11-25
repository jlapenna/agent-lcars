import { ORPCError } from '@orpc/client';
import { describe, expect, it, vi } from 'vitest';

import type { LocalCallResult, LocalRequest } from './events/local-protocol';
import {
  executeSessionEventsCommand,
  sessionEventsUsage,
} from './session-events-command';

const VIEW = {
  id: '5f0c2a9e7b1d4c3a8e6f0b2d4c6a8e0f',
  key: 'lcars:session:other',
  source: 'lcars:session' as const,
  kinds: ['ended'],
  until: 'ended',
  target: { type: 'session' as const, sessionId: 's1', host: 'pike' },
  createdAt: '2026-11-25T12:00:00.000Z',
};

const ENV = {
  CLAUDE_CODE_SESSION_ID: 's1',
  XDG_RUNTIME_DIR: '/run/user/1000',
};

function run(
  argv: string[],
  answer: LocalCallResult = {
    ok: true,
    response: { ok: true, subscription: VIEW },
  },
  env: NodeJS.ProcessEnv = ENV,
) {
  const out: string[] = [];
  const err: string[] = [];
  const call = vi.fn(async (_socket: string, _request: LocalRequest) => answer);
  const exit = executeSessionEventsCommand(argv, {
    env,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    call,
  });
  return {
    exit,
    out: () => out.join('\n'),
    err: () => err.join('\n'),
    call,
  };
}

describe('lcars session subscribe', () => {
  it('sends a validated subscription for the calling session', async () => {
    const r = run([
      'subscribe',
      'lcars:session:other',
      '--kinds',
      'ended, idle',
      '--until',
      'ended',
    ]);
    expect(await r.exit).toBe(0);
    expect(r.call).toHaveBeenCalledWith(
      '/run/user/1000/agent-lcars/events.sock',
      {
        version: 1,
        op: 'subscribe',
        sessionId: 's1',
        key: 'lcars:session:other',
        kinds: ['ended', 'idle'],
        until: 'ended',
      },
    );
    expect(r.out()).toContain(`Subscribed ${VIEW.id} to lcars:session:other`);
    expect(r.out()).toContain('Notices arrive in this terminal');
    expect(r.out()).toContain(`lcars session unsubscribe ${VIEW.id}`);
  });

  it('normalizes a GitHub key and prints JSON on request', async () => {
    const r = run(['subscribe', 'github:pr:JLapenna/Homelab#3827', '--json']);
    expect(await r.exit).toBe(0);
    expect(r.call.mock.calls[0][1]).toMatchObject({
      key: 'github:pr:jlapenna/homelab#3827',
    });
    expect(JSON.parse(r.out())).toEqual(VIEW);
  });

  it.each([
    [['subscribe', 'nope'], 'not a key'],
    [
      ['subscribe', 'lcars:session:x', '--kinds', 'merged'],
      'has no kind merged',
    ],
    [
      ['subscribe', 'lcars:session:x', '--kinds', 'idle', '--until', 'ended'],
      'is not one of the subscribed kinds',
    ],
  ])('refuses %j locally with exit 2', async (argv, message) => {
    const r = run(argv);
    expect(await r.exit).toBe(2);
    expect(r.err()).toContain(message);
    expect(r.call).not.toHaveBeenCalled();
  });

  it.each([
    [['subscribe']],
    [['subscribe', 'a', 'b']],
    [['subscribe', 'lcars:session:x', '--all']],
    [['subscribe', 'lcars:session:x', '--bogus']],
    [['subscribe', 'lcars:session:x', '--kinds', ',']],
    [['unsubscribe']],
    [['subscriptions', 'extra']],
    [['other']],
  ])('prints usage for %j', async (argv) => {
    const r = run(argv);
    expect(await r.exit).toBe(2);
    expect(r.err()).toContain('Usage:');
    expect(r.call).not.toHaveBeenCalled();
  });

  it('needs a session id', async () => {
    const r = run(['subscribe', 'lcars:session:x'], undefined, {
      XDG_RUNTIME_DIR: '/run/user/1000',
    });
    expect(await r.exit).toBe(1);
    expect(r.err()).toContain('no session id');
  });

  it('explains an agent that is not running or not configured', async () => {
    const notRunning = run(['subscribe', 'lcars:session:x'], {
      ok: false,
      reason: 'not-running',
    });
    expect(await notRunning.exit).toBe(1);
    expect(notRunning.err()).toContain(
      'the LCARS events agent is not running on this host',
    );

    const notConfigured = run(['subscribe', 'lcars:session:x'], {
      ok: true,
      response: { ok: false, error: 'not-configured', message: 'x' },
    });
    expect(await notConfigured.exit).toBe(1);
    expect(notConfigured.err()).toContain('is not configured');
    expect(notConfigured.err()).toContain('events-key.json');
  });

  it('explains a session LCARS does not see on this host', async () => {
    const r = run(['subscribe', 'lcars:session:x'], {
      ok: true,
      response: {
        ok: false,
        error: 'forbidden',
        message:
          'session s1 is not a live session that LCARS telemetry reports on this host (403)',
      },
    });
    expect(await r.exit).toBe(1);
    expect(r.err()).toContain('session s1 is not a live session');
    expect(r.err()).toContain('lcars hook is installed');
  });
});

describe('lcars session subscriptions', () => {
  const listed: LocalCallResult = {
    ok: true,
    response: { ok: true, subscriptions: [VIEW] },
  };

  it("lists this session's subscriptions", async () => {
    const r = run(['subscriptions'], listed);
    expect(await r.exit).toBe(0);
    expect(r.call.mock.calls[0][1]).toEqual({
      version: 1,
      op: 'list',
      sessionId: 's1',
    });
    expect(r.out()).toBe(
      `${VIEW.id}  lcars:session:other  kinds=ended  until=ended  session=s1  since 2026-11-25T12:00:00.000Z`,
    );
  });

  it('lists the whole host with --all, without a session, as JSON', async () => {
    const r = run(['subscriptions', '--all', '--json'], listed, {
      XDG_RUNTIME_DIR: '/run/user/1000',
    });
    expect(await r.exit).toBe(0);
    expect(r.call.mock.calls[0][1]).toEqual({ version: 1, op: 'list' });
    expect(JSON.parse(r.out())).toEqual({ subscriptions: [VIEW] });
  });

  it('says when there are none', async () => {
    const r = run(['subscriptions'], {
      ok: true,
      response: { ok: true, subscriptions: [] },
    });
    expect(await r.exit).toBe(0);
    expect(r.out()).toBe('No subscriptions.');
  });
});

describe('lcars session unsubscribe', () => {
  it('removes one by id', async () => {
    const r = run(['unsubscribe', VIEW.id], {
      ok: true,
      response: { ok: true, deleted: VIEW.id },
    });
    expect(await r.exit).toBe(0);
    expect(r.call.mock.calls[0][1]).toEqual({
      version: 1,
      op: 'unsubscribe',
      id: VIEW.id,
    });
    expect(r.out()).toBe(`Unsubscribed ${VIEW.id}`);
  });

  it('refuses a malformed id and reports a missing one', async () => {
    const bad = run(['unsubscribe', '../etc']);
    expect(await bad.exit).toBe(2);
    expect(bad.call).not.toHaveBeenCalled();

    const missing = run(['unsubscribe', VIEW.id, '--json'], {
      ok: true,
      response: {
        ok: false,
        error: 'not-found',
        message: 'no such subscription on this host',
      },
    });
    expect(await missing.exit).toBe(1);
    expect(missing.err()).toContain('no such subscription on this host');
  });
});

describe('help', () => {
  it('explains keys, kinds, --until and what a notice looks like', async () => {
    const r = run(['subscribe', '--help']);
    expect(await r.exit).toBe(0);
    const help = r.out();
    expect(help).toBe(sessionEventsUsage());
    expect(help).toContain('lcars:session:<session-id>');
    expect(help).toContain('idle, ended; ends on ended');
    expect(help).toContain('github:pr:<owner>/<repo>#<number>');
    expect(help).toContain('--until <kind>');
    expect(help).toContain(
      '[lcars-event] github:pr:jlapenna/homelab#3827 review by jlapenna',
    );
    expect(help).toContain('when the session is idle');
  });
});

describe('inside a dispatched run (#3570)', () => {
  const RUN_ENV = {
    // A run also carries a provider session id; the run token wins.
    CLAUDE_CODE_SESSION_ID: 's1',
    LCARS_RUN_ID: 'work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1',
    LCARS_RUN_TOKEN: 'run-token-1',
    LCARS_CONSOLE_URL: 'https://lcars.test',
  };
  const WORK_VIEW = {
    ...VIEW,
    key: 'github:run:jlapenna/agent-lcars/42',
    source: 'github:run' as const,
    kinds: undefined,
    until: 'completed',
    target: { type: 'work' as const, workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G' },
  };

  function inRun(argv: string[], status: number, body: unknown) {
    const out: string[] = [];
    const err: string[] = [];
    const call = vi.fn();
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const exit = executeSessionEventsCommand(argv, {
      env: RUN_ENV,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      call,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    return {
      exit,
      out: () => out.join('\n'),
      err: () => err.join('\n'),
      call,
      request: async () => {
        const [input, init] = fetchImpl.mock.calls[0]!;
        const request = new Request(input, init);
        return {
          method: request.method,
          url: request.url,
          authorization: request.headers.get('authorization'),
          body: request.method === 'GET' ? undefined : await request.json(),
        };
      },
    };
  }

  it('subscribes the run’s Work through LCARS with the run token, not the delivery agent', async () => {
    const r = inRun(
      [
        'subscribe',
        'github:run:jlapenna/agent-lcars/42',
        '--until',
        'completed',
      ],
      201,
      WORK_VIEW,
    );
    expect(await r.exit).toBe(0);
    expect(r.call).not.toHaveBeenCalled();
    expect(await r.request()).toEqual({
      method: 'POST',
      url: 'https://lcars.test/api/work/v1/events/subscriptions',
      authorization: 'Bearer run-token-1',
      body: {
        runId: RUN_ENV.LCARS_RUN_ID,
        key: 'github:run:jlapenna/agent-lcars/42',
        until: 'completed',
      },
    });
    expect(r.out()).toContain(
      `Subscribed ${VIEW.id} to github:run:jlapenna/agent-lcars/42 for Work 01J5Z3K9QX8F0N2B4V6C8D1E3G`,
    );
    expect(r.out()).toContain('end your turn with the waiting deliverable');
  });

  it('lists and removes the Work’s subscriptions', async () => {
    const listed = inRun(['subscriptions'], 200, {
      subscriptions: [WORK_VIEW],
    });
    expect(await listed.exit).toBe(0);
    expect(await listed.request()).toMatchObject({
      method: 'GET',
      url: `https://lcars.test/api/work/v1/events/subscriptions?runId=${encodeURIComponent(RUN_ENV.LCARS_RUN_ID)}`,
    });
    expect(listed.out()).toContain('work=01J5Z3K9QX8F0N2B4V6C8D1E3G');

    const removed = inRun(['unsubscribe', VIEW.id], 200, {
      id: VIEW.id,
      deleted: true,
    });
    expect(await removed.exit).toBe(0);
    expect(await removed.request()).toMatchObject({
      method: 'DELETE',
      url: `https://lcars.test/api/work/v1/events/subscriptions/${VIEW.id}`,
      body: { runId: RUN_ENV.LCARS_RUN_ID },
    });
    expect(removed.out()).toBe(`Unsubscribed ${VIEW.id}`);
  });

  it('reports a refusal from LCARS', async () => {
    const forbidden = inRun(
      ['subscribe', 'lcars:session:x'],
      403,
      new ORPCError('FORBIDDEN', {
        message: 'A run may subscribe only its own Work',
      }).toJSON(),
    );
    expect(await forbidden.exit).toBe(1);
    expect(forbidden.err()).toContain('A run may subscribe only its own Work');

    const expired = inRun(
      ['subscriptions'],
      401,
      new ORPCError('UNAUTHORIZED', {
        message: 'Invalid or expired run token',
      }).toJSON(),
    );
    expect(await expired.exit).toBe(1);
    expect(expired.err()).toContain('the run may have ended');
  });

  it('refuses --all in a run', async () => {
    const r = inRun(['subscriptions', '--all'], 200, { subscriptions: [] });
    expect(await r.exit).toBe(2);
  });
});
