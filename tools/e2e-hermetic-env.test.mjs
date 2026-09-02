/* eslint-disable vitest/no-import-node-test -- CI runs this boundary test with node --test before installing workspace dependencies. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const e2eLocal = path.join(root, 'tools/e2e-local.sh');
const validator = path.join(root, 'tools/e2e/validate-env.mjs');
function runThroughE2eBoundary(probe, env = {}, excludedEnvironmentKeys = []) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-e2e-probe-'));
  const fakeBin = path.join(tempDir, 'bin');
  const probeFile = path.join(tempDir, 'probe.mjs');
  const pnpm = path.join(fakeBin, 'pnpm');
  const inheritedEnvironment = { ...process.env };
  for (const key of excludedEnvironmentKeys) {
    delete inheritedEnvironment[key];
  }
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(probeFile, probe);
  fs.writeFileSync(
    pnpm,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(probeFile)}\n`,
  );
  fs.chmodSync(pnpm, 0o755);

  try {
    return spawnSync(e2eLocal, [], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...inheritedEnvironment,
        ...env,
        E2E_LOCAL_LOCK_FILE: path.join(tempDir, 'e2e-local.lock'),
        PATH: `${fakeBin}:${env.PATH ?? process.env.PATH}`,
      },
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('ambient credentials cannot cross the E2E boundary', () => {
  const sentinel = 'sentinel-value-that-must-not-appear';
  const credentialKeys = [
    'OPENCODE_LLM_API_KEY',
    'GITHUB_TOKEN',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'AWS_SECRET_ACCESS_KEY',
  ];
  const probe = `
    const forbidden = ${JSON.stringify(credentialKeys)};
    if (forbidden.some((key) => process.env[key] !== undefined)) process.exit(9);
    if (process.env.LCARS_E2E_UNRELATED !== undefined) process.exit(10);
    if (process.env.DEBUG !== undefined) process.exit(11);
    if (process.env.NX_DAEMON !== 'false') process.exit(12);
    if (process.env.AUTH_SECRET !== 'dummy-secret') process.exit(13);
    if (process.env.HOME === ${JSON.stringify(process.env.HOME)}) process.exit(14);
    if (process.env.E2E_HERMETIC !== '1') process.exit(15);
    if (process.env.NX_LOAD_DOT_ENV_FILES !== 'false') process.exit(16);
    if (process.env.NX_CACHE_DIRECTORY !== process.env.HOME + '/nx-cache') process.exit(17);
    process.stdout.write('hermetic environment verified\\n');
  `;

  const result = runThroughE2eBoundary(probe, {
    ...Object.fromEntries(credentialKeys.map((key) => [key, sentinel])),
    LCARS_E2E_UNRELATED: sentinel,
    DEBUG: 'true',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'hermetic environment verified\n');
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /sentinel-value/u);
});

test('the remote cache capability crosses the E2E boundary only as a complete pair', () => {
  const remoteCache = {
    NX_SELF_HOSTED_REMOTE_CACHE_SERVER: 'http://nx-cache.lan.jlapenna.net:3123',
    NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: 'test-token-not-a-credential',
  };
  const probe = `
    const expected = ${JSON.stringify(remoteCache)};
    if (Object.entries(expected).some(([key, value]) => process.env[key] !== value)) {
      process.exit(9);
    }
    process.stdout.write('remote cache capability verified\\n');
  `;

  const result = runThroughE2eBoundary(probe, remoteCache);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'remote cache capability verified\n');
});

test('an incomplete remote cache capability cannot cross the E2E boundary', () => {
  const probe = `
    if (process.env.NX_SELF_HOSTED_REMOTE_CACHE_SERVER !== undefined) process.exit(9);
    if (process.env.NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN !== undefined) process.exit(10);
    process.stdout.write('incomplete remote cache capability rejected\\n');
  `;

  const result = runThroughE2eBoundary(
    probe,
    {
      NX_SELF_HOSTED_REMOTE_CACHE_SERVER:
        'http://nx-cache.lan.jlapenna.net:3123',
    },
    [
      'NX_SELF_HOSTED_REMOTE_CACHE_SERVER',
      'NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN',
    ],
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'incomplete remote cache capability rejected\n');
});

test('the safe Playwright selection control crosses the E2E boundary', () => {
  const controls = {
    E2E_GREP: '@smoke|@mobile-layout',
  };
  const probe = `
    const expected = ${JSON.stringify(controls)};
    if (Object.entries(expected).some(([key, value]) => process.env[key] !== value)) {
      process.exit(9);
    }
    process.stdout.write('selection controls verified\\n');
  `;

  const result = runThroughE2eBoundary(probe, controls);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'selection controls verified\n');
});

test('tool caches stay durable while HOME remains isolated', () => {
  const callerHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'lcars-e2e-caller-home-'),
  );
  const expectedCorepackHome = path.join(callerHome, '.cache/node/corepack');
  const expectedFirebaseHome = path.join(
    callerHome,
    '.cache/firebase/emulators',
  );
  const probe = `
    if (process.env.HOME === ${JSON.stringify(callerHome)}) process.exit(9);
    if (process.env.COREPACK_HOME !== ${JSON.stringify(expectedCorepackHome)}) {
      process.exit(10);
    }
    if (process.env.FIREBASE_EMULATORS_PATH !== ${JSON.stringify(expectedFirebaseHome)}) {
      process.exit(11);
    }
    process.stdout.write('tool caches verified\\n');
  `;

  try {
    const result = runThroughE2eBoundary(probe, { HOME: callerHome });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'tool caches verified\n');
  } finally {
    fs.rmSync(callerHome, { recursive: true, force: true });
  }
});

test('a simulated Windows uname selects the Windows Corepack cache path', () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'lcars-e2e-windows-corepack-cache-'),
  );
  const callerHome = path.join(tempDir, 'home');
  const fakeBin = path.join(tempDir, 'bin');
  const corepackCache = path.join(callerHome, 'AppData/Local/node/corepack');
  fs.mkdirSync(fakeBin, { recursive: true });
  const uname = path.join(fakeBin, 'uname');
  fs.writeFileSync(uname, '#!/bin/sh\nprintf "MINGW64_NT-10.0\\n"\n');
  fs.chmodSync(uname, 0o755);

  const probe = `
    if (process.env.HOME === ${JSON.stringify(callerHome)}) process.exit(9);
    if (process.env.COREPACK_HOME !== ${JSON.stringify(corepackCache)}) {
      process.exit(10);
    }
    process.stdout.write('windows Corepack cache verified\\n');
  `;

  try {
    const result = runThroughE2eBoundary(probe, {
      HOME: callerHome,
      PATH: `${fakeBin}:${process.env.PATH}`,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'windows Corepack cache verified\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('a simulated Darwin uname selects the macOS browser cache path', () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'lcars-e2e-darwin-cache-'),
  );
  const callerHome = path.join(tempDir, 'home');
  const fakeBin = path.join(tempDir, 'bin');
  const browserCache = path.join(callerHome, 'Library/Caches/ms-playwright');
  fs.mkdirSync(browserCache, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  const uname = path.join(fakeBin, 'uname');
  fs.writeFileSync(uname, '#!/bin/sh\nprintf "Darwin\\n"\n');
  fs.chmodSync(uname, 0o755);

  const probe = `
    if (process.env.PLAYWRIGHT_BROWSERS_PATH !== ${JSON.stringify(browserCache)}) {
      process.exit(9);
    }
    process.stdout.write('darwin browser cache verified\\n');
  `;

  try {
    const result = runThroughE2eBoundary(probe, {
      HOME: callerHome,
      PATH: `${fakeBin}:${process.env.PATH}`,
      PLAYWRIGHT_BROWSERS_PATH: '',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'darwin browser cache verified\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rejected Playwright arguments recommend the hermetic scoped path', () => {
  const result = spawnSync(e2eLocal, ['--grep', '@smoke'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /E2E_GREP='@smoke' \.\/tools\/e2e-local\.sh/u);
  assert.doesNotMatch(result.stderr, /:e2e-run/u);
});

test('ambient mode cannot select a non-hermetic live implementation', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-e2e-mode-'));
  const fakeBin = path.join(tempDir, 'bin');
  const argsFile = path.join(tempDir, 'pnpm-args');
  fs.mkdirSync(fakeBin, { recursive: true });
  const pnpm = path.join(fakeBin, 'pnpm');
  fs.writeFileSync(
    pnpm,
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n`,
  );
  fs.chmodSync(pnpm, 0o755);

  try {
    const result = spawnSync(e2eLocal, [], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        E2E_CONFIGURATION: 'live',
        E2E_LOCAL_LOCK_FILE: path.join(tempDir, 'e2e-local.lock'),
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(argsFile, 'utf8').trim().split('\n'), [
      'exec',
      'repo-nx',
      'run',
      '@agent-lcars/console-e2e:e2e-implementation:emulator',
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('a concurrent e2e-local run fails fast against the held host lock', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-e2e-lock-'));
  const fakeBin = path.join(tempDir, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  const pnpm = path.join(fakeBin, 'pnpm');
  // Simulates a long-running e2e-implementation run so the lock stays held
  // long enough for a concurrent contender to observe it (agent-lcars#535:
  // two real runs fight over the same fixed emulator/app ports instead of
  // failing cleanly).
  fs.writeFileSync(pnpm, '#!/bin/sh\nsleep 5\n');
  fs.chmodSync(pnpm, 0o755);
  const lockFile = path.join(tempDir, 'e2e-local.lock');
  const env = {
    ...process.env,
    E2E_LOCAL_LOCK_FILE: lockFile,
    PATH: `${fakeBin}:${process.env.PATH}`,
  };

  const holder = spawn(e2eLocal, [], { cwd: root, env, detached: true });
  try {
    const deadline = Date.now() + 5000;
    while (
      Date.now() < deadline &&
      (!fs.existsSync(lockFile) ||
        fs.readFileSync(lockFile, 'utf8').trim() === '')
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      fs.readFileSync(lockFile, 'utf8').trim(),
      String(holder.pid),
      'holder should have recorded its own pid before the contender races it',
    );

    const contender = spawnSync(e2eLocal, [], {
      cwd: root,
      encoding: 'utf8',
      env,
    });

    assert.equal(contender.status, 1);
    assert.match(
      contender.stderr,
      new RegExp(`another e2e-local is running \\(pid ${holder.pid}\\)`, 'u'),
    );
    // The lock's holder recorded pid must not have been clobbered by the
    // losing contender opening the same lock file.
    assert.equal(fs.readFileSync(lockFile, 'utf8').trim(), String(holder.pid));
  } finally {
    if (holder.pid) {
      try {
        process.kill(-holder.pid, 'SIGKILL');
      } catch {
        // Already exited.
      }
    }
    await new Promise((resolve) => holder.on('exit', resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('SIGTERM forwards to the E2E child before its temporary HOME is removed', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-e2e-signal-'));
  const fakeBin = path.join(tempDir, 'bin');
  const pnpm = path.join(fakeBin, 'pnpm');
  const readyFile = path.join(tempDir, 'ready');
  const signalFile = path.join(tempDir, 'signal');
  const lockFile = path.join(tempDir, 'e2e-local.lock');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(
    pnpm,
    [
      '#!/bin/sh',
      `trap 'if [ -d "$HOME" ] && [ -d "$TMPDIR" ]; then printf TERM > ${JSON.stringify(signalFile)}; else printf missing-home > ${JSON.stringify(signalFile)}; fi; exit 0' TERM`,
      `printf ready > ${JSON.stringify(readyFile)}`,
      'while :; do sleep 1; done',
      '',
    ].join('\n'),
  );
  fs.chmodSync(pnpm, 0o755);
  const env = {
    ...process.env,
    E2E_LOCAL_LOCK_FILE: lockFile,
    PATH: `${fakeBin}:${process.env.PATH}`,
  };
  const holder = spawn(e2eLocal, [], { cwd: root, env });
  const holderExit = new Promise((resolve) => {
    holder.once('exit', (code, signal) => resolve({ code, signal }));
  });

  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !fs.existsSync(readyFile)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(fs.existsSync(readyFile), 'the E2E child should have started');

    assert.ok(holder.pid, 'the e2e-local parent should expose a pid');
    process.kill(holder.pid, 'SIGTERM');
    const result = await holderExit;
    assert.equal(result.code, 143);
    assert.equal(result.signal, null);
    assert.equal(fs.readFileSync(signalFile, 'utf8'), 'TERM');

    fs.writeFileSync(pnpm, '#!/bin/sh\nexit 0\n');
    const successor = spawnSync(e2eLocal, [], {
      cwd: root,
      encoding: 'utf8',
      env,
    });
    assert.equal(successor.status, 0, successor.stderr);
  } finally {
    if (holder.exitCode === null && holder.signalCode === null && holder.pid) {
      try {
        process.kill(holder.pid, 'SIGKILL');
      } catch {
        // Already exited.
      }
    }
    await holderExit;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('a platform without flock on PATH fails clearly instead of an opaque error', () => {
  // Simulates a stock macOS or Windows Bash environment where flock is not
  // preinstalled (agent-lcars#535 review thread: this wrapper documents
  // supporting those platforms, so the lock must degrade honestly rather
  // than fail with a bash syntax error or a bare "command not found").
  // Only `bash` (to run the script at all) and `dirname` (used before the
  // flock check) are put on PATH -- deliberately no `flock`.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-e2e-noflock-'));
  const fakeBin = path.join(tempDir, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  for (const bin of ['bash', 'dirname']) {
    const real = spawnSync('/bin/sh', ['-c', `command -v ${bin}`], {
      encoding: 'utf8',
    }).stdout.trim();
    assert.ok(real, `expected to locate ${bin} on the host`);
    fs.symlinkSync(real, path.join(fakeBin, bin));
  }

  try {
    const result = spawnSync(e2eLocal, [], {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: fakeBin },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /flock is required/u);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('public and internal Nx targets explicitly reject live configuration', () => {
  const project = JSON.parse(
    fs.readFileSync(path.join(root, 'apps/console-e2e/project.json'), 'utf8'),
  );
  const e2e = project.targets.e2e;
  const rejectionCommand = './tools/e2e/reject-live.sh';

  assert.equal(e2e.defaultConfiguration, 'emulator');
  assert.equal(e2e.configurations.live.command, rejectionCommand);
  assert.equal(e2e.options.command, './tools/e2e-local.sh');
  assert.equal(project.targets['e2e-implementation'].cache, false);
  assert.equal(project.targets['e2e-build-hermetic'].cache, false);
  assert.equal(
    project.targets['e2e-implementation'].configurations.live.command,
    rejectionCommand,
  );
  assert.equal(
    project.targets['e2e-local'].configurations.live.command,
    rejectionCommand,
  );
});

test('dotenv validation names an unsafe key without echoing its value', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-e2e-env-test-'));
  const envFile = path.join(tempDir, '.env.e2e');
  const unsafeValue = 'sentinel-credential-value';
  fs.writeFileSync(envFile, `OPENCODE_LLM_API_KEY="${unsafeValue}"\n`);

  try {
    const result = spawnSync(process.execPath, [validator, envFile], {
      cwd: root,
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /OPENCODE_LLM_API_KEY/u);
    assert.doesNotMatch(result.stderr, new RegExp(unsafeValue, 'u'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('dotenv validation rejects generic debug output', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-e2e-env-test-'));
  const envFile = path.join(tempDir, '.env.e2e');
  fs.writeFileSync(envFile, 'DEBUG="true"\n');

  try {
    const result = spawnSync(process.execPath, [validator, envFile], {
      cwd: root,
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /DEBUG must not enable/u);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('dotenv validation rejects keys outside the checked-in schema', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcars-e2e-env-test-'));
  const envFile = path.join(tempDir, '.env.e2e');
  fs.writeFileSync(envFile, 'OPENAI_KEY="not-a-real-credential"\n');

  try {
    const result = spawnSync(process.execPath, [validator, envFile], {
      cwd: root,
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /OPENAI_KEY/u);
    assert.doesNotMatch(result.stderr, /not-a-real-credential/u);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('internal E2E target validation requires the isolation marker', () => {
  const result = spawnSync(
    process.execPath,
    [validator, '--require-hermetic', path.join(root, 'tools/e2e/ci.env')],
    {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires the hermetic wrapper/u);
});

test('isolation marker cannot bless an ambient credential', () => {
  const unsafeValue = 'sentinel-process-credential';
  const result = spawnSync(
    process.execPath,
    [validator, '--require-hermetic', path.join(root, 'tools/e2e/ci.env')],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        E2E_HERMETIC: '1',
        OPENAI_KEY: unsafeValue,
      },
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /OPENAI_KEY/u);
  assert.doesNotMatch(result.stderr, new RegExp(unsafeValue, 'u'));
});

test('Next auto-loaded dotenv files are validated before build', () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'lcars-next-env-test-'),
  );
  const unsafeValue = 'sentinel-next-credential';
  fs.writeFileSync(
    path.join(tempDir, '.env.local'),
    `OPENCODE_LLM_API_KEY="${unsafeValue}"\n`,
  );

  try {
    const result = spawnSync(
      process.execPath,
      [
        validator,
        '--require-hermetic',
        '--next-root',
        tempDir,
        path.join(root, 'tools/e2e/ci.env'),
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: { E2E_HERMETIC: '1', PATH: process.env.PATH },
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /OPENCODE_LLM_API_KEY/u);
    assert.doesNotMatch(result.stderr, new RegExp(unsafeValue, 'u'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
