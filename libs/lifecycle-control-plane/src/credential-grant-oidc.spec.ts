import type {
  AcceptedAttemptSpec,
  ActivationRecord,
  RunBinding,
  TenantRef,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it } from 'vitest';

import type { AttemptState } from './attempt-reducer';
import { attemptSpecDigest } from './attempt-reducer';
import {
  type AuthorityClock,
  AuthorityConflict,
  InMemoryLifecycleAuthorityStorage,
  type MintReservation,
} from './authority-storage';
import { admitAcceptedSpecForTest } from './authority-storage-test-support';
import {
  CredentialGrantConflict,
  CredentialGrantCoordinator,
  credentialGrantIdentityDigest,
  type ExpectedWorkerGrantOidcSource,
  WorkerGrantOidcBoundary,
  type WorkerGrantOidcClaims,
} from './credential-grant-oidc';
import {
  resolveLaunchForTest,
  writeAttemptForTest,
} from './launch-resolution-test-support';
import {
  type InstallationTokenMinter,
  InstallationTokenMinterBoundary,
} from './mint-resolution';

const T0 = '2026-08-16T00:00:00.000Z';
const T1 = '2026-08-16T00:01:00.000Z';
const T2 = '2026-08-16T00:30:00.000Z';
const T6 = '2026-08-16T06:00:00.000Z';
const T6_30 = '2026-08-16T06:30:00.000Z';
const T7 = '2026-08-16T07:00:00.000Z';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const ATTEMPT_ID = 'A'.repeat(22);
const EXPECTED_SOURCE: ExpectedWorkerGrantOidcSource = {
  issuer: 'https://token.actions.githubusercontent.com',
  audience: 'agent-lcars/credential-grant/v1',
  sourceId: 'github-actions',
};

class ManualClock implements AuthorityClock {
  constructor(private value = T0) {}
  now(): string {
    return this.value;
  }
  set(value: string): void {
    this.value = value;
  }
}

class TrackingStorage extends InMemoryLifecycleAuthorityStorage {
  lastReservation?: MintReservation;

  constructor(clock: AuthorityClock) {
    super(clock, { mint: () => ATTEMPT_ID });
  }

  override async lookupOrReserveMint(
    input: Parameters<
      InMemoryLifecycleAuthorityStorage['lookupOrReserveMint']
    >[0],
  ): Promise<MintReservation> {
    const result = await super.lookupOrReserveMint(input);
    this.lastReservation = result;
    return result;
  }
}

function authorityFixture(): {
  tenant: TenantRef;
  activation: ActivationRecord;
  spec: AcceptedAttemptSpec;
  attempt: AttemptState;
  binding: RunBinding;
} {
  const tenant: TenantRef = {
    tenantId: 'tenant-1',
    repositoryId: 123,
    repository: 'octo/example',
    installationId: 456,
  };
  const task = { tenantId: tenant.tenantId, repositoryId: 123, issueNumber: 9 };
  const activation: ActivationRecord = {
    schema: 'agent-lcars.control-plane-activation/v1',
    version: 1,
    tenant,
    taskClassId: 'github-issue',
    activationId: 'activation-1',
    authorityEpoch: 1,
    effectiveBoundary: 1,
    mode: 'central-authoritative',
    effectMode: 'enabled',
    recordedAt: T0,
  };
  const spec: AcceptedAttemptSpec = {
    schema: 'agent-lcars.attempt-spec/v1',
    version: 1,
    requestId: 'admission-request-1',
    attemptId: ATTEMPT_ID,
    tenant,
    task,
    activation: {
      activationId: activation.activationId,
      taskClassId: activation.taskClassId,
      authorityEpoch: activation.authorityEpoch,
      mode: 'central-authoritative',
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
      workflowSha: SHA_A,
      mode: 'implement',
      executorId: 'executor-1',
      credentialProfileId: 'profile-1',
      renewalDeadline: T6,
    },
    authorization: {
      schema: 'agent-lcars.policy-decision/v1',
      version: 1,
      policy: {
        policyId: 'policy-1',
        policyVersion: 1,
        contentSha256: SHA_A,
      },
      decision: 'accepted',
      ruleId: 'rule-1',
      sourceFactId: 'fact-1',
      principal: { kind: 'system', systemId: 'system-1' },
      evidenceRef: 'evidence-1',
      decidedAt: T0,
    },
  };
  const binding: RunBinding = {
    runId: 10,
    runAttempt: 1,
    checkRunId: 11,
    workflowPath: spec.execution.workflowPath,
    workflowRef: spec.execution.workflowRef,
    workflowSha: spec.execution.workflowSha,
  };
  const digest = attemptSpecDigest(spec);
  const attempt: AttemptState = {
    schema: 'agent-lcars.attempt-state/v1',
    version: 1,
    spec,
    specDigest: digest,
    revision: 1,
    phase: 'launch-pending',
    launch: { operationId: ATTEMPT_ID, executionEpoch: 1, state: 'recorded' },
    executionEpoch: 1,
    facts: [],
    commands: [],
    pendingClaims: [],
    futureGrantsDenied: false,
    updatedAt: T0,
  };
  return { tenant, activation, spec, attempt, binding };
}

