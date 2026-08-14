import { randomUUID } from 'node:crypto';

import type {
  AcceptedAttemptSpec,
  ActivationProvenance,
  ActivationRecord,
  CredentialGrantIssuance,
  ProjectionIntent,
  ProjectionStatusV1,
  RunBinding,
} from '@agent-lcars/dispatch-contracts';
import {
  credentialGrantIssuanceSchema,
  hasValidRuntimeObservationPayloadDigest,
  localAttemptMarkerSchema,
  projectionIntentSchema,
  projectionStatusV1Schema,
  runtimeObservationEnvelopeSchema,
} from '@agent-lcars/dispatch-contracts';

import type { AttemptState } from './attempt-reducer';
import {
  attemptSpecDigest,
  attemptTransitionDigest,
  reduceAttempt,
} from './attempt-reducer';
import {
  isVerifiedMintResolution,
  type VerifiedMintResolution,
} from './mint-resolution';
import {
  isVerifiedRunBindingIngress,
  type VerifiedRunBindingIngress,
} from './run-binding-ingress';
import type { TaskIntentState } from './task-intent-reducer';

const SHA256 = /^[a-f0-9]{64}$/u;

export interface TaskAuthorityScope {
  tenantId: string;
  repositoryId: number;
  issueNumber: number;
}

export interface EffectAuthorityScope extends TaskAuthorityScope {
  taskClassId: string;
}

export interface TaskAuthorityLease {
  taskKey: string;
  ownerId: string;
  /** Monotonic for this task, including release/reacquire ABA cycles. */
  fence: number;
  acquiredAt: string;
  expiresAt: string;
}

/** Implementations supply a trusted server/storage clock. */
export interface AuthorityClock {
  now(): string;
}

export interface LaunchOutboxRecord {
  operationId: string;
  attemptId: string;
  tenantId: string;
  repositoryId: number;
  issueNumber: number;
  executionEpoch: number;
  state: 'pending' | 'dispatching' | 'accepted' | 'unknown';
  claimedFence?: number;
}

export interface ObservationIdentity {
  tenantId: string;
  repositoryId: number;
  attemptId: string;
  sourceIdentity: string;
  factId: string;
  requestId: string;
  canonicalDigest: string;
  payloadSha256: string;
}

export interface MintIdentity {
  tenantId: string;
  repositoryId: number;
  attemptId: string;
  sourceIdentity: string;
  binding: RunBinding;
  requestId: string;
  /** One-way SHA-256 of a signed OIDC JTI; raw JTIs are never durable. */
  jtiSha256: string;
  canonicalDigest: string;
}

export interface ProjectionRecord {
  tenantId: string;
  intent: ProjectionIntent;
  status?: ProjectionStatusV1;
  deliveryState: 'pending' | 'delivering' | 'complete';
  claimedFence?: number;
}

export interface AdmissionResult {
  replay: boolean;
  launch: LaunchOutboxRecord;
}

export type WriteResult = 'applied' | 'replay';

export interface MintReservation {
  status: 'created' | 'existing';
  grant: CredentialGrantIssuance;
}

/**
 * Server-only durability boundary for the lifecycle authority. Implementations
 * must make each method atomic. No method performs a provider side effect.
 */
export interface LifecycleAuthorityStorage {
  acquireTaskLease(input: {
    scope: TaskAuthorityScope;
    ownerId: string;
    leaseDurationMs: number;
  }): Promise<TaskAuthorityLease>;
  renewTaskLease(input: {
    lease: TaskAuthorityLease;
    leaseDurationMs: number;
  }): Promise<TaskAuthorityLease>;
  releaseTaskLease(lease: TaskAuthorityLease): Promise<boolean>;

  registerActivation(record: ActivationRecord): Promise<WriteResult>;
  mayWriteEffects(input: {
    scope: EffectAuthorityScope;
    activation: ActivationProvenance;
    boundary: number;
  }): Promise<boolean>;

  writeTask(input: {
    lease: TaskAuthorityLease;
    expectedRevision: number;
    next: TaskIntentState;
  }): Promise<WriteResult>;

  admitAttemptAndRecordLaunch(input: {
    lease: TaskAuthorityLease;
    expectedTaskRevision: number;
    nextTask: TaskIntentState;
    attempt: AttemptState;
    spec: AcceptedAttemptSpec;
    specDigest: string;
  }): Promise<AdmissionResult>;
  readTask(scope: TaskAuthorityScope): Promise<TaskIntentState | undefined>;
  readAttempt(input: {
    tenantId: string;
    attemptId: string;
  }): Promise<AttemptState | undefined>;
  writeAttempt(input: {
    lease: TaskAuthorityLease;
    expectedRevision: number;
    next: AttemptState;
  }): Promise<WriteResult>;

  readLaunch(input: {
    tenantId: string;
    attemptId: string;
  }): Promise<LaunchOutboxRecord | undefined>;
  listLaunches(input: {
    tenantId: string;
    state: LaunchOutboxRecord['state'];
  }): Promise<LaunchOutboxRecord[]>;
  claimLaunch(input: {
    lease: TaskAuthorityLease;
    attemptId: string;
  }): Promise<WriteResult>;
  resolveLaunch(input: {
    lease: TaskAuthorityLease;
    attemptId: string;
    expectedState: LaunchOutboxRecord['state'];
    state: 'accepted' | 'unknown';
    expectedAttemptRevision: number;
    nextAttempt: AttemptState;
  }): Promise<WriteResult>;

  recordObservation(identity: ObservationIdentity): Promise<WriteResult>;
  /**
   * One transaction for verified exact run binding ingress. It records both
   * idempotency keys, CAS-writes the attempt/binding, and resolves the one
   * launch outbox record to accepted (even when binding preceded a response).
   */
  recordBindingObservationAndResolveLaunch(input: {
    lease: TaskAuthorityLease;
    /** Runtime-checked opaque ingress capability, not a caller assertion. */
    verified: VerifiedRunBindingIngress;
    expectedAttemptRevision: number;
  }): Promise<WriteResult>;

