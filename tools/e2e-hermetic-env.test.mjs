/* eslint-disable vitest/no-import-node-test -- CI runs this boundary test with node --test before installing workspace dependencies. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wrapper = path.join(root, 'tools/e2e/run-hermetic.sh');
const validator = path.join(root, 'tools/e2e/validate-env.mjs');

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
    process.stdout.write('hermetic environment verified\\n');
  `;

  const result = spawnSync(wrapper, [process.execPath, '-e', probe], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...Object.fromEntries(credentialKeys.map((key) => [key, sentinel])),
      LCARS_E2E_UNRELATED: sentinel,
      DEBUG: 'true',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'hermetic environment verified\n');
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /sentinel-value/u);
});

test('safe Playwright selection controls cross the E2E boundary', () => {
  const controls = {
    E2E_GREP: '@smoke|@visual',
    SKIP_VISUAL: '1',
    UPDATE_SNAPSHOTS: '1',
    VISUAL_ONLY: '1',
  };
  const probe = `
    const expected = ${JSON.stringify(controls)};
    if (Object.entries(expected).some(([key, value]) => process.env[key] !== value)) {
      process.exit(9);
    }
    process.stdout.write('selection controls verified\\n');
  `;

  const result = spawnSync(wrapper, [process.execPath, '-e', probe], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...controls },
  });

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
    const result = spawnSync(wrapper, [process.execPath, '-e', probe], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, HOME: callerHome },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'tool caches verified\n');
  } finally {
    fs.rmSync(callerHome, { recursive: true, force: true });
  }
});

test('Playwright uses the platform-specific macOS browser cache', () => {
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
    const result = spawnSync(wrapper, [process.execPath, '-e', probe], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: callerHome,
        PATH: `${fakeBin}:${process.env.PATH}`,
        PLAYWRIGHT_BROWSERS_PATH: '',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'darwin browser cache verified\n');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