async function activeHarness() {
  const clock = new ManualClock();
  const storage = new TrackingStorage(clock);
  const value = authorityFixture();
  const admitted = await admitAcceptedSpecForTest({
    storage,
    activation: value.activation,
    spec: value.spec,
    ownerId: 'owner-1',
  });
  const registered = admitted.result.attempt;
  if (registered === undefined)
    throw new Error('Admission omitted its Attempt');
  const lease = admitted.lease;
  await resolveLaunchForTest({
    storage,
    lease,
    tenantId: registered.spec.tenant.tenantId,
    attemptId: ATTEMPT_ID,
    kind: 'accepted',
    at: T1,
  });
  const accepted = await storage.readAttempt({
    tenantId: registered.spec.tenant.tenantId,
    attemptId: ATTEMPT_ID,
  });
  if (accepted === undefined) throw new Error('Accepted Attempt disappeared');
  const active: AttemptState = {
    ...accepted,
    revision: 3,
    phase: 'active',
    binding: value.binding,
  };
  await writeAttemptForTest({
    storage,
    lease,
    expectedRevision: 2,
    next: active,
  });
  return {
    ...value,
    spec: registered.spec,
    attempt: registered,
    active,
    clock,
    lease,
    storage,
  };
}

function claims(
  value: ReturnType<typeof authorityFixture>,
  overrides: Partial<WorkerGrantOidcClaims> = {},
): WorkerGrantOidcClaims {
  return {
    ...EXPECTED_SOURCE,
    jtiSha256: SHA_B,
    expiresAt: T2,
    repositoryId: value.tenant.repositoryId,
    attemptId: value.spec.attemptId,
    requestId: 'grant-request-1',
    localAttemptMarker: value.spec.local.attemptMarker,
    ...value.binding,
    ...overrides,
  };
}

function request(requestId = 'grant-request-1') {
  return {
    schema: 'agent-lcars.credential-grant-request/v1' as const,
    version: 1 as const,
    requestId,
    attemptId: ATTEMPT_ID,
  };
}

async function verifiedProof(
  value: ReturnType<typeof authorityFixture>,
  clock: ManualClock,
  overrides: Partial<WorkerGrantOidcClaims> = {},
) {
  const boundary = new WorkerGrantOidcBoundary(
    {
      async verify() {
        return claims(value, overrides);
      },
    },
    EXPECTED_SOURCE,
    clock,
  );
  return boundary.verify({ opaque: 'test-proof' });
}

function coordinator(
  harness: Awaited<ReturnType<typeof activeHarness>>,
  minter: InstallationTokenMinter,
) {
  let tenantLookups = 0;
  return {
    service: new CredentialGrantCoordinator(
      harness.storage,
      {
        async resolve(repositoryId) {
          tenantLookups += 1;
          return repositoryId === harness.tenant.repositoryId
            ? harness.tenant
            : undefined;
        },
      },
      new InstallationTokenMinterBoundary(minter, harness.clock),
      harness.clock,
    ),
    tenantLookups: () => tenantLookups,
  };
}

