import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import plugin from '../../packages/fleet-tools/bin/worker-opencode-plugin.mjs';
import { sessionResolver } from '../../packages/fleet-tools/bin/worker-opencode-session.mjs';
import session from '../../packages/fleet-tools/bin/worker-session.cjs';

const roots: string[] = [];
const context = {
  provider: 'opencode',
  runId: 'work:item/r1',
  attemptId: 'g1:work:item/r1',
  mode: 'implement',
  anchor: { type: 'work', id: 'item' },
};
const event = (id: string) => ({
  session_id: id,
  tool_name: 'Bash',
  tool_input: { command: 'echo harmless' },
});
function fixture(
  parents: Record<string, string | undefined> = {
    child: 'root',
    grandchild: 'child',
  },
) {
  const root = mkdtempSync(join(tmpdir(), 'worker-lineage-'));
  roots.push(root);
  const path = join(root, 'context.json');
  writeFileSync(path, JSON.stringify(context));
  vi.stubEnv('LCARS_WORKER_CONTEXT', path);
  vi.stubEnv('LCARS_RUN_ID', context.runId);
  vi.stubEnv('ATTEMPT_ID', context.attemptId);
  expect(session.rejection(event('root'), context)).toBeNull();
  const get = vi.fn(async ({ path: request }: { path: { id: string } }) => ({
    data: { id: request.id, parentID: parents[request.id] },
  }));
  const client = { session: { get } };
  return { path, root, get, client, resolve: sessionResolver(context, client) };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it('keeps root events native without calling the session API', async () => {
  const f = fixture();
  expect(await f.resolve(event('root'))).toEqual(event('root'));
  expect(f.get).not.toHaveBeenCalled();
});
it('maps verified descendants to the immutable attempt root and caches native ancestry', async () => {
  const f = fixture();
  const before = readFileSync(f.path + '.session.json', 'utf8');
  expect(await f.resolve(event('grandchild'))).toEqual({
    ...event('root'),
    native_session_id: 'grandchild',
  });
  expect(f.get).toHaveBeenCalledTimes(2);
  expect(await f.resolve(event('child'))).toEqual({
    ...event('root'),
    native_session_id: 'child',
  });
  expect(f.get).toHaveBeenCalledTimes(2);
  expect(readFileSync(f.path + '.session.json', 'utf8')).toBe(before);
  // A fresh plugin process reconstructs lineage rather than trusting task input.
  await sessionResolver(context, f.client)(event('child'));
  expect(f.get).toHaveBeenCalledTimes(3);
});
it.each([
  { child: undefined },
  { child: 'foreign-root' },
  { child: 'child' },
  { child: 'loop', loop: 'child' },
  { child: '../invalid' },
])(
  'rejects unrelated, cyclic, or malformed native ancestry: %j',
  async (parents) => {
    const f = fixture(parents);
    await expect(
      f.resolve({
        ...event('child'),
        parentID: 'root',
        tool_input: { command: 'echo harmless', parentID: 'root' },
      }),
    ).rejects.toThrow('does not match');
    expect(session.boundSession(context)).toBe('root');
  },
);
it('rejects missing, mismatched, and failed API responses without creating a child binding', async () => {
  const f = fixture();
  for (const result of [
    undefined,
    { data: { id: 'other', parentID: 'root' } },
    { data: { id: 'child', parentID: 'root' }, error: 'failure' },
  ]) {
    f.get.mockResolvedValueOnce(result as never);
    await expect(f.resolve(event('child'))).rejects.toThrow('does not match');
  }
  expect(session.boundSession(context)).toBe('root');
});
it('bounds ancestry lookup time and aborts the native request', async () => {
  const f = fixture();
  f.get.mockImplementationOnce(
    () =>
      new Promise(() => {
        /* Simulate an unresponsive provider API. */
      }),
  );
  await expect(f.resolve(event('child'))).rejects.toThrow('does not match');
  expect(
    (f.get.mock.calls[0][0] as { signal?: AbortSignal }).signal?.aborted,
  ).toBe(true);
});
it('does not trust cached descendants after the attempt binding changes', async () => {
  const f = fixture();
  await f.resolve(event('child'));
  writeFileSync(f.path + '.session.json', '{}');
  await expect(f.resolve(event('child'))).rejects.toThrow('does not match');
});
it('bounds ancestry depth and rejects a binding changed during lookup', async () => {
  const parents = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`child${i}`, `child${i + 1}`]),
  );
  const f = fixture(parents);
  await expect(f.resolve(event('child0'))).rejects.toThrow('does not match');
  expect(f.get).toHaveBeenCalledTimes(32);
  f.get.mockImplementationOnce(async () => {
    writeFileSync(f.path + '.session.json', '{}');
    return { data: { id: 'child', parentID: 'root' } };
  });
  await expect(f.resolve(event('child'))).rejects.toThrow('does not match');
  expect(readFileSync(f.path + '.session.json', 'utf8')).toBe('{}');
});
it('keeps ordinary policy rejection active for verified child sessions', async () => {
  const f = fixture();
  const hooks = await plugin({ directory: f.root, client: f.client });
  await expect(
    hooks['tool.execute.before'](
      { sessionID: 'child', tool: 'bash' },
      { args: { command: 'git commit --no-verify -m bypass' } },
    ),
  ).rejects.toThrow('Do not bypass Git hooks');
  expect(session.boundSession(context)).toBe('root');
});
