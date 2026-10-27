import { describe, expect, it, vi } from 'vitest';

import { executeWorkCommand, type WorkCommandDeps } from './work-command';

function deps(
  routes: Record<string, (init: RequestInit & { url: string }) => unknown>,
): WorkCommandDeps & { calls: string[]; out: string[]; err: string[] } {
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let sleeps = 0;
  return {
    calls,
    out,
    err,
    origin: 'https://lcars.test',
    token: async () => 'tok',
    now: () => new Date('2026-08-26T10:00:00.000Z'),
    sleep: vi.fn(async () => {
      // Bound a broken watch loop so regression failures remain diagnosable.
      if (++sleeps > 3) throw new Error('unexpected additional watch sleep');
    }),
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`;
      calls.push(key);
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer tok',
      );
      expect(new Headers(init?.headers).has('cookie')).toBe(false);
      const route =
        routes[key] ?? routes[key.replace(/\/[0-9A-Z]{26}/u, '/{id}')];
      if (!route) return new Response('nf', { status: 404 });
      return new Response(JSON.stringify(route({ ...init, url })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  };
}
const item = (state: string) => ({
  id: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
  state,
  spec: {
    title: 't',
    description: 'd',
    pipeline: 'claude',
    target: { repo: 'o/r' },
  },
  origin: { principal: 'user:x', channel: 'api' },
  createdAt: 't',
  updatedAt: 't',
  runs: [],
  sessions: [],
});

describe('lcars work', () => {
  describe('owner', () => {
    const owner = {
      anchor: { repo: 'jlapenna/agent-lcars', issue: 2502 },
      observedAt: '2026-08-26T10:00:00.000Z',
      verdict: 'fleet-run',
      complete: true,
      warnings: [],
      task: {
        state: 'running',
        pipeline: 'claude',
        runCount: 2,
        activeRunId: 'jlapenna/agent-lcars#2502/r2',
        updatedAt: '2026-08-26T09:59:00.000Z',
        run: {
          runId: 'jlapenna/agent-lcars#2502/r2',
          state: 'running',
          pipeline: 'claude',
          priority: 'normal',
          createdAt: '2026-08-26T09:00:00.000Z',
          updatedAt: '2026-08-26T09:59:00.000Z',
          queue: { state: 'claimed', claimedBy: 'lcars-direct-1' },
        },
        runSessions: [
          {
            sessionId: 'worker-1',
            runId: 'jlapenna/agent-lcars#2502/r2',
            startedAt: '2026-08-26T09:01:00.000Z',
            lastActivityAt: '2026-08-26T09:58:00.000Z',
          },
        ],
      },
      cliSessions: [
        {
          sessionId: 'cli-1',
          agent: 'claude-code',
          liveness: 'idle',
          host: 'laforge',
          branch: 'feat/issue-owner-query-2502',
          pr: { number: 2560, url: 'https://github.com/x/pull/2560' },
          startedAt: '2026-08-26T08:00:00.000Z',
          lastActivityAt: '2026-08-26T09:30:00.000Z',
        },
      ],
    };

    it('reads the anchor once and prints the verdict with its evidence', async () => {
      let query = '';
      const d = deps({
        'GET /api/work/v1/anchors/github/owner': (init) => {
          query = new URL(init.url).search;
          return owner;
        },
      });
      expect(
        await executeWorkCommand(['owner', 'jlapenna/agent-lcars#2502'], d),
      ).toEqual({ ok: true });
      expect(d.calls).toEqual(['GET /api/work/v1/anchors/github/owner']);
      expect(new URLSearchParams(query).get('repo')).toBe(
        'jlapenna/agent-lcars',
      );
      expect(new URLSearchParams(query).get('issue')).toBe('2502');
      expect(d.out).toEqual([
        'jlapenna/agent-lcars#2502  fleet-run',
        '  task     running  claude  runs 2  updated 2026-08-26T09:59:00.000Z',
        '  live run jlapenna/agent-lcars#2502/r2  running  claude  claimed by lcars-direct-1  updated 2026-08-26T09:59:00.000Z',
        '  worker   worker-1  last activity 2026-08-26T09:58:00.000Z',
        '  session  cli-1  idle  claude-code  laforge  branch feat/issue-owner-query-2502  PR #2560  last activity 2026-08-26T09:30:00.000Z',
      ]);
    });

    it('prints JSON for scripts and names an anchor Console never saw', async () => {
      const none = {
        ...owner,
        verdict: 'none',
        task: undefined,
        cliSessions: [],
      };
      const d = deps({ 'GET /api/work/v1/anchors/github/owner': () => none });
      expect(
        await executeWorkCommand(
          ['owner', '--json', 'jlapenna/agent-lcars#2502'],
          d,
        ),
      ).toEqual({ ok: true });
      expect(JSON.parse(d.out[0] ?? '')).toMatchObject({ verdict: 'none' });

      const human = deps({
        'GET /api/work/v1/anchors/github/owner': () => none,
      });
      await executeWorkCommand(['owner', 'jlapenna/agent-lcars#2502'], human);
      expect(human.out).toEqual([
        'jlapenna/agent-lcars#2502  none',
        '  task     none (Console has never dispatched this anchor)',
        '  session  none referencing this anchor',
      ]);
    });

    it('exits 1 with the warning when session telemetry was unavailable', async () => {
      const d = deps({
        'GET /api/work/v1/anchors/github/owner': () => ({
          ...owner,
          verdict: 'none',
          task: undefined,
          cliSessions: [],
          complete: false,
          warnings: [
            'CLI sessions unavailable (agent-telemetry store failed).',
          ],
        }),
      });
      expect(
        await executeWorkCommand(['owner', 'jlapenna/agent-lcars#2502'], d),
      ).toEqual({ ok: false });
      expect(d.out[0]).toBe('jlapenna/agent-lcars#2502  none  (incomplete)');
      expect(d.err).toEqual([
        'warning: CLI sessions unavailable (agent-telemetry store failed).',
      ]);
    });

    it.each([
      [[]],
      [['jlapenna/agent-lcars']],
      [['2502']],
      [['jlapenna/agent-lcars#0']],
      [['jlapenna/agent-lcars#2502', 'extra']],
      [['jlapenna/agent-lcars#2502', '--watch']],
    ])('rejects %j before authenticating', async (args) => {
      const d = deps({});
      d.token = vi.fn(async () => {
        throw new Error('Must not request credentials');
      });
      expect((await executeWorkCommand(['owner', ...args], d)).ok).toBe(false);
      expect(d.calls).toEqual([]);
      expect(d.token).not.toHaveBeenCalled();
    });
  });

  it.each([true, false])(
    'exports a bounded metrics snapshot and fails closed when complete=%s',
    async (complete) => {
      const prometheus = `# TYPE lcars_product_snapshot_complete gauge\nlcars_product_snapshot_complete ${complete ? 1 : 0}\n`;
      const d = deps({
        'GET /api/work/v1/metrics/lifecycle': () => ({
          observedAt: '2026-08-26T10:00:00.000Z',
          windowSeconds: 3600,
          complete,
          prometheus,
        }),
      });
      expect(await executeWorkCommand(['metrics'], d)).toEqual({
        ok: complete,
      });
      expect(d.calls).toEqual(['GET /api/work/v1/metrics/lifecycle']);
      expect(d.out).toEqual([prometheus.trimEnd()]);
      expect(d.err.length).toBe(complete ? 0 : 1);
    },
  );
  it('supports JSON metrics and rejects unrecognized flags before authentication', async () => {
    const snapshot = {
      observedAt: '2026-08-26T10:00:00.000Z',
      windowSeconds: 3600,
      complete: true,
      prometheus: 'lcars_product_snapshot_complete 1\n',
    };
    const d = deps({ 'GET /api/work/v1/metrics/lifecycle': () => snapshot });
    expect(await executeWorkCommand(['metrics', '--json'], d)).toEqual({
      ok: true,
    });
    expect(JSON.parse(d.out[0] ?? '')).toEqual(snapshot);
    const invalid = deps({});
    invalid.token = vi.fn(async () => {
      throw new Error('Must not request credentials');
    });
    expect(
      (await executeWorkCommand(['metrics', '--unsafe'], invalid)).ok,
    ).toBe(false);
    expect(invalid.calls).toEqual([]);
    expect(invalid.token).not.toHaveBeenCalled();
  });
  it('sends explicit ordered alternatives and supports disabling them per redispatch', async () => {
    const d = deps({
      'PUT /api/work/v1/items/{id}': (init) => {
        expect(JSON.parse(String(init.body)).spec.fallbackPipelines).toEqual([
          'opencode',
          'codex',
        ]);
        return item('running');
      },
      'POST /api/work/v1/items/{id}/redispatch': (init) => {
        expect(JSON.parse(String(init.body)).fallbackPipelines).toEqual([]);
        return item('running');
      },
    });
    expect(
      await executeWorkCommand(
        [
          'create',
          '--repo',
          'o/r',
          '--pipeline',
          'claude',
          '--title',
          't',
          '--description',
          'd',
          '--fallback-pipelines',
          'opencode,codex',
        ],
        d,
      ),
    ).toEqual({ ok: true });
    expect(
      await executeWorkCommand(
        ['redispatch', item('running').id, '--fallback-pipelines', 'none'],
        d,
      ),
    ).toEqual({ ok: true });
  });
  it.each(['codex,codex', 'unknown'])(
    'rejects invalid fallback choices %s without a request',
    async (choices) => {
      const d = deps({});
      expect(
        await executeWorkCommand(
          ['redispatch', item('running').id, '--fallback-pipelines', choices],
          d,
        ),
      ).toEqual({ ok: false });
      expect(d.calls).toEqual([]);
    },
  );
  describe('reply', () => {
    const id = item('parked').id;
    const replyUrl = `POST /api/work/v1/items/${id}/reply`;

    it.each([true, false])(
      'sends a bounded authenticated reply and prints the admitted run (resumed=%s)',
      async (resumed) => {
        const d = deps({
          [replyUrl]: (init) => {
            expect(JSON.parse(String(init.body))).toEqual({
              text: 'Continue with the selected design.',
              pipeline: 'codex',
              requestId: 'operator-turn-2',
              resume: false,
            });
            return {
              ...item('running'),
              admittedRunId: 'r2',
              resumed,
              runs: [
                {
                  runId: 'r3',
                  state: 'running',
                  pipeline: 'codex',
                  createdAt: 't',
                  updatedAt: 't',
                },
              ],
            };
          },
        });
        expect(
          await executeWorkCommand(
            [
              'reply',
              id,
              '--text',
              'Continue with the selected design.',
              '--pipeline',
              'codex',
              '--request-id',
              'operator-turn-2',
              '--fresh',
            ],
            d,
          ),
        ).toEqual({ ok: true });
        expect(d.calls).toEqual([replyUrl]);
        expect(d.out).toEqual([
          `admitted r2  ${resumed ? 'resume requested' : 'fresh session requested'}  request "operator-turn-2"`,
        ]);
        expect(d.err.join('\n')).toContain('reuse --request-id');
      },
    );

    it('reads a real UTF-8 file and generates a retry key before HTTP', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'lcars-reply-'));
      try {
        const file = join(dir, 'reply.txt');
        const text = 'Continue.\nKeep the Unicode: 🖖';
        writeFileSync(file, text);
        const d = deps({
          [replyUrl]: (init) => {
            const body = JSON.parse(String(init.body));
            expect(body.text).toBe(text);
            expect(body.requestId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
            expect(body).not.toHaveProperty('pipeline');
            expect(body).not.toHaveProperty('resume');
            expect(d.err.join('\n')).toContain(body.requestId);
            return { ...item('running'), admittedRunId: 'r2', resumed: true };
          },
        });
        expect(
          await executeWorkCommand(['reply', id, '--text-file', file], d),
        ).toEqual({ ok: true });
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    it.each([
      ['reply', id],
      ['reply', 'bad-id', '--text', 'hi'],
      ['reply', id, '--text', ''],
      ['reply', id, '--text', 'x'.repeat(WORK_DESCRIPTION_MAX + 1)],
      ['reply', id, '--text', 'hi', '--text-file', '/unused'],
      ['reply', id, '--text', 'hi', '--pipeline', 'invalid'],
      ['reply', id, '--text', 'hi', '--request-id', ''],
      ['reply', id, '--text', 'hi', '--request-id', 'x'.repeat(129)],
      ['reply', id, '--text', 'hi', '--text', 'changed'],
      ['reply', id, '--text', 'hi', '--unknown'],
      ['reply', id, '--text'],
      ['reply', id, 'extra', '--text', 'hi'],
    ])('rejects invalid input before HTTP (case %$)', async (...args) => {
      const d = deps({});
      expect((await executeWorkCommand(args, d)).ok).toBe(false);
      expect(d.calls).toEqual([]);
      expect(d.out).toEqual([]);
      expect(d.err.length).toBeGreaterThan(0);
    });

    it('rejects oversized files, non-files and invalid UTF-8 without sending a request', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'lcars-reply-bounds-'));
      try {
        const file = join(dir, 'reply.txt');
        for (const bytes of [
          Buffer.alloc(WORK_DESCRIPTION_MAX * 4 + 1, 120),
          Buffer.from([0xff]),
        ]) {
          writeFileSync(file, bytes);
          const d = deps({});
          expect(
            (await executeWorkCommand(['reply', id, '--text-file', file], d))
              .ok,
          ).toBe(false);
          expect(d.calls).toEqual([]);
        }
        const d = deps({});
        expect(
          (await executeWorkCommand(['reply', id, '--text-file', dir], d)).ok,
        ).toBe(false);
        expect(d.calls).toEqual([]);
        expect(d.err.join('\n')).toContain('regular file');
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    it.each([
      [401, 'UNAUTHORIZED', 'unauthorized'],
      [403, 'FORBIDDEN', 'pipeline not permitted'],
      [409, 'CONFLICT', 'task-busy'],
    ])(
      'fails HTTP %s without cookie fallback or retry',
      async (status, code, message) => {
        const d = deps({});
        d.fetchImpl = vi.fn(async (_input, init) => {
          expect(new Headers(init?.headers).get('authorization')).toBe(
            'Bearer tok',
          );
          expect(new Headers(init?.headers).has('cookie')).toBe(false);
          return Response.json(
            { defined: true, code, message },
            { status: Number(status) },
          );
        });
        expect(
          await executeWorkCommand(
            ['reply', id, '--text', 'hi', '--request-id', 'retry-me'],
            d,
          ),
        ).toEqual({ ok: false });
        expect(d.fetchImpl).toHaveBeenCalledTimes(1);
        expect(d.err.join('\n')).toContain(message);
        expect(d.err.join('\n')).toContain(
          Number(status) === 409
            ? 'check work status'
            : 'check the bearer identity',
        );
        expect(d.out).toEqual([]);
      },
    );

    it('retains the generated request identity when the response is lost', async () => {
      const d = deps({
        [replyUrl]: (init) => {
          const body = JSON.parse(String(init.body));
          expect(d.err.join('\n')).toContain(body.requestId);
          throw new Error('connection lost');
        },
      });
      expect(
        (await executeWorkCommand(['reply', id, '--text', 'hi'], d)).ok,
      ).toBe(false);
      expect(d.err.join('\n')).toContain('connection lost');
      expect(d.calls).toEqual([replyUrl]);
      expect(d.out).toEqual([]);
    });
  });
  it.each(['urgent', 'normal', 'background', undefined])(
    'create sends validated priority %s',
    async (priority) => {
      const d = deps({
        'PUT /api/work/v1/items/{id}': ({ body }) => {
          expect(JSON.parse(body as string).spec.priority).toBe(
            priority ?? 'normal',
          );
          return item('running');
        },
      });
      const args = [
        'create',
        '--repo',
        'o/r',
        '--pipeline',
        'claude',
        '--title',
        't',
        '--description',
        'd',
      ];
      if (priority) args.push('--priority', priority);
      expect(await executeWorkCommand(args, d)).toEqual({ ok: true });
      expect(d.calls).toHaveLength(1);
    },
  );
  it.each([
    ['--priority', 'invalid'],
    ['--priority'],
    ['--priority', '--title', 't'],
  ])(
    'rejects invalid priority before credentials or HTTP: %j',
    async (...flags) => {
      const d = deps({});
      d.token = vi.fn(async () => 'tok');
      const result = await executeWorkCommand(
        [
          'create',
          '--repo',
          'o/r',
          '--pipeline',
          'claude',
          '--title',
          't',
          '--description',
          'd',
          ...flags,
        ],
        d,
      );
      expect(result.ok).toBe(false);
      expect(result.usage).toContain('urgent|normal|background');
      expect(d.token).not.toHaveBeenCalled();
      expect(d.calls).toEqual([]);
    },
  );
  it('create PUTs a client-generated ULID and prints it', async () => {
    const d = deps({ 'PUT /api/work/v1/items/{id}': () => item('running') });
    const r = await executeWorkCommand(
      [
        'create',
        '--repo',
        'o/r',
        '--pipeline',
        'claude',
        '--title',
        't',
        '--description',
        'd',
      ],
      d,
    );
    expect(r.ok).toBe(true);
    expect(d.calls[0]).toMatch(
      /^PUT \/api\/work\/v1\/items\/[0-9A-HJKMNP-TV-Z]{26}$/u,
    );
    expect(d.out.join('\n')).toMatch(/running/);
  });
  it('create --deliverable report opts the item into a report result', async () => {
    let spec: unknown;
    const d = deps({
      'PUT /api/work/v1/items/{id}': (init) => {
        spec = JSON.parse(String(init.body)).spec;
        return item('running');
      },
    });
    const create = [
      'create',
      '--repo',
      'o/r',
      '--pipeline',
      'claude',
      '--title',
      't',
      '--description',
      'd',
    ];
    expect(
      (await executeWorkCommand([...create, '--deliverable', 'report'], d)).ok,
    ).toBe(true);
    expect(spec).toMatchObject({ deliverable: 'report' });
    const refused = await executeWorkCommand(
      [...create, '--deliverable', 'pr'],
      d,
    );
    expect(refused.ok).toBe(false);
    expect(d.calls).toHaveLength(1);
  });
  it.each(['done', 'parked', 'failed', 'canceled'])(
    'status --watch stops when running work becomes %s',
    async (state) => {
      let n = 0;
      const d = deps({
        'GET /api/work/v1/items/{id}': () =>
          item(n++ === 0 ? 'running' : state),
      });
      const r = await executeWorkCommand(
        ['status', item(state).id, '--watch'],
        d,
      );
      expect(r).toEqual({ ok: state !== 'failed' });
      expect(d.calls).toEqual(
        Array(2).fill(`GET /api/work/v1/items/${item(state).id}`),
      );
      expect(d.sleep).toHaveBeenCalledExactlyOnceWith(15_000);
      expect(d.out).toHaveLength(2);
      expect(d.out.at(-1)).toContain(state);
      expect(d.err).toEqual([]);
    },
  );
  it.each(['done', 'parked', 'failed', 'canceled'])(
    'status --watch stops immediately for initially %s work',
    async (state) => {
      const d = deps({ 'GET /api/work/v1/items/{id}': () => item(state) });
      const r = await executeWorkCommand(
        ['status', item(state).id, '--watch'],
        d,
      );
      expect(r).toEqual({ ok: state !== 'failed' });
      expect(d.calls).toEqual([`GET /api/work/v1/items/${item(state).id}`]);
      expect(d.sleep).not.toHaveBeenCalled();
      expect(d.out).toHaveLength(1);
      expect(d.out[0]).toContain(state);
    },
  );
  it('reports failed status without watch as unsuccessful', async () => {
    const d = deps({ 'GET /api/work/v1/items/{id}': () => item('failed') });
    expect(await executeWorkCommand(['status', item('failed').id], d)).toEqual({
      ok: false,
    });
    expect(d.calls).toHaveLength(1);
    expect(d.sleep).not.toHaveBeenCalled();
    expect(d.out[0]).toContain('failed');
  });
  it('keeps watching a lost run awaiting retry and the replacement run', async () => {
    let n = 0;
    const d = deps({
      'GET /api/work/v1/items/{id}': () => ({
        ...item(n < 2 ? 'running' : 'done'),
        runs: [
          {
            runId: n === 0 ? 'r1' : 'r2',
            state: ['lost', 'running', 'finished'][n++],
            pipeline: 'claude',
            createdAt: 't',
            updatedAt: 't',
          },
        ],
      }),
    });
    expect(
      await executeWorkCommand(['status', item('running').id, '--watch'], d),
    ).toEqual({ ok: true });
    expect(d.calls).toEqual(
      Array(3).fill(`GET /api/work/v1/items/${item('running').id}`),
    );
    expect(d.sleep).toHaveBeenCalledTimes(2);
    expect(d.sleep).toHaveBeenNthCalledWith(1, 15_000);
    expect(d.sleep).toHaveBeenNthCalledWith(2, 15_000);
    expect(d.out.at(-1)).toContain('done');
  });
  it.each(['running', 'done', 'parked', 'failed', 'canceled'])(
    'list accepts the %s state filter and sends it to the API',
    async (state) => {
      const d = deps({
        'GET /api/work/v1/items': ({ url }) => {
          expect(new URL(url).searchParams.get('state')).toBe(state);
          return { items: [item(state)] };
        },
      });
      expect(await executeWorkCommand(['list', '--state', state], d)).toEqual({
        ok: true,
      });
      expect(d.calls).toEqual(['GET /api/work/v1/items']);
      expect(d.out[0]).toContain(state);
    },
  );
  it.each([['--state', 'lost'], ['--state'], ['--state', '--repo', 'o/r']])(
    'rejects an invalid or missing list state before HTTP: %j',
    async (...args) => {
      const d = deps({});
      const r = await executeWorkCommand(['list', ...args], d);
      expect(r.ok).toBe(false);
      expect(r.usage).toContain('running|done|parked|failed|canceled');
      expect(d.calls).toEqual([]);
      expect(d.err).toHaveLength(1);
    },
  );
  it('prints usage for an unknown subcommand', async () => {
    const d = deps({});
    const r = await executeWorkCommand(['bogus'], d);
    expect(r.ok).toBe(false);
    expect(r.usage).toMatch(/usage: work/);
    // Usage is a CLI error and belongs on stderr, not stdout.
    expect(d.err.join('\n')).toMatch(/usage: work/);
    expect(d.out).toEqual([]);
  });
  it('treats a flag with no value (the next token is another flag) as absent', async () => {
    const d = deps({ 'PUT /api/work/v1/items/{id}': () => item('running') });
    const r = await executeWorkCommand(
      [
        'create',
        '--repo',
        'o/r',
        '--pipeline',
        'claude',
        '--title',
        '--description',
        'd',
      ],
      d,
    );
    expect(r.ok).toBe(false);
    expect(r.usage).toMatch(/usage: work/);
    expect(d.calls).toEqual([]);
  });
  it('routes a request failure to stderr as an error: line', async () => {
    const d = deps({
      'PUT /api/work/v1/items/{id}': () => {
        throw new Error('boom');
      },
    });
    const r = await executeWorkCommand(
      [
        'create',
        '--repo',
        'o/r',
        '--pipeline',
        'claude',
        '--title',
        't',
        '--description',
        'd',
      ],
      d,
    );
    expect(r.ok).toBe(false);
    expect(d.err.join('\n')).toMatch(/^error: /);
    expect(d.out).toEqual([]);
  });
});
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WORK_DESCRIPTION_MAX } from '@agent-lcars/work';