describe('inactive verified-OIDC CredentialGrant coordinator', () => {
  it('canonicalizes authorization material before deriving replay identity', () => {
    expect(
      credentialGrantIdentityDigest({
        request: { attemptId: ATTEMPT_ID, requestId: 'request-1' },
        binding: { runId: 10, workflowSha: SHA_A },
      }),
    ).toBe(
      credentialGrantIdentityDigest({
        binding: { workflowSha: SHA_A, runId: 10 },
        request: { requestId: 'request-1', attemptId: ATTEMPT_ID },
      }),
    );
  });

  it('rejects structural capabilities and expired proofs before authority lookup', async () => {
    const harness = await activeHarness();
    let mintCalls = 0;
    const built = coordinator(harness, {
      async mint() {
        mintCalls += 1;
        return { kind: 'definitely-not-started' };
      },
    });
    await expect(
      built.service.issue({
        request: request(),
        verified: { claims: claims(harness) } as never,
      }),
    ).rejects.toBeInstanceOf(CredentialGrantConflict);
    const verified = await verifiedProof(harness, harness.clock);
    harness.clock.set(T2);
    await expect(
      built.service.issue({ request: request(), verified }),
    ).resolves.toEqual({ kind: 'denied', code: 'oidc_invalid' });
    expect(built.tenantLookups()).toBe(0);
    expect(mintCalls).toBe(0);
  });

  it('fails closed for malformed clocks and fixed source mismatches', async () => {
    const harness = await activeHarness();
    const malformedClock = new ManualClock('not-a-time');
    const malformed = new WorkerGrantOidcBoundary(
      {
        async verify() {
          return claims(harness);
        },
      },
      EXPECTED_SOURCE,
      malformedClock,
    );
    await expect(malformed.verify('proof')).rejects.toBeInstanceOf(
      CredentialGrantConflict,
    );
    for (const changed of [
      { issuer: 'https://issuer.invalid' },
      { audience: 'other-audience' },
      { sourceId: 'other-source' },
    ]) {
      await expect(
        verifiedProof(harness, harness.clock, changed),
      ).rejects.toBeInstanceOf(CredentialGrantConflict);
    }
  });

  it('denies tenant, marker, binding, and inactive-attempt mismatches without minting', async () => {
    const harness = await activeHarness();
    let mintCalls = 0;
    const built = coordinator(harness, {
      async mint() {
        mintCalls += 1;
        return { kind: 'definitely-not-started' };
      },
    });
    const wrongTenant = await verifiedProof(harness, harness.clock, {
      repositoryId: 999,
    });
    await expect(
      built.service.issue({ request: request(), verified: wrongTenant }),
    ).resolves.toEqual({ kind: 'denied', code: 'tenant_mismatch' });
    const wrongMarker = await verifiedProof(harness, harness.clock, {
      localAttemptMarker: 'g1:other',
    });
    await expect(
      built.service.issue({ request: request(), verified: wrongMarker }),
    ).resolves.toEqual({ kind: 'denied', code: 'binding_mismatch' });
    const wrongRun = await verifiedProof(harness, harness.clock, { runId: 99 });
    await expect(
      built.service.issue({ request: request(), verified: wrongRun }),
    ).resolves.toEqual({ kind: 'denied', code: 'binding_mismatch' });

    await writeAttemptForTest({
      storage: harness.storage,
      lease: harness.lease,
      expectedRevision: 3,
      next: { ...harness.active, revision: 4, phase: 'result-observed' },
    });
    const valid = await verifiedProof(harness, harness.clock);
    await expect(
      built.service.issue({ request: request(), verified: valid }),
    ).resolves.toEqual({ kind: 'denied', code: 'attempt_not_active' });
    expect(mintCalls).toBe(0);
  });

  it('denies after the immutable renewal deadline without reserving or minting', async () => {
    const harness = await activeHarness();
    let mintCalls = 0;
    const built = coordinator(harness, {
      async mint() {
        mintCalls += 1;
        return { kind: 'definitely-not-started' };
      },
    });
    harness.clock.set(T6);
    const verified = await verifiedProof(harness, harness.clock, {
      expiresAt: T7,
    });
    await expect(
      built.service.issue({ request: request(), verified }),
    ).resolves.toEqual({
      kind: 'denied',
      code: 'renewal_deadline_elapsed',
    });
    expect(harness.storage.lastReservation).toBeUndefined();
    expect(mintCalls).toBe(0);
  });

  it('records but withholds a token whose mint completes after the deadline', async () => {
    const harness = await activeHarness();
    let mintCalls = 0;
    const built = coordinator(harness, {
      async mint() {
        mintCalls += 1;
        harness.clock.set(T6);
        return {
          kind: 'issued',
          token: 'late-ephemeral-token',
          tokenExpiresAt: T6_30,
        };
      },
    });
    const verified = await verifiedProof(harness, harness.clock, {
      expiresAt: T7,
    });
    await expect(
      built.service.issue({ request: request(), verified }),
    ).resolves.toEqual({
      kind: 'denied',
      code: 'renewal_deadline_elapsed',
    });
    const grantId = harness.storage.lastReservation?.grant.grantId;
    if (grantId === undefined) throw new Error('reservation missing');
    const durable = await harness.storage.readMint({
      tenantId: harness.tenant.tenantId,
      grantId,
    });
    expect(durable).toMatchObject({
      issuanceState: 'issued',
      issuedAt: T6,
      tokenExpiresAt: T6_30,
    });
    expect(durable).not.toHaveProperty('token');
    await expect(
      built.service.issue({ request: request(), verified }),
    ).resolves.toEqual({ kind: 'denied', code: 'renewal_deadline_elapsed' });
    expect(mintCalls).toBe(1);
  });

  it('reserves once under concurrency, persists metadata only, and never replays the token', async () => {
    const harness = await activeHarness();
    let mintCalls = 0;
    const built = coordinator(harness, {
      async mint() {
        mintCalls += 1;
        return {
          kind: 'issued',
          token: 'ephemeral-token',
          tokenExpiresAt: T2,
        };
      },
    });
    const verified = await verifiedProof(harness, harness.clock);
    const results = await Promise.all([
      built.service.issue({ request: request(), verified }),
      built.service.issue({ request: request(), verified }),
    ]);
    expect(mintCalls).toBe(1);
    expect(results.filter((result) => result.kind === 'issued')).toHaveLength(
      1,
    );
    expect(results).toContainEqual({
      kind: 'denied',
      code: 'mint_in_progress',
    });
    const issued = results.find((result) => result.kind === 'issued');
    expect(issued).toMatchObject({ token: 'ephemeral-token' });
    if (issued?.kind !== 'issued') throw new Error('issued result missing');
    const durable = await harness.storage.readMint({
      tenantId: harness.tenant.tenantId,
      grantId: issued.grantId,
    });
    expect(durable).toMatchObject({
      issuanceState: 'issued',
      tokenFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(durable)).not.toMatch(/ephemeral-token|jwt|jti/iu);
    await expect(
      built.service.issue({ request: request(), verified }),
    ).resolves.toEqual({ kind: 'denied', code: 'already_issued_no_replay' });
    expect(mintCalls).toBe(1);
  });

  it('closes definite no-send and ambiguous mint outcomes without reminting', async () => {
    for (const scenario of ['definite', 'unknown'] as const) {
      const harness = await activeHarness();
      let mintCalls = 0;
      const built = coordinator(harness, {
        async mint() {
          mintCalls += 1;
          if (scenario === 'unknown') throw new Error('response lost');
          return { kind: 'definitely-not-started' };
        },
      });
      const verified = await verifiedProof(harness, harness.clock);
      const expected = {
        kind: 'denied' as const,
        code:
          scenario === 'unknown'
            ? ('mint_unknown' as const)
            : ('service_unavailable' as const),
      };
      await expect(
        built.service.issue({ request: request(), verified }),
      ).resolves.toEqual(expected);
      await expect(
        built.service.issue({ request: request(), verified }),
      ).resolves.toEqual(expected);
      expect(mintCalls).toBe(1);
      expect(harness.storage.lastReservation?.grant).not.toHaveProperty(
        'token',
      );
    }
  });

  it('conflicts changed request/JTI identities without a second mint', async () => {
    const harness = await activeHarness();
    let mintCalls = 0;
    const built = coordinator(harness, {
      async mint() {
        mintCalls += 1;
        return { kind: 'definitely-not-started' };
      },
    });
    const first = await verifiedProof(harness, harness.clock);
    await built.service.issue({ request: request(), verified: first });
    const changedJti = await verifiedProof(harness, harness.clock, {
      jtiSha256: 'c'.repeat(64),
    });
    await expect(
      built.service.issue({ request: request(), verified: changedJti }),
    ).rejects.toBeInstanceOf(AuthorityConflict);
    const changedRequest = await verifiedProof(harness, harness.clock, {
      requestId: 'grant-request-2',
    });
    await expect(
      built.service.issue({
        request: request('grant-request-2'),
        verified: changedRequest,
      }),
    ).rejects.toBeInstanceOf(AuthorityConflict);
    expect(mintCalls).toBe(1);
  });
});
