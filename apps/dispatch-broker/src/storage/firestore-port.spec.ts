/**
 * Proves `FirestoreStoragePort` against the shared `StoragePort` contract
 * (./port.contract.ts) by running it against a REAL Firestore emulator --
 * not `firestore-jest-mock` (used elsewhere in this repo, e.g.
 * libs/telemetry/src/server/store.test.ts), which records query shapes but
 * does not evaluate transactions, so it cannot prove the one property this
 * backend exists for: that `writeTask`'s compare-and-swap is genuinely
 * atomic under real concurrent writers. See ./firestore-port.ts's header
 * for the collection layout and the atomicity argument this test exists to
 * verify.
 *
 * ## Why this file manages its own emulator process
 *
 * This repo already runs the Firebase emulator for console e2e
 * (tools/e2e-local.sh -> `firebase emulators:exec`), but that path is
 * Playwright-oriented (fixed ports, a host-level flock, a Next.js server)
 * and is not something a `vitest` file can reach into. This file drives
 * the same underlying `firebase emulators:start` CLI directly instead,
 * scoped to `--only firestore`, on its own dedicated ports (distinct from
 * firebase.json's console-e2e ports AND from firebase-tools' own bare
 * defaults -- see FIRESTORE_PORT/HUB_PORT below) so this spec can run
 * concurrently with `tools/e2e-local.sh` without a port collision, and
 * clears all emulator data between contract-suite tests via the
 * emulator-only `clearFirestoreData` REST endpoint rather than tearing the
 * process down and back up (Firebase's own documented pattern for
 * per-test isolation).
 *
 * ## Why this can skip itself
 *
 * firebase-tools' Firestore emulator requires Java 21+ (see
 * .github/workflows/ci.yml's `e2e` job comment, which hit this the hard
 * way: ubuntu-latest's default `java` is only 17). This repo's self-hosted
 * `verify` CI job -- which is what actually runs `nx test
 * @agent-lcars/dispatch-broker` in CI -- installs no Java at all (see
 * apps/runner-autoscaler/runner-image/Dockerfile); only the separate `e2e`
 * job installs Java 21. That job invokes this spec directly before the
 * Playwright suite, so CI proves the real transactional contract without
 * adding Java or emulator startup cost to every `verify` run. Making this
 * spec's emulator a hard requirement in the broker's ordinary test target
 * would still break `verify` in CI, not just fail one spec.
 *
 * So: if a suitable `java` is not on PATH, this file registers ONE explicit
 * `test.skip` naming exactly why, instead of either (a) hard-failing a CI
 * job that was never given the tool it needs, or (b) silently registering
 * nothing and letting a missing dependency look like "nothing to test
 * here." Where `java` IS available (confirmed locally while implementing
 * this file, and true of any workstation that has already run
 * tools/e2e-local.sh), the full, unmodified contract suite runs for real
 * against a real emulator -- this is not a substitute for that run, it is
 * what makes that run possible in environments that can't do it.
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

import { FirestoreStoragePort } from './firestore-port.js';
import { runStoragePortContractSuite } from './port.contract.js';
import type { StoragePort } from './port.js';

// Dedicated, fixed, and distinct from every other port this repo's emulator
// tooling uses -- firebase.json's console-e2e ports (4000/4002/4003/4004),
// firebase-tools' own bare defaults (4000/4400/8080/9099/9299, per
// tools/kill-e2e-ports.sh's comment) -- so this spec can run alongside
// tools/e2e-local.sh without EADDRINUSE.
const FIRESTORE_PORT = 4112;
const HUB_PORT = 4412;
const PROJECT_ID = 'demo-dispatch-broker-storage-port';
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
  // header ("Why this can skip itself").
  test.skipIf(true)(
    `FirestoreStoragePort contract suite skipped: ${javaCheck.reason}`,
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
      path.join(tmpdir(), 'agent-lcars-firestore-port-test-'),
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
    return new FirestoreStoragePort({
      projectId: PROJECT_ID,
      databaseId: '(default)',
      emulatorHost: EMULATOR_HOST,
    });
  }

  runStoragePortContractSuite('FirestoreStoragePort', createPort);
}
