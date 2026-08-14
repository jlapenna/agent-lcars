import type {
  CredentialGrantRequest,
  CredentialGrantResult,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it } from 'vitest';

import { AuthorityConflict } from './authority-storage';
import { CredentialGrantHttpHandler } from './credential-grant-http';
import type { VerifiedWorkerGrantOidc } from './credential-grant-oidc';
import { WorkerGrantJwtUnavailableError } from './github-worker-grant-oidc-verifier';

const ATTEMPT_ID = 'A'.repeat(22);
const JWT = 'header.payload.signature';
const T0 = '2026-08-14T19:00:00.000Z';
const T1 = '2026-08-14T19:30:00.000Z';
const T2 = '2026-08-14T19:45:00.000Z';
const T3 = '2026-08-14T20:00:00.000Z';

const REQUEST: CredentialGrantRequest = {
  schema: 'agent-lcars.credential-grant-request/v1',
  version: 1,
  requestId: 'request-1',
  attemptId: ATTEMPT_ID,
};

const VERIFIED = {
  claims: {
    issuer: 'https://token.actions.githubusercontent.com',
    audience: 'agent-lcars/credential-grant/v1',
    jtiSha256: 'a'.repeat(64),
    expiresAt: T3,
    repositoryId: 123,
    repository: 'octo/example',
    runId: 456,
    runAttempt: 1,
    checkRunId: 789,
    workflowRef: 'octo/example/.github/workflows/worker.yml@refs/heads/main',
    workflowSha: 'c'.repeat(40),
  },
  binding: {
    runId: 456,
    runAttempt: 1,
    checkRunId: 789,
    workflowPath: '.github/workflows/worker.yml',
    workflowRef: 'refs/heads/main',
    workflowSha: 'c'.repeat(40),
  },
  sourceId: 'github-worker-grant-v1',
} as VerifiedWorkerGrantOidc;

function issued(): CredentialGrantResult {
  return {
    kind: 'issued',
    token: 'ghs_ephemeral',
    grantId: 'grant-1',
    credentialProfileId: 'profile-1',
    issuedAt: T0,
    tokenExpiresAt: T1,
    renewalDeadline: T2,
    maxResidualTokenExpiry: T3,
  };
}

function request(
  body: BodyInit = JSON.stringify(REQUEST),
  headers: HeadersInit = {
    Authorization: `Bearer ${JWT}`,
    'Content-Type': 'application/json',
  },
) {
  return new Request('https://lcars.example/credential-grant', {
    method: 'POST',
    headers,
    body,
  });
}

function harness(options?: {
  verifyError?: Error;
  issue?: (input: {
    request: CredentialGrantRequest;
    verified: VerifiedWorkerGrantOidc;
  }) => Promise<CredentialGrantResult>;
}) {
  let verifyCalls = 0;
  let issueCalls = 0;
  let seenToken: unknown;
  let seenInput: unknown;
  const handler = new CredentialGrantHttpHandler(
    {
      async verify(raw) {
        verifyCalls += 1;
        seenToken = raw;
        if (options?.verifyError !== undefined) throw options.verifyError;
        return VERIFIED;
      },
    },
    {
      async issue(input) {
        issueCalls += 1;
        seenInput = input;
        return options?.issue === undefined ? issued() : options.issue(input);
      },
    },
  );
  return {
    handler,
    verifyCalls: () => verifyCalls,
    issueCalls: () => issueCalls,
    seenToken: () => seenToken,
    seenInput: () => seenInput,
  };
}

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe('inactive CredentialGrant HTTP handler', () => {
  it.each<CredentialGrantResult>([
    issued(),
    { kind: 'denied', code: 'attempt_cancelled' },
    { kind: 'terminal', terminalState: 'superseded' },
  ])('returns a strict no-store $kind result', async (result) => {
    const test = harness({ issue: async () => result });
    const response = await test.handler.handle(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    );
    expect(await body(response)).toEqual(result);
    expect(test.verifyCalls()).toBe(1);
    expect(test.issueCalls()).toBe(1);
    expect(test.seenToken()).toBe(JWT);
    expect(test.seenInput()).toEqual({ request: REQUEST, verified: VERIFIED });
  });

  it('rejects method, media type, body, and authorization before verification', async () => {
    const duplicateAuthorization = new Headers({
      Authorization: `Bearer ${JWT}`,
      'Content-Type': 'application/json',
    });
    duplicateAuthorization.append('Authorization', `Bearer ${JWT}`);
    const cases = [
      new Request('https://lcars.example/credential-grant', { method: 'GET' }),
      request(JSON.stringify(REQUEST), {
        Authorization: `Bearer ${JWT}`,
        'Content-Type': 'text/plain',
      }),
      request('{'),
      request(JSON.stringify({ ...REQUEST, extra: true })),
      request(JSON.stringify({ ...REQUEST, attemptId: 'g1:intent-1' })),
      request(new Uint8Array([0xff])),
      request('x'.repeat(4_097)),
      request(JSON.stringify(REQUEST), {
        Authorization: 'Basic secret',
        'Content-Type': 'application/json',
      }),
      request(JSON.stringify(REQUEST), duplicateAuthorization),
    ];

    for (const input of cases) {
      const test = harness();
      const response = await test.handler.handle(input);
      expect([400, 405]).toContain(response.status);
      expect(test.verifyCalls()).toBe(0);
      expect(test.issueCalls()).toBe(0);
      expect(JSON.stringify(await body(response))).not.toContain(JWT);
    }
  });

  it('maps authentication and JWKS availability without leaking errors', async () => {
    const secret = 'verification-secret';
    for (const [error, expectedStatus, expectedCode] of [
      [new Error(secret), 401, 'invalid_token'],
      [new WorkerGrantJwtUnavailableError(), 503, 'service_unavailable'],
    ] as const) {
      const test = harness({ verifyError: error });
      const response = await test.handler.handle(request());
      const responseText = await response.text();
      expect(response.status).toBe(expectedStatus);
      expect(JSON.parse(responseText)).toMatchObject({ code: expectedCode });
      expect(test.issueCalls()).toBe(0);
      expect(responseText).not.toContain(secret);
    }
  });

  it('maps replay conflicts and unexpected failures without response details', async () => {
    const secret = 'storage-or-provider-secret';
    for (const [error, expectedStatus, expectedCode] of [
      [new AuthorityConflict(secret), 409, 'conflict'],
      [new Error(secret), 503, 'service_unavailable'],
    ] as const) {
      const test = harness({
        issue: async () => {
          throw error;
        },
      });
      const response = await test.handler.handle(request());
      const responseBody = await body(response);
      expect(response.status).toBe(expectedStatus);
      expect(responseBody).toMatchObject({ code: expectedCode });
      expect(JSON.stringify(responseBody)).not.toContain(secret);
    }
  });

  it('fails closed if an injected service returns a malformed result', async () => {
    const secret = 'malformed-token-secret';
    const test = harness({
      issue: async () =>
        ({ kind: 'issued', token: secret }) as CredentialGrantResult,
    });
    const response = await test.handler.handle(request());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await body(response))).not.toContain(secret);
  });
});
