import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

const run = promisify(execFile);
const script = path.resolve('tools/kill-e2e-ports.sh');

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
  await once(child, 'message');
  return { child, closed };
}

async function stop(child: ChildProcess, closed: Promise<unknown>) {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await closed;
}

it.each(['lsof', 'fuser'])(
  'cleans an orphan on the owned port via %s without killing another emulator',
  async (discovery) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'lcars-port-cleanup-'),
    );
    const owned = await fixtureProcess();
    const unrelated = await fixtureProcess();
    try {
      // Execute the real shell cleanup with bounded discovery shims. Never
      // claim or signal actual ports or JVMs belonging to another session.
      for (const command of ['lsof', 'fuser', 'pkill', 'rm']) {
        const body =
          command === 'lsof'
            ? `if (process.env.DISCOVERY === 'lsof' && process.argv.includes('tcp:8080')) console.log(process.env.OWNED_PID);`
            : command === 'fuser'
              ? `if (process.env.DISCOVERY === 'fuser' && process.argv.includes('8080')) console.log(process.env.OWNED_PID);`
              : command === 'pkill'
                ? `if (process.argv.includes('cloud-firestore-emulator')) process.kill(Number(process.env.UNRELATED_PID), 'SIGTERM');`
                : '// Do not remove the real shared hub locator in a test.';
        await writeFile(
          path.join(directory, command),
          `#!${process.execPath}\n${body}\n`,
          { mode: 0o700 },
        );
      }
      await run('/bin/bash', [script], {
        env: {
          PATH: directory,
          DISCOVERY: discovery,
          OWNED_PID: String(owned.child.pid),
          UNRELATED_PID: String(unrelated.child.pid),
        },
        timeout: 5_000,
      });
      await owned.closed;
      expect(owned.child.signalCode).toBe('SIGKILL');
      // A round-trip proves the unrelated process is still responding, not
      // just awaiting asynchronous reaping after an unsafe broad signal.
      expect(unrelated.child.connected).toBe(true);
      const response = once(unrelated.child, 'message');
      unrelated.child.send('still running');
      expect(await response).toEqual(['still running', undefined]);
    } finally {
      await stop(owned.child, owned.closed);
      await stop(unrelated.child, unrelated.closed);
      await rm(directory, { recursive: true, force: true });
    }
  },
  10_000,
);
