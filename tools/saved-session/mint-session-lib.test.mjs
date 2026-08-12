import assert from 'node:assert/strict';

import { decode } from 'next-auth/jwt';
import { test } from 'vitest';

import {
  mintStorageState,
  readSecretValue,
  SESSION_MAX_AGE_SECONDS,
  sessionCookieName,
  VERIFICATION_SUBJECT,
} from './mint-session-lib.mjs';

test('production sessions use the Auth.js secure cookie name', () => {
  assert.equal(
    sessionCookieName('https://lcars.example'),
    '__Secure-authjs.session-token',
  );
  assert.equal(
    sessionCookieName('http://localhost:4200'),
    'authjs.session-token',
  );
});

test('minted state contains a dedicated, decodable admin verification session', async () => {
  const authSecret = 'unit-test-auth-secret';
  const now = Date.UTC(2026, 7, 12, 12, 0, 0);
  const storageState = await mintStorageState({
    authSecret,
    origin: 'https://lcars.example',
    now,
  });
  const cookie = storageState.cookies[0];
  const payload = await decode({
    token: cookie.value,
    secret: authSecret,
    salt: cookie.name,
  });

  assert.equal(cookie.name, '__Secure-authjs.session-token');
  assert.equal(cookie.domain, 'lcars.example');
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.secure, true);
  assert.equal(
    cookie.expires,
    Math.floor(now / 1000) + SESSION_MAX_AGE_SECONDS,
  );
  assert.equal(payload.sub, VERIFICATION_SUBJECT);
  assert.equal(payload.githubLogin, VERIFICATION_SUBJECT);
  assert.equal(payload.isAdmin, true);
  assert.equal(payload.verificationSession, true);
  assert.deepEqual(storageState.origins, []);
});

test('Auth.js secret access is narrow and never prints the value', () => {
  let call;
  const value = readSecretValue('AUTH_SECRET', 'test-project', {
    runFile(file, args, options) {
      call = { file, args, options };
      return 'super-secret-value';
    },
  });

  assert.equal(value, 'super-secret-value');
  assert.equal(call.file, 'gcloud');
  assert.deepEqual(call.args, [
    'secrets',
    'versions',
    'access',
    'latest',
    '--secret=AUTH_SECRET',
    '--project=test-project',
  ]);
  assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('empty or unavailable Auth.js secrets fail closed', () => {
  assert.throws(
    () =>
      readSecretValue('AUTH_SECRET', 'test-project', {
        runFile: () => '',
      }),
    /is empty/,
  );
  assert.throws(
    () =>
      readSecretValue('AUTH_SECRET', 'test-project', {
        runFile: () => {
          throw new Error('gcloud included sensitive details');
        },
      }),
    /Could not read AUTH_SECRET/,
  );
});