  /**
   * Atomically finds the durable request/JTI reservation or creates it. Only
   * `created` may invoke the external token minter.
   */
  lookupOrReserveMint(input: {
    identity: MintIdentity;
    credentialProfileId: string;
    maxIssuances: number;
  }): Promise<MintReservation>;
  resolveMint(input: {
    tenantId: string;
    attemptId: string;
    grant: CredentialGrantIssuance;
  }): Promise<WriteResult>;
  resolveVerifiedMint(input: {
    tenantId: string;
    attemptId: string;
    verified: VerifiedMintResolution;
  }): Promise<WriteResult>;
  readMint(input: {
    tenantId: string;
    grantId: string;
  }): Promise<CredentialGrantIssuance | undefined>;

  enqueueProjection(input: {
    lease: TaskAuthorityLease;
    tenantId: string;
    intent: ProjectionIntent;
  }): Promise<WriteResult>;
  listProjections(input: {
    tenantId: string;
    state: ProjectionRecord['deliveryState'];
  }): Promise<ProjectionRecord[]>;
  claimProjection(input: {
    lease: TaskAuthorityLease;
    tenantId: string;
    operationId: string;
  }): Promise<WriteResult>;
  acknowledgeProjection(input: {
    lease: TaskAuthorityLease;
    tenantId: string;
    status: ProjectionStatusV1;
  }): Promise<WriteResult>;
  readProjection(input: {
    tenantId: string;
    operationId: string;
  }): Promise<ProjectionRecord | undefined>;
}

export class AuthorityConflict extends Error {
  override name = 'AuthorityConflict';
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Avoid delimiter collisions: opaque ids are permitted to contain `:`. */
function tupleKey(...parts: readonly (string | number)[]): string {
  return JSON.stringify(parts);
}

function parsedTime(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new AuthorityConflict(`${field} must be a timestamp`);
  }
  return parsed;
}

function canonicalTaskKey(scope: TaskAuthorityScope): string {
  return tupleKey(scope.tenantId, scope.repositoryId, scope.issueNumber);
}

function activationKey(scope: EffectAuthorityScope): string {
  return tupleKey(scope.tenantId, scope.repositoryId, scope.taskClassId);
}

function acceptanceKey(spec: AcceptedAttemptSpec): string {
  return tupleKey(
    spec.task.tenantId,
    spec.task.repositoryId,
    spec.task.issueNumber,
    spec.local.intentId,
    spec.local.generation,
  );
}

function bindingKey(spec: AcceptedAttemptSpec, binding: RunBinding): string {
  return tupleKey(
    spec.tenant.tenantId,
    spec.tenant.repositoryId,
    binding.runId,
    binding.runAttempt,
    binding.checkRunId,
  );
}

function observationKeys(identity: {
  tenantId: string;
  repositoryId: number;
  sourceIdentity: string;
  attemptId: string;
  factId: string;
  requestId: string;
}): { factKey: string; requestKey: string } {
  const scope = tupleKey(
    identity.tenantId,
    identity.repositoryId,
    identity.sourceIdentity,
    identity.attemptId,
  );
  return {
    factKey: tupleKey(scope, 'fact', identity.factId),
    requestKey: tupleKey(scope, 'request', identity.requestId),
  };
}

function mintKeys(
  identity: MintIdentity,
  credentialProfileId: string,
): {
  requestKey: string;
  jtiKey: string;
  slotKey: string;
} {
  return {
    requestKey: tupleKey(
      identity.tenantId,
      identity.repositoryId,
      identity.sourceIdentity,
      identity.attemptId,
      'request',
      identity.requestId,
    ),
    // A signed verifier source + JTI is one-use globally, never per tenant.
    jtiKey: tupleKey(
      'verified-jti',
      identity.sourceIdentity,
      identity.jtiSha256,
    ),
    slotKey: tupleKey(
      identity.tenantId,
      identity.attemptId,
      'profile',
      credentialProfileId,
    ),
  };
}

interface StoredAcceptance {
  attemptId: string;
  specDigest: string;
  admissionDigest: string;
}

interface StoredIdempotency {
  counterpartId: string;
  canonicalDigest: string;
  payloadSha256?: string;
  resourceId: string;
}

interface StoredMint {
  tenantId: string;
  repositoryId: number;
  identity: MintIdentity;
  grant: CredentialGrantIssuance;
}

const systemClock: AuthorityClock = {
  now: () => new Date().toISOString(),
};

/**
 * Reference implementation for the backend contract suite. Methods are
 * contain no await between validation and mutation, so each method is one
 * indivisible transaction in this adapter.
 */
export class InMemoryLifecycleAuthorityStorage implements LifecycleAuthorityStorage {
  private readonly leases = new Map<string, TaskAuthorityLease>();
  private readonly leaseFences = new Map<string, number>();
  private readonly tasks = new Map<string, TaskIntentState>();
  private readonly attempts = new Map<string, AttemptState>();
  private readonly acceptances = new Map<string, StoredAcceptance>();
  private readonly launches = new Map<string, LaunchOutboxRecord>();
  private readonly bindings = new Map<string, string>();
  private readonly outcomes = new Map<string, string>();
  private readonly factKeys = new Map<string, StoredIdempotency>();
  private readonly requestKeys = new Map<string, StoredIdempotency>();
  private readonly mintRequestKeys = new Map<string, StoredIdempotency>();
  private readonly jtiKeys = new Map<string, StoredIdempotency>();
  private readonly mints = new Map<string, StoredMint>();
  private readonly mintSlots = new Map<string, string>();
  private readonly mintCounts = new Map<string, number>();
  private readonly mintLimits = new Map<string, number>();
  private readonly projections = new Map<string, ProjectionRecord>();
  private readonly activations = new Map<string, ActivationRecord>();

  constructor(private readonly clock: AuthorityClock = systemClock) {}

  private now(): string {
    const value = this.clock.now();
    parsedTime(value, 'clock.now');
    return value;
  }

