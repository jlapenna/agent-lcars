import type {
  AcceptedAttemptSpec,
  ActivationRecord,
  AttemptOutcome,
  CredentialGrantIssuance,
  ProjectionIntent,
  RunBinding,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it } from 'vitest';

import type { AttemptState } from './attempt-reducer';
import { attemptSpecDigest } from './attempt-reducer';
import {
  type AuthorityClock,
  AuthorityConflict,
  InMemoryLifecycleAuthorityStorage,
  type LifecycleAuthorityStorage,
  type MintIdentity,
  type ObservationIdentity,
  type TaskAuthorityLease,
  type TaskAuthorityScope,
} from './authority-storage';
import { InstallationTokenMinterBoundary } from './mint-resolution';
import type { TaskIntentState } from './task-intent-reducer';

const T0 = '2026-08-16T00:00:00.000Z';
const T1 = '2026-08-16T01:00:00.000Z';
const T2 = '2026-08-16T02:00:00.000Z';
const T3 = '2026-08-16T03:00:00.000Z';
const T4 = '2026-08-16T04:00:00.000Z';
const T6 = '2026-08-16T06:00:00.000Z';
const HOUR = 60 * 60 * 1000;
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

export interface AuthorityStorageContractClock extends AuthorityClock {
  set(value: string): void;
}

class ManualClock implements AuthorityStorageContractClock {
  constructor(private value = T0) {}
  now(): string {
    return this.value;
  }
  set(value: string): void {
    this.value = value;
  }
}

interface FixtureOptions {
  tenantId?: string;
  repositoryId?: number;
  issueNumber?: number;
  attemptId?: string;
  intentId?: string;
  generation?: number;
  admissionRevision?: number;
  activationId?: string;
  authorityEpoch?: number;
}

function fixture(options: FixtureOptions = {}) {
  const tenantId = options.tenantId ?? 'tenant-1';
  const repositoryId = options.repositoryId ?? 123;
  const issueNumber = options.issueNumber ?? 9;
  const attemptId = options.attemptId ?? 'A'.repeat(22);
  const intentId = options.intentId ?? 'intent-1';
  const generation = options.generation ?? 1;
  const admissionRevision = options.admissionRevision ?? 1;
  const activationId = options.activationId ?? 'activation-1';
  const authorityEpoch = options.authorityEpoch ?? 1;
  const tenant = {
    tenantId,
    repositoryId,
    repository: `octo/repo-${repositoryId}`,
    installationId: repositoryId + 1000,
  };
  const task = { tenantId, repositoryId, issueNumber };
  const scope = { ...task } satisfies TaskAuthorityScope;
  const activation: ActivationRecord = {
    schema: 'agent-lcars.control-plane-activation/v1',
    version: 1,
    tenant,
    taskClassId: 'github-issue',
    activationId,
    authorityEpoch,
    effectiveBoundary: 1,
    mode: 'central-authoritative',
    effectMode: 'enabled',
    recordedAt: T0,
  };
  const spec: AcceptedAttemptSpec = {
    schema: 'agent-lcars.attempt-spec/v1',
    version: 1,
    requestId: `request-${intentId}`,
    attemptId,
    tenant,
    task,
    activation: {
      activationId,
      taskClassId: 'github-issue',
      authorityEpoch,
      mode: 'central-authoritative',
    },
    local: {
      intentId,
      generation,
      attemptMarker: `g${generation}:${intentId}`,
      admissionRevision,
      idempotencyKey: `admit-${intentId}`,
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
      sourceFactId: `fact-${intentId}`,
      principal: { kind: 'system', systemId: 'system-1' },
      evidenceRef: `evidence-${intentId}`,
      decidedAt: T0,
    },
  };
  const digest = attemptSpecDigest(spec);
  const attempt: AttemptState = {
    schema: 'agent-lcars.attempt-state/v1',
    version: 1,
    spec,
    specDigest: digest,
    revision: 1,
    phase: 'launch-pending',
    launch: { operationId: attemptId, executionEpoch: 1, state: 'recorded' },
    executionEpoch: 1,
    facts: [],
    commands: [],
    pendingClaims: [],
    futureGrantsDenied: false,
    updatedAt: T0,
  };
  const taskState = (revision: number): TaskIntentState => ({
    schema: 'agent-lcars.task-intent-state/v1',
    version: 1,
    tenant,
    task,
    revision,
    activation: spec.activation,
    facts: [],
    intents: [],
    attempt: { kind: 'unlaunched', intentId },
    updatedAt: T0,
  });
  return { tenant, task, scope, activation, spec, digest, attempt, taskState };
}

