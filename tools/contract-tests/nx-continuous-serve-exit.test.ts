import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Regression for #2325: a standalone foreground `nx run` of a `continuous`
// serve target reported `Successfully ran target` and exited 0 after the
// command had already died on a fatal startup error, because
// `handleContinuousTaskExit` completed any exit of a task nothing depended on
// as `fulfilled`. The repair lives in `patches/nx+23.2.1.patch`.
//
// These run the real installed (patched) nx binary rather than the supervisor,
// because the false success is produced by the orchestrator above it: a
// supervisor-level assertion stays green while the shipped `pnpm dev` wrapper
// still reports success. The scratch fixture isolates each exit path; the last
// case drives this repository's actual supported entrypoint.
//
// Ctrl-C is covered through the exit code Nx's own signal handling produces
// (143 for SIGTERM, 130 for SIGINT, both in `EXPECTED_TERMINATION_SIGNALS`)
// rather than a literal keystroke: a real SIGINT race is the one thing that
// cannot be made deterministic here, and it lands in the same orchestrator
// branch this asserts on.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const nx = path.join(repoRoot, 'node_modules/.bin/nx');
const portCount = 7; // tools/dev-console.mjs buildPorts(base..base+6)

type NxRun = { status: number; output: string };

function runNx(
  cwd: string,
  args: string[],
  timeout: number,
  env: Record<string, string> = {},
): NxRun {
  const result = spawnSync(nx, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    // Minimal and hermetic, matching tools/nx-remote-cache-read-failure.test.sh:
    // no daemon to talk to, no shared cache to write, and no ambient
    // credentials crossing into the task process.
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: process.env['HOME'] ?? os.homedir(),
      NX_DAEMON: 'false',
      NX_SKIP_NX_CACHE: 'true',
      ...env,
    },
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

async function closeAll(servers: Array<net.Server>): Promise<void> {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
}

// Reserves a genuinely free contiguous range so the occupied-port run cannot
// collide with anything else on a shared runner.
async function reservePortRange(
  count: number,
): Promise<{ base: number; servers: Array<net.Server> }> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const base = 20_000 + Math.floor(Math.random() * 40_000);
    const servers: Array<net.Server> = [];
    try {
      for (let offset = 0; offset < count; offset += 1) {
        const server = net.createServer((socket) => socket.end('still alive'));
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(base + offset, '127.0.0.1', () => resolve());
        });
        servers.push(server);
      }
      return { base, servers };
    } catch {
      await closeAll(servers);
    }
  }
  throw new Error('could not reserve a free contiguous port range');
}

describe('Nx continuous task exit contract (#2325)', () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'lcars-nx-continuous-'),
  );
  const fixture = path.join(fixtureRoot, 'workspace');

  beforeAll(() => {
    fs.mkdirSync(path.join(fixture, 'apps/a'), { recursive: true });
    fs.writeFileSync(
      path.join(fixture, 'package.json'),
      '{"name":"fixture","version":"0.0.0","private":true,"workspaces":["apps/*"]}\n',
    );
    fs.writeFileSync(path.join(fixture, 'nx.json'), '{"targetDefaults":{}}\n');
    fs.writeFileSync(
      path.join(fixture, 'apps/a/project.json'),
      `${JSON.stringify(
        {
          name: 'a',
          root: 'apps/a',
          targets: {
            // What a fatal startup error looks like: the command is gone with
            // a nonzero code and nothing in the graph depends on it.
            fatal: {
              executor: 'nx:run-commands',
              continuous: true,
              cache: false,
              options: {
                command:
                  "printf 'fatal: port is unavailable (EADDRINUSE)\\n' >&2; exit 3",
              },
            },
            // A continuous target that ends deliberately is still a success.
            deliberate: {
              executor: 'nx:run-commands',
              continuous: true,
              cache: false,
              options: { command: 'echo deliberate-exit' },
            },
            // SIGTERM -> 143, which Nx lists as an expected termination signal.
            signal: {
              executor: 'nx:run-commands',
              continuous: true,
              cache: false,
              options: { command: 'kill -TERM $$' },
            },
            // Nx kills a continuous dependency itself once the dependent is
            // done, marking the stop before killing it.
            watcher: {
              executor: 'nx:run-commands',
              continuous: true,
              cache: false,
              options: { command: 'sleep 120' },
            },
            finish: {
              executor: 'nx:run-commands',
              cache: false,
              dependsOn: ['watcher'],
              options: { command: 'echo dependent-finished' },
            },
          },
        },
        null,
        1,
      )}\n`,
    );
    fs.writeFileSync(
      path.join(fixture, 'apps/a/package.json'),
      '{"name":"a","version":"0.0.0"}\n',
    );
  });

  afterAll(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it(
    'fails a standalone continuous target whose command exits nonzero',
    { timeout: 120_000 },
    () => {
      const run = runNx(fixture, ['run', 'a:fatal'], 100_000);
      expect(run.output).toContain(
        'Task "a:fatal" is continuous but exited with code 3',
      );
      expect(run.output).not.toContain('Successfully ran target');
      expect(run.status).toBe(1);
    },
  );

  it(
    'keeps a deliberate clean exit of a standalone continuous target a success',
    { timeout: 120_000 },
    () => {
      const run = runNx(fixture, ['run', 'a:deliberate'], 100_000);
      expect(run.output).toContain('deliberate-exit');
      expect(run.output).toContain('Successfully ran target deliberate');
      expect(run.status).toBe(0);
    },
  );

  it(
    'keeps an expected termination signal distinguishable from a crash',
    { timeout: 120_000 },
    () => {
      const run = runNx(fixture, ['run', 'a:signal'], 100_000);
      expect(run.output).not.toContain('is continuous but exited with code');
      expect(run.output).not.toContain('Successfully ran target');
      // `completed` is false for a stopped task, so nx reports the interrupt
      // code rather than 0 or the generic failure 1.
      expect(run.status).toBe(130);
    },
  );

  it(
    'still reports success when nx cleans up a continuous dependency',
    { timeout: 120_000 },
    () => {
      const run = runNx(fixture, ['run', 'a:finish'], 100_000);
      expect(run.output).toContain('dependent-finished');
      expect(run.output).not.toContain('is continuous but exited with code');
      expect(run.output).toContain('Successfully ran target finish');
      expect(run.status).toBe(0);
    },
  );

  it(
    'exits nonzero from the supported development entrypoint on a fatal startup error',
    { timeout: 180_000 },
    async () => {
      const { base, servers } = await reservePortRange(portCount);
      try {
        const run = runNx(
          repoRoot,
          [
            'run',
            '@agent-lcars/console:serve-emulator',
            '--port-base',
            String(base),
          ],
          150_000,
        );
        expect(run.output).toContain(
          `port ${base} is unavailable (EADDRINUSE)`,
        );
        expect(run.output).toContain('is continuous but exited with code 1');
        expect(run.output).not.toContain('Successfully ran target');
        expect(run.status).toBe(1);
        // The refused stack stays whoever else owns it (#2269): a failed
        // diagnostic must not have taken it down.
        expect(servers.every((server) => server.listening)).toBe(true);
      } finally {
        await closeAll(servers);
      }
    },
  );
});
