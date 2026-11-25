import { describe, expect, it, vi } from 'vitest';

import {
  herdrCoreSend,
  resolveHcBinary,
  type RunFile,
} from './herdr-core-send';

function runner(
  code: number | null,
  stdout: string,
  stderr = '',
): RunFile & ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ code, stdout, stderr }));
}

describe('herdrCoreSend', () => {
  it('pastes the text with `hc send`, never as an option', async () => {
    const run = runner(0, '{"turn":4,"status":"done","started":true}\n');
    expect(await herdrCoreSend(run, '/bin/hc', 't36', '-rf notice')).toEqual({
      kind: 'sent',
      started: true,
    });
    expect(run).toHaveBeenCalledWith(
      '/bin/hc',
      ['send', '--json', '--', 't36', '-rf notice'],
      { timeoutMs: 45_000 },
    );
  });

  it('reports an unknown start as null', async () => {
    expect(
      await herdrCoreSend(
        runner(0, '{"turn":4,"started":null}'),
        'hc',
        't36',
        'x',
      ),
    ).toEqual({ kind: 'sent', started: null });
  });

  it.each([
    ['blocked', 'refused'],
    ['status_mismatch', 'refused'],
    ['not_found', 'gone'],
    ['finished', 'gone'],
    ['unavailable', 'failed'],
  ])('maps the %s error to %s', async (error, kind) => {
    const run = runner(
      3,
      JSON.stringify({ error: { kind: error, message: 'no' } }),
    );
    expect(await herdrCoreSend(run, 'hc', 't36', 'x')).toEqual({ kind, error });
  });

  it('reads an error printed on stderr', async () => {
    const run = runner(3, '', '{"error":{"kind":"blocked"}}');
    expect(await herdrCoreSend(run, 'hc', 't36', 'x')).toEqual({
      kind: 'refused',
      error: 'blocked',
    });
  });

  it('fails when hc does not run', async () => {
    expect(await herdrCoreSend(runner(null, ''), 'hc', 't36', 'x')).toEqual({
      kind: 'failed',
      error: 'exit_null',
    });
  });

  it('refuses another machine’s terminal without running hc', async () => {
    const run = runner(0, '{}');
    expect(await herdrCoreSend(run, 'hc', 'laptop/t7', 'x')).toEqual({
      kind: 'gone',
      error: 'bad_address',
    });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('resolveHcBinary', () => {
  it('prefers HC, then the per-user install, then PATH', () => {
    expect(resolveHcBinary({ HC: '/opt/hc' }, '/home/u', () => true)).toBe(
      '/opt/hc',
    );
    expect(resolveHcBinary({}, '/home/u', () => true)).toBe(
      '/home/u/.local/bin/hc',
    );
    expect(resolveHcBinary({}, '/home/u', () => false)).toBe('hc');
  });
});