  async acquireTaskLease(input: {
    scope: TaskAuthorityScope;
    ownerId: string;
    leaseDurationMs: number;
  }): Promise<TaskAuthorityLease> {
    const acquiredAt = this.now();
    const now = parsedTime(acquiredAt, 'clock.now');
    if (
      !Number.isSafeInteger(input.leaseDurationMs) ||
      input.leaseDurationMs <= 0
    ) {
      throw new AuthorityConflict('Lease duration must be a positive integer');
    }
    const expiresAt = new Date(now + input.leaseDurationMs).toISOString();
    const key = canonicalTaskKey(input.scope);
    const current = this.leases.get(key);
    if (
      current !== undefined &&
      parsedTime(current.expiresAt, 'expiresAt') > now
    ) {
      if (current.ownerId === input.ownerId) return clone(current);
      throw new AuthorityConflict('Task authority lease remains active');
    }
    const fence = (this.leaseFences.get(key) ?? 0) + 1;
    const lease: TaskAuthorityLease = {
      taskKey: key,
      ownerId: input.ownerId,
      fence,
      acquiredAt,
      expiresAt,
    };
    this.leaseFences.set(key, fence);
    this.leases.set(key, lease);
    return clone(lease);
  }

  async renewTaskLease(input: {
    lease: TaskAuthorityLease;
    leaseDurationMs: number;
  }): Promise<TaskAuthorityLease> {
    const now = this.now();
    const current = this.assertLeaseByKey(input.lease, now);
    if (
      !Number.isSafeInteger(input.leaseDurationMs) ||
      input.leaseDurationMs <= 0
    ) {
      throw new AuthorityConflict('Lease duration must be a positive integer');
    }
    const renewed = {
      ...current,
      expiresAt: new Date(
        parsedTime(now, 'clock.now') + input.leaseDurationMs,
      ).toISOString(),
    };
    this.leases.set(current.taskKey, renewed);
    return clone(renewed);
  }

  async releaseTaskLease(lease: TaskAuthorityLease): Promise<boolean> {
    const current = this.leases.get(lease.taskKey);
    if (
      current === undefined ||
      current.ownerId !== lease.ownerId ||
      current.fence !== lease.fence ||
      !same(current, lease)
    ) {
      return false;
    }
    this.leases.delete(lease.taskKey);
    return true;
  }

  private assertLeaseByKey(
    lease: TaskAuthorityLease,
    now: string,
  ): TaskAuthorityLease {
    const current = this.leases.get(lease.taskKey);
    if (
      current === undefined ||
      current.ownerId !== lease.ownerId ||
      current.fence !== lease.fence ||
      !same(current, lease) ||
      parsedTime(current.expiresAt, 'expiresAt') <= parsedTime(now, 'now')
    ) {
      throw new AuthorityConflict('Stale, expired, or foreign task lease');
    }
    return current;
  }

  private assertLease(
    lease: TaskAuthorityLease,
    scope: TaskAuthorityScope,
    now: string,
  ): void {
    if (lease.taskKey !== canonicalTaskKey(scope)) {
      throw new AuthorityConflict('Lease belongs to another task');
    }
    this.assertLeaseByKey(lease, now);
  }

  async registerActivation(record: ActivationRecord): Promise<WriteResult> {
    const key = activationKey({
      ...record.tenant,
      issueNumber: 0,
      taskClassId: record.taskClassId,
    });
    const current = this.activations.get(key);
    if (current !== undefined && same(current, record)) return 'replay';
    if (
      current !== undefined &&
      (record.authorityEpoch <= current.authorityEpoch ||
        record.effectiveBoundary < current.effectiveBoundary)
    ) {
      throw new AuthorityConflict('Activation is not forward-only');
    }
    this.activations.set(key, clone(record));
    return 'applied';
  }

  async mayWriteEffects(input: {
    scope: EffectAuthorityScope;
    activation: ActivationProvenance;
    boundary: number;
  }): Promise<boolean> {
    return this.mayWriteEffectsSync(input);
  }

  private mayWriteEffectsSync(input: {
    scope: EffectAuthorityScope;
    activation: ActivationProvenance;
    boundary: number;
  }): boolean {
    const current = this.activations.get(activationKey(input.scope));
    return (
      current?.mode === 'central-authoritative' &&
      current.effectMode === 'enabled' &&
      current.activationId === input.activation.activationId &&
      current.taskClassId === input.activation.taskClassId &&
      current.authorityEpoch === input.activation.authorityEpoch &&
      input.activation.mode === 'central-authoritative' &&
      input.boundary >= current.effectiveBoundary
    );
  }

  async writeTask(input: {
    lease: TaskAuthorityLease;
    expectedRevision: number;
    next: TaskIntentState;
  }): Promise<WriteResult> {
    this.assertLease(input.lease, input.next.task, this.now());
    const key = canonicalTaskKey(input.next.task);
    const current = this.tasks.get(key);
    if (current !== undefined && same(current, input.next)) return 'replay';
    if (
      (current?.revision ?? 0) !== input.expectedRevision ||
      input.next.revision !== input.expectedRevision + 1 ||
      input.next.tenant.tenantId !== input.next.task.tenantId ||
      input.next.tenant.repositoryId !== input.next.task.repositoryId
    ) {
      throw new AuthorityConflict('Task CAS or canonical identity failed');
    }
    this.tasks.set(key, clone(input.next));
    return 'applied';
  }