async function acquire(
  storage: LifecycleAuthorityStorage,
  scope: TaskAuthorityScope,
  ownerId = 'owner-1',
  leaseDurationMs = 4 * HOUR,
): Promise<TaskAuthorityLease> {
  return storage.acquireTaskLease({ scope, ownerId, leaseDurationMs });
}

async function admit(
  storage: LifecycleAuthorityStorage,
  value = fixture(),
  expectedTaskRevision = 0,
  existingLease?: TaskAuthorityLease,
) {
  await storage.registerActivation(value.activation);
  const lease = existingLease ?? (await acquire(storage, value.scope));
  const result = await storage.admitAttemptAndRecordLaunch({
    lease,
    expectedTaskRevision,
    nextTask: value.taskState(expectedTaskRevision + 1),
    attempt: value.attempt,
    spec: value.spec,
    specDigest: value.digest,
  });
  return { ...value, lease, result };
}

function bindingFor(value: ReturnType<typeof fixture>, runId = 10): RunBinding {
  return {
    runId,
    runAttempt: 1,
    checkRunId: runId + 1,
    workflowPath: value.spec.execution.workflowPath,
    workflowRef: value.spec.execution.workflowRef,
    workflowSha: value.spec.execution.workflowSha,
  };
}

async function activateAttempt(
  storage: LifecycleAuthorityStorage,
  admitted: Awaited<ReturnType<typeof admit>>,
  binding = bindingFor(admitted),
): Promise<AttemptState> {
  expect(
    await storage.claimLaunch({
      lease: admitted.lease,
      attemptId: admitted.spec.attemptId,
    }),
  ).toBe('applied');
  const accepted: AttemptState = {
    ...admitted.attempt,
    revision: 2,
    phase: 'launch-accepted',
    launch: { ...admitted.attempt.launch, state: 'accepted' },
    updatedAt: T1,
  };
  await storage.resolveLaunch({
    lease: admitted.lease,
    attemptId: admitted.spec.attemptId,
    expectedState: 'dispatching',
    state: 'accepted',
    expectedAttemptRevision: 1,
    nextAttempt: accepted,
  });
  const active: AttemptState = {
    ...accepted,
    revision: 3,
    phase: 'active',
    binding,
    updatedAt: T1,
  };
  await storage.writeAttempt({
    lease: admitted.lease,
    expectedRevision: 2,
    next: active,
  });
  return active;
}

function cancelledOutcome(attemptId: string): AttemptOutcome {
  return {
    schema: 'agent-lcars.attempt-outcome/v1',
    version: 1,
    attemptId,
    terminalState: 'cancelled',
    execution: 'not_started',
    result: 'none',
    evidence: { kind: 'lifecycle-decision', decisionFactId: 'cancel-1' },
    evidenceValidation: { status: 'not-applicable' },
    finalizedAt: T2,
  };
}

async function resolveIssuedMint(
  storage: LifecycleAuthorityStorage,
  tenantId: string,
  attemptId: string,
  pending: Extract<CredentialGrantIssuance, { issuanceState: 'pending' }>,
  issuedAt: string,
  tokenExpiresAt: string,
): Promise<void> {
  const boundary = new InstallationTokenMinterBoundary(
    {
      async mint() {
        return {
          kind: 'issued' as const,
          token: 'ephemeral-test-token',
          tokenExpiresAt,
        };
      },
    },
    { now: () => issuedAt },
  );
  const verified = await boundary.mint(
    {
      installationId: 1,
      repositoryId: 1,
      credentialProfileId: pending.credentialProfileId,
    },
    pending,
  );
  await storage.resolveVerifiedMint({ tenantId, attemptId, verified });
}

