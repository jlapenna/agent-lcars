/* eslint-disable vitest/no-import-node-test -- the published Action runs dependency-free under plain Node. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CREDENTIAL_GRANT_OIDC_AUDIENCE,
  CREDENTIAL_GRANT_URL,
  CredentialGrantClientError,
  credentialGrantRequest,
  exchangeCredentialGrant,
  parseCredentialGrantResult,
  runCredentialGrantAction,
} from './credential-grant.mjs';

const ATTEMPT_ID = 'A'.repeat(22);
const JWT = 'header.payload.signature';
const T0 = '2026-08-14T19:00:00.000Z';
const T1 = '2026-08-14T19:30:00.000Z';
const T2 = '2026-08-14T19:45:00.000Z';
const T3 = '2026-08-14T20:00:00.000Z';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function issued(overrides = {}) {
  return {
    kind: 'issued',
    token: 'ghs_ephemeral_token',
    grantId: 'grant-1',
    credentialProfileId: 'profile-1',
    issuedAt: T0,
    tokenExpiresAt: T1,
    renewalDeadline: T2,
    maxResidualTokenExpiry: T3,
    ...overrides,
  };
}

test('requests the fixed audience and endpoint exactly once', async () => {
  const requests = [];
  const result = await exchangeCredentialGrant({
    attemptId: ATTEMPT_ID,
    requestId: 'request-1',
    oidcRequestUrl:
      'https://pipelines.actions.githubusercontent.com/oidc?api-version=2.0',
    oidcRequestToken: 'oidc-request-secret',
    async fetchImpl(url, init) {
      requests.push({ url: String(url), init });
      return requests.length === 1
        ? response(200, { value: JWT })
        : response(200, issued());
    },
  });

  assert.deepEqual(result, issued());
  assert.equal(requests.length, 2);
  const oidcUrl = new URL(requests[0].url);
  assert.equal(
    oidcUrl.origin,
    'https://pipelines.actions.githubusercontent.com',
  );
  assert.equal(
    oidcUrl.searchParams.get('audience'),
    CREDENTIAL_GRANT_OIDC_AUDIENCE,
  );
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(requests[1].url, CREDENTIAL_GRANT_URL);
  assert.equal(requests[1].init.redirect, 'error');
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    schema: 'agent-lcars.credential-grant-request/v1',
    version: 1,
    requestId: 'request-1',
    attemptId: ATTEMPT_ID,
  });
  assert.equal(requests[1].init.headers.Authorization, `Bearer ${JWT}`);
});

test('rejects local markers, malformed requests, and untrusted OIDC origins before I/O', async () => {
  assert.throws(
    () => credentialGrantRequest({ attemptId: 'g1:intent-1', requestId: 'r' }),
    CredentialGrantClientError,
  );
  assert.throws(
    () =>
      credentialGrantRequest({ attemptId: ATTEMPT_ID, requestId: 'bad id' }),
    CredentialGrantClientError,
  );

  let calls = 0;
  await assert.rejects(
    exchangeCredentialGrant({
      attemptId: ATTEMPT_ID,
      requestId: 'request-1',
      oidcRequestUrl: 'https://evil.example/id-token',
      oidcRequestToken: 'request-secret',
      async fetchImpl() {
        calls += 1;
      },
    }),
    CredentialGrantClientError,
  );
  assert.equal(calls, 0);
});

test('strictly parses issued, denied, and terminal results', () => {
  assert.deepEqual(parseCredentialGrantResult(issued()), issued());
  assert.deepEqual(
    parseCredentialGrantResult({
      kind: 'denied',
      code: 'mint_in_progress',
      retryAfter: T1,
    }),
    { kind: 'denied', code: 'mint_in_progress', retryAfter: T1 },
  );
  assert.deepEqual(
    parseCredentialGrantResult({
      kind: 'terminal',
      terminalState: 'superseded',
    }),
    { kind: 'terminal', terminalState: 'superseded' },
  );

  for (const invalid of [
    { ...issued(), extra: true },
    issued({ tokenExpiresAt: T0 }),
    issued({ token: 'token\noutput-injection' }),
    { kind: 'denied', code: 'try_again' },
    { kind: 'terminal', terminalState: 'running' },
    { kind: 'unknown' },
  ]) {
    assert.throws(
      () => parseCredentialGrantResult(invalid),
      CredentialGrantClientError,
    );
  }
});

test('rejects malformed OIDC JSON without dispatching the grant', async () => {
  for (const oidcBody of [
    {},
    { value: JWT, extra: true },
    { value: 'not-a-jwt' },
  ]) {
    let calls = 0;
    await assert.rejects(
      exchangeCredentialGrant({
        attemptId: ATTEMPT_ID,
        requestId: 'request-1',
        oidcRequestUrl: 'https://token.actions.githubusercontent.com/id-token',
        oidcRequestToken: 'request-secret',
        async fetchImpl() {
          calls += 1;
          return response(200, oidcBody);
        },
      }),
      CredentialGrantClientError,
    );
    assert.equal(calls, 1);
  }
});

test('never retries or leaks a failed OIDC request', async () => {
  for (const failure of ['throw', 'http']) {
    let calls = 0;
    const secret = `oidc-secret-${failure}`;
    let error;
    try {
      await exchangeCredentialGrant({
        attemptId: ATTEMPT_ID,
        requestId: 'request-1',
        oidcRequestUrl: 'https://token.actions.githubusercontent.com/id-token',
        oidcRequestToken: 'request-secret',
        async fetchImpl() {
          calls += 1;
          if (failure === 'throw') throw new Error(secret);
          return response(503, { leaked: secret });
        },
      });
      assert.fail('CredentialGrant exchange unexpectedly succeeded');
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof CredentialGrantClientError);
    assert.equal(calls, 1);
    assert.doesNotMatch(error.message, new RegExp(secret, 'u'));
  }
});

test('never retries an ambiguous or failed grant POST', async () => {
  for (const failure of ['throw', 'http']) {
    let calls = 0;
    const secret = `secret-response-${failure}`;
    let error;
    try {
      await exchangeCredentialGrant({
        attemptId: ATTEMPT_ID,
        requestId: 'request-1',
        oidcRequestUrl: 'https://token.actions.githubusercontent.com/id-token',
        oidcRequestToken: 'request-secret',
        async fetchImpl() {
          calls += 1;
          if (calls === 1) return response(200, { value: JWT });
          if (failure === 'throw') throw new Error(secret);
          return response(503, { leaked: secret });
        },
      });
      assert.fail('CredentialGrant exchange unexpectedly succeeded');
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof CredentialGrantClientError);
    assert.equal(calls, 2);
    assert.doesNotMatch(error.message, new RegExp(secret, 'u'));
    assert.match(error.message, /outcome is unknown/u);
  }
});

test('masks an issued token before exposing typed outputs', async () => {
  const events = [];
  let fetches = 0;
  const result = await runCredentialGrantAction({
    env: {
      INPUT_ATTEMPT_ID: ATTEMPT_ID,
      INPUT_REQUEST_ID: 'request-1',
      ACTIONS_ID_TOKEN_REQUEST_URL:
        'https://token.actions.githubusercontent.com/id-token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-secret',
    },
    async fetchImpl() {
      fetches += 1;
      events.push({ kind: 'fetch' });
      return fetches === 1
        ? response(200, { value: JWT })
        : response(200, issued());
    },
    maskSecret(value) {
      events.push({ kind: 'mask', value });
    },
    async setOutput(name, value) {
      events.push({ kind: 'output', name, value });
    },
  });

  assert.equal(result.kind, 'issued');
  const maskAt = events.findIndex((event) => event.kind === 'mask');
  const tokenOutputAt = events.findIndex(
    (event) => event.kind === 'output' && event.name === 'token',
  );
  assert.ok(maskAt >= 0 && maskAt < tokenOutputAt);
  assert.equal(events[maskAt].value, issued().token);
});

test('exposes denied and terminal results without a token output', async () => {
  for (const grantResult of [
    { kind: 'denied', code: 'attempt_cancelled' },
    { kind: 'terminal', terminalState: 'cancelled' },
  ]) {
    const events = [];
    let fetches = 0;
    await runCredentialGrantAction({
      env: {
        INPUT_ATTEMPT_ID: ATTEMPT_ID,
        INPUT_REQUEST_ID: 'request-1',
        ACTIONS_ID_TOKEN_REQUEST_URL:
          'https://token.actions.githubusercontent.com/id-token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-secret',
      },
      async fetchImpl() {
        fetches += 1;
        return fetches === 1
          ? response(200, { value: JWT })
          : response(200, grantResult);
      },
      maskSecret(value) {
        events.push({ kind: 'mask', value });
      },
      async setOutput(name, value) {
        events.push({ kind: 'output', name, value });
      },
    });
    assert.equal(
      events.some((event) => event.kind === 'mask'),
      false,
    );
    assert.equal(
      events.some((event) => event.kind === 'output' && event.name === 'token'),
      false,
    );
    assert.ok(
      events.some((event) => event.kind === 'output' && event.name === 'kind'),
    );
  }
});
