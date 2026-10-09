import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { test } from 'vitest';

import { chromiumHeadlessShellReadiness } from './browser-runtime.mjs';

const execFile = promisify(execFileCallback);

test('fails closed when the installed registry cannot resolve its runtime', async () => {
  for (const resolveExecutable of [
    () => undefined,
    () => 'relative/browser',
    () => {
      throw new Error('registry changed');
    },
  ]) {
    assert.deepEqual(
      await chromiumHeadlessShellReadiness({ resolveExecutable }),
      {
        ready: false,
        reason: 'runtime-location-unavailable',
      },
    );
  }
});

test('reports readiness only when the resolved headless-shell executable is usable', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lcars-browser-'));
  const installLocation = path.join(directory, 'chromium_headless_shell-1234');
  const executable = path.join(
    installLocation,
    'chrome-headless-shell-linux64',
    'chrome-headless-shell',
  );
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, '#!/bin/sh\nexit 0\n');
  await chmod(executable, 0o755);
  const options = { resolveExecutable: () => executable };

  assert.deepEqual(await chromiumHeadlessShellReadiness(options), {
    ready: true,
    executablePath: executable,
  });

  await unlink(executable);
  const decoy = path.join(installLocation, 'leftover', 'chrome-headless-shell');
  await mkdir(path.dirname(decoy));
  await writeFile(decoy, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.deepEqual(await chromiumHeadlessShellReadiness(options), {
    ready: false,
    reason: 'executable-unavailable',
  });
});

test('verify returns a distinct readiness result before reading saved credentials', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lcars-browser-'));
  const browserCache = path.join(directory, 'empty-browser-cache');
  await mkdir(browserCache);

  await assert.rejects(
    execFile(
      process.execPath,
      [
        path.resolve('tools/saved-session/verify.mjs'),
        '--origin',
        'https://console.example',
        '--path',
        '/',
        '--state-file',
        path.join(directory, 'missing-session.json'),
      ],
      {
        cwd: path.resolve('.'),
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserCache },
        encoding: 'utf8',
      },
    ),
    (error) => {
      assert.equal(error.code, 5);
      assert.match(error.stderr, /BROWSER_RUNTIME_UNAVAILABLE/);
      assert.match(error.stderr, /playwright install chromium --only-shell/);
      assert.doesNotMatch(error.stderr, /missing-session|ENOENT/);
      return true;
    },
  );
  assert.deepEqual(await readdir(browserCache), []);
});
