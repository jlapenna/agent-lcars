import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { test } from 'vitest';

import {
  assertSuccessfulNavigation,
  defaultStatePath,
  loadStorageState,
  matchesTargetLocation,
  normalizeOrigin,
  savedSessionExpiration,
  saveStorageState,
  secretNameForRole,
  sessionStatus,
  targetUrlFor,
  verificationStatus,
} from './saved-session-lib.mjs';

const STORAGE_STATE = {
  cookies: [
    {
      name: 'authjs.session-token',
      value: 'dummy-session-cookie',
      domain: 'example.com',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ],
  origins: [],
};

test('role checks distinguish an admin from any authenticated user', () => {
  const admin = { user: { id: '1', isAdmin: true } };
  const user = { user: { id: '2', isAdmin: false } };

  assert.equal(sessionStatus(admin, 'admin'), 'ok');
  assert.equal(sessionStatus(admin, 'user'), 'ok');
  assert.equal(sessionStatus(user, 'admin'), 'wrong-role');
  assert.equal(sessionStatus(user, 'user'), 'ok');
  assert.equal(sessionStatus({}, 'user'), 'expired');
});

test('authenticated login redirects are classified after session and role checks', () => {
  const target = new URL('https://console.example/sessions');
  const login = new URL('https://console.example/login');
  const admin = { user: { id: '1', isAdmin: true } };
  const user = { user: { id: '2', isAdmin: false } };

  assert.equal(verificationStatus(admin, 'admin', login, target), 'redirected');
  assert.equal(verificationStatus(user, 'admin', login, target), 'wrong-role');
  assert.equal(verificationStatus(user, 'user', login, target), 'redirected');
  assert.equal(verificationStatus({}, 'user', login, target), 'expired');
  assert.equal(verificationStatus(admin, 'admin', target, target), 'ok');
});

test('session targets stay on the configured origin', () => {
  assert.equal(
    targetUrlFor('https://console.example', '/sessions?id=1').toString(),
    'https://console.example/sessions?id=1',
  );
  assert.throws(
    () => targetUrlFor('https://console.example', '//attacker.example/path'),
    /one slash/,
  );
  assert.throws(
    () => normalizeOrigin('https://user:secret@console.example'),
    /without credentials/,
  );
});

test('saved session expiry ignores unrelated and non-persistent cookies', () => {
  assert.equal(
    savedSessionExpiration({
      cookies: [
        { name: 'analytics', expires: 9999999999 },
        { name: '__Secure-authjs.session-token.0', expires: 200 },
        { name: '__Secure-authjs.session-token.1', expires: 190 },
        { name: 'authjs.callback-url', expires: 180 },
      ],
      origins: [],
    }),
    190,
  );
  assert.equal(savedSessionExpiration(STORAGE_STATE), undefined);
});

test('destination checks preserve meaningful query and hash state', () => {
  const target = new URL(
    'https://console.example/inbox?repo=lcars&q=open#queue',
  );

  assert.equal(
    matchesTargetLocation(
      new URL('https://console.example/inbox?q=open&repo=lcars#queue'),
      target,
    ),
    true,
  );
  assert.equal(
    matchesTargetLocation(
      new URL('https://console.example/inbox?repo=lcars#queue'),
      target,
    ),
    false,
  );
  assert.equal(
    matchesTargetLocation(
      new URL('https://console.example/inbox?repo=lcars&q=open#other'),
      target,
    ),
    false,
  );
});

test('navigation checks reject missing and unsuccessful document responses', () => {
  const target = new URL('https://console.example/missing');

  assert.throws(
    () => assertSuccessfulNavigation(null, target),
    /returned no response/,
  );
  assert.throws(
    () =>
      assertSuccessfulNavigation(
        {
          ok: () => false,
          status: () => 404,
          statusText: () => 'Not Found',
        },
        target,
      ),
    /HTTP 404 Not Found/,
  );
  assert.doesNotThrow(() =>
    assertSuccessfulNavigation({ ok: () => true }, target),
  );
});

test('default local paths are outside the repository and role-specific', () => {
  assert.equal(
    defaultStatePath('admin', {
      env: {},
      homeDirectory: '/home/tester',
    }),
    '/home/tester/.local/state/agent-lcars/sessions/admin.json',
  );
  assert.equal(secretNameForRole('user'), 'AGENT_LCARS_USER_STORAGE_STATE');
});

test('local storage states are written atomically with private permissions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lcars-session-'));
  const stateFile = path.join(directory, 'nested', 'admin.json');

  await saveStorageState(STORAGE_STATE, {
    storage: 'local',
    role: 'admin',
    stateFile,
  });

  assert.equal((await stat(path.dirname(stateFile))).mode & 0o777, 0o700);
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  assert.deepEqual(
    JSON.parse(await readFile(stateFile, 'utf8')),
    STORAGE_STATE,
  );
  assert.deepEqual(
    (await loadStorageState({ storage: 'local', role: 'admin', stateFile }))
      .storageState,
    STORAGE_STATE,
  );
});

