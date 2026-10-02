import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import test from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const runner = path.join(root, 'tools/e2e/run-console-emulators.sh');

function runHarness(output, exitCode) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-emulator-diag-'));
  const fakePnpm = path.join(temp, 'pnpm');
  fs.writeFileSync(
    fakePnpm,
    '#!/usr/bin/env bash\nprintf \'%s\\n\' "$FAKE_OUTPUT"\nexit "$FAKE_EXIT"\n',
  );
  fs.chmodSync(fakePnpm, 0o755);
  try {
    return spawnSync('bash', [runner], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${temp}:${process.env.PATH ?? ''}`,
        FAKE_OUTPUT: output,
        FAKE_EXIT: String(exitCode),
      },
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test('passes through a successful emulator-backed suite', () => {
  const result = runHarness('Playwright Run Summary: 116 passed', 0);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /::error/u);
});

test('names a Firestore crash instead of reporting a generic E2E failure', () => {
  const result = runHarness(
    'firestore: Fatal error occurred:\nFirestore Emulator has exited with code: 143',
    1,
  );
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /::error title=Console E2E environment::Firestore emulator exited/u,
  );
});

test('names an occupied emulator port', () => {
  const result = runHarness(
    'Error: listen EADDRINUSE: address already in use',
    1,
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /required local port was unavailable/u);
});

test('does not misclassify an ordinary Playwright assertion failure', () => {
  const result = runHarness('Playwright Run Summary: 1 failed\\n115 passed', 1);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /::error title=Console E2E environment/u);
});
