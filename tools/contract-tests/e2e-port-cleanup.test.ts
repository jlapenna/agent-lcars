import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

const run = promisify(execFile);
const script = path.resolve('tools/kill-e2e-ports.sh');
const config = JSON.parse(readFileSync('firebase.json', 'utf8')) as {
  emulators: Record<string, { port?: number }>;
};
const configuredPorts = Object.values(config.emulators).flatMap((value) =>
  value.port === undefined ? [] : [value.port],
);
const discoveryCases = ['lsof', 'fuser'].flatMap((discovery) =>
  configuredPorts.map((port) => [discovery, port] as const),
);

async function bounded(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Fixture response timed out')),
          2_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixtureProcess() {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "process.on('message', m => process.send(m)); process.send('ready');",
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  const closed = once(child, 'close');
  try {
    await once(child, 'message', { signal: AbortSignal.timeout(2_000) });
  } catch (error) {
    await stop(child, closed);
    throw error;
  }
  return { child, closed };
}

async function stop(child: ChildProcess, closed: Promise<unknown>) {
  if (child.exitCode === null && child.signalCode === null)
    child.kill('SIGKILL');
  await bounded(closed);
}

it.each(discoveryCases)(
  'cleans an orphan via %s on configured port %i without killing another emulator',
  async (discovery, port) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'lcars-port-cleanup-'),
    );
    let owned: Awaited<ReturnType<typeof fixtureProcess>> | undefined;
    let unrelated: Awaited<ReturnType<typeof fixtureProcess>> | undefined;
    try {
      owned = await fixtureProcess();
      unrelated = await fixtureProcess();
      // Execute the real shell cleanup with bounded discovery shims. Never
      // claim or signal actual ports or JVMs belonging to another session.
      for (const command of ['lsof', 'fuser', 'pkill', 'rm']) {
        // Discovery shims need shell builtins only. Starting a fresh Node
        // runtime for every port made the test's five-second command budget
        // measure cold interpreter startup rather than cleanup ownership.
        const body =
          command === 'lsof' || command === 'fuser'
            ? `if [ "$DISCOVERY" = '${command}' ]; then
  for argument in "$@"; do
    if [ "$argument" = "${command === 'lsof' ? 'tcp:' : ''}$OWNED_PORT" ]; then
      printf '%s\\n' "$OWNED_PID"
    fi
  done
fi`
            : command === 'pkill'
              ? `for argument in "$@"; do
  if [ "$argument" = 'cloud-firestore-emulator' ]; then
    kill -TERM "$UNRELATED_PID"
  fi
done`
              : '# Do not remove the real shared hub locator in a test.\n:';
        await writeFile(
          path.join(directory, command),
          `#!/bin/bash\n${body}\n`,
          {
            mode: 0o700,
          },
        );
      }
      await run('/bin/bash', [script], {
        env: {
          PATH: directory,
          DISCOVERY: discovery,
          OWNED_PORT: String(port),
          OWNED_PID: String(owned.child.pid),
          UNRELATED_PID: String(unrelated.child.pid),
        },
        timeout: 5_000,
      });
      await bounded(owned.closed);
      expect(owned.child.signalCode).toBe('SIGKILL');
      // A round-trip proves the unrelated process is still responding, not
      // just awaiting asynchronous reaping after an unsafe broad signal.
      expect(unrelated.child.connected).toBe(true);
      const response = once(unrelated.child, 'message', {
        signal: AbortSignal.timeout(2_000),
      });
      unrelated.child.send('still running');
      expect(await response).toEqual(['still running', undefined]);
    } finally {
      await Promise.all([
        owned && stop(owned.child, owned.closed),
        unrelated && stop(unrelated.child, unrelated.closed),
      ]);
      await rm(directory, { recursive: true, force: true });
    }
  },
  10_000,
);