  async admitAttemptAndRecordLaunch(input: {
    lease: TaskAuthorityLease;
    expectedTaskRevision: number;
    nextTask: TaskIntentState;
    attempt: AttemptState;
    spec: AcceptedAttemptSpec;
    specDigest: string;
  }): Promise<AdmissionResult> {
    const scope: EffectAuthorityScope = {
      ...input.spec.task,
      taskClassId: input.spec.activation.taskClassId,
    };
    this.assertLease(input.lease, input.spec.task, this.now());
    if (attemptSpecDigest(input.spec) !== input.specDigest) {
      throw new AuthorityConflict(
        'Attempt spec digest does not match the spec',
      );
    }

    const localKey = acceptanceKey(input.spec);
    const admissionDigest = canonicalJson({
      nextTask: input.nextTask,
      attempt: input.attempt,
      spec: input.spec,
      specDigest: input.specDigest,
    });
    const accepted = this.acceptances.get(localKey);
    if (accepted !== undefined) {
      const storedAttempt = this.attempts.get(accepted.attemptId);
      const launch = this.launches.get(accepted.attemptId);
      if (
        accepted.attemptId !== input.spec.attemptId ||
        accepted.specDigest !== input.specDigest ||
        accepted.admissionDigest !== admissionDigest ||
        storedAttempt === undefined ||
        !same(storedAttempt.spec, input.spec) ||
        launch === undefined
      ) {
        throw new AuthorityConflict(
          'Local acceptance tuple was reused differently',
        );
      }
      return { replay: true, launch: clone(launch) };
    }

    if (
      !this.mayWriteEffectsSync({
        scope,
        activation: input.spec.activation,
        boundary: input.spec.local.admissionRevision,
      })
    ) {
      throw new AuthorityConflict('Shadow, retired, or stale activation');
    }

    const key = canonicalTaskKey(input.spec.task);
    const currentTask = this.tasks.get(key);
    if ((currentTask?.revision ?? 0) !== input.expectedTaskRevision) {
      throw new AuthorityConflict('Task CAS failed');
    }
    if (
      input.nextTask.revision !== input.expectedTaskRevision + 1 ||
      canonicalTaskKey(input.nextTask.task) !== key ||
      !same(input.nextTask.tenant, input.spec.tenant) ||
      !same(input.nextTask.activation, input.spec.activation) ||
      input.nextTask.attempt.kind !== 'unlaunched' ||
      input.nextTask.attempt.intentId !== input.spec.local.intentId ||
      !same(input.attempt.spec, input.spec) ||
      input.attempt.specDigest !== input.specDigest ||
      input.attempt.revision !== 1 ||
      input.attempt.phase !== 'launch-pending' ||
      input.attempt.executionEpoch !== 1 ||
      input.attempt.launch.operationId !== input.spec.attemptId ||
      input.attempt.launch.executionEpoch !== 1 ||
      input.attempt.launch.state !== 'recorded' ||
      input.attempt.binding !== undefined ||
      input.attempt.outcome !== undefined ||
      input.attempt.pendingTerminal !== undefined ||
      input.attempt.finalization !== undefined ||
      input.attempt.cancellation !== undefined ||
      input.attempt.facts.length !== 0 ||
      input.attempt.commands.length !== 0 ||
      input.attempt.pendingClaims.length !== 0 ||
      input.attempt.futureGrantsDenied
    ) {
      throw new AuthorityConflict(
        'Admission records are not one next transaction',
      );
    }
    if (this.attempts.has(input.spec.attemptId)) {
      throw new AuthorityConflict('Global attemptId collision');
    }

    const launch: LaunchOutboxRecord = {
      operationId: input.spec.attemptId,
      attemptId: input.spec.attemptId,
      tenantId: input.spec.tenant.tenantId,
      repositoryId: input.spec.tenant.repositoryId,
      issueNumber: input.spec.task.issueNumber,
      executionEpoch: 1,
      state: 'pending',
    };
    this.tasks.set(key, clone(input.nextTask));
    this.attempts.set(input.spec.attemptId, clone(input.attempt));
    this.acceptances.set(localKey, {
      attemptId: input.spec.attemptId,
      specDigest: input.specDigest,
      admissionDigest,
    });
    this.launches.set(input.spec.attemptId, launch);
    return { replay: false, launch: clone(launch) };
  }

  async readTask(
    scope: TaskAuthorityScope,
  ): Promise<TaskIntentState | undefined> {
    const value = this.tasks.get(canonicalTaskKey(scope));
    return value === undefined ? undefined : clone(value);
  }

  async readAttempt(input: {
    tenantId: string;
    attemptId: string;
  }): Promise<AttemptState | undefined> {
    const value = this.attempts.get(input.attemptId);
    if (value === undefined || value.spec.tenant.tenantId !== input.tenantId) {
      return undefined;
    }
    return clone(value);
  }

  async writeAttempt(input: {
    lease: TaskAuthorityLease;
    expectedRevision: number;
    next: AttemptState;
  }): Promise<WriteResult> {
    return this.writeAttemptTransaction(input);
  }

  private writeAttemptTransaction(input: {
    lease: TaskAuthorityLease;
    expectedRevision: number;
    next: AttemptState;
  }): WriteResult {
    const current = this.attempts.get(input.next.spec.attemptId);
    if (current === undefined)
      throw new AuthorityConflict('Attempt is unknown');
    this.assertLease(input.lease, current.spec.task, this.now());
    if (same(current, input.next)) return 'replay';
    if (
      current.revision !== input.expectedRevision ||
      input.next.revision !== input.expectedRevision + 1
    ) {
      throw new AuthorityConflict('Attempt CAS failed');
    }
    if (
      !same(current.spec, input.next.spec) ||
      current.specDigest !== input.next.specDigest
    ) {
      throw new AuthorityConflict('Accepted attempt spec is immutable');
    }
    if (
      current.binding !== undefined &&
      !same(current.binding, input.next.binding)
    ) {
      throw new AuthorityConflict('Exact attempt binding is immutable');
    }
    if (
      current.outcome !== undefined &&
      !same(current.outcome, input.next.outcome)
    ) {
      throw new AuthorityConflict('Attempt outcome is immutable');
    }
    if (current.futureGrantsDenied && !input.next.futureGrantsDenied) {
      throw new AuthorityConflict('Future-grant denial cannot be cleared');
    }

    const nextBinding = input.next.binding;
    const nextBindingKey =
      nextBinding === undefined
        ? undefined
        : bindingKey(input.next.spec, nextBinding);
    const bindingOwner =
      nextBindingKey === undefined
        ? undefined
        : this.bindings.get(nextBindingKey);
    if (
      bindingOwner !== undefined &&
      bindingOwner !== input.next.spec.attemptId
    ) {
      throw new AuthorityConflict(
        'Exact run binding belongs to another attempt',
      );
    }
    const outcome =
      input.next.outcome === undefined
        ? undefined
        : canonicalJson(input.next.outcome);
    const storedOutcome = this.outcomes.get(input.next.spec.attemptId);
    if (storedOutcome !== undefined && storedOutcome !== outcome) {
      throw new AuthorityConflict('Terminal outcome conflicts');
    }

    if (nextBindingKey !== undefined) {
      this.bindings.set(nextBindingKey, input.next.spec.attemptId);
    }
    if (outcome !== undefined) {
      this.outcomes.set(input.next.spec.attemptId, outcome);
    }
    this.attempts.set(input.next.spec.attemptId, clone(input.next));
    return 'applied';
  }

