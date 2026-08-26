import { describe, expect, it } from 'vitest';

import { executeWorkCommand, type WorkCommandDeps } from './work-command';

function deps(
  routes: Record<string, (init: RequestInit & { url: string }) => unknown>,
): WorkCommandDeps & { calls: string[]; out: string[] } {
  const calls: string[] = [];
  const out: string[] = [];
  return {
    calls,
    out,
    origin: 'https://lcars.test',
    token: async () => 'tok',
    now: () => new Date('2026-08-26T10:00:00.000Z'),
    sleep: async () => undefined,
    stdout: (l) => out.push(l),
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
  it('status --watch polls until settled', async () => {
    let n = 0;
    const d = deps({
      'GET /api/work/v1/items/{id}': () => item(n++ < 2 ? 'running' : 'done'),
    });
    const r = await executeWorkCommand(
      ['status', '01J5Z3K9QX8F0N2B4V6C8D1E3G', '--watch'],
      d,
    );
    expect(r.ok).toBe(true);
    expect(d.calls.filter((c) => c.startsWith('GET')).length).toBe(3);
    expect(d.out.at(-1)).toMatch(/done/);
  });
  it('prints usage for an unknown subcommand', async () => {
    const r = await executeWorkCommand(['bogus'], deps({}));
    expect(r.ok).toBe(false);
    expect(r.usage).toMatch(/usage: work/);
  });
});
