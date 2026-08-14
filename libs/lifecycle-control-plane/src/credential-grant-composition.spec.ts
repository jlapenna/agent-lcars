import type {
  AcceptedAttemptSpec,
  ActivationRecord,
  CredentialGrantRequest,
  RunBinding,
  TenantRef,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it } from 'vitest';

import { type AttemptState } from './attempt-reducer';
import {
  type AuthorityClock,
  InMemoryLifecycleAuthorityStorage,
} from './authority-storage';
import { admitAcceptedSpecForTest } from './authority-storage-test-support';
import {
  createCredentialGrantComposition,
  type CredentialGrantCompositionDependencies,
} from './credential-grant-composition';
import type { ExpectedWorkerGrantOidcSource } from './credential-grant-oidc';
import {
  resolveLaunchForTest,
  writeAttemptForTest,
} from './launch-resolution-test-support';

const REQUEST: CredentialGrantRequest = {
  schema: 'agent-lcars.credential-grant-request/v1',
  version: 1,
  requestId: 'request-1',
  attemptId: 'A'.repeat(22),
};
const JWT = 'header.payload.signature';
const NOW = '2026-08-14T19:00:00.000Z';
const EXPIRES = '2026-08-14T20:00:00.000Z';
const DEADLINE = '2026-08-14T19:30:00.000Z';
const TENANT: TenantRef = {
  tenantId: 'tenant-1',
  repositoryId: 123,
  repository: 'octo/example',
  installationId: 456,
};
const EXPECTED_SOURCE: ExpectedWorkerGrantOidcSource = {
  issuer: 'https://token.actions.githubusercontent.com',
  audience: 'agent-lcars/credential-grant/v1',
  sourceId: 'github-worker-grant-v1',
};

class ManualClock implements AuthorityClock {
  constructor(private value = NOW) {}
  now(): string {
    return this.value;
  }
}

async function activeStorage(clock: ManualClock) {
  const storage = new InMemoryLifecycleAuthorityStorage(clock, {
    mint: () => 'A'.repeat(22),
  });
  const activation: ActivationRecord = {
    schema: 'agent-lcars.control-plane-activation/v1',
    version: 1,
    tenant: TENANT,
    taskClassId: 'github-issue',
    activationId: 'activation-1',
    authorityEpoch: 1,
    effectiveBoundary: 1,
    mode: 'central-authoritative',
    effectMode: 'enabled',
    recordedAt: NOW,
  };
  const spec: AcceptedAttemptSpec = {
    schema: 'agent-lcars.attempt-spec/v1',
    version: 1,
    requestId: 'admission-request-1',
    attemptId: REQUEST.attemptId,
    tenant: TENANT,
    task: {
      tenantId: TENANT.tenantId,
      repositoryId: TENANT.repositoryId,
      issueNumber: 9,
    },
    activation: {
      activationId: activation.activationId,
      taskClassId: activation.taskClassId,
      authorityEpoch: activation.authorityEpoch,
      mode: activation.mode,
    },
    local: {
      intentId: 'intent-1',
      generation: 1,
      attemptMarker: 'g1:intent-1',
      admissionRevision: 1,
      idempotencyKey: 'admit-intent-1',
    },
    execution: {
      workflowPath: '.github/workflows/worker.yml',
      workflowRef: 'refs/heads/main',
      workflowSha: 'c'.repeat(40),
      mode: 'implement',
      executorId: 'executor-1',
      credentialProfileId: 'profile-1',
      renewalDeadline: DEADLINE,
    },
    authorization: {
      schema: 'agent-lcars.policy-decision/v1',
      version: 1,
      policy: {
        policyId: 'policy-1',
        policyVersion: 1,
        contentSha256: 'a'.repeat(64),
      },
      decision: 'accepted',
      ruleId: 'rule-1',
      sourceFactId: 'fact-1',
      principal: { kind: 'system', systemId: 'system-1' },
      evidenceRef: 'evidence-1',
      decidedAt: NOW,
    },
  };
  const binding: RunBinding = {
    runId: 456,
    runAttempt: 1,
    checkRunId: 789,
    workflowPath: spec.execution.workflowPath,
    workflowRef: spec.execution.workflowRef,
    workflowSha: spec.execution.workflowSha,
  };
  const admitted = await admitAcceptedSpecForTest({
    storage,
    activation,
    spec,
    ownerId: 'owner-1',
  });
  if (admitted.result.attempt === undefined) throw new Error('Attempt omitted');
  await resolveLaunchForTest({
    storage,
    lease: admitted.lease,
    tenantId: TENANT.tenantId,
    attemptId: REQUEST.attemptId,
    kind: 'accepted',
    at: NOW,
  });
  const accepted = await storage.readAttempt({
    tenantId: TENANT.tenantId,
    attemptId: REQUEST.attemptId,
  });
  if (accepted === undefined) throw new Error('Attempt disappeared');
  const active: AttemptState = {
    ...accepted,
    revision: accepted.revision + 1,
    phase: 'active',
    binding,
  };
  await writeAttemptForTest({
    storage,
    lease: admitted.lease,
    expectedRevision: accepted.revision,
    next: active,
  });
  return storage;
}