  async readLaunch(input: {
    tenantId: string;
    attemptId: string;
  }): Promise<LaunchOutboxRecord | undefined> {
    const value = this.launches.get(input.attemptId);
    if (value === undefined || value.tenantId !== input.tenantId)
      return undefined;
    return clone(value);
  }

  async listLaunches(input: {
    tenantId: string;
    state: LaunchOutboxRecord['state'];
  }): Promise<LaunchOutboxRecord[]> {
    return [...this.launches.values()]
      .filter(
        (launch) =>
          launch.tenantId === input.tenantId && launch.state === input.state,
      )
      .map(clone);
  }

  async claimLaunch(input: {
    lease: TaskAuthorityLease;
    attemptId: string;
  }): Promise<WriteResult> {
    const attempt = this.attempts.get(input.attemptId);
    const current = this.launches.get(input.attemptId);
    if (attempt === undefined || current === undefined) {
      throw new AuthorityConflict('Launch operation is unknown');
    }
    this.assertLease(input.lease, attempt.spec.task, this.now());
    if (
      current.state === 'dispatching' &&
      current.claimedFence === input.lease.fence
    ) {
      return 'replay';
    }
    if (current.state !== 'pending') {
      throw new AuthorityConflict('Launch operation is not claimable');
    }
    this.launches.set(input.attemptId, {
      ...current,
      state: 'dispatching',
      claimedFence: input.lease.fence,
    });
    return 'applied';
  }

  async resolveLaunch(input: {
    lease: TaskAuthorityLease;
    attemptId: string;
    expectedState: LaunchOutboxRecord['state'];
    state: 'accepted' | 'unknown';
    expectedAttemptRevision: number;
    nextAttempt: AttemptState;
  }): Promise<WriteResult> {
    const attempt = this.attempts.get(input.attemptId);
    const current = this.launches.get(input.attemptId);
    if (attempt === undefined || current === undefined) {
      throw new AuthorityConflict('Launch operation is unknown');
    }
    this.assertLease(input.lease, attempt.spec.task, this.now());
    if (current.state === input.state) {
      if (!same(attempt, input.nextAttempt)) {
        throw new AuthorityConflict('Launch and attempt resolution diverged');
      }
      return 'replay';
    }
    if (current.state !== input.expectedState) {
      throw new AuthorityConflict('Launch outbox state conflict');
    }
    const ownsClaim = current.claimedFence === input.lease.fence;
    if (!ownsClaim && input.state !== 'unknown') {
      throw new AuthorityConflict(
        'Only the claimant may accept a launch; takeover must reconcile unknown',
      );
    }
    const expectedAttemptLaunchState =
      input.state === 'accepted' ? 'accepted' : 'response-unknown';
    const expectedAttemptPhase =
      input.state === 'accepted'
        ? 'launch-accepted'
        : 'launch-response-unknown';
    if (
      current.state !== 'dispatching' ||
      !['accepted', 'unknown'].includes(input.state) ||
      input.nextAttempt.spec.attemptId !== input.attemptId ||
      input.nextAttempt.launch.state !== expectedAttemptLaunchState ||
      input.nextAttempt.phase !== expectedAttemptPhase
    ) {
      throw new AuthorityConflict(
        'Launch resolution contradicts attempt state',
      );
    }
    this.writeAttemptTransaction({
      lease: input.lease,
      expectedRevision: input.expectedAttemptRevision,
      next: input.nextAttempt,
    });
    this.launches.set(input.attemptId, {
      ...current,
      state: input.state,
    });
    return 'applied';
  }

  async recordObservation(identity: ObservationIdentity): Promise<WriteResult> {
    if (
      !SHA256.test(identity.canonicalDigest) ||
      !SHA256.test(identity.payloadSha256) ||
      identity.sourceIdentity.length === 0 ||
      identity.factId.length === 0 ||
      identity.requestId.length === 0
    ) {
      throw new AuthorityConflict('Observation identity is invalid');
    }
    const attempt = this.attempts.get(identity.attemptId);
    if (
      attempt === undefined ||
      attempt.spec.tenant.tenantId !== identity.tenantId ||
      attempt.spec.tenant.repositoryId !== identity.repositoryId
    ) {
      throw new AuthorityConflict('Observation attempt scope is invalid');
    }
    const { factKey, requestKey } = observationKeys(identity);
    const fact: StoredIdempotency = {
      counterpartId: identity.requestId,
      canonicalDigest: identity.canonicalDigest,
      payloadSha256: identity.payloadSha256,
      resourceId: identity.attemptId,
    };
    const request: StoredIdempotency = {
      counterpartId: identity.factId,
      canonicalDigest: identity.canonicalDigest,
      payloadSha256: identity.payloadSha256,
      resourceId: identity.attemptId,
    };
    const priorFact = this.factKeys.get(factKey);
    const priorRequest = this.requestKeys.get(requestKey);
    if (priorFact !== undefined || priorRequest !== undefined) {
      if (!same(priorFact, fact) || !same(priorRequest, request)) {
        throw new AuthorityConflict(
          'Fact/request identity was reused differently',
        );
      }
      return 'replay';
    }
    this.factKeys.set(factKey, fact);
    this.requestKeys.set(requestKey, request);
    return 'applied';
  }

