import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const gate = path.join(repoRoot, 'tools/firestore-emulator-gate.mjs');
const projectJson = path.join(repoRoot, 'libs/orchestrator/project.json');
const ciWorkflow = path.join(repoRoot, '.github/workflows/ci.yml');

const JAR_NAME = 'cloud-firestore-emulator-v9.9.9-test.jar';

let scratch: string;
let payload: Buffer;
let expectations: { size: number; sha256: string; md5: string };
const openServers: (http.Server | net.Server)[] = [];

function sha(buffer: Buffer, algorithm: 'sha256' | 'md5') {
  return crypto.createHash(algorithm).update(buffer).digest('hex');
}

async function listen<T extends net.Server>(server: T): Promise<number> {
  openServers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('no test port');
  return address.port;
}

// Reproduces the measured shape: the request dies before the body arrives, which is
// what a cold-cache provider blip looks like from inside the gate.
async function unreachableArtifactHost(): Promise<string> {
  const server = net.createServer((socket) => socket.destroy());
  const port = await listen(server);
  return `http://127.0.0.1:${port}/emulator/${JAR_NAME}`;
}

interface ArtifactHostOptions {
  failFirst?: number;
  truncate?: boolean;
}

async function artifactHost({
  failFirst = 0,
  truncate = false,
}: ArtifactHostOptions = {}) {
  const state = { requests: 0, failures: failFirst };
  const server = http.createServer((req, res) => {
    state.requests += 1;
    if (state.failures > 0) {
      state.failures -= 1;
      req.socket.destroy();
      return;
    }
    const body = truncate
      ? payload.subarray(0, Math.floor(payload.length / 2))
      : payload;
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(body);
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}/emulator/${JAR_NAME}`,
    requests: () => state.requests,
  };
}

function writeStub(name: string) {
  const stub = path.join(scratch, name);
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bash
set -uo pipefail
printf '%s\\n' '' ' RUN  vitest 1.0' '\${STUB_EVIDENCE:-}'
if [ -n "\${STUB_SENTINEL:-}" ]; then printf ran > "\$STUB_SENTINEL"; fi
if [ -n "\${STUB_NOISE:-}" ]; then for i in \$(seq 1 200); do printf 'emulator noise %s\\n' "\$i"; done; fi
if [ -n "\${STUB_SECRET:-}" ]; then printf 'Authorization: Bearer %s\\n' "\$STUB_SECRET"; printf 'token=%s\\n' "\$STUB_SECRET"; fi
exit "\${STUB_EXIT:-0}"
`,
  );
  return `bash ${stub}`;
}

function runGate(
  args: string[],
  env: Record<string, string>,
): Promise<{
  status: number;
  stdout: string;
  stderr: string;
  combined: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [gate, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        FIRESTORE_GATE_DOWNLOAD_ATTEMPTS: '3',
        FIRESTORE_GATE_RETRY_DELAY_MS: '0',
        FIRESTORE_GATE_DOWNLOAD_TIMEOUT_MS: '5000',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('gate timed out'));
    }, 60_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({
        status: status ?? -1,
        stdout,
        stderr,
        combined: `${stdout}\n${stderr}`,
      });
    });
  });
}

function fixtureEnv(infoPath: string, cacheDir: string) {
  return {
    FIRESTORE_GATE_INFO_JSON: infoPath,
    FIREBASE_EMULATORS_PATH: cacheDir,
  };
}

function writeDeclaration(
  infoPath: string,
  remoteUrl: string,
  verify: boolean,
) {
  fs.writeFileSync(
    infoPath,
    JSON.stringify({
      firestore: {
        version: '9.9.9-test',
        expectedSize: verify ? expectations.size : -1,
        expectedChecksum: verify ? expectations.md5 : '',
        expectedChecksumSHA256: verify ? expectations.sha256 : '',
        remoteUrl,
        downloadPathRelativeToCacheDir: JAR_NAME,
      },
    }),
  );
}

function jarPathIn(cacheDir: string) {
  return path.join(cacheDir, JAR_NAME);
}

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lcars-2592-'));
  payload = Buffer.alloc(8192, 0);
  for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 31) % 251;
  expectations = {
    size: payload.length,
    sha256: sha(payload, 'sha256'),
    md5: sha(payload, 'md5'),
  };
});

