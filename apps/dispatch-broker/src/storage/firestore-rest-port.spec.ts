/**
 * Proves `FirestoreRestStoragePort` against the shared `StoragePort`
 * contract (./port.contract.ts) by running it against a REAL Firestore
 * emulator -- not a mocked `fetch`, which would prove nothing here: the
 * entire claim this adapter makes is that Firestore's REST `:commit`
 * preconditions are evaluated atomically, server-side, under real
 * contention. A mock cannot demonstrate that; only a real emulator racing
 * real concurrent HTTP requests can. See ./firestore-rest-port.ts's header
 * for the collection layout and the atomicity argument this test exists to
 * verify.
 *
 * This file is a near-duplicate of ./firestore-port.spec.ts's emulator
 * harness (same Java-version gate, same `skipIf` pattern -- see #732 for
 * why that gate exists), deliberately: same reasons, same shape, just
 * pointed at a different adapter and a different dedicated port range so
 * both specs can run concurrently without a collision.
 */

import {
  type ChildProcessWithoutNullStreams,
  spawn,
  spawnSync,
} from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, expect, test } from 'vitest';

import { FirestoreRestStoragePort } from './firestore-rest-port.js';
import { runStoragePortContractSuite } from './port.contract.js';
import type { StoragePort } from './port.js';

// Dedicated, fixed, and distinct from every other port this repo's emulator
// tooling uses -- firebase.json's console-e2e ports (4000/4002/4003/4004),
// firebase-tools' own bare defaults (4000/4400/8080/9099/9299, per
// tools/kill-e2e-ports.sh's comment), AND ./firestore-port.spec.ts's own
// dedicated ports (4112/4412) -- so this spec can run alongside
// tools/e2e-local.sh and the sibling client-library spec without EADDRINUSE.
const FIRESTORE_PORT = 4113;
const HUB_PORT = 4413;
const PROJECT_ID = 'demo-dispatch-broker-storage-port-rest';
const EMULATOR_HOST = `127.0.0.1:${FIRESTORE_PORT}`;

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const FIREBASE_BIN = path.join(REPO_ROOT, 'node_modules/.bin/firebase');

function parseJavaMajorVersion(versionOutput: string): number | undefined {
  const match = versionOutput.match(/version "(\d+)(?:\.(\d+))?/);
  if (!match) return undefined;
  const first = Number(match[1]);
  // Legacy "1.8.0_x" scheme -> Java 8; Java 9+ dropped the leading "1.".
  return first === 1 && match[2] ? Number(match[2]) : first;
}

function checkJavaAtLeast21(): { ok: true } | { ok: false; reason: string } {
  const result = spawnSync('java', ['-version']);
  if (result.error) {
    return {
      ok: false,
      reason: `no 'java' on PATH (${result.error.message})`,
    };
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const major = parseJavaMajorVersion(output);
  if (major === undefined) {
    return {
      ok: false,
      reason: `could not parse 'java -version' output: ${output.trim()}`,
    };
  }
  if (major < 21) {
    return {
      ok: false,
      reason:
        `java ${major} on PATH; firebase-tools' Firestore emulator requires ` +
        'Java 21+ (see .github/workflows/ci.yml\'s "e2e" job comment)',
    };
  }
  return { ok: true };
}

function waitForPort(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = connect({ host, port }, () => {
        socket.end();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(
            new Error(
              `Firestore emulator did not open ${host}:${port} within ${timeoutMs}ms`,
            ),
          );
          return;
        }
        setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

async function clearFirestoreData(): Promise<void> {
  const url = `http://${EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
  const response = await fetch(url, { method: 'DELETE' });
  if (!response.ok) {
    throw new Error(
      `Failed to clear Firestore emulator data: ${response.status} ${await response.text()}`,
    );
  }
}

const javaCheck = checkJavaAtLeast21();

if (!javaCheck.ok) {
  // Environment gate, not a disabled test: the Firestore emulator needs Java
  // 21+ and CI's `verify` job installs no Java at all. `test.skipIf` is the
  // idiomatic vitest form for "this environment cannot run it", and unlike
  // `.skip` it says so in the reporter output rather than looking like
  // someone parked a failing test. Kept as one named case so the reason is
  // visible in a test run instead of vanishing silently -- see this file's
  // header and ./firestore-port.spec.ts's identical gate.
  test.skipIf(true)(
    `FirestoreRestStoragePort contract suite skipped: ${javaCheck.reason}`,
    () => {
      // Never executed. The assertion exists so this reads as a real test to
      // both vitest and eslint; the whole point of the case is its name,
      // which puts the reason in the reporter output.
      expect(javaCheck.ok).toBe(false);
    },
  );
} else {
  let emulator: ChildProcessWithoutNullStreams | undefined;
  let configDir: string | undefined;

  beforeAll(async () => {
    configDir = mkdtempSync(
      path.join(tmpdir(), 'agent-lcars-firestore-rest-port-test-'),
    );
    const configPath = path.join(configDir, 'firebase.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        emulators: {
          firestore: { port: FIRESTORE_PORT },
          hub: { port: HUB_PORT },
        },
      }),
    );

    emulator = spawn(
      FIREBASE_BIN,
      [
        '--config',
        configPath,
        'emulators:start',
        '--only',
        'firestore',
        '--project',
        PROJECT_ID,
      ],
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let exited: Error | undefined;
    emulator.once('exit', (code, signal) => {
      exited = new Error(
        `Firestore emulator process exited early (code=${code}, signal=${signal})`,
      );
    });
    emulator.once('error', (error) => {
      exited = error;
    });

    await Promise.race([
      waitForPort('127.0.0.1', FIRESTORE_PORT, 45_000),
      new Promise<void>((_, reject) => {
        const check = setInterval(() => {
          if (exited) {
            clearInterval(check);
            reject(exited);
          }
        }, 100);
      }),
    ]);
  }, 60_000);

  afterAll(async () => {
    if (emulator && !emulator.killed) {
      const proc = emulator;
      await new Promise<void>((resolve) => {
        proc.once('exit', () => resolve());
        proc.kill('SIGINT');
        setTimeout(() => {
          proc.kill('SIGKILL');
          resolve();
        }, 10_000);
      });
    }
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true });
    }
  }, 30_000);

  async function createPort(): Promise<StoragePort> {
    await clearFirestoreData();
    // The emulator's magic admin token -- see ./firestore-rest-port.ts's
    // module header ("Auth"): this file never resolves credentials itself,
    // so the test supplies whatever token is appropriate for its
    // environment, exactly as production would supply one from
    // google-github-actions/auth.
    return new FirestoreRestStoragePort({
      projectId: PROJECT_ID,
      token: 'owner',
      emulatorHost: EMULATOR_HOST,
    });
  }

  runStoragePortContractSuite('FirestoreRestStoragePort', createPort);
}