  async recordBindingObservationAndResolveLaunch(input: {
    lease: TaskAuthorityLease;
    verified: VerifiedRunBindingIngress;
    expectedAttemptRevision: number;
  }): Promise<WriteResult> {
    if (!isVerifiedRunBindingIngress(input.verified)) {
      throw new AuthorityConflict(
        'Binding capability was not minted by ingress',
      );
    }
    const parsedEnvelope = runtimeObservationEnvelopeSchema.safeParse(
      input.verified.envelope,
    );
    const parsedMarker = localAttemptMarkerSchema.safeParse(
      input.verified.localAttemptMarker,
    );
    if (!parsedEnvelope.success || !parsedMarker.success) {
      throw new AuthorityConflict('Binding observation is invalid');
    }
    const envelope = parsedEnvelope.data;
    if (
      envelope.payload.kind !== 'run-bound' ||
      !(await hasValidRuntimeObservationPayloadDigest(envelope))
    ) {
      throw new AuthorityConflict('Binding observation is invalid');
    }
    const attempt = this.attempts.get(envelope.attemptId);
    const launch = this.launches.get(envelope.attemptId);
    if (attempt === undefined || launch === undefined) {
      throw new AuthorityConflict(
        'Binding attempt or launch operation is unknown',
      );
    }
    this.assertLease(input.lease, attempt.spec.task, this.now());
    if (
      envelope.tenant.tenantId !== attempt.spec.tenant.tenantId ||
      envelope.tenant.repositoryId !== attempt.spec.tenant.repositoryId ||
      envelope.task.issueNumber !== attempt.spec.task.issueNumber ||
      parsedMarker.data !== attempt.spec.local.attemptMarker
    ) {
      throw new AuthorityConflict(
        'Binding ingress scope or local marker is invalid',
      );
    }
    const sourceIdentity = `${envelope.source.kind}:${envelope.source.sourceId}`;
    const canonicalDigest = attemptTransitionDigest({
      kind: 'observation',
      envelope,
    });
    const { factKey, requestKey } = observationKeys({
      tenantId: envelope.tenant.tenantId,
      repositoryId: envelope.tenant.repositoryId,
      sourceIdentity,
      attemptId: envelope.attemptId,
      factId: envelope.factId,
      requestId: envelope.requestId,
    });
    const fact: StoredIdempotency = {
      counterpartId: envelope.requestId,
      canonicalDigest,
      payloadSha256: envelope.payloadSha256,
      resourceId: envelope.attemptId,
    };
    const request: StoredIdempotency = {
      counterpartId: envelope.factId,
      canonicalDigest,
      payloadSha256: envelope.payloadSha256,
      resourceId: envelope.attemptId,
    };
    const priorFact = this.factKeys.get(factKey);
    const priorRequest = this.requestKeys.get(requestKey);
    if (priorFact !== undefined || priorRequest !== undefined) {
      const converged =
        attempt.launch.state === 'accepted' &&
        launch.state === 'accepted' &&
        attempt.binding !== undefined &&
        same(attempt.binding, envelope.payload.binding) &&
        attempt.facts.some(
          (receipt) =>
            receipt.factId === envelope.factId &&
            receipt.requestId === envelope.requestId &&
            receipt.payloadSha256 === envelope.payloadSha256 &&
            receipt.canonicalDigest === canonicalDigest,
        );
      if (
        !same(priorFact, fact) ||
        !same(priorRequest, request) ||
        !converged
      ) {
        throw new AuthorityConflict('Binding fact/request replay conflicts');
      }
      return 'replay';
    }
    if (
      !['pending', 'dispatching', 'unknown', 'accepted'].includes(launch.state)
    ) {
      throw new AuthorityConflict(
        'Launch outbox cannot be reconciled by binding',
      );
    }
    const reduced = reduceAttempt(attempt, {
      kind: 'transition',
      expectedRevision: input.expectedAttemptRevision,
      transitionedAt: envelope.observedAt,
      canonicalDigest,
      event: { kind: 'observation', envelope },
    });
    if (reduced.status !== 'applied') {
      throw new AuthorityConflict(
        'Binding observation did not produce a new valid transition',
      );
    }
    const nextAttempt = reduced.state;
    if (
      attempt.revision !== input.expectedAttemptRevision ||
      nextAttempt.revision !== attempt.revision + 1 ||
      nextAttempt.binding === undefined ||
      nextAttempt.launch.state !== 'accepted' ||
      !same(nextAttempt.binding, envelope.payload.binding)
    ) {
      throw new AuthorityConflict('Binding attempt CAS failed');
    }
    const nextBindingKey = bindingKey(nextAttempt.spec, nextAttempt.binding);
    const bindingOwner = this.bindings.get(nextBindingKey);
    if (bindingOwner !== undefined && bindingOwner !== envelope.attemptId) {
      throw new AuthorityConflict(
        'Exact run binding belongs to another attempt',
      );
    }
    this.writeAttemptTransaction({
      lease: input.lease,
      expectedRevision: input.expectedAttemptRevision,
      next: nextAttempt,
    });
    this.factKeys.set(factKey, fact);
    this.requestKeys.set(requestKey, request);
    this.launches.set(envelope.attemptId, { ...launch, state: 'accepted' });
    return 'applied';
  }