describe('canceled CLI delivery presentation', () => {
  it.each(['waiting'] as const)(
    'canceled CLI commands retain canceled state with %s history',
    async (deliveryState) => {
      const value = {
        ...item('canceled'),
        runs: [
          {
            runId: 'work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1',
            state: 'finished',
            pipeline: 'claude',
            createdAt: 't',
            updatedAt: 't',
            delivery: {
              runId: 'work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1',
              repo: 'o/r',
              number: 12,
              baseRef: 'main',
              head: 'a'.repeat(40),
              state: deliveryState,
              observedAt: 't',
            },
          },
        ],
      };
      const d = deps({
        'POST /api/work/v1/items/{id}/cancel': () => value,
        'GET /api/work/v1/items/{id}': () => value,
        'GET /api/work/v1/items': ({ url }) => {
          expect(new URL(url).searchParams.get('state')).toBe('canceled');
          return { items: [value] };
        },
      });
      for (const args of [
        ['cancel', value.id],
        ['status', value.id],
        ['status', value.id, '--watch'],
        ['list', '--state', 'canceled'],
      ])
        expect(await executeWorkCommand(args, d)).toEqual({ ok: true });
      expect(d.out).toHaveLength(4);
      for (const output of d.out) {
        expect(output).toContain('canceled');
        expect(output).not.toContain('delivery:');
      }
      expect(d.sleep).not.toHaveBeenCalled();
    },
  );
  it('keeps a pending delivery label while the authoritative item is running', async () => {
    const value = {
      ...item('running'),
      runs: [{ delivery: { state: 'waiting' } }],
    };
    const d = deps({ 'GET /api/work/v1/items/{id}': () => value });
    expect(await executeWorkCommand(['status', value.id], d)).toEqual({
      ok: true,
    });
    expect(d.out[0]).toContain('delivery:waiting');
  });
});
