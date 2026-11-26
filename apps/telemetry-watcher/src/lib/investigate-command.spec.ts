import { describe, expect, it, vi } from 'vitest';

import {
  executeInvestigateCommand,
  type InvestigateCommandDeps,
} from './investigate-command';

const runId = 'work:01J5Z3K9QX8F0N2B4V6C8D1E4A/r1';
const workId = '01M7K7A7WSF7E2PP07E3E0M4K8';
const base = `https://lcars.jlapenna.net/api/work/v1/runs/${encodeURIComponent(runId)}`;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function fixture(responses: Response[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  let clock = 0;
  const deps: InvestigateCommandDeps = {
    env: { LCARS_RUN_ID: runId, LCARS_RUN_TOKEN: 'run-token', ...env },
    readFile: vi.fn(async () => 'question from file'),
    monotonic: () => clock,
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
    }),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    fetchImpl: vi.fn(async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return responses.shift() ?? json({}, 500);
    }) as typeof fetch,
  };
  return { deps, out, err, calls };
}

describe('lcars investigate', () => {
  it('admits a round for this run, waits for it to settle and prints its report', async () => {
    const f = fixture([
      json({ workId, state: 'running' }),
      json({ workId, state: 'running' }),
      json({
        workId,
        state: 'done',
        ok: true,
        summary: 'report',
        report: '{"summary":"ok"}',
      }),
    ]);
    const result = await executeInvestigateCommand(
      [
        '--request-id',
        'disk-1',
        '--question',
        'Why?',
        '--context',
        'logs say x',
      ],
      f.deps,
    );
    expect(result).toEqual({ ok: true });
    expect(f.calls[0]!.url).toBe(
      `${base}/agents/jlapenna/homelab/investigator`,
    );
    expect(f.calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({
      requestId: 'disk-1',
      message: 'Why?\n\nContext from the requesting run:\nlogs say x',
    });
    expect(
      (f.calls[0]!.init.headers as Record<string, string>)['authorization'],
    ).toBe('Bearer run-token');
    expect(f.calls[1]!.url).toBe(`${base}/agent-runs/${workId}`);
    expect(JSON.parse(f.out[0]!)).toMatchObject({
      state: 'done',
      report: '{"summary":"ok"}',
    });
  });

  it('honors --agent and LCARS_INVESTIGATE_AGENT', async () => {
    const f = fixture([json({ workId, state: 'done', ok: true })], {
      LCARS_INVESTIGATE_AGENT: 'o/r/env-agent',
    });
    await executeInvestigateCommand(
      ['--request-id', 'x', '--question', 'Q', '--agent', 'o/r/flag-agent'],
      f.deps,
    );
    expect(f.calls[0]!.url).toBe(`${base}/agents/o/r/flag-agent`);
  });

  it('reports a failed round as a failure but still prints its status', async () => {
    const f = fixture([
      json({ workId, state: 'failed', ok: false, summary: 'runner-failed' }),
    ]);
    const result = await executeInvestigateCommand(
      ['--request-id', 'x', '--question', 'Q'],
      f.deps,
    );
    expect(result).toEqual({ ok: false });
    expect(JSON.parse(f.out[0]!)).toMatchObject({ state: 'failed' });
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'agent-forbidden'],
    [404, 'agent-not-found'],
    [409, 'request-id-conflict'],
    [503, 'investigation-unavailable'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const f = fixture([json({}, status)]);
    expect(
      await executeInvestigateCommand(
        ['--request-id', 'x', '--question', 'Q'],
        f.deps,
      ),
    ).toEqual({ ok: false });
    expect(f.err).toEqual([`investigate failed: ${code}`]);
    expect(f.out).toEqual([]);
  });

  it('retains the admitted round when the local deadline expires', async () => {
    const f = fixture(
      Array.from({ length: 10 }, () => json({ workId, state: 'running' })),
      { LCARS_INVESTIGATE_TIMEOUT_SECONDS: '12' },
    );
    expect(
      await executeInvestigateCommand(
        ['--request-id', 'x', '--question', 'Q'],
        f.deps,
      ),
    ).toEqual({ ok: false });
    expect(f.err).toEqual(['investigate failed: deadline-exceeded']);
    expect(f.out.map((line) => JSON.parse(line))).toEqual([{ workId }]);
  });

  it('retains only the admitted ID when the terminal response arrives too late', async () => {
    const f = fixture(
      [json({ workId, state: 'done', ok: true, report: 'late' })],
      {
        LCARS_INVESTIGATE_TIMEOUT_SECONDS: '1',
      },
    );
    f.deps.monotonic = vi
      .fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(1_001);
    const result = await executeInvestigateCommand(
      ['--request-id', 'x', '--question', 'Q'],
      f.deps,
    );
    expect(result.ok).toBe(false);
    expect(f.err).toEqual(['investigate failed: deadline-exceeded']);
    expect(f.out.map((line) => JSON.parse(line))).toEqual([{ workId }]);
  });

  it('passes whole milliseconds to AbortSignal.timeout from a fractional clock', async () => {
    const f = fixture([json({ workId, state: 'done', ok: true })], {
      LCARS_INVESTIGATE_TIMEOUT_SECONDS: '20',
    });
    let now = 0.25;
    f.deps.monotonic = () => (now += 0.333);
    expect(
      await executeInvestigateCommand(
        ['--request-id', 'x', '--question', 'Q'],
        f.deps,
      ),
    ).toEqual({ ok: true });
  });

  it('bounds the wait by a short deadline instead of a full poll interval', async () => {
    const f = fixture(
      [
        json({ workId, state: 'running' }),
        json({ workId, state: 'done', ok: true }),
      ],
      { LCARS_INVESTIGATE_TIMEOUT_SECONDS: '1' },
    );
    expect(
      await executeInvestigateCommand(
        ['--request-id', 'x', '--question', 'Q'],
        f.deps,
      ),
    ).toEqual({ ok: false });
    expect(f.deps.sleep).toHaveBeenCalledWith(1000);
    expect(f.err).toEqual(['investigate failed: deadline-exceeded']);
  });

  it.each([
    [['--question', 'Q']],
    [['--request-id', 'x']],
    [['--request-id', 'x', '--question', 'Q', '--question-file', 'f']],
    [['--request-id', 'x', '--question', 'Q', '--agent', 'not an agent']],
  ])('refuses invalid input %j without any request', async (argv) => {
    const f = fixture([]);
    expect(await executeInvestigateCommand(argv, f.deps)).toEqual({
      ok: false,
    });
    expect(f.calls).toHaveLength(0);
    expect(f.err).toEqual(['investigate failed: invalid-input']);
  });

  it('reads the question from a file', async () => {
    const f = fixture([json({ workId, state: 'done', ok: true })]);
    await executeInvestigateCommand(
      ['--request-id', 'x', '--question-file', '/tmp/q'],
      f.deps,
    );
    expect(JSON.parse(String(f.calls[0]!.init.body)).message).toBe(
      'question from file',
    );
  });
});