  private reserveMintAt(
    input: {
      identity: MintIdentity;
      grant: CredentialGrantIssuance;
      maxIssuances: number;
    },
    now: string,
  ): WriteResult {
    const parsedGrant = credentialGrantIssuanceSchema.safeParse(input.grant);
    if (!parsedGrant.success) {
      throw new AuthorityConflict(
        'Grant metadata is invalid or contains extra data',
      );
    }
    const grant = parsedGrant.data;
    const attempt = this.attempts.get(input.identity.attemptId);
    if (
      attempt === undefined ||
      attempt.spec.tenant.tenantId !== input.identity.tenantId ||
      attempt.spec.tenant.repositoryId !== input.identity.repositoryId ||
      grant.attemptId !== input.identity.attemptId ||
      grant.requestId !== input.identity.requestId ||
      grant.credentialProfileId !==
        attempt.spec.execution.credentialProfileId ||
      attempt.binding === undefined ||
      !same(attempt.binding, input.identity.binding) ||
      attempt.phase !== 'active'
    ) {
      throw new AuthorityConflict('Mint request scope or profile is invalid');
    }
    if (
      attempt.futureGrantsDenied ||
      parsedTime(now, 'clock.now') >=
        parsedTime(attempt.spec.execution.renewalDeadline, 'renewalDeadline')
    ) {
      throw new AuthorityConflict('Attempt cannot receive another grant');
    }
    if (
      grant.issuanceState !== 'pending' ||
      grant.mintState !== 'mint-in-progress' ||
      grant.mintStartedAt !== now
    ) {
      throw new AuthorityConflict(
        'Mint must reserve pending/in-progress first',
      );
    }
    if (
      !Number.isSafeInteger(input.maxIssuances) ||
      input.maxIssuances <= 0 ||
      !SHA256.test(input.identity.canonicalDigest) ||
      !SHA256.test(input.identity.jtiSha256)
    ) {
      throw new AuthorityConflict('Mint budget or digest is invalid');
    }

    const { requestKey, jtiKey, slotKey } = mintKeys(
      input.identity,
      grant.credentialProfileId,
    );
    const request: StoredIdempotency = {
      counterpartId: input.identity.jtiSha256,
      canonicalDigest: input.identity.canonicalDigest,
      resourceId: grant.grantId,
    };
    const jti: StoredIdempotency = {
      counterpartId: input.identity.requestId,
      canonicalDigest: input.identity.canonicalDigest,
      resourceId: grant.grantId,
    };
    const priorRequest = this.mintRequestKeys.get(requestKey);
    const priorJti = this.jtiKeys.get(jtiKey);
    const priorGrant = this.mints.get(grant.grantId);
    if (
      priorRequest !== undefined ||
      priorJti !== undefined ||
      priorGrant !== undefined
    ) {
      if (
        !same(priorRequest, request) ||
        !same(priorJti, jti) ||
        priorGrant === undefined ||
        !same(priorGrant.identity, input.identity) ||
        !same(priorGrant.grant, grant)
      ) {
        throw new AuthorityConflict(
          'Mint request, JTI, or grant was reused differently',
        );
      }
      return 'replay';
    }

    const storedLimit = this.mintLimits.get(slotKey);
    if (storedLimit !== undefined && storedLimit !== input.maxIssuances) {
      throw new AuthorityConflict('Credential issuance budget is immutable');
    }
    if ((this.mintCounts.get(slotKey) ?? 0) >= input.maxIssuances) {
      throw new AuthorityConflict('Credential issuance budget is exhausted');
    }
    const slotGrantId = this.mintSlots.get(slotKey);
    if (slotGrantId !== undefined) {
      const slot = this.mints.get(slotGrantId);
      if (slot === undefined)
        throw new AuthorityConflict('Mint slot is corrupt');
      if (
        slot.grant.mintState === 'mint-in-progress' ||
        slot.grant.mintState === 'mint-unknown' ||
        (slot.grant.issuanceState === 'issued' &&
          parsedTime(slot.grant.tokenExpiresAt, 'tokenExpiresAt') >
            parsedTime(now, 'clock.now'))
      ) {
        throw new AuthorityConflict(
          'Credential profile already has live exposure',
        );
      }
    }

    this.mintRequestKeys.set(requestKey, request);
    this.jtiKeys.set(jtiKey, jti);
    this.mints.set(grant.grantId, {
      tenantId: input.identity.tenantId,
      repositoryId: input.identity.repositoryId,
      identity: clone(input.identity),
      grant: clone(grant),
    });
    this.mintSlots.set(slotKey, grant.grantId);
    this.mintLimits.set(slotKey, input.maxIssuances);
    this.mintCounts.set(slotKey, (this.mintCounts.get(slotKey) ?? 0) + 1);
    return 'applied';
  }

  async lookupOrReserveMint(input: {
    identity: MintIdentity;
    credentialProfileId: string;
    maxIssuances: number;
  }): Promise<MintReservation> {
    const { requestKey, jtiKey, slotKey } = mintKeys(
      input.identity,
      input.credentialProfileId,
    );
    const priorRequest = this.mintRequestKeys.get(requestKey);
    const priorJti = this.jtiKeys.get(jtiKey);
    if (priorRequest !== undefined || priorJti !== undefined) {
      if (
        priorRequest === undefined ||
        priorJti === undefined ||
        priorRequest.resourceId !== priorJti.resourceId ||
        priorRequest.counterpartId !== input.identity.jtiSha256 ||
        priorJti.counterpartId !== input.identity.requestId ||
        priorRequest.canonicalDigest !== input.identity.canonicalDigest ||
        priorJti.canonicalDigest !== input.identity.canonicalDigest
      ) {
        throw new AuthorityConflict(
          'Mint request or JTI was reused differently',
        );
      }
      const stored = this.mints.get(priorRequest.resourceId);
      if (
        stored === undefined ||
        !same(stored.identity, input.identity) ||
        stored.grant.credentialProfileId !== input.credentialProfileId ||
        this.mintLimits.get(slotKey) !== input.maxIssuances
      ) {
        throw new AuthorityConflict(
          'Mint reservation is corrupt, changed, or cross-scoped',
        );
      }
      return { status: 'existing', grant: clone(stored.grant) };
    }
    const mintStartedAt = this.now();
    const grant: CredentialGrantIssuance = {
      grantId: randomUUID(),
      attemptId: input.identity.attemptId,
      requestId: input.identity.requestId,
      credentialProfileId: input.credentialProfileId,
      issuanceState: 'pending',
      mintState: 'mint-in-progress',
      mintStartedAt,
    };
    this.reserveMintAt({ ...input, grant }, mintStartedAt);
    return { status: 'created', grant: clone(grant) };
  }

  async resolveMint(input: {
    tenantId: string;
    attemptId: string;
    grant: CredentialGrantIssuance;
  }): Promise<WriteResult> {
    return this.resolveMintAt(input, 'unknown-only');
  }

  async resolveVerifiedMint(input: {
    tenantId: string;
    attemptId: string;
    verified: VerifiedMintResolution;
  }): Promise<WriteResult> {
    if (!isVerifiedMintResolution(input.verified)) {
      throw new AuthorityConflict('Mint resolution was not verified here');
    }
    return this.resolveMintAt(
      {
        tenantId: input.tenantId,
        attemptId: input.attemptId,
        grant: input.verified.issuance,
      },
      'verified',
    );
  }

