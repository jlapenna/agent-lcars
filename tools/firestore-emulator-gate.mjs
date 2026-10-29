// The owning gate for @agent-lcars/orchestrator:test-firestore (issue #2592).
//
// The required Verify step runs the Store and authenticated HTTP contracts inside
// `firebase emulators:exec`, which downloads the Firestore emulator jar from
// storage.googleapis.com on every cold-cache runner. A transient failure of that
// download killed the gate before a single contract assertion evaluated, and the
// retained log kept only the jar URL plus a generic `Failed to make request` --
// the same visible shape as a real contract failure.
//
// This gate keeps the failing stage identifiable without weakening the check.
//
//   1. Preflight resolves the jar the installed firebase-tools itself declares
//      (version, remote URL, size, checksums) and makes it present in Firebase's
//      own emulator cache directory, which the CLI already skips downloading when
//      the file exists. A cold download is retried a bounded number of times and
//      every candidate is verified against the declared size and checksum before
//      it is moved into place, so a truncated or corrupt artifact can never become
//      the emulator the contracts run against.
//   2. The unchanged emulator and contract command then runs, streamed live to the
//      CI log and into a bounded buffer kept for the failure path.
//   3. Any non-zero exit prints exactly one bounded, sanitized, classified block
//      naming the deepest stage reached (artifact bootstrap, emulator start, or
//      contract execution) and whether contract assertions were evaluated.
//
// Nothing here relaxes the gate. Every failure path exits non-zero, an unevaluated
// contract run is never reported as a passed one, and a classified
// `artifact-bootstrap` failure is still a failed required check -- the original
// failed log stays the evidence.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');

export const DEFAULT_INFO_JSON = path.join(
  REPO_ROOT,
  'node_modules/firebase-tools/lib/emulator/downloadableEmulatorInfo.json',
);
export const DEFAULT_EXEC_CMD =
  'pnpm exec firebase emulators:exec --only firestore --project=demo-no-project ' +
  '"FIRESTORE_EMULATOR_HOST=localhost:4002 ./tools/test-firestore-contracts.sh"';

export const STAGE_BOOTSTRAP = 'artifact-bootstrap';
export const STAGE_EMULATOR_START = 'emulator-start';
export const STAGE_CONTRACT_EXECUTION = 'contract-execution';
export const STAGE_UNKNOWN = 'unknown';

export const DIAGNOSTIC_MAX_LINES = 40;
export const DIAGNOSTIC_MAX_BYTES = 6_000;
export const DIAGNOSTIC_LINE_MAX_CHARS = 400;
export const BUFFER_MAX_BYTES = 512 * 1024;
export const LIVE_MAX_BYTES = 48 * 1024;
export const DOWNLOAD_ATTEMPTS = 3;
export const DOWNLOAD_TIMEOUT_MS = 300_000;
export const RETRY_DELAY_MS = 10_000;

// Signatures taken from the installed firebase-tools, not invented: apiv2 raises
// `Failed to make request: ...`, downloadToTmp raises `download failed, status N:`
// and the size/checksum validators raise `download failed, expected ...`.
const BOOTSTRAP_FAILURE_PATTERNS = [
  /Failed to make request/i,
  /download failed, status \d+/i,
  /download failed, expected \d+ bytes but got \d+/i,
  /download failed, expected checksum/i,
  /\b(ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|ERR_NETWORK)\b/,
  /getaddrinfo/i,
  /Failed to download/i,
];

const EMULATOR_START_FAILURE_PATTERNS = [
  /has exited with code: \d+/,
  /has exited upon receiving signal:/,
  /address already in use/i,
  /Unsupported java version/i,
  /UnsupportedClassVersionError/,
  /Process `java -version` has exited with code/i,
  /Failed to start .*emulator/i,
  /Cannot start .*emulator/i,
];

// Evidence that the inner contract script actually reached the runner, so a
// bootstrap problem is never mistaken for an evaluated assertion (or the reverse).
const CONTRACT_EXECUTION_PATTERNS = [
  /\bvitest\b/i,
  /Test Files\s+\d/,
  /\b(store-contract|credential-fallback)\.spec\.ts\b/,
  /\b(runs-router|work-provider-fallback)\.test\.ts\b/,
  /"script" exited with code \d+/i,
];

