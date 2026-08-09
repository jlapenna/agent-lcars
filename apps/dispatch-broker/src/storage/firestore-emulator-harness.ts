/**
 * Shared real-Firestore-emulator harness for StoragePort conformance specs.
 *
 * Isolation contract: every registered suite must provide its own project ID,
 * Firestore port, and hub port. The harness puts those values in a temporary
 * Firebase config, addresses cleanup through that project/port pair, and never
 * reads ambient emulator configuration. Consequently independently configured
 * suites can run in parallel with one another and with console E2E.
 *
 * The environment gate is intentional and shared too. firebase-tools needs
 * Java 21+, while the ordinary Verify runner does not install Java; in that
 * environment each caller registers one explicit, reason-bearing skipped test.
 * CI's Java-21 E2E job continues to invoke both spec files directly, where the
 * unmodified StoragePort contract (including concurrent CAS) runs for real.
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, expect, test } from 'vitest';

import { runStoragePortContractSuite } from './port.contract.js';
import type { StoragePort } from './port.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const FIREBASE_BIN = path.join(REPO_ROOT, 'node_modules/.bin/firebase');

interface FirestoreEmulatorHarnessOptions {
  suiteName: string;
  projectId: string;
  firestorePort: number;
  hubPort: number;
  createPort: (context: {
    projectId: string;
    emulatorHost: string;
  }) => StoragePort | Promise<StoragePort>;
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

export function runFirestoreEmulatorStoragePortContract(
  options: FirestoreEmulatorHarnessOptions,
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
      path.join(tmpdir(), 'agent-lcars-firestore-port-test-'),
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

    // Pay one-time emulator/client initialization inside beforeAll so normal
    // contract timeouts measure storage behavior rather than cold startup.
    await clearFirestoreData();
    const warmupPort = await options.createPort(context);
    await warmupPort.readTask({
      repositoryId: 0,
      repository: 'warmup/firestore-emulator',
      issue: 0,
    });
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

  runStoragePortContractSuite(options.suiteName, async () => {
    await clearFirestoreData();
    return options.createPort(context);
  });
}