  private resolveMintAt(
    input: {
      tenantId: string;
      attemptId: string;
      grant: CredentialGrantIssuance;
    },
    authority: 'unknown-only' | 'verified',
  ): WriteResult {
    const parsedGrant = credentialGrantIssuanceSchema.safeParse(input.grant);
    if (!parsedGrant.success) {
      throw new AuthorityConflict('Grant resolution metadata is invalid');
    }
    const grant = parsedGrant.data;
    const stored = this.mints.get(grant.grantId);
    if (
      stored === undefined ||
      stored.tenantId !== input.tenantId ||
      stored.grant.attemptId !== input.attemptId ||
      grant.attemptId !== input.attemptId
    ) {
      throw new AuthorityConflict('Mint reservation is unknown');
    }
    if (same(stored.grant, grant)) return 'replay';
    if (
      stored.grant.issuanceState !== 'pending' ||
      stored.grant.mintState !== 'mint-in-progress' ||
      !(
        (authority === 'verified' &&
          grant.issuanceState === 'issued' &&
          grant.mintState === 'minted') ||
        (grant.issuanceState === 'denied' &&
          ((grant.mintState === 'mint-unknown' &&
            grant.denialCode === 'mint_unknown') ||
            (authority === 'verified' &&
              grant.mintState === 'not-started' &&
              grant.denialCode === 'service_unavailable')))
      ) ||
      grant.requestId !== stored.grant.requestId ||
      grant.credentialProfileId !== stored.grant.credentialProfileId
    ) {
      throw new AuthorityConflict('Mint resolution is not a legal transition');
    }
    stored.grant = clone(grant);
    return 'applied';
  }

  async readMint(input: {
    tenantId: string;
    grantId: string;
  }): Promise<CredentialGrantIssuance | undefined> {
    const stored = this.mints.get(input.grantId);
    if (stored === undefined || stored.tenantId !== input.tenantId) {
      return undefined;
    }
    return clone(stored.grant);
  }

  async enqueueProjection(input: {
    lease: TaskAuthorityLease;
    tenantId: string;
    intent: ProjectionIntent;
  }): Promise<WriteResult> {
    if (!projectionIntentSchema.safeParse(input.intent).success) {
      throw new AuthorityConflict('Projection intent is invalid');
    }
    const attempt = this.attempts.get(input.intent.attemptId);
    if (
      attempt === undefined ||
      input.tenantId !== attempt.spec.tenant.tenantId
    ) {
      throw new AuthorityConflict('Projection attempt scope is invalid');
    }
    this.assertLease(input.lease, attempt.spec.task, this.now());
    const key = `${input.tenantId}:${input.intent.operationId}`;
    const current = this.projections.get(key);
    if (current !== undefined) {
      if (!same(current.intent, input.intent)) {
        throw new AuthorityConflict(
          'Projection operation was reused differently',
        );
      }
      return 'replay';
    }
    this.projections.set(key, {
      tenantId: input.tenantId,
      intent: clone(input.intent),
      deliveryState: 'pending',
    });
    return 'applied';
  }

  async listProjections(input: {
    tenantId: string;
    state: ProjectionRecord['deliveryState'];
  }): Promise<ProjectionRecord[]> {
    return [...this.projections.values()]
      .filter(
        (projection) =>
          projection.tenantId === input.tenantId &&
          projection.deliveryState === input.state,
      )
      .map(clone);
  }

  async claimProjection(input: {
    lease: TaskAuthorityLease;
    tenantId: string;
    operationId: string;
  }): Promise<WriteResult> {
    const key = `${input.tenantId}:${input.operationId}`;
    const current = this.projections.get(key);
    const attempt =
      current === undefined
        ? undefined
        : this.attempts.get(current.intent.attemptId);
    if (current === undefined || attempt === undefined) {
      throw new AuthorityConflict('Projection operation is unknown');
    }
    this.assertLease(input.lease, attempt.spec.task, this.now());
    if (
      current.deliveryState === 'delivering' &&
      current.claimedFence === input.lease.fence
    ) {
      return 'replay';
    }
    if (current.deliveryState === 'delivering') {
      // Projection effects are idempotent by operationId, so a later fenced
      // owner may redeliver after the previous task lease disappeared.
      current.claimedFence = input.lease.fence;
      return 'applied';
    }
    if (current.deliveryState !== 'pending') {
      throw new AuthorityConflict('Projection is not claimable');
    }
    current.deliveryState = 'delivering';
    current.claimedFence = input.lease.fence;
    return 'applied';
  }

  async acknowledgeProjection(input: {
    lease: TaskAuthorityLease;
    tenantId: string;
    status: ProjectionStatusV1;
  }): Promise<WriteResult> {
    if (!projectionStatusV1Schema.safeParse(input.status).success) {
      throw new AuthorityConflict('Projection status is invalid');
    }
    const key = `${input.tenantId}:${input.status.operationId}`;
    const current = this.projections.get(key);
    const attempt =
      current === undefined
        ? undefined
        : this.attempts.get(current.intent.attemptId);
    if (current === undefined || attempt === undefined) {
      throw new AuthorityConflict('Projection operation is unknown');
    }
    this.assertLease(input.lease, attempt.spec.task, this.now());
    if (same(current.status, input.status)) return 'replay';
    if (
      current.deliveryState !== 'delivering' ||
      current.claimedFence !== input.lease.fence ||
      input.status.state === 'pending'
    ) {
      throw new AuthorityConflict('Projection acknowledgement is not claimed');
    }
    if (current.status?.state === 'converged') {
      throw new AuthorityConflict('Converged projection is immutable');
    }
    if (
      current.status !== undefined &&
      parsedTime(input.status.observedAt, 'observedAt') <
        parsedTime(current.status.observedAt, 'observedAt')
    ) {
      throw new AuthorityConflict('Projection acknowledgement moved backwards');
    }
    current.status = clone(input.status);
    current.deliveryState =
      input.status.state === 'converged' ? 'complete' : 'pending';
    current.claimedFence = undefined;
    return 'applied';
  }

  async readProjection(input: {
    tenantId: string;
    operationId: string;
  }): Promise<ProjectionRecord | undefined> {
    const value = this.projections.get(
      `${input.tenantId}:${input.operationId}`,
    );
    return value === undefined ? undefined : clone(value);
  }
}

/** Compatibility-free short alias for callers that do not name the backend. */
export type AuthorityStorage = LifecycleAuthorityStorage;
export { InMemoryLifecycleAuthorityStorage as InMemoryAuthorityStorage };
