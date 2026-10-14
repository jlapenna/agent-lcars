import { createServer } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  executeInvestigateCommand,
  type InvestigateCommandDeps,
} from './investigate-command';

const runId = 'o/r#7/r2';
const args = [
  '--request-id',
  'owned-request',
  '--question',
  'Which unit?',
  '--context',
  'observed metadata',
];
const auth = {
  version: 1,
  runId,
  repository: 'o/r',
  anchor: { repo: 'o/r', issue: 7 },
  issueUrl: 'https://github.com/o/r/issues/7',
  verifiedAt: '2026-10-14T09:00:00Z',
  validUntil: '2026-10-14T09:05:00Z',
  worker: null,
};
const answer = {
  version: 1,
  runId,
  requestId: 'owned-request',
  investigationId: '00000000-0000-4000-8000-000000000001',
  findings: [
    {
      finding: 'unit inactive',
      confidence: 1,
      evidence: [
        {
          id: 'probe-1',
          ts: '2026-10-14T09:00:01Z',
          host: 'declared-host',
          probe: 'declared-probe',
          exit: 3,
          truncated: false,
          audit_delivery: { journal: 'retained', loki: 'accepted' },
          excerpt: 'inactive',
        },
      ],
    },
  ],
  confidence: 1,
  could_not_answer: [],
  audit_delivery: { journal: 'retained', loki: 'unknown' },
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
function fixture() {
  const out: string[] = [],
    err: string[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const f = {
    out,
    err,
    calls,
    tick: 0,
    introspection: () => json(auth),
    gateway: () => json(answer),
  };
  const deps: InvestigateCommandDeps = {
    env: { LCARS_RUN_ID: runId, LCARS_RUN_TOKEN: 'owned-bearer' },
    readFile: vi.fn(async () => 'e30.e30.signature'),
    monotonic: () => f.tick,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    fetchImpl: vi.fn(async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return calls.length === 1 ? f.introspection() : f.gateway();
    }) as typeof fetch,
  };
  return { ...f, deps, state: f };
}
afterEach(() => vi.useRealTimers());
describe('lcars investigate', () => {
  it('uses the existing run token, fixed origins and canonical issue URL', async () => {
    const f = fixture();
    expect(await executeInvestigateCommand(args, f.deps)).toEqual({ ok: true });
    expect(f.calls.map((c) => c.url)).toEqual([
      'https://lcars.jlapenna.net/api/work/v1/runs/o%2Fr%237%2Fr2/introspect',
      'https://investigate.lan.jlapenna.net/v1/investigations',
    ]);
    expect(JSON.parse(String(f.calls[1].init.body))).toEqual({
      version: 1,
      runId,
      requestId: 'owned-request',
      question: 'Which unit?',
      context: 'observed metadata',
      issueUrl: auth.issueUrl,
    });
    expect(
      f.calls.map((c) => new Headers(c.init.headers).get('authorization')),
    ).toEqual(['Bearer owned-bearer', 'Bearer owned-bearer']);
    expect(f.calls.map((c) => c.init.redirect)).toEqual(['error', 'error']);
    expect(
      f.calls.map((c) => new Headers(c.init.headers).has('cookie')),
    ).toEqual([false, false]);
    expect(f.out.map((line) => JSON.parse(line))).toEqual([answer]);
    expect(f.err).toEqual([]);
  });
  it('preserves native Work and forwards the exact verified receipt generation', async () => {
    const f = fixture();
    f.deps.env = {
      ...f.deps.env,
      LCARS_CAPACITY_RECEIPT: '{}',
      LCARS_WORKER_IDENTITY_FILE: '/owned/projected-token',
      LCARS_WORKER_GENERATION: '7',
    };
    f.state.introspection = () =>
      json({
        ...auth,
        anchor: { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G' },
        issueUrl: null,
        worker: { poolId: 'pool', podUid: 'pod', generation: 7 },
      });
    expect(await executeInvestigateCommand(args, f.deps)).toEqual({ ok: true });
    expect(f.deps.readFile).toHaveBeenCalledWith(
      '/owned/projected-token',
      16384,
    );
    expect(
      f.calls.map((c) =>
        new Headers(c.init.headers).get('x-lcars-worker-identity'),
      ),
    ).toEqual(['e30.e30.signature', 'e30.e30.signature']);
    expect(
      f.calls.map((c) =>
        new Headers(c.init.headers).get('x-lcars-worker-generation'),
      ),
    ).toEqual(['7', '7']);
    expect(JSON.parse(String(f.calls[1].init.body)).issueUrl).toBeNull();
    expect(String(f.calls[1].init.body)).not.toContain('owned-bearer');
  });
  it.each([401, 409, 503])(
    'does not invoke the gateway after authentication refusal %s',
    async (status) => {
      const f = fixture();
      f.state.introspection = () => json({ secret: 'do not print' }, status);
      expect(await executeInvestigateCommand(args, f.deps)).toEqual({
        ok: false,
      });
      expect(f.calls).toHaveLength(1);
      expect(f.out).toEqual([]);
      expect(f.err.join()).not.toContain('do not print');
    },
  );
  it.each([
    { LCARS_CAPACITY_RECEIPT: '{}' },
    { LCARS_WORKER_GENERATION: '7' },
    {
      LCARS_WORKER_GENERATION: '1.5',
      LCARS_WORKER_IDENTITY_FILE: '/owned/token',
    },
    {
      LCARS_WORKER_GENERATION: '9007199254740993',
      LCARS_WORKER_IDENTITY_FILE: '/owned/token',
    },
  ])(
    'refuses partial/invalid receipt credentials without bearer fallback %j',
    async (env) => {
      const f = fixture();
      f.deps.env = { ...f.deps.env, ...env };
      expect(await executeInvestigateCommand(args, f.deps)).toEqual({
        ok: false,
      });
      expect(f.calls).toEqual([]);
    },
  );
  it.each([
    { ...auth, runId: 'another-run' },
    { ...auth, issueUrl: 'https://other.invalid/issues/7' },
    { ...auth, repository: 'other/repo' },
    { ...auth, worker: { poolId: 'pool', podUid: 'pod', generation: 7 } },
    { ...auth, validUntil: auth.verifiedAt },
    { ...auth, params: { private: 'secret' } },
  ])(
    'does not accept an incompatible introspection identity/authority %j',
    async (value) => {
      const f = fixture();
      f.state.introspection = () => json(value);
      expect(await executeInvestigateCommand(args, f.deps)).toEqual({
        ok: false,
      });
      expect(f.calls).toHaveLength(1);
      expect(f.out).toEqual([]);
    },
  );
  it('accounts for observed round trip against server validity without a wall-clock guess', async () => {
    const f = fixture();
    f.state.introspection = () => {
      f.state.tick = 1200;
      return json({ ...auth, validUntil: '2026-10-14T09:00:01Z' });
    };
    expect(await executeInvestigateCommand(args, f.deps)).toEqual({
      ok: false,
    });
    expect(f.calls).toHaveLength(1);
  });
  it.each([
    { input: [...args, '--origin', 'https://other.invalid'] },
    { input: [...args, '--issue-url', 'https://other.invalid'] },
    { input: ['--request-id', 'id', '--question', 'é'.repeat(2049)] },
    {
      input: [
        '--request-id',
        'id',
        '--question',
        'text',
        '--context',
        'é'.repeat(8193),
      ],
    },
    { input: [...args, '--question-file', '/owned/question'] },
  ])(
    'refuses malformed/unbounded input without transport',
    async ({ input }) => {
      const f = fixture();
      expect(await executeInvestigateCommand(input, f.deps)).toEqual({
        ok: false,
      });
      expect(f.calls).toEqual([]);
      expect(f.out).toEqual([]);
    },
  );
  it('bounds caller file reads and uses their content as text, never authority', async () => {
    const f = fixture();
    f.deps.readFile = vi.fn(async () => 'Which unit?');
    expect(
      await executeInvestigateCommand(
        ['--request-id', 'owned-request', '--question-file', '/owned/input'],
        f.deps,
      ),
    ).toEqual({ ok: true });
    expect(f.deps.readFile).toHaveBeenCalledWith('/owned/input', 4096);
  });
  it.each([
    { ...answer, runId: 'other' },
    { ...answer, requestId: 'other' },
    { ...answer, confidence: 2 },
    { ...answer, raw: 'transcript' },
    { ...answer, audit_delivery: { journal: 'failed', loki: 'accepted' } },
    { ...answer, could_not_answer: ['owned-bearer'] },
    {
      ...answer,
      findings: [{ ...answer.findings[0], finding: 'owned-bearer' }],
    },
  ])(
    'does not print invalid or credential-bearing success %j',
    async (value) => {
      const f = fixture();
      f.state.gateway = () => json(value);
      expect(await executeInvestigateCommand(args, f.deps)).toEqual({
        ok: false,
      });
      expect(f.out).toEqual([]);
      expect(f.err.join()).not.toContain('owned-bearer');
    },
  );
  it('returns only a safe typed error and never retries an in-progress request', async () => {
    const f = fixture();
    f.state.gateway = () =>
      json(
        {
          version: 1,
          requestId: 'owned-request',
          error: {
            code: 'request-in-progress',
            message: 'secret upstream exception',
            retryable: true,
          },
        },
        429,
      );
    expect(await executeInvestigateCommand(args, f.deps)).toEqual({
      ok: false,
    });
    expect(f.calls).toHaveLength(2);
    expect(f.err).toEqual(['investigate failed: request-in-progress']);
  });
  it('refuses a truncated or oversized streamed response', async () => {
    const f = fixture();
    f.state.gateway = () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(65537));
            c.close();
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    expect(await executeInvestigateCommand(args, f.deps)).toEqual({
      ok: false,
    });
    expect(f.out).toEqual([]);
  });
  it('aborts a hung transport at the finite outer deadline with no retry/output', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.deps.fetchImpl = vi.fn(() => new Promise<Response>(() => undefined));
    const task = executeInvestigateCommand(args, f.deps);
    await vi.advanceTimersByTimeAsync(65000);
    expect(await task).toEqual({ ok: false });
    expect(f.deps.fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.out).toEqual([]);
    expect(f.err).toEqual(['investigate failed: deadline-exceeded']);
  });
  it('validates actual localhost HTTP request headers and chunked terminal findings', async () => {
    const f = fixture();
    const seen: { url: string; token: string | undefined }[] = [];
    const server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', token: req.headers.authorization });
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        const text = JSON.stringify(req.method === 'POST' ? answer : auth);
        res.write(text.slice(0, 40));
        res.end(text.slice(40));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('unexpected test address');
    f.deps.fetchImpl = ((input, init) =>
      fetch(
        `http://127.0.0.1:${address.port}${new URL(String(input)).pathname}`,
        init,
      )) as typeof fetch;
    try {
      expect(await executeInvestigateCommand(args, f.deps)).toEqual({
        ok: true,
      });
      expect(seen).toEqual([
        {
          url: '/api/work/v1/runs/o%2Fr%237%2Fr2/introspect',
          token: 'Bearer owned-bearer',
        },
        { url: '/v1/investigations', token: 'Bearer owned-bearer' },
      ]);
      expect(f.out.map((line) => JSON.parse(line))).toEqual([answer]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