function request(body: unknown = REQUEST, method = 'POST'): Request {
  return new Request('https://lcars.example/credential-grant', {
    method,
    headers: {
      Authorization: `Bearer ${JWT}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function dependencies(
  overrides: Partial<CredentialGrantCompositionDependencies> = {},
) {
  let verifyCalls = 0;
  let mintCalls = 0;
  const value: CredentialGrantCompositionDependencies = {
    storage: undefined as never,
    tenants: { resolve: async () => undefined },
    minter: {
      async mint() {
        mintCalls += 1;
        return { kind: 'definitely-not-started' };
      },
    },
    oidc: {
      async verify() {
        verifyCalls += 1;
        return {
          issuer: 'https://token.actions.githubusercontent.com',
          audience: 'agent-lcars/credential-grant/v1',
          jtiSha256: 'a'.repeat(64),
          expiresAt: EXPIRES,
          repositoryId: 123,
          repository: 'octo/example',
          runId: 456,
          runAttempt: 1,
          checkRunId: 789,
          workflowRef:
            'octo/example/.github/workflows/worker.yml@refs/heads/main',
          workflowSha: 'c'.repeat(40),
        };
      },
    },
    expectedOidcSource: EXPECTED_SOURCE,
    clock: { now: () => NOW },
    ...overrides,
  };
  return { value, verifyCalls: () => verifyCalls, mintCalls: () => mintCalls };
}

function oidcClaims() {
  return {
    issuer: EXPECTED_SOURCE.issuer,
    audience: EXPECTED_SOURCE.audience,
    jtiSha256: 'a'.repeat(64),
    expiresAt: EXPIRES,
    repositoryId: TENANT.repositoryId,
    repository: TENANT.repository,
    runId: 456,
    runAttempt: 1,
    checkRunId: 789,
    workflowRef: `${TENANT.repository}/.github/workflows/worker.yml@refs/heads/main`,
    workflowSha: 'c'.repeat(40),
  };
}

describe('inactive CredentialGrant composition', () => {
  it('wires HTTP through OIDC and coordinator authority without selecting infrastructure', async () => {
    const test = dependencies();
    const handler = createCredentialGrantComposition(test.value);

    const response = await handler.handle(request());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      kind: 'denied',
      code: 'tenant_mismatch',
    });
    expect(test.verifyCalls()).toBe(1);
    expect(test.mintCalls()).toBe(0);
  });

  it('issues once through real storage, then treats exact replay as non-replayable', async () => {
    const clock = new ManualClock();
    const storage = await activeStorage(clock);
    let mintCalls = 0;
    const test = dependencies({
      storage,
      tenants: { resolve: async () => TENANT },
      oidc: { verify: async () => oidcClaims() },
      clock,
      minter: {
        async mint() {
          mintCalls += 1;
          return {
            kind: 'issued',
            token: 'ghs_ephemeral',
            tokenExpiresAt: '2026-08-14T19:10:00.000Z',
          };
        },
      },
    });
    const handler = createCredentialGrantComposition(test.value);

    const first = await handler.handle(request());
    const replay = await handler.handle(request());

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      kind: 'issued',
      token: 'ghs_ephemeral',
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      kind: 'denied',
      code: 'already_issued_no_replay',
    });
    expect(mintCalls).toBe(1);
  });

  it('turns an ambiguous provider failure into mint_unknown without retry', async () => {
    const clock = new ManualClock();
    const storage = await activeStorage(clock);
    let mintCalls = 0;
    const test = dependencies({
      storage,
      tenants: { resolve: async () => TENANT },
      oidc: { verify: async () => oidcClaims() },
      clock,
      minter: {
        async mint() {
          mintCalls += 1;
          throw new Error('connection lost after send');
        },
      },
    });
    const handler = createCredentialGrantComposition(test.value);

    const first = await handler.handle(request());
    const retry = await handler.handle(request());

    expect(await first.json()).toEqual({
      kind: 'denied',
      code: 'mint_unknown',
    });
    expect(await retry.json()).toEqual({
      kind: 'denied',
      code: 'mint_unknown',
    });
    expect(mintCalls).toBe(1);
  });

  it('rejects invalid HTTP before the injected OIDC verifier or provider', async () => {
    const test = dependencies();
    const handler = createCredentialGrantComposition(test.value);

    const response = await handler.handle(request({ ...REQUEST, extra: true }));

    expect(response.status).toBe(400);
    expect(test.verifyCalls()).toBe(0);
    expect(test.mintCalls()).toBe(0);
  });

  it('keeps the same trusted clock at both verification boundaries', async () => {
    const test = dependencies({
      clock: { now: () => 'not-a-utc-time' },
    });
    const handler = createCredentialGrantComposition(test.value);

    const response = await handler.handle(request());

    expect(response.status).toBe(401);
    expect(test.verifyCalls()).toBe(1);
    expect(test.mintCalls()).toBe(0);
  });
});