function mintIdentity(
  value: Awaited<ReturnType<typeof admit>>,
  binding: RunBinding,
  requestId = 'grant-request-1',
  jti = 'jti-1',
): MintIdentity {
  return {
    tenantId: value.tenant.tenantId,
    repositoryId: value.tenant.repositoryId,
    attemptId: value.spec.attemptId,
    sourceIdentity: 'worker-oidc-1',
    binding,
    requestId,
    jtiSha256: String(
      'abcdef'[
        Array.from(jti).reduce(
          (sum, character) => sum + character.charCodeAt(0),
          0,
        ) % 6
      ],
    ).repeat(64),
    canonicalDigest: requestId === 'grant-request-1' ? SHA_A : SHA_B,
  };
}

/** Every production adapter must pass this same asynchronous suite. */
export function runLifecycleAuthorityStorageContract(
  makeStorage: (
    clock: AuthorityStorageContractClock,
  ) => LifecycleAuthorityStorage | Promise<LifecycleAuthorityStorage>,
): void {
  const makeHarness = async () => {
    const clock = new ManualClock();
    return { clock, storage: await makeStorage(clock) };
  };
  describe('Lifecycle authority storage contract', () => {
    it('enforces lease expiry, renewal, exclusion, and ABA fencing', async () => {
      const { storage, clock } = await makeHarness();
      const value = fixture();
      const first = await acquire(storage, value.scope, 'owner-1', HOUR);
      await expect(acquire(storage, value.scope, 'owner-2')).rejects.toThrow(
        AuthorityConflict,
      );
      const renewed = await storage.renewTaskLease({
        lease: first,
        leaseDurationMs: 2 * HOUR,
      });
      expect(renewed.fence).toBe(first.fence);
      expect(await storage.releaseTaskLease(first)).toBe(false);
      clock.set(T3);
      const takeover = await acquire(storage, value.scope, 'owner-2');
      expect(takeover.fence).toBeGreaterThan(first.fence);
      expect(await storage.releaseTaskLease(renewed)).toBe(false);
    });

    it('persists task-only reductions with fenced CAS', async () => {
      const { storage } = await makeHarness();
      const value = fixture();
      const lease = await acquire(storage, value.scope);
      expect(
        await storage.writeTask({
          lease,
          expectedRevision: 0,
          next: value.taskState(1),
        }),
      ).toBe('applied');
      expect(
        await storage.writeTask({
          lease,
          expectedRevision: 0,
          next: value.taskState(1),
        }),
      ).toBe('replay');
      await expect(
        storage.writeTask({
          lease,
          expectedRevision: 0,
          next: { ...value.taskState(1), updatedAt: T1 },
        }),
      ).rejects.toThrow(AuthorityConflict);
    });

    it('atomically admits task, global attempt, local tuple, and launch outbox', async () => {
      const { storage } = await makeHarness();
      const admitted = await admit(storage);
      expect(admitted.result).toMatchObject({
        replay: false,
        launch: { operationId: admitted.spec.attemptId, state: 'pending' },
      });
      expect((await storage.readTask(admitted.scope))?.revision).toBe(1);
      expect(
        await storage.readAttempt({
          tenantId: admitted.tenant.tenantId,
          attemptId: admitted.spec.attemptId,
        }),
      ).toEqual(admitted.attempt);
      expect(
        await storage.listLaunches({
          tenantId: admitted.tenant.tenantId,
          state: 'pending',
        }),
      ).toHaveLength(1);
    });

    it('replays admission after task advance and after activation cutover', async () => {
      const { storage } = await makeHarness();
      const admitted = await admit(storage);
      await storage.writeTask({
        lease: admitted.lease,
        expectedRevision: 1,
        next: { ...admitted.taskState(2), updatedAt: T1 },
      });
      await storage.registerActivation({
        ...admitted.activation,
        activationId: 'shadow-2',
        authorityEpoch: 2,
        mode: 'shadow',
        effectMode: 'none',
      });
      expect(
        (
          await storage.admitAttemptAndRecordLaunch({
            lease: admitted.lease,
            expectedTaskRevision: 0,
            nextTask: admitted.taskState(1),
            attempt: admitted.attempt,
            spec: admitted.spec,
            specDigest: admitted.digest,
          })
        ).replay,
      ).toBe(true);
      await expect(
        storage.admitAttemptAndRecordLaunch({
          lease: admitted.lease,
          expectedTaskRevision: 0,
          nextTask: { ...admitted.taskState(1), updatedAt: T3 },
          attempt: admitted.attempt,
          spec: admitted.spec,
          specDigest: admitted.digest,
        }),
      ).rejects.toThrow(AuthorityConflict);
      const next = fixture({
        attemptId: 'B'.repeat(22),
        intentId: 'intent-2',
        generation: 2,
        admissionRevision: 3,
      });
      await expect(
        storage.admitAttemptAndRecordLaunch({
          lease: admitted.lease,
          expectedTaskRevision: 2,
          nextTask: next.taskState(3),
          attempt: next.attempt,
          spec: next.spec,
          specDigest: next.digest,
        }),
      ).rejects.toThrow(AuthorityConflict);
    });

    it('resolves concurrent CAS and global identity collisions without partial writes', async () => {
      const { storage } = await makeHarness();
      const first = fixture();
      await storage.registerActivation(first.activation);
      const lease = await acquire(storage, first.scope);
      const second = fixture({
        attemptId: 'B'.repeat(22),
        intentId: 'intent-2',
        generation: 2,
      });
      const attempts = [first, second].map((value) =>
        storage.admitAttemptAndRecordLaunch({
          lease,
          expectedTaskRevision: 0,
          nextTask: value.taskState(1),
          attempt: value.attempt,
          spec: value.spec,
          specDigest: value.digest,
        }),
      );
      const results = await Promise.allSettled(attempts);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      expect(
        await storage.listLaunches({ tenantId: 'tenant-1', state: 'pending' }),
      ).toHaveLength(1);

      const winner = results[0]?.status === 'fulfilled' ? first : second;
      const collision = fixture({
        issueNumber: 10,
        attemptId: winner.spec.attemptId,
        intentId: 'other-task',
      });
      await storage.registerActivation(collision.activation);
      const otherLease = await acquire(storage, collision.scope);
      await expect(
        storage.admitAttemptAndRecordLaunch({
          lease: otherLease,
          expectedTaskRevision: 0,
          nextTask: collision.taskState(1),
          attempt: collision.attempt,
          spec: collision.spec,
          specDigest: collision.digest,
        }),
      ).rejects.toThrow(AuthorityConflict);
      expect(await storage.readTask(collision.scope)).toBeUndefined();
    });

    it('isolates the same repository/task coordinates by tenant', async () => {
      const { storage } = await makeHarness();
      const one = await admit(storage);
      const two = await admit(
        storage,
        fixture({ tenantId: 'tenant-2', attemptId: 'T'.repeat(22) }),
      );
      expect((await storage.readTask(one.scope))?.tenant.tenantId).toBe(
        'tenant-1',
      );
      expect((await storage.readTask(two.scope))?.tenant.tenantId).toBe(
        'tenant-2',
      );
      expect(
        await storage.readAttempt({
          tenantId: 'tenant-2',
          attemptId: one.spec.attemptId,
        }),
      ).toBeUndefined();
    });

    it('claims launch exactly once before dispatch and atomically resolves attempt state', async () => {
      const { storage, clock } = await makeHarness();
      const admitted = await admit(storage);
      const claims = await Promise.all([
        storage.claimLaunch({
          lease: admitted.lease,
          attemptId: admitted.spec.attemptId,
        }),
        storage.claimLaunch({
          lease: admitted.lease,
          attemptId: admitted.spec.attemptId,
        }),
      ]);
      expect(claims.sort()).toEqual(['applied', 'replay']);
      const unknown: AttemptState = {
        ...admitted.attempt,
        revision: 2,
        phase: 'launch-response-unknown',
        launch: { ...admitted.attempt.launch, state: 'response-unknown' },
        updatedAt: T1,
      };
      clock.set(T4);
      const takeover = await acquire(storage, admitted.scope, 'owner-2');
      await storage.resolveLaunch({
        lease: takeover,
        attemptId: admitted.spec.attemptId,
        expectedState: 'dispatching',
        state: 'unknown',
        expectedAttemptRevision: 1,
        nextAttempt: unknown,
      });
      await expect(
        storage.resolveLaunch({
          lease: takeover,
          attemptId: admitted.spec.attemptId,
          expectedState: 'unknown',
          state: 'accepted',
          expectedAttemptRevision: 2,
          nextAttempt: {
            ...unknown,
            revision: 3,
            phase: 'launch-accepted',
            launch: { ...unknown.launch, state: 'accepted' },
          },
        }),
      ).rejects.toThrow(AuthorityConflict);
      expect(takeover.fence).toBeGreaterThan(admitted.lease.fence);
      await expect(
        storage.writeAttempt({
          lease: admitted.lease,
          expectedRevision: 2,
          next: { ...unknown, revision: 3 },
        }),
      ).rejects.toThrow(AuthorityConflict);
    });

    it('enforces immutable exact bindings, outcomes, and attempt revisions', async () => {
      const { storage } = await makeHarness();
      const first = await admit(storage);
      const binding = bindingFor(first);
      const active = await activateAttempt(storage, first, binding);
      expect(
        await storage.writeAttempt({
          lease: first.lease,
          expectedRevision: 2,
          next: active,
        }),
      ).toBe('replay');
      await expect(
        storage.writeAttempt({
          lease: first.lease,
          expectedRevision: 3,
          next: { ...active, revision: 5 },
        }),
      ).rejects.toThrow(AuthorityConflict);
      await expect(
        storage.writeAttempt({
          lease: first.lease,
          expectedRevision: 3,
          next: { ...active, revision: 4, binding: undefined },
        }),
      ).rejects.toThrow(AuthorityConflict);

      const second = await admit(
        storage,
        fixture({ issueNumber: 10, attemptId: 'B'.repeat(22) }),
      );
      await storage.claimLaunch({
        lease: second.lease,
        attemptId: second.spec.attemptId,
      });
      const acceptedSecond = {
        ...second.attempt,
        revision: 2,
        phase: 'launch-accepted' as const,
        launch: { ...second.attempt.launch, state: 'accepted' as const },
      };
      await storage.resolveLaunch({
        lease: second.lease,
        attemptId: second.spec.attemptId,
        expectedState: 'dispatching',
        state: 'accepted',
        expectedAttemptRevision: 1,
        nextAttempt: acceptedSecond,
      });
      await expect(
        storage.writeAttempt({
          lease: second.lease,
          expectedRevision: 2,
          next: { ...acceptedSecond, revision: 3, phase: 'active', binding },
        }),
      ).rejects.toThrow(AuthorityConflict);

      const outcome = cancelledOutcome(first.spec.attemptId);
      const terminal = {
        ...active,
        revision: 4,
        phase: 'terminal' as const,
        outcome,
        futureGrantsDenied: true,
      };
      await storage.writeAttempt({
        lease: first.lease,
        expectedRevision: 3,
        next: terminal,
      });
      await expect(
        storage.writeAttempt({
          lease: first.lease,
          expectedRevision: 4,
          next: {
            ...terminal,
            revision: 5,
            outcome: { ...outcome, finalizedAt: T3 },
          },
        }),
      ).rejects.toThrow(AuthorityConflict);
    });

    it('atomically pairs observation fact and request identities', async () => {
      const { storage } = await makeHarness();
      const first = await admit(storage);
      const identity: ObservationIdentity = {
        tenantId: first.tenant.tenantId,
        repositoryId: first.tenant.repositoryId,
        attemptId: first.spec.attemptId,
        sourceIdentity: 'github-run-10',
        factId: 'fact-1',
        requestId: 'request-1',
        canonicalDigest: SHA_A,
        payloadSha256: SHA_B,
      };
      const results = await Promise.all([
        storage.recordObservation(identity),
        storage.recordObservation(identity),
      ]);
      expect(results.sort()).toEqual(['applied', 'replay']);
      await expect(
        storage.recordObservation({ ...identity, requestId: 'request-2' }),
      ).rejects.toThrow(AuthorityConflict);
      await expect(
        storage.recordObservation({ ...identity, canonicalDigest: SHA_B }),
      ).rejects.toThrow(AuthorityConflict);
      expect(
        await storage.recordObservation({
          ...identity,
          sourceIdentity: 'github-poll-10',
        }),
      ).toBe('applied');
    });

    it('requires a bound active attempt and exact mint request metadata', async () => {
      const { storage, clock } = await makeHarness();
      const admitted = await admit(storage);
      const binding = bindingFor(admitted);
      await expect(
        storage.lookupOrReserveMint({
          identity: mintIdentity(admitted, binding),
          credentialProfileId: admitted.spec.execution.credentialProfileId,
          maxIssuances: 2,
        }),
      ).rejects.toThrow(AuthorityConflict);
      await activateAttempt(storage, admitted, binding);
      clock.set(T1);
      await expect(
        storage.lookupOrReserveMint({
          identity: mintIdentity(admitted, binding),
          credentialProfileId: 'different-profile',
          maxIssuances: 2,
        }),
      ).rejects.toThrow(AuthorityConflict);
      expect(
        await storage.lookupOrReserveMint({
          identity: mintIdentity(admitted, binding),
          credentialProfileId: admitted.spec.execution.credentialProfileId,
          maxIssuances: 2,
        }),
      ).toMatchObject({
        status: 'created',
        grant: {
          attemptId: admitted.spec.attemptId,
          requestId: 'grant-request-1',
          issuanceState: 'pending',
          mintState: 'mint-in-progress',
          mintStartedAt: T1,
        },
      });
    });

    it('atomically rejects a grant when terminal evidence wins the read/reserve race', async () => {
      const { storage, clock } = await makeHarness();
      const admitted = await admit(storage);
      const binding = bindingFor(admitted);
      const active = await activateAttempt(storage, admitted, binding);
      await storage.writeAttempt({
        lease: admitted.lease,
        expectedRevision: active.revision,
        next: {
          ...active,
          revision: active.revision + 1,
          phase: 'result-observed',
        },
      });
      clock.set(T1);
      await expect(
        storage.lookupOrReserveMint({
          identity: mintIdentity(admitted, binding),
          credentialProfileId: admitted.spec.execution.credentialProfileId,
          maxIssuances: 1,
        }),
      ).rejects.toThrow(AuthorityConflict);
    });

    it('atomically fences JTI replay, overlap, budget, and mint-unknown', async () => {
      const { storage, clock } = await makeHarness();
      const first = await admit(storage);
      const binding = bindingFor(first);
      await activateAttempt(storage, first, binding);
      clock.set(T1);
      const identity = mintIdentity(first, binding);
      const reservation = await storage.lookupOrReserveMint({
        identity,
        credentialProfileId: first.spec.execution.credentialProfileId,
        maxIssuances: 2,
      });
      expect(reservation.status).toBe('created');
      const grant = reservation.grant as Extract<
        CredentialGrantIssuance,
        { issuanceState: 'pending' }
      >;
      expect(
        await storage.lookupOrReserveMint({
          identity,
          credentialProfileId: first.spec.execution.credentialProfileId,
          maxIssuances: 2,
        }),
      ).toEqual({ status: 'existing', grant });
      await expect(
        storage.lookupOrReserveMint({
          identity,
          credentialProfileId: first.spec.execution.credentialProfileId,
          maxIssuances: 1,
        }),
      ).rejects.toThrow(AuthorityConflict);
      await expect(
        storage.resolveMint({
          tenantId: first.tenant.tenantId,
          attemptId: first.spec.attemptId,
          grant: {
            grantId: grant.grantId,
            attemptId: first.spec.attemptId,
            requestId: grant.requestId,
            credentialProfileId: grant.credentialProfileId,
            issuanceState: 'issued',
            mintState: 'minted',
            issuedAt: T1,
            tokenExpiresAt: T2,
            maxResidualTokenExpiry: T2,
            tokenFingerprint: SHA_A,
          },
        }),
      ).rejects.toThrow(AuthorityConflict);
      await resolveIssuedMint(
        storage,
        first.tenant.tenantId,
        first.spec.attemptId,
        grant,
        T1,
        T2,
      );
      await expect(
        storage.lookupOrReserveMint({
          identity: mintIdentity(first, binding, 'grant-request-2', 'jti-1'),
          credentialProfileId: first.spec.execution.credentialProfileId,
          maxIssuances: 2,
        }),
      ).rejects.toThrow(AuthorityConflict);
      clock.set(T3);
      const nextReservation = await storage.lookupOrReserveMint({
        identity: mintIdentity(first, binding, 'grant-request-2', 'jti-2'),
        credentialProfileId: first.spec.execution.credentialProfileId,
        maxIssuances: 2,
      });
      expect(nextReservation.status).toBe('created');
      const nextGrant = nextReservation.grant as Extract<
        CredentialGrantIssuance,
        { issuanceState: 'pending' }
      >;
      const unknown: CredentialGrantIssuance = {
        grantId: nextGrant.grantId,
        attemptId: first.spec.attemptId,
        requestId: nextGrant.requestId,
        credentialProfileId: 'profile-1',
        issuanceState: 'denied',
        mintState: 'mint-unknown',
        denialCode: 'mint_unknown',
        mintStartedAt: T3,
        maxResidualTokenExpiry: T4,
      };
      await storage.resolveMint({
        tenantId: first.tenant.tenantId,
        attemptId: first.spec.attemptId,
        grant: unknown,
      });
      await expect(
        storage.lookupOrReserveMint({
          identity: mintIdentity(first, binding, 'grant-request-3', 'jti-3'),
          credentialProfileId: first.spec.execution.credentialProfileId,
          maxIssuances: 2,
        }),
      ).rejects.toThrow(AuthorityConflict);
      expect(
        await storage.readMint({
          tenantId: first.tenant.tenantId,
          grantId: nextGrant.grantId,
        }),
      ).not.toHaveProperty('token');
      await expect(
        storage.resolveMint({
          tenantId: first.tenant.tenantId,
          attemptId: first.spec.attemptId,
          grant: {
            ...unknown,
            token: 'raw',
          } as never,
        }),
      ).rejects.toThrow(AuthorityConflict);
    });

    it('uses globally one-shot JTI per authenticated source across attempts', async () => {
      const { storage, clock } = await makeHarness();
      const first = await admit(storage);
      const firstBinding = bindingFor(first, 10);
      await activateAttempt(storage, first, firstBinding);
      clock.set(T1);
      await storage.lookupOrReserveMint({
        identity: mintIdentity(
          first,
          firstBinding,
          'grant-request-1',
          'fleet-jti',
        ),
        credentialProfileId: first.spec.execution.credentialProfileId,
        maxIssuances: 2,
      });
      const second = await admit(
        storage,
        fixture({ issueNumber: 10, attemptId: 'B'.repeat(22) }),
      );
      const secondBinding = bindingFor(second, 20);
      await activateAttempt(storage, second, secondBinding);
      await expect(
        storage.lookupOrReserveMint({
          identity: mintIdentity(
            second,
            secondBinding,
            'grant-request-2',
            'fleet-jti',
          ),
          credentialProfileId: second.spec.execution.credentialProfileId,
          maxIssuances: 2,
        }),
      ).rejects.toThrow(AuthorityConflict);
    });

    it('pins the issuance budget on first reservation', async () => {
      const { storage, clock } = await makeHarness();
      const admitted = await admit(storage);
      const binding = bindingFor(admitted);
      await activateAttempt(storage, admitted, binding);
      clock.set(T1);
      const reservation = await storage.lookupOrReserveMint({
        identity: mintIdentity(admitted, binding),
        credentialProfileId: admitted.spec.execution.credentialProfileId,
        maxIssuances: 1,
      });
      const grant = reservation.grant as Extract<
        CredentialGrantIssuance,
        { issuanceState: 'pending' }
      >;
      await resolveIssuedMint(
        storage,
        admitted.tenant.tenantId,
        admitted.spec.attemptId,
        grant,
        T1,
        T2,
      );
      clock.set(T3);
      await expect(
        storage.lookupOrReserveMint({
          identity: mintIdentity(admitted, binding, 'grant-request-2', 'jti-2'),
          credentialProfileId: admitted.spec.execution.credentialProfileId,
          maxIssuances: 2,
        }),
      ).rejects.toThrow(AuthorityConflict);
    });

    it('claims projection delivery and keeps retries isolated from terminal truth', async () => {
      const { storage, clock } = await makeHarness();
      const admitted = await admit(storage);
      const outcome = cancelledOutcome(admitted.spec.attemptId);
      await storage.writeAttempt({
        lease: admitted.lease,
        expectedRevision: 1,
        next: {
          ...admitted.attempt,
          revision: 2,
          phase: 'terminal',
          outcome,
          futureGrantsDenied: true,
        },
      });
      const intent: ProjectionIntent = {
        schema: 'agent-lcars.projection-intent/v1',
        version: 1,
        operationId: 'projection-1',
        attemptId: admitted.spec.attemptId,
        kind: 'outcome-comment',
        desiredRevision: 1,
        payload: { kind: 'outcome-comment', outcomeDigest: SHA_A },
      };
      expect(
        await storage.enqueueProjection({
          lease: admitted.lease,
          tenantId: admitted.tenant.tenantId,
          intent,
        }),
      ).toBe('applied');
      const claims = await Promise.all([
        storage.claimProjection({
          lease: admitted.lease,
          tenantId: admitted.tenant.tenantId,
          operationId: intent.operationId,
        }),
        storage.claimProjection({
          lease: admitted.lease,
          tenantId: admitted.tenant.tenantId,
          operationId: intent.operationId,
        }),
      ]);
      expect(claims.sort()).toEqual(['applied', 'replay']);
      clock.set(T4);
      const takeover = await acquire(storage, admitted.scope, 'owner-2');
      expect(
        await storage.claimProjection({
          lease: takeover,
          tenantId: admitted.tenant.tenantId,
          operationId: intent.operationId,
        }),
      ).toBe('applied');
      await storage.acknowledgeProjection({
        lease: takeover,
        tenantId: admitted.tenant.tenantId,
        status: {
          operationId: intent.operationId,
          state: 'diverged',
          observedAt: T1,
          failure: {
            owningSystem: 'projector',
            phase: 'reporting',
            reason: 'github_write_failed',
            retryDisposition: 'manual',
            evidenceRef: 'projection-failure-1',
          },
        },
      });
      expect(
        await storage.listProjections({
          tenantId: admitted.tenant.tenantId,
          state: 'pending',
        }),
      ).toHaveLength(1);
      await storage.claimProjection({
        lease: takeover,
        tenantId: admitted.tenant.tenantId,
        operationId: intent.operationId,
      });
      const converged = {
        operationId: intent.operationId,
        state: 'converged' as const,
        observedAt: T2,
      };
      await storage.acknowledgeProjection({
        lease: takeover,
        tenantId: admitted.tenant.tenantId,
        status: converged,
      });
      expect(
        await storage.acknowledgeProjection({
          lease: takeover,
          tenantId: admitted.tenant.tenantId,
          status: converged,
        }),
      ).toBe('replay');
      expect(
        (
          await storage.readAttempt({
            tenantId: admitted.tenant.tenantId,
            attemptId: admitted.spec.attemptId,
          })
        )?.outcome,
      ).toEqual(outcome);
    });

    it('allows pinned in-flight effects but blocks shadow admissions and pre-boundary effects', async () => {
      const { storage } = await makeHarness();
      const admitted = await admit(storage);
      await storage.registerActivation({
        ...admitted.activation,
        activationId: 'shadow-2',
        authorityEpoch: 2,
        mode: 'shadow',
        effectMode: 'none',
      });
      const intent: ProjectionIntent = {
        schema: 'agent-lcars.projection-intent/v1',
        version: 1,
        operationId: 'projection-old-attempt',
        attemptId: admitted.spec.attemptId,
        kind: 'ledger-projection',
        desiredRevision: 1,
        payload: { kind: 'ledger-projection', ledgerRevision: 1 },
      };
      expect(
        await storage.enqueueProjection({
          lease: admitted.lease,
          tenantId: admitted.tenant.tenantId,
          intent,
        }),
      ).toBe('applied');

      const future = fixture({
        activationId: 'activation-3',
        authorityEpoch: 3,
        admissionRevision: 1,
      });
      await storage.registerActivation({
        ...future.activation,
        effectiveBoundary: 2,
      });
      await expect(
        storage.admitAttemptAndRecordLaunch({
          lease: admitted.lease,
          expectedTaskRevision: 1,
          nextTask: future.taskState(2),
          attempt: future.attempt,
          spec: future.spec,
          specDigest: future.digest,
        }),
      ).rejects.toThrow(AuthorityConflict);
    });
  });
}

runLifecycleAuthorityStorageContract(
  (clock) => new InMemoryLifecycleAuthorityStorage(clock),
);