test('local storage refuses a caller-owned directory with public permissions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lcars-session-'));
  const publicDirectory = path.join(directory, 'public');
  await mkdir(publicDirectory, { mode: 0o755 });
  await chmod(publicDirectory, 0o755);

  await assert.rejects(
    saveStorageState(STORAGE_STATE, {
      storage: 'local',
      role: 'admin',
      stateFile: path.join(publicDirectory, 'admin.json'),
    }),
    /non-private directory/,
  );
  assert.equal((await stat(publicDirectory)).mode & 0o777, 0o755);
});

test('secret storage adds a version then destroys every older live version', async () => {
  const calls = [];
  const runFile = (file, args, options) => {
    calls.push({ file, args, options });
    if (args[2] === 'add') {
      return 'projects/test-project/secrets/TEST_STORAGE_STATE/versions/12\n';
    }
    if (args[2] === 'list') {
      return JSON.stringify([
        {
          name: 'projects/test-project/secrets/TEST_STORAGE_STATE/versions/12',
          state: 'ENABLED',
        },
        {
          name: 'projects/test-project/secrets/TEST_STORAGE_STATE/versions/11',
          state: 'DISABLED',
        },
        {
          name: 'projects/test-project/secrets/TEST_STORAGE_STATE/versions/10',
          state: 'DESTROYED',
        },
      ]);
    }
    return '';
  };

  await saveStorageState(
    STORAGE_STATE,
    {
      storage: 'secret',
      role: 'admin',
      project: 'test-project',
      secretName: 'TEST_STORAGE_STATE',
    },
    { runFile },
  );

  assert.deepEqual(calls[0].args.slice(0, 3), ['secrets', 'versions', 'add']);
  assert.equal(calls[0].args.includes('create'), false);
  assert.deepEqual(calls[1].args.slice(0, 3), ['secrets', 'versions', 'list']);
  assert.deepEqual(calls[2].args.slice(0, 4), [
    'secrets',
    'versions',
    'destroy',
    '11',
  ]);
  assert.deepEqual(
    JSON.parse(Buffer.from(calls[0].options.input, 'base64').toString('utf8')),
    STORAGE_STATE,
  );
});

test('secret storage preserves the replacement when version cleanup fails', async () => {
  const calls = [];
  const runFile = (_file, args) => {
    calls.push(args);
    if (args[2] === 'add') {
      return 'projects/test-project/secrets/TEST_STORAGE_STATE/versions/12\n';
    }
    throw new Error('list denied');
  };

  await assert.rejects(
    saveStorageState(
      STORAGE_STATE,
      {
        storage: 'secret',
        role: 'admin',
        project: 'test-project',
        secretName: 'TEST_STORAGE_STATE',
      },
      { runFile },
    ),
    /Added a replacement version.*could not prune older versions/,
  );
  assert.deepEqual(
    calls.map((args) => args[2]),
    ['add', 'list'],
  );
});

test('secret storage states can be loaded from their encoded version', async () => {
  const encoded = Buffer.from(JSON.stringify(STORAGE_STATE)).toString('base64');
  const runFile = () => `${encoded}\n`;

  const result = await loadStorageState(
    {
      storage: 'secret',
      role: 'admin',
      project: 'test-project',
      secretName: 'TEST_STORAGE_STATE',
    },
    { runFile },
  );

  assert.deepEqual(result.storageState, STORAGE_STATE);
  assert.equal(result.source, 'test-project/TEST_STORAGE_STATE');
});