// The tail is written into the retained CI log, so anything that can carry a
// credential is truncated or replaced before it is printed.
const SECRET_PATTERNS = [
  { pattern: /\bbearer\s+[^\s,;]+/gi, replacement: 'bearer [redacted]' },
  {
    pattern: /\b(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi,
    replacement: '$1[redacted]',
  },
  {
    pattern:
      /\b(ya29\.[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9]{8,}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[A-Za-z0-9-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/g,
    replacement: '[redacted]',
  },
  {
    pattern:
      /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|api[_-]?key)"?(\s*[:=]\s*)"?[^"'\s,;]+/gi,
    replacement: '$1$2[redacted]',
  },
];

export function emulatorCacheDir(env = process.env) {
  return (
    env.FIREBASE_EMULATORS_PATH ||
    path.join(os.homedir(), '.cache', 'firebase', 'emulators')
  );
}

function redact(text) {
  let out = String(text ?? '');
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function redactedLine(line) {
  const cleaned = redact(line).replace(/\s+/g, ' ').trim();
  return cleaned.length > DIAGNOSTIC_LINE_MAX_CHARS
    ? `${cleaned.slice(0, DIAGNOSTIC_LINE_MAX_CHARS)}…`
    : cleaned;
}

// Live output is sanitized before it reaches the retained CI log. The bounded
// buffer still receives the raw chunks because classification needs the deepest
// available stage evidence; every excerpt printed from it passes through this
// redactor again.
function createSanitizingLineWriter(
  stream,
  { maxBytes = LIVE_MAX_BYTES } = {},
) {
  let pending = '';
  let bytes = 0;
  let suppressed = 0;
  const writeLine = (line) => {
    const text = `${redact(line)}\n`;
    const size = Buffer.byteLength(text, 'utf8');
    if (bytes + size > maxBytes) {
      suppressed += size;
      return;
    }
    bytes += size;
    stream.write(text);
  };
  return {
    push(chunk) {
      pending += String(chunk);
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) writeLine(line);
    },
    flush() {
      if (pending) {
        writeLine(pending);
        pending = '';
      }
      if (suppressed > 0) {
        stream.write(
          `[firestore-gate] live output capped after ${maxBytes} bytes; ${suppressed} bytes omitted\n`,
        );
      }
    },
  };
}

// Bounded, sanitized excerpt: the CI log stays the full record, the gate's own
// block must never be able to spill a credential or a 136 MB progress bar.
export function boundedExcerpt(
  text,
  { maxLines = DIAGNOSTIC_MAX_LINES, maxBytes = DIAGNOSTIC_MAX_BYTES } = {},
) {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => redactedLine(line))
    .filter((line) => line.length > 0);
  const kept = [];
  let bytes = 0;
  for (const line of lines.slice(-Math.max(1, maxLines)).reverse()) {
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes + size > maxBytes && kept.length > 0) break;
    kept.push(line);
    bytes += size;
  }
  return kept.reverse().join('\n');
}

export function firstMatches(text, patterns) {
  const haystack = String(text ?? '');
  const matched = [];
  for (const pattern of patterns) {
    const hit = haystack.match(pattern);
    if (hit) matched.push(hit[0].slice(0, 160));
  }
  return matched;
}

// The deepest stage with evidence wins: contracts that started prove the jar and
// the emulator process were already past, while a log with only download failures
// proves nothing was evaluated.
export function classifyFailure({ exitCode, log = '' }) {
  const contract = firstMatches(log, CONTRACT_EXECUTION_PATTERNS);
  const emulatorStart = firstMatches(log, EMULATOR_START_FAILURE_PATTERNS);
  const bootstrap = firstMatches(log, BOOTSTRAP_FAILURE_PATTERNS);

  let stage = STAGE_UNKNOWN;
  let evidence = [];
  if (contract.length > 0) {
    stage = STAGE_CONTRACT_EXECUTION;
    evidence = contract;
  } else if (emulatorStart.length > 0) {
    stage = STAGE_EMULATOR_START;
    evidence = emulatorStart;
  } else if (bootstrap.length > 0) {
    stage = STAGE_BOOTSTRAP;
    evidence = bootstrap;
  }

  return {
    stage,
    exitCode,
    assertionsEvaluated: contract.length > 0 ? 'yes' : 'no',
    evidence: evidence.slice(0, 3),
  };
}

// The jar the installed firebase-tools will run, resolved from its own declaration
// rather than a version duplicated here. Operator overrides that change which
// artifact Firebase runs are left entirely to the operator.
export function resolveExpectations({
  env = process.env,
  infoPath = env.FIRESTORE_GATE_INFO_JSON || DEFAULT_INFO_JSON,
  cacheDir = emulatorCacheDir(env),
} = {}) {
  if (env.FIRESTORE_EMULATOR_BINARY_PATH) {
    return { seedable: false, reason: 'operator-binary-override', cacheDir };
  }

  const declaration = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
  const declared = declaration.firestore;
  if (!declared?.remoteUrl || !declared?.downloadPathRelativeToCacheDir) {
    throw new Error(
      `firestore emulator declaration is incomplete in ${infoPath}`,
    );
  }

  const versionOverride = env.FIRESTORE_EMULATOR_VERSION;
  if (versionOverride && versionOverride !== declared.version) {
    return {
      seedable: false,
      reason: 'operator-version-override',
      cacheDir,
      version: versionOverride,
    };
  }

  return {
    seedable: true,
    version: declared.version,
    remoteUrl: declared.remoteUrl,
    cacheDir,
    destPath: path.join(cacheDir, declared.downloadPathRelativeToCacheDir),
    expectedSize: Number.isInteger(declared.expectedSize)
      ? declared.expectedSize
      : null,
    expectedSha256: declared.expectedChecksumSHA256 || null,
    expectedMd5: declared.expectedChecksum || null,
  };
}

function digestOf(filePath, algorithm) {
  const hash = createHash(algorithm);
  const fd = fs.openSync(filePath, 'r');
  const chunk = Buffer.alloc(1024 * 1024);
  try {
    for (
      let read = fs.readSync(fd, chunk, 0, chunk.length, null);
      read > 0;
      read = fs.readSync(fd, chunk, 0, chunk.length, null)
    ) {
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

// A cache entry is only trusted when it matches what Firebase expects to run. A
// half-written jar left behind by an earlier killed run is reported invalid so the
// download path replaces it instead of the JVM failing on a corrupt archive.
export function inspectJar({
  destPath,
  expectedSize,
  expectedSha256,
  expectedMd5,
}) {
  if (!fs.existsSync(destPath)) return { state: 'missing', destPath };
  let stat;
  try {
    stat = fs.statSync(destPath);
  } catch (err) {
    return {
      state: 'invalid',
      destPath,
      detail: `stat failed: ${err.code || err.message}`,
    };
  }
  if (expectedSize !== null && stat.size !== expectedSize) {
    return {
      state: 'invalid',
      destPath,
      detail: `size ${stat.size} != declared ${expectedSize}`,
    };
  }
  if (expectedSha256) {
    const actual = digestOf(destPath, 'sha256');
    if (actual !== expectedSha256) {
      return {
        state: 'invalid',
        destPath,
        detail: `sha256 ${actual} != declared ${expectedSha256}`,
      };
    }
  } else if (expectedMd5) {
    const actual = digestOf(destPath, 'md5');
    if (actual !== expectedMd5) {
      return {
        state: 'invalid',
        destPath,
        detail: `md5 ${actual} != declared ${expectedMd5}`,
      };
    }
  }
  return { state: 'ready', destPath, size: stat.size };
}

export async function seedJar(
  expectations,
  {
    attempts = DOWNLOAD_ATTEMPTS,
    timeoutMs = DOWNLOAD_TIMEOUT_MS,
    retryDelayMs = RETRY_DELAY_MS,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  const { remoteUrl, destPath, expectedSize, expectedSha256 } = expectations;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const algorithm = expectedSha256 ? 'sha256' : 'md5';
  const expectedDigest = expectedSha256 || expectations.expectedMd5;
  const failures = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const partial = `${destPath}.partial-${process.pid}-${attempt}`;
    try {
      const res = await fetchImpl(remoteUrl, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok || !res.body) {
        throw new Error(`download failed, status ${res.status}`);
      }
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(partial));
      if (expectedSize !== null && fs.statSync(partial).size !== expectedSize) {
        throw new Error(
          `download failed, expected ${expectedSize} bytes but got ${fs.statSync(partial).size}`,
        );
      }
      if (expectedDigest) {
        const actual = digestOf(partial, algorithm);
        if (actual !== expectedDigest) {
          throw new Error(
            `download failed, expected checksum ${expectedDigest} but got ${actual}`,
          );
        }
      }
      fs.renameSync(partial, destPath);
      return {
        ok: true,
        attempt,
        attempts: attempt,
        destPath,
        verifiedBy: expectedDigest ? algorithm : 'size-only',
      };
    } catch (err) {
      fs.rmSync(partial, { force: true });
      failures.push(`attempt ${attempt}: ${redactedLine(errMessage(err))}`);
      if (attempt < attempts) await sleep(retryDelayMs);
    }
  }

  return { ok: false, attempt: attempts, attempts, failures };
}

function errMessage(err) {
  const parts = [];
  for (
    let current = err;
    current && parts.length < 3;
    current = current.cause
  ) {
    const part = current.code || current.message || String(current);
    if (!parts.includes(part)) parts.push(String(part));
  }
  return parts.join(': ').replace(/\?.*$/, '?query-stripped').slice(0, 300);
}

export function diagnosticBlock({
  stage,
  exitCode,
  assertionsEvaluated,
  failures = [],
  evidence = [],
  log,
}) {
  const excerpt = boundedExcerpt(log);
  const lines = [
    `::error title=Firestore emulator gate failed closed::stage=${stage} exit=${exitCode} assertionsEvaluated=${assertionsEvaluated}`,
    `[firestore-gate] stage=${stage} exit=${exitCode} assertionsEvaluated=${assertionsEvaluated}`,
  ];
  if (evidence.length > 0) {
    lines.push(
      `[firestore-gate] evidence=${redactedLine(evidence.join(' | '))}`,
    );
  }
  for (const failure of failures) {
    lines.push(`[firestore-gate] bootstrap-attempt=${redactedLine(failure)}`);
  }
  if (excerpt) {
    lines.push(
      `[firestore-gate] --- bounded sanitized log tail (max ${DIAGNOSTIC_MAX_LINES} lines) ---`,
    );
    lines.push(excerpt);
    lines.push('[firestore-gate] --- end of tail ---');
  }
  lines.push(
    stage === STAGE_BOOTSTRAP
      ? '[firestore-gate] the emulator artifact never became available: no contract assertion was evaluated. The required check stays failed; one supported infrastructure retry of the failed job at the unchanged reviewed head is the bounded recovery, and the original failed log remains the evidence.'
      : stage === STAGE_CONTRACT_EXECUTION
        ? '[firestore-gate] contract assertions were evaluated and failed: this is a real product failure, never an infrastructure blip, and it must not be retried into green.'
        : '[firestore-gate] the stage above is the deepest stage with log evidence; treat it as a failed required check until the stage is resolved.',
  );
  return `${lines.join('\n')}\n`;
}

export async function preflight({
  env = process.env,
  log = (line) => process.stdout.write(line),
  ...seedOptions
} = {}) {
  const expectations = resolveExpectations({ env });
  if (!expectations.seedable) {
    log(
      `[firestore-gate] stage=${STAGE_BOOTSTRAP} status=skipped reason=${expectations.reason}\n`,
    );
    return { ok: true, status: 'skipped' };
  }

  const declared = `version=${expectations.version} cacheDir=${expectations.cacheDir}`;
  const inspection = inspectJar(expectations);
  if (inspection.state === 'ready') {
    log(
      `[firestore-gate] stage=${STAGE_BOOTSTRAP} status=cached ${declared} bytes=${inspection.size}\n`,
    );
    return { ok: true, status: 'cached' };
  }
  if (inspection.state === 'invalid') {
    log(
      `[firestore-gate] stage=${STAGE_BOOTSTRAP} status=invalid detail=${redactedLine(inspection.detail)}\n`,
    );
  }

  const startedAt = Date.now();
  log(
    `[firestore-gate] stage=${STAGE_BOOTSTRAP} status=fetching ${declared} attempts=${seedOptions.attempts ?? DOWNLOAD_ATTEMPTS}\n`,
  );
  const seeded = await seedJar(expectations, seedOptions);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (seeded.ok) {
    log(
      `[firestore-gate] stage=${STAGE_BOOTSTRAP} status=seeded attempt=${seeded.attempt} elapsedS=${seconds} verifiedBy=${seeded.verifiedBy}\n`,
    );
    return { ok: true, status: 'seeded', seeded };
  }

  log(
    `[firestore-gate] stage=${STAGE_BOOTSTRAP} status=failed elapsedS=${seconds} attempts=${seeded.attempts}\n`,
  );
  return { ok: false, status: 'failed', failures: seeded.failures };
}

class BoundedBuffer {
  constructor(maxBytes = BUFFER_MAX_BYTES) {
    this.maxBytes = maxBytes;
    this.chunks = [];
    this.bytes = 0;
  }

  push(chunk) {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift().length;
    }
  }

  text() {
    return Buffer.concat(
      this.chunks.map((chunk) => Buffer.from(chunk)),
    ).toString('utf8');
  }
}

function runCommand(command, { env, onChunk }) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', command], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = createSanitizingLineWriter(process.stdout);
    const stderr = createSanitizingLineWriter(process.stderr);
    child.stdout.on('data', (chunk) => {
      stdout.push(chunk);
      onChunk(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk);
      onChunk(chunk);
    });
    const relay = (signal) => child.kill(signal);
    process.on('SIGINT', relay);
    process.on('SIGTERM', relay);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      process.off('SIGINT', relay);
      process.off('SIGTERM', relay);
      stdout.flush();
      stderr.flush();
      resolve(signal ? { exitCode: 1, signal } : { exitCode: code ?? 1 });
    });
  });
}

