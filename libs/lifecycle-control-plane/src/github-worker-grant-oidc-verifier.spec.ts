import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { errors, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import {
  CREDENTIAL_GRANT_OIDC_AUDIENCE,
  GITHUB_ACTIONS_OIDC_ISSUER,
  GitHubWorkerGrantOidcVerifier,
  workerGrantClaimsFromJwtPayload,
  WorkerGrantJwtUnavailableError,
  WorkerGrantJwtVerificationError,
} from './github-worker-grant-oidc-verifier';

const REPOSITORY = 'octo/example';
const WORKFLOW_REF =
  'octo/example/.github/workflows/worker.yml@refs/heads/main';
const WORKFLOW_SHA = 'c'.repeat(40);
const RAW_JTI = 'raw-jti-never-returned';

function payload(exp: number) {
  return {
    iss: GITHUB_ACTIONS_OIDC_ISSUER,
    aud: CREDENTIAL_GRANT_OIDC_AUDIENCE,
    exp,
    jti: RAW_JTI,
    repository: REPOSITORY,
    repository_id: '123',
    run_id: '456',
    run_attempt: '2',
    check_run_id: '789',
    workflow_ref: WORKFLOW_REF,
    workflow_sha: WORKFLOW_SHA,
  };
}

async function signedToken(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .sign(privateKey);
}

describe('GitHub WorkerGrant JWT verifier', () => {
  it('shares the published worker client fixed audience', async () => {
    const clientSource = await readFile(
      new URL(
        '../../../.github/actions/credential-grant/credential-grant.mjs',
        import.meta.url,
      ),
      'utf8',
    );
    expect(clientSource).toContain(`'${CREDENTIAL_GRANT_OIDC_AUDIENCE}'`);
  });

  it('verifies a real signature and returns only normalized facts', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const exp = Math.floor(Date.now() / 1_000) + 300;
    const raw = await signedToken(privateKey, payload(exp));
    const verified = await new GitHubWorkerGrantOidcVerifier(publicKey).verify(
      raw,
    );

    expect(verified).toEqual({
      issuer: GITHUB_ACTIONS_OIDC_ISSUER,
      audience: CREDENTIAL_GRANT_OIDC_AUDIENCE,
      jtiSha256: createHash('sha256').update(RAW_JTI).digest('hex'),
      expiresAt: new Date(exp * 1_000).toISOString(),
      repositoryId: 123,
      repository: REPOSITORY,
      runId: 456,
      runAttempt: 2,
      checkRunId: 789,
      workflowRef: WORKFLOW_REF,
      workflowSha: WORKFLOW_SHA,
    });
    expect(JSON.stringify(verified)).not.toContain(raw);
    expect(JSON.stringify(verified)).not.toContain(RAW_JTI);
  });

  it('normalizes a complete reusable-workflow pair and ignores unrelated claims', () => {
    const exp = Math.floor(Date.now() / 1_000) + 300;
    expect(
      workerGrantClaimsFromJwtPayload({
        ...payload(exp),
        actor: 'octocat',
        job_workflow_ref:
          'octo/automation/.github/workflows/reusable.yml@refs/tags/v1',
        job_workflow_sha: 'd'.repeat(40),
      }),
    ).toMatchObject({
      jobWorkflowRef:
        'octo/automation/.github/workflows/reusable.yml@refs/tags/v1',
      jobWorkflowSha: 'd'.repeat(40),
    });
  });

  it.each([
    ['issuer', { iss: 'https://issuer.invalid' }],
    ['audience', { aud: 'other-audience' }],
    ['exp', { exp: 0 }],
    ['jti', { jti: '' }],
    ['repository', { repository: 'invalid' }],
    ['repository_id', { repository_id: '0' }],
    ['run_id', { run_id: 'not-a-number' }],
    ['run_attempt', { run_attempt: Number.MAX_SAFE_INTEGER + 1 }],
    ['check_run_id', { check_run_id: undefined }],
    ['workflow_ref', { workflow_ref: '' }],
    ['workflow_sha', { workflow_sha: 'a'.repeat(64) }],
    [
      'job_workflow_ref',
      {
        job_workflow_ref:
          'octo/automation/.github/workflows/reusable.yml@refs/heads/main',
      },
    ],
    [
      'job_workflow_sha',
      {
        job_workflow_ref:
          'octo/automation/.github/workflows/reusable.yml@refs/heads/main',
        job_workflow_sha: 'bad',
      },
    ],
  ])('rejects the malformed %s claim without echoing it', (field, override) => {
    const claims = {
      ...payload(Math.floor(Date.now() / 1_000) + 300),
      ...override,
    };
    expect(() => workerGrantClaimsFromJwtPayload(claims)).toThrow(field);
  });

  it('rejects wrong signature, issuer, audience, expiry, and structural input generically', async () => {
    const first = await generateKeyPair('RS256');
    const second = await generateKeyPair('RS256');
    const now = Math.floor(Date.now() / 1_000);
    const verifier = new GitHubWorkerGrantOidcVerifier(first.publicKey);
    const cases: unknown[] = [
      undefined,
      '',
      'x'.repeat(16_385),
      await signedToken(second.privateKey, payload(now + 300)),
      await signedToken(first.privateKey, {
        ...payload(now + 300),
        iss: 'https://issuer.invalid',
      }),
      await signedToken(first.privateKey, {
        ...payload(now + 300),
        aud: 'other-audience',
      }),
      await signedToken(first.privateKey, payload(now - 1)),
    ];

    for (const raw of cases) {
      let error: unknown;
      try {
        await verifier.verify(raw);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(WorkerGrantJwtVerificationError);
      expect((error as Error).message).toBe(
        'GitHub WorkerGrant OIDC token is invalid',
      );
      expect((error as Error).message).not.toContain(RAW_JTI);
    }
  });

  it.each([
    new Error('jwks-transport-secret'),
    new errors.JOSEError('jwks-http-or-json-secret'),
    new errors.JWKSInvalid('jwks-shape-secret'),
  ])('keeps a JWKS failure operational and secret-free', async (failure) => {
    const { privateKey } = await generateKeyPair('RS256');
    const raw = await signedToken(
      privateKey,
      payload(Math.floor(Date.now() / 1_000) + 300),
    );
    const verifier = new GitHubWorkerGrantOidcVerifier(async () => {
      throw failure;
    });
    let error: unknown;
    try {
      await verifier.verify(raw);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorkerGrantJwtUnavailableError);
    expect((error as Error).message).not.toContain(failure.message);
  });
});
