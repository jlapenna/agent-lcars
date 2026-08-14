import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const CREDENTIAL_GRANT_OIDC_AUDIENCE = 'agent-lcars/credential-grant/v1';
export const CREDENTIAL_GRANT_URL =
  'https://lcars.jlapenna.net/api/control-plane/credential-grant';

const REQUEST_SCHEMA = 'agent-lcars.credential-grant-request/v1';
const GITHUB_OIDC_ORIGINS = new Set([
  'https://pipelines.actions.githubusercontent.com',
  'https://token.actions.githubusercontent.com',
]);
const ATTEMPT_ID = /^[A-Za-z0-9_-]{22,64}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const SAFE_BEARER = /^[\x21-\x7e]+$/u;
const MAX_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const DENIAL_CODES = new Set([
  'oidc_invalid',
  'binding_mismatch',
  'profile_denied',
  'attempt_not_active',
  'attempt_cancelled',
  'attempt_superseded',
  'attempt_expired',
  'renewal_deadline_elapsed',
  'jti_replayed',
  'request_replayed',
  'already_issued_no_replay',
  'mint_in_progress',
  'mint_unknown',
  'tenant_mismatch',
  'service_unavailable',
]);
const TERMINAL_STATES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'superseded',
  'lost',
  'expired',
]);

export class CredentialGrantClientError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CredentialGrantClientError';
  }
}

function fail(message) {
  throw new CredentialGrantClientError(message);
}

function isRecord(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertExactKeys(value, required, optional = []) {
  if (!isRecord(value)) fail('CredentialGrant response is invalid');
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    fail('CredentialGrant response is invalid');
  }
}

function validUtc(value) {
  return (
    typeof value === 'string' &&
    value.endsWith('Z') &&
    Number.isFinite(Date.parse(value))
  );
}

function validOpaqueId(value) {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

function validOutputToken(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
    })
  );
}

export function credentialGrantRequest({ attemptId, requestId }) {
  if (typeof attemptId !== 'string' || !ATTEMPT_ID.test(attemptId)) {
    fail('attempt-id must be a global Agent LCARS AttemptId');
  }
  if (typeof requestId !== 'string' || !OPAQUE_ID.test(requestId)) {
    fail('request-id is invalid');
  }
  return Object.freeze({
    schema: REQUEST_SCHEMA,
    version: 1,
    requestId,
    attemptId,
  });
}

export function parseCredentialGrantResult(value) {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    fail('CredentialGrant response is invalid');
  }

  if (value.kind === 'issued') {
    assertExactKeys(value, [
      'kind',
      'token',
      'grantId',
      'credentialProfileId',
      'issuedAt',
      'tokenExpiresAt',
      'renewalDeadline',
      'maxResidualTokenExpiry',
    ]);
    if (
      !validOutputToken(value.token) ||
      !validOpaqueId(value.grantId) ||
      !validOpaqueId(value.credentialProfileId) ||
      !validUtc(value.issuedAt) ||
      !validUtc(value.tokenExpiresAt) ||
      !validUtc(value.renewalDeadline) ||
      !validUtc(value.maxResidualTokenExpiry)
    ) {
      fail('CredentialGrant response is invalid');
    }
    const issuedAt = Date.parse(value.issuedAt);
    const tokenExpiresAt = Date.parse(value.tokenExpiresAt);
    const renewalDeadline = Date.parse(value.renewalDeadline);
    const maxResidualTokenExpiry = Date.parse(value.maxResidualTokenExpiry);
    if (
      tokenExpiresAt <= issuedAt ||
      renewalDeadline <= issuedAt ||
      maxResidualTokenExpiry < tokenExpiresAt ||
      tokenExpiresAt > issuedAt + MAX_TOKEN_LIFETIME_MS ||
      maxResidualTokenExpiry > issuedAt + MAX_TOKEN_LIFETIME_MS
    ) {
      fail('CredentialGrant response is invalid');
    }
    return Object.freeze({ ...value });
  }

  if (value.kind === 'denied') {
    assertExactKeys(value, ['kind', 'code'], ['retryAfter']);
    if (
      typeof value.code !== 'string' ||
      !DENIAL_CODES.has(value.code) ||
      (value.retryAfter !== undefined && !validUtc(value.retryAfter))
    ) {
      fail('CredentialGrant response is invalid');
    }
    return Object.freeze({ ...value });
  }

  if (value.kind === 'terminal') {
    assertExactKeys(value, ['kind', 'terminalState']);
    if (
      typeof value.terminalState !== 'string' ||
      !TERMINAL_STATES.has(value.terminalState)
    ) {
      fail('CredentialGrant response is invalid');
    }
    return Object.freeze({ ...value });
  }

  fail('CredentialGrant response is invalid');
}

function oidcRequestUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('GitHub OIDC request URL is invalid');
  }
  if (
    !GITHUB_OIDC_ORIGINS.has(url.origin) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    fail('GitHub OIDC request URL is invalid');
  }
  url.searchParams.set('audience', CREDENTIAL_GRANT_OIDC_AUDIENCE);
  return url;
}

async function readJson(response, label) {
  try {
    return await response.json();
  } catch {
    fail(`${label} returned malformed JSON`);
  }
}

async function requestOidcToken({ requestUrl, requestToken, fetchImpl }) {
  if (typeof requestToken !== 'string' || !SAFE_BEARER.test(requestToken)) {
    fail('GitHub OIDC request token is unavailable');
  }
  let response;
  try {
    response = await fetchImpl(oidcRequestUrl(requestUrl), {
      method: 'GET',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${requestToken}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    fail('GitHub OIDC request failed');
  }
  if (!response.ok) {
    fail(`GitHub OIDC request failed with HTTP ${response.status}`);
  }
  const body = await readJson(response, 'GitHub OIDC request');
  if (
    !isRecord(body) ||
    Object.keys(body).length !== 1 ||
    typeof body.value !== 'string' ||
    !JWT.test(body.value)
  ) {
    fail('GitHub OIDC response is invalid');
  }
  return body.value;
}

export async function exchangeCredentialGrant({
  attemptId,
  requestId,
  oidcRequestUrl: requestUrl,
  oidcRequestToken,
  fetchImpl = fetch,
}) {
  const request = credentialGrantRequest({ attemptId, requestId });
  const idToken = await requestOidcToken({
    requestUrl,
    requestToken: oidcRequestToken,
    fetchImpl,
  });
  let response;
  try {
    response = await fetchImpl(CREDENTIAL_GRANT_URL, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    fail('CredentialGrant request failed after dispatch; outcome is unknown');
  }
  if (!response.ok) {
    fail(
      `CredentialGrant request failed with HTTP ${response.status}; outcome is unknown`,
    );
  }
  return parseCredentialGrantResult(
    await readJson(response, 'CredentialGrant request'),
  );
}

function outputsFor(result) {
  if (result.kind === 'issued') {
    return {
      kind: result.kind,
      token: result.token,
      'grant-id': result.grantId,
      'credential-profile-id': result.credentialProfileId,
      'issued-at': result.issuedAt,
      'token-expires-at': result.tokenExpiresAt,
      'renewal-deadline': result.renewalDeadline,
      'max-residual-token-expiry': result.maxResidualTokenExpiry,
    };
  }
  if (result.kind === 'denied') {
    return {
      kind: result.kind,
      'denial-code': result.code,
      ...(result.retryAfter === undefined
        ? {}
        : { 'retry-after': result.retryAfter }),
    };
  }
  return { kind: result.kind, 'terminal-state': result.terminalState };
}

export async function runCredentialGrantAction({
  env = process.env,
  fetchImpl = fetch,
  setOutput,
  maskSecret,
}) {
  const result = await exchangeCredentialGrant({
    attemptId: env.INPUT_ATTEMPT_ID,
    requestId: env.INPUT_REQUEST_ID,
    oidcRequestUrl: env.ACTIONS_ID_TOKEN_REQUEST_URL,
    oidcRequestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    fetchImpl,
  });
  if (result.kind === 'issued') maskSecret(result.token);
  for (const [name, value] of Object.entries(outputsFor(result))) {
    await setOutput(name, value);
  }
  return result;
}

async function main() {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    fail('GITHUB_OUTPUT is unavailable');
  }
  await runCredentialGrantAction({
    setOutput: async (name, value) => {
      await appendFile(outputPath, `${name}=${value}\n`, { encoding: 'utf8' });
    },
    maskSecret: (value) => process.stdout.write(`::add-mask::${value}\n`),
  });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const message =
      error instanceof CredentialGrantClientError
        ? error.message
        : 'CredentialGrant client failed';
    process.stderr.write(`::error::${message}\n`);
    process.exitCode = 1;
  });
}