export async function runGate({
  env = process.env,
  command = env.FIRESTORE_GATE_EXEC_CMD || DEFAULT_EXEC_CMD,
  preflightOptions = {},
  log = (line) => process.stdout.write(line),
} = {}) {
  const boot = await preflight({ env, log, ...preflightOptions });
  if (!boot.ok) {
    process.stderr.write(
      diagnosticBlock({
        stage: STAGE_BOOTSTRAP,
        exitCode: 1,
        assertionsEvaluated: 'no',
        failures: boot.failures,
      }),
    );
    return 1;
  }

  const buffer = new BoundedBuffer();
  const startedAt = Date.now();
  const { exitCode } = await runCommand(command, {
    env,
    onChunk: (chunk) => buffer.push(chunk),
  });
  const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
  const captured = buffer.text();
  const verdict = classifyFailure({ exitCode, log: captured });

  if (exitCode === 0) {
    const stage =
      verdict.stage === STAGE_UNKNOWN
        ? STAGE_CONTRACT_EXECUTION
        : verdict.stage;
    log(
      `[firestore-gate] stage=${stage} status=passed elapsedS=${elapsedS} assertionsEvaluated=${verdict.assertionsEvaluated}\n`,
    );
    return 0;
  }

  process.stderr.write(
    diagnosticBlock({
      stage: verdict.stage,
      exitCode,
      assertionsEvaluated: verdict.assertionsEvaluated,
      evidence: verdict.evidence,
      log: captured,
    }),
  );
  return exitCode || 1;
}

function intFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

// Bounded retry knobs. The defaults are deliberately small: the gate may add a
// couple of bounded download attempts to the required job, never an unbounded
// wait, and the retry only ever covers the artifact fetch before a contract runs.
function retryPolicy(env) {
  return {
    attempts: Math.max(
      1,
      intFromEnv(env.FIRESTORE_GATE_DOWNLOAD_ATTEMPTS, DOWNLOAD_ATTEMPTS),
    ),
    retryDelayMs: intFromEnv(env.FIRESTORE_GATE_RETRY_DELAY_MS, RETRY_DELAY_MS),
    timeoutMs: intFromEnv(
      env.FIRESTORE_GATE_DOWNLOAD_TIMEOUT_MS,
      DOWNLOAD_TIMEOUT_MS,
    ),
  };
}

async function main(argv) {
  const mode = argv[0] || 'run';
  const env = process.env;
  const policy = retryPolicy(env);

  if (mode === 'preflight') {
    const result = await preflight({
      env,
      log: (line) => process.stderr.write(line),
      ...policy,
    });
    return result.ok ? 0 : 1;
  }

  if (mode === 'classify') {
    const flags = Object.fromEntries(
      argv.slice(1).map((arg) => {
        const [key, ...rest] = arg.replace(/^--/, '').split('=');
        return [key, rest.join('=')];
      }),
    );
    const log = flags.log ? fs.readFileSync(flags.log, 'utf8') : '';
    const verdict = classifyFailure({ exitCode: Number(flags.code ?? 1), log });
    process.stdout.write(`${JSON.stringify(verdict)}\n`);
    return verdict.stage === STAGE_UNKNOWN ? 3 : 0;
  }

  if (mode !== 'run') {
    process.stderr.write(
      `usage: node tools/firestore-emulator-gate.mjs [run|preflight|classify --code=N --log=FILE]\n`,
    );
    return 64;
  }

  return runGate({ env, preflightOptions: policy });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