afterAll(() => {
  for (const server of openServers) server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('Firestore emulator artifact bootstrap gate (#2592)', () => {
  const ownedTarget = JSON.parse(fs.readFileSync(projectJson, 'utf8')) as {
    targets: Record<
      string,
      { cache?: boolean; options?: { command?: string } }
    >;
  };
  const ownedCommand =
    ownedTarget.targets['test-firestore']?.options?.command ?? '';

  it('keeps the owning target name, its no-cache posture, and the required Verify consumer', () => {
    expect(ownedCommand).toBe('node tools/firestore-emulator-gate.mjs run');
    expect(ownedTarget.targets['test-firestore']?.cache).toBe(false);
    expect(fs.readFileSync(ciWorkflow, 'utf8')).toContain(
      './tools/nx run @agent-lcars/orchestrator:test-firestore',
    );
  });

  it('classifies a cold-cache download failure as artifact bootstrap and never starts the contracts', async () => {
    const url = await unreachableArtifactHost();
    const cacheDir = path.join(scratch, 'cache-unreachable');
    const infoPath = path.join(scratch, 'declaration-unreachable.json');
    const sentinel = path.join(scratch, 'contracts-ran-unreachable');
    writeDeclaration(infoPath, url, true);

    const run = await runGate(['run'], {
      ...fixtureEnv(infoPath, cacheDir),
      FIRESTORE_GATE_EXEC_CMD: writeStub('stub-unreachable.sh'),
      STUB_SENTINEL: sentinel,
      STUB_EVIDENCE: ' Test Files  5 passed',
    });

    expect(run.status).not.toBe(0);
    expect(run.combined).toContain(
      '::error title=Firestore emulator gate failed closed::',
    );
    expect(run.combined).toContain(
      'stage=artifact-bootstrap exit=1 assertionsEvaluated=no',
    );
    expect(run.combined).toContain('bootstrap-attempt=attempt 1:');
    expect(run.combined).toContain('bootstrap-attempt=attempt 3:');
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(fs.existsSync(jarPathIn(cacheDir))).toBe(false);
    expect(run.combined).toContain('no contract assertion was evaluated');
  });

  it('qualifies the cold-cache bootstrap: bounded retry seeds Firebase’s own cache and the second run reuses it', async () => {
    const host = await artifactHost({ failFirst: 1 });
    const cacheDir = path.join(scratch, 'cache-recovered');
    const infoPath = path.join(scratch, 'declaration-recovered.json');
    writeDeclaration(infoPath, host.url, true);
    const env = {
      ...fixtureEnv(infoPath, cacheDir),
      FIRESTORE_GATE_EXEC_CMD: writeStub('stub-recovered.sh'),
      STUB_EVIDENCE: ' Test Files  5 passed',
    };

    const cold = await runGate(['run'], env);
    expect(cold.combined).toContain('status=fetching');
    expect(cold.combined).toContain('status=seeded attempt=2');
    expect(cold.status).toBe(0);
    expect(cold.combined).toContain('status=passed');
    expect(sha(fs.readFileSync(jarPathIn(cacheDir)), 'sha256')).toBe(
      expectations.sha256,
    );
    expect(host.requests()).toBe(2);

    const warm = await runGate(['run'], env);
    expect(warm.status).toBe(0);
    expect(warm.combined).toContain('status=cached');
    expect(host.requests()).toBe(2);
  });

  it('never lets a truncated artifact become the emulator the contracts run against', async () => {
    const host = await artifactHost({ truncate: true });
    const cacheDir = path.join(scratch, 'cache-truncated');
    const infoPath = path.join(scratch, 'declaration-truncated.json');
    const sentinel = path.join(scratch, 'contracts-ran-truncated');
    writeDeclaration(infoPath, host.url, true);

    const run = await runGate(['run'], {
      ...fixtureEnv(infoPath, cacheDir),
      FIRESTORE_GATE_EXEC_CMD: writeStub('stub-truncated.sh'),
      STUB_SENTINEL: sentinel,
    });

    expect(run.status).not.toBe(0);
    expect(run.combined).toContain('stage=artifact-bootstrap');
    expect(run.combined).toContain('download failed, expected');
    expect(fs.existsSync(jarPathIn(cacheDir))).toBe(false);
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(host.requests()).toBe(3);
  });

  it('fails closed on an evaluated contract failure and does not retry it as infrastructure', async () => {
    const host = await artifactHost();
    const cacheDir = path.join(scratch, 'cache-contract');
    const infoPath = path.join(scratch, 'declaration-contract.json');
    writeDeclaration(infoPath, host.url, true);

    const run = await runGate(['run'], {
      ...fixtureEnv(infoPath, cacheDir),
      FIRESTORE_GATE_EXEC_CMD: writeStub('stub-contract.sh'),
      STUB_EXIT: '1',
      STUB_EVIDENCE: ' ❯ store-contract.spec.ts  FAIL',
    });

    expect(run.status).toBe(1);
    expect(run.combined).toContain(
      'stage=contract-execution exit=1 assertionsEvaluated=yes',
    );
    expect(run.combined).toContain('must not be retried into green');
    expect(run.combined).not.toContain('bootstrap-attempt=attempt 2:');
    expect(host.requests()).toBe(1);
  });

  it('reports the deepest stage with evidence, so bootstrap blips and assertions stay separate', async () => {
    const classify = async (name: string, log: string) => {
      const logPath = path.join(scratch, `classify-${name}.log`);
      fs.writeFileSync(logPath, log);
      const run = await runGate(
        ['classify', '--code=1', `--log=${logPath}`],
        {},
      );
      expect(run.status).toBe(0);
      return JSON.parse(run.stdout.trim()) as {
        stage: string;
        assertionsEvaluated: string;
      };
    };

    expect(
      await classify(
        'bootstrap-only',
        'i  firestore: downloading cloud-firestore-emulator-v1.22.0.jar...\n' +
          '[firestore] Error: Failed to make request: socket hang up\n',
      ),
    ).toMatchObject({ stage: 'artifact-bootstrap', assertionsEvaluated: 'no' });

    expect(
      await classify(
        'download-warning-then-assertions',
        'Failed to make request: socket hang up\n' +
          ' RUN  vitest 1.0\n Test Files  4 passed (4)\n ❯ store-contract.spec.ts (2 tests)\n',
      ),
    ).toMatchObject({
      stage: 'contract-execution',
      assertionsEvaluated: 'yes',
    });

    expect(
      await classify(
        'emulator-process',
        'i  firestore: firestore emulator logging to firebase-debug.log\n' +
          '[firestore] java.lang.UnsupportedClassVersionError\n' +
          'i  firestore: Firestore Emulator has exited with code: 1\n',
      ),
    ).toMatchObject({ stage: 'emulator-start', assertionsEvaluated: 'no' });
  });

  it('keeps the preserved diagnostic bounded and sanitized', async () => {
    const host = await artifactHost();
    const cacheDir = path.join(scratch, 'cache-sanitized');
    const infoPath = path.join(scratch, 'declaration-sanitized.json');
    writeDeclaration(infoPath, host.url, true);

    const run = await runGate(['run'], {
      ...fixtureEnv(infoPath, cacheDir),
      FIRESTORE_GATE_EXEC_CMD: writeStub('stub-sanitized.sh'),
      STUB_EXIT: '1',
      STUB_NOISE: '1',
      STUB_SECRET: 'supersecrettranscriptvalue',
    });

    expect(run.status).toBe(1);
    expect(run.combined).not.toContain('supersecrettranscriptvalue');
    expect(run.combined).toContain('[redacted]');
    expect(run.combined).toContain('bounded sanitized log tail');
    const tail = run.combined
      .split('\n')
      .filter((line) => line.startsWith('[firestore-gate]'));
    expect(tail.length).toBeLessThan(60);
    expect(Buffer.byteLength(run.stderr, 'utf8')).toBeLessThan(8_000);
  });

  it('leaves an operator-supplied emulator binary to the operator instead of seeding a second artifact', async () => {
    const host = await artifactHost();
    const cacheDir = path.join(scratch, 'cache-override');
    const infoPath = path.join(scratch, 'declaration-override.json');
    writeDeclaration(infoPath, host.url, true);
    const binary = path.join(scratch, 'operator-owned.jar');
    fs.writeFileSync(binary, payload);

    const run = await runGate(['run'], {
      ...fixtureEnv(infoPath, cacheDir),
      FIRESTORE_EMULATOR_BINARY_PATH: binary,
      FIRESTORE_GATE_EXEC_CMD: writeStub('stub-override.sh'),
    });

    expect(run.status).toBe(0);
    expect(run.combined).toContain(
      'status=skipped reason=operator-binary-override',
    );
    expect(host.requests()).toBe(0);
  });
});
