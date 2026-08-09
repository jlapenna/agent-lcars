/**
 * Real-Firestore-emulator harness for `RecoveryOperationPort` conformance
 * specs, mirroring `./firestore-emulator-harness.ts` exactly (see that
 * file's header for the isolation contract and Java-21 environment gate,
 * which apply here unchanged). Kept as a sibling file rather than a shared
 * generic, so that refactoring one storage port's emulator harness can
 * never destabilize the other's already-proven CAS coverage.
 *
 * Uses its own project ID and port pair (distinct from
 * `./firestore-port.spec.ts` and `./firestore-rest-port.spec.ts`'s), so all
 * three emulator users can run concurrently.
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, expect, test } from 'vitest';

import { runRecoveryOperationPortContractSuite } from './recovery-port.contract.js';
import type { RecoveryOperationPort } from './recovery-port.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const FIREBASE_BIN = path.join(REPO_ROOT, 'node_modules/.bin/firebase');

interface RecoveryFirestoreEmulatorHarnessOptions {
  suiteName: string;
  projectId: string;
  firestorePort: number;
  hubPort: number;
  createPort: (context: {
    projectId: string;
    emulatorHost: string;
  }) => RecoveryOperationPort | Promise<RecoveryOperationPort>;
}

function parseJavaMajorVersion(versionOutput: string): number | undefined {
  const match = versionOutput.match(/version "(\d+)(?:\.(\d+))?/);
  if (!match) return undefined;
  const first = Number(match[1]);
  return first === 1 && match[2] ? Number(match[2]) : first;
}

function checkJavaAtLeast21(): { ok: true } | { ok: false; reason: string } {
  const result = spawnSync('java', ['-version']);
  if (result.error) {
    return { ok: false, reason: `no 'java' on PATH (${result.error.message})` };
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
      reason: `java ${major} on PATH; firebase-tools' Firestore emulator requires Java 21+`,
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

export function runFirestoreEmulatorRecoveryOperationPortContract(
  options: RecoveryFirestoreEmulatorHarnessOptions,
): void {
  const javaCheck = checkJavaAtLeast21();
  if (!javaCheck.ok) {
    test.skipIf(true)(
      `${options.suiteName} contract suite skipped: ${javaCheck.reason}`,
      () => expect(javaCheck.ok).toBe(false),
    );
    return;
  }

  const emulatorHost = `127.0.0.1:${options.firestorePort}`;
  const context = { projectId: options.projectId, emulatorHost };
  let emulator: ChildProcess | undefined;
  let configDir: string | undefined;

  const clearFirestoreData = async (): Promise<void> => {
    const url = `http://${emulatorHost}/emulator/v1/projects/${options.projectId}/databases/(default)/documents`;
    const response = await fetch(url, { method: 'DELETE' });
    if (!response.ok) {
      throw new Error(
        `Failed to clear Firestore emulator data: ${response.status} ${await response.text()}`,
      );
    }
  };

  beforeAll(async () => {
    configDir = mkdtempSync(
      path.join(tmpdir(), 'agent-lcars-recovery-port-test-'),
    );
    const configPath = path.join(configDir, 'firebase.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        emulators: {
          firestore: { port: options.firestorePort },
          hub: { port: options.hubPort },
        },
      }),
    );

    const proc = spawn(
      FIREBASE_BIN,
      [
        '--config',
        configPath,
        'emulators:start',
        '--only',
        'firestore',
        '--project',
        options.projectId,
      ],
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    emulator = proc;

    let rejectEarlyExit: ((error: Error) => void) | undefined;
    const earlyExit = new Promise<void>((_, reject) => {
      rejectEarlyExit = reject;
    });
    proc.once('exit', (code, signal) => {
      rejectEarlyExit?.(
        new Error(
          `Firestore emulator process exited early (code=${code}, signal=${signal})`,
        ),
      );
    });
    proc.once('error', (error) => rejectEarlyExit?.(error));

    await Promise.race([
      waitForPort('127.0.0.1', options.firestorePort, 45_000),
      earlyExit,
    ]);

    await clearFirestoreData();
    const warmupPort = await options.createPort(context);
    await warmupPort.readRecoveryOperation('warmup');
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
    if (configDir) rmSync(configDir, { recursive: true, force: true });
  }, 30_000);

  runRecoveryOperationPortContractSuite(async () => {
    await clearFirestoreData();
    return options.createPort(context);
  });
}
