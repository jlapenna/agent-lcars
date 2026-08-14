import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type {
  AcceptedAttemptSpec,
  ActivationProvenance,
  ActivationRecord,
  AttemptPresentationPlan,
  CredentialGrantIssuance,
  RunBinding,
  TaskPresentationPlan,
} from '@agent-lcars/dispatch-contracts';
import type { AgentResultClaimV1 } from '@agent-lcars/dispatch-contracts';
import {
  acceptedAttemptSpecSchema,
  attemptPresentationPlanSchema,
  credentialGrantIssuanceSchema,
  formatAttemptId,
  hasValidRuntimeObservationPayloadDigest,
  localAttemptMarkerSchema,
  runtimeObservationEnvelopeSchema,
  taskPresentationPlanSchema,
} from '@agent-lcars/dispatch-contracts';

import {
  isVerifiedAttemptAdmission,
  type VerifiedAttemptAdmission,
} from './admission-capability';
import type { AttemptState } from './attempt-reducer';
import {
  type AttemptEvent,
  attemptSpecDigest,
  attemptTransitionDigest,
  deriveFinalizedOutcome,
  reduceAttempt,
} from './attempt-reducer';
import { registerAttemptTestHydrator } from './attempt-test-hydration';
import {
  isVerifiedCancellationEffect,
  type VerifiedCancellationEffect,
} from './cancellation-effect-capability';
import {
  attemptHasCommand,
  finalizationCommandId,
  isVerifiedFinalizationTransition,
  validationForVerdict,
  type VerifiedFinalizationTransition,
} from './finalization-capability';
import {
  isVerifiedLaunchResolution,
  launchResolutionEventId,
  mintClaimedLaunchWork,
  type VerifiedClaimedLaunchWork,
  type VerifiedLaunchResolution,
} from './launch-resolution-capability';
import {
  isVerifiedMintResolution,
  type VerifiedMintResolution,
} from './mint-resolution';
import {
  isVerifiedRunBindingIngress,
  type VerifiedRunBindingIngress,
} from './run-binding-ingress';
import {
  isVerifiedAdmissionEffectCompletion,
  isVerifiedTaskEffectObsoletion,
  isVerifiedTaskEffectTransition,
  type VerifiedAdmissionEffectCompletion,
  type VerifiedTaskEffectObsoletion,
  type VerifiedTaskEffectTransition,
} from './task-effect-capability';
import {
  admitTaskAttempt,
  reduceTaskIntent,
  type TaskIntentEffect,
  taskIntentInputDigest,
  type TaskIntentState,
} from './task-intent-reducer';
import { registerTaskTestHydrator } from './task-test-hydration';

const SHA256 = /^[a-f0-9]{64}$/u;
const ATTEMPT_ID = /^[A-Za-z0-9_-]{22,64}$/u;

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

/** Storage mints an id only after its acceptance preflight succeeds. */
export interface AttemptIdFactory {
  mint(): string;
}

export interface LaunchOutboxRecord {
  operationId: string;
  attemptId: string;
  tenantId: string;
  repositoryId: number;
  issueNumber: number;
  executionEpoch: number;
  state: 'pending' | 'dispatching' | 'accepted' | 'unknown' | 'suppressed';
  claimedFence?: number;
  claimToken?: string;
}

export interface LaunchWorkClaim {
  status: 'claimed' | 'replay' | 'terminal';
  work?: VerifiedClaimedLaunchWork;
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

export interface AdmissionResult {
  replay: boolean;
  task?: TaskIntentState;
  attempt?: AttemptState;
  launch: LaunchOutboxRecord;
}

export type WriteResult = 'applied' | 'replay';

export interface MintReservation {
  status: 'created' | 'existing';
  grant: CredentialGrantIssuance;
}

export interface ValidationWorkRecord {
  tenantId: string;
  attemptId: string;
  terminalFactId: string;
  claimFactId: string;
  claim: AgentResultClaimV1;
  state: 'pending' | 'resolving' | 'complete';
  claimedFence?: number;
  validationFactId?: string;
}

export interface TaskEffectRecord {
  tenantId: string;
  task: TaskAuthorityScope;
  sourceFactId: string;
  effectKey: string;
  canonicalDigest: string;
  /** Reducer revision that causally emitted this effect; never reconstructed. */
  taskRevision: number;
  activation: ActivationProvenance;
  payload: TaskIntentEffect;
  deliveryState: 'pending' | 'working' | 'complete' | 'obsolete';
  claimedFence?: number;
  claimToken?: string;
  completion?:
    | { kind: 'admission-receipt'; attemptId: string }
    | { kind: 'task-presentation-receipt'; operationId: string };
  obsoleteReason?: 'superseded' | 'activation-no-longer-authoritative';
}

export interface TaskPresentationRecord {
  tenantId: string;
  plan: TaskPresentationPlan;
  deliveryState: 'pending' | 'obsolete';
  obsoleteAtTaskRevision?: number;
  obsoleteReason?: 'newer-presentation' | 'task-resumed' | 'task-cancelled';
}

export interface AttemptPresentationRecord {
  tenantId: string;
  plan: AttemptPresentationPlan;
  deliveryState: 'pending';
}

export interface TaskEffectTransitionResult {
  status: 'applied' | 'replay';
  task: TaskIntentState;
  effects: TaskEffectRecord[];
  plans: TaskPresentationRecord[];
  obsoletedPlans: TaskPresentationRecord[];
}

export interface TaskEffectClaim {
  status: 'claimed' | 'replay' | 'terminal';
  effect: TaskEffectRecord;
}

export interface CancellationWorkRecord {
  tenantId: string;
  attemptId: string;
  eventId: string;
  executionEpoch: number;
  state: 'awaiting-binding' | 'pending';
  supersededByIntentId?: string;
}

export interface CancellationEffectResult {
  effect: TaskEffectRecord;
  attempt?: AttemptState;
  work?: CancellationWorkRecord;
  presentation?: AttemptPresentationRecord;
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

  /** Capability-checked Task/Intent reducer transition and exact work receipt. */
  applyTaskEffectTransition(input: {
    lease: TaskAuthorityLease;
    transition: VerifiedTaskEffectTransition;
  }): Promise<TaskEffectTransitionResult>;
  readTaskPresentation(input: {
    tenantId: string;
    task: TaskAuthorityScope;
    operationId: string;
  }): Promise<TaskPresentationRecord | undefined>;
  listTaskPresentations(input: {
    tenantId: string;
    task: TaskAuthorityScope;
    state?: TaskPresentationRecord['deliveryState'];
  }): Promise<TaskPresentationRecord[]>;
  readAttemptPresentation(input: {
    tenantId: string;
    attemptId: string;
    operationId: string;
  }): Promise<AttemptPresentationRecord | undefined>;
  listAttemptPresentations(input: {
    tenantId: string;
    attemptId?: string;
    task?: TaskAuthorityScope;
  }): Promise<AttemptPresentationRecord[]>;
  listTaskEffects(input: {
    tenantId: string;
    task: TaskAuthorityScope;
    state?: TaskEffectRecord['deliveryState'];
  }): Promise<TaskEffectRecord[]>;
  readTaskEffect(input: {
    tenantId: string;
    task: TaskAuthorityScope;
    sourceFactId: string;
    effectKey: string;
  }): Promise<TaskEffectRecord | undefined>;
  claimTaskEffect(input: {
    lease: TaskAuthorityLease;
    tenantId: string;
    task: TaskAuthorityScope;
    sourceFactId: string;
    effectKey: string;
  }): Promise<TaskEffectClaim>;
  completeTaskEffect(input: {
    lease: TaskAuthorityLease;
    completion: VerifiedAdmissionEffectCompletion;
  }): Promise<TaskEffectRecord>;
  obsoleteTaskEffect(input: {
    lease: TaskAuthorityLease;
    obsoletion: VerifiedTaskEffectObsoletion;
  }): Promise<TaskEffectRecord>;
  applyVerifiedCancellationEffect(input: {
    lease: TaskAuthorityLease;
    cancellation: VerifiedCancellationEffect;
  }): Promise<CancellationEffectResult>;
  /**
   * Returns the immutable cancellation transaction receipt after a caller
   * crashes between commit and observing its response. This remains lease
   * scoped: a stale or foreign controller cannot use it as a read bypass.
   */
  readCancellationReceipt(input: {
    lease: TaskAuthorityLease;
    tenantId: string;
    task: TaskAuthorityScope;
    sourceFactId: string;
    effectKey: string;
  }): Promise<CancellationEffectResult | undefined>;
  listCancellationWork(input: {
    tenantId: string;
    state?: CancellationWorkRecord['state'];
  }): Promise<CancellationWorkRecord[]>;

  /** Runtime-checked coordinator capability; no structural admission writer. */
  admitVerifiedAttemptAndRecordLaunch(input: {
    lease: TaskAuthorityLease;
    admission: VerifiedAttemptAdmission;
  }): Promise<AdmissionResult>;
  /** Exact read-only replay receipt; never scans across tenant/task scope. */
  readAttemptAdmission(input: {
    lease: TaskAuthorityLease;
    tenantId: string;
    task: TaskAuthorityScope;
    intentId: string;
    intentRevision: number;
  }): Promise<AdmissionResult | undefined>;
  readTask(scope: TaskAuthorityScope): Promise<TaskIntentState | undefined>;
  readAttempt(input: {
    tenantId: string;
    attemptId: string;
  }): Promise<AttemptState | undefined>;
  /** Capability-checked atomic reducer transition, replay indexes and work. */
  applyFinalizationTransition(input: {
    lease: TaskAuthorityLease;
    transition: VerifiedFinalizationTransition;
  }): Promise<WriteResult>;
  listValidationWork(input: {
    tenantId: string;
    state: ValidationWorkRecord['state'];
  }): Promise<ValidationWorkRecord[]>;
  claimValidationWork(input: {
    lease: TaskAuthorityLease;
    tenantId: string;
    attemptId: string;
    terminalFactId: string;
    claimFactId: string;
  }): Promise<WriteResult>;

  readLaunch(input: {
    tenantId: string;
    attemptId: string;
  }): Promise<LaunchOutboxRecord | undefined>;
  listLaunches(input: {
    tenantId: string;
    state: LaunchOutboxRecord['state'];
  }): Promise<LaunchOutboxRecord[]>;
  claimLaunchWork(input: {
    lease: TaskAuthorityLease;
    tenantId: string;
    attemptId: string;
  }): Promise<LaunchWorkClaim>;
  resolveVerifiedLaunch(input: {
    lease: TaskAuthorityLease;
    resolution: VerifiedLaunchResolution;
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

function admissionAcceptanceKey(input: VerifiedAttemptAdmission): string {
  return tupleKey(
    input.task.tenantId,
    input.task.repositoryId,
    input.task.issueNumber,
    input.intentId,
    input.intentRevision,
  );
}

function admissionCommandDigest(input: VerifiedAttemptAdmission): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        tenant: input.tenant,
        task: input.task,
        expectedTaskRevision: input.expectedTaskRevision,
        intentId: input.intentId,
        intentRevision: input.intentRevision,
        activation: input.activation,
        execution: input.execution,
      }),
    )
    .digest('hex');
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

function validationWorkKey(
  tenantId: string,
  attemptId: string,
  terminalFactId: string,
  claimFactId: string,
): string {
  return tupleKey(
    tenantId,
    attemptId,
    'validation-work',
    terminalFactId,
    claimFactId,
  );
}

function taskEffectKey(input: {
  tenantId: string;
  task: TaskAuthorityScope;
  sourceFactId: string;
  effectKey: string;
}): string {
  return tupleKey(
    input.tenantId,
    input.task.repositoryId,
    input.task.issueNumber,
    'task-effect',
    input.sourceFactId,
    input.effectKey,
  );
}

function cancellationEventId(
  command: Pick<
    VerifiedCancellationEffect,
    'tenantId' | 'task' | 'sourceFactId' | 'effectKey'
  >,
  target: Extract<TaskIntentEffect, { kind: 'cancel-or-drain' }>,
): string {
  return `cancel:${createHash('sha256')
    .update(
      canonicalJson({
        tenantId: command.tenantId,
        task: {
          tenantId: command.task.tenantId,
          repositoryId: command.task.repositoryId,
          issueNumber: command.task.issueNumber,
        },
        sourceFactId: command.sourceFactId,
        effectKey: command.effectKey,
        target: {
          attemptId: target.attemptId,
          intentId: target.intentId,
          intentRevision: target.intentRevision,
          supersededByIntentId: target.supersededByIntentId,
        },
      }),
    )
    .digest('hex')}`;
}

function taskPresentationKey(input: {
  tenantId: string;
  task: TaskAuthorityScope;
  operationId: string;
}): string {
  return tupleKey(
    input.tenantId,
    input.task.repositoryId,
    input.task.issueNumber,
    'task-presentation',
    input.operationId,
  );
}

function attemptPresentationKey(
  tenantId: string,
  attemptId: string,
  operationId: string,
): string {
  return tupleKey(tenantId, attemptId, 'attempt-presentation', operationId);
}

function attemptPresentationReceiptKey(
  tenantId: string,
  attemptId: string,
  finalizationCommandId: string,
): string {
  return tupleKey(
    tenantId,
    attemptId,
    'attempt-presentation-receipt',
    finalizationCommandId,
  );
}

interface DerivedAttemptPresentation {
  key: string;
  receiptKey: string;
  planDigest: string;
  outcomeDigest: string;
  record: AttemptPresentationRecord;
}

function finalizationPresentationProvenance(
  state: AttemptState,
  commandId: string,
): Extract<AttemptPresentationPlan['terminal'], { kind: 'finalization' }> {
  const terminalFactId = state.finalization?.terminalFactId;
  if (terminalFactId === undefined) {
    throw new AuthorityConflict('Final outcome terminal fact is absent');
  }
  return { kind: 'finalization', commandId, terminalFactId };
}

function deriveAttemptPresentation(
  state: AttemptState,
  terminal: AttemptPresentationPlan['terminal'],
): DerivedAttemptPresentation {
  const outcome = state.outcome;
  const activation = state.spec.activation;
  if (outcome === undefined || activation.mode !== 'central-authoritative') {
    throw new AuthorityConflict(
      'Final outcome presentation is not centrally pinned',
    );
  }
  if (
    (terminal.kind === 'finalization' &&
      state.finalization?.terminalFactId !== terminal.terminalFactId) ||
    (terminal.kind === 'lifecycle-decision' &&
      (outcome.evidence.kind !== 'lifecycle-decision' ||
        outcome.evidence.decisionFactId !== terminal.commandId))
  ) {
    throw new AuthorityConflict(
      'Final outcome presentation provenance is invalid',
    );
  }
  const outcomeDigest = createHash('sha256')
    .update(canonicalJson(outcome))
    .digest('hex');
  const operationId = `attempt-final:${createHash('sha256')
    .update(
      canonicalJson({
        tenantId: state.spec.tenant.tenantId,
        attemptId: state.spec.attemptId,
        revision: state.revision,
        terminal,
        outcomeDigest,
      }),
    )
    .digest('hex')}`;
  const failure =
    outcome.failure === undefined
      ? undefined
      : {
          owningSystem: outcome.failure.owningSystem,
          phase: outcome.failure.phase,
          reason: outcome.failure.reason,
          retryDisposition: outcome.failure.retryDisposition,
          ...(outcome.failure.retryBudget === undefined
            ? {}
            : { retryBudget: outcome.failure.retryBudget }),
        };
  const parsed = attemptPresentationPlanSchema.safeParse({
    schema: 'agent-lcars.attempt-presentation-plan/v1',
    version: 1,
    operationId,
    tenant: state.spec.tenant,
    task: state.spec.task,
    attemptId: state.spec.attemptId,
    attemptRevision: state.revision,
    terminal,
    outcomeDigest,
    activation,
    presentation: {
      kind: 'attempt-finalized',
      terminalState: outcome.terminalState,
      execution: outcome.execution,
      result: outcome.result,
      ...(outcome.reference === undefined
        ? {}
        : { reference: outcome.reference }),
      evidenceValidation: outcome.evidenceValidation.status,
      ...(failure === undefined ? {} : { failure }),
    },
  });
  if (!parsed.success) {
    throw new AuthorityConflict('Derived attempt presentation is invalid');
  }
  const record: AttemptPresentationRecord = {
    tenantId: parsed.data.tenant.tenantId,
    plan: parsed.data,
    deliveryState: 'pending',
  };
  return {
    key: attemptPresentationKey(
      record.tenantId,
      record.plan.attemptId,
      record.plan.operationId,
    ),
    receiptKey: attemptPresentationReceiptKey(
      record.tenantId,
      record.plan.attemptId,
      terminal.commandId,
    ),
    planDigest: createHash('sha256')
      .update(canonicalJson(record.plan))
      .digest('hex'),
    outcomeDigest,
    record,
  };
}

function taskPresentationForEffect(input: {
  tenant: TaskIntentState['tenant'];
  effect: TaskEffectRecord;
  transitionDigest: string;
}): TaskPresentationPlan | undefined {
  const payload = input.effect.payload;
  if (payload.kind !== 'park-projection') return undefined;
  const semantic = {
    tenantId: input.tenant.tenantId,
    task: input.effect.task,
    taskRevision: input.effect.taskRevision,
    sourceFactId: input.effect.sourceFactId,
    taskEffectKey: input.effect.effectKey,
    effectDigest: input.effect.canonicalDigest,
    transitionDigest: input.transitionDigest,
    activation: input.effect.activation,
    presentation: {
      disposition: 'parked' as const,
      humanAttention: 'required' as const,
      notice: { kind: 'task-parked' as const },
      ...(payload.intentId === undefined
        ? {}
        : {
            intentId: payload.intentId,
            intentRevision: payload.intentRevision,
          }),
      reason: payload.reason,
    },
  };
  const operationId = `task-park:${createHash('sha256').update(canonicalJson(semantic)).digest('hex')}`;
  const plan: TaskPresentationPlan = {
    schema: 'agent-lcars.task-presentation-plan/v1',
    version: 1,
    operationId,
    tenant: clone(input.tenant),
    task: clone(input.effect.task),
    taskRevision: input.effect.taskRevision,
    sourceFactId: input.effect.sourceFactId,
    taskEffectKey: input.effect.effectKey,
    effectDigest: input.effect.canonicalDigest,
    transitionDigest: input.transitionDigest,
    activation: clone(input.effect.activation),
    presentation: semantic.presentation,
  };
  if (!taskPresentationPlanSchema.safeParse(plan).success) {
    throw new AuthorityConflict('Derived task presentation plan is invalid');
  }
  return plan;
}

function taskPresentationDigest(record: TaskPresentationRecord): string {
  return createHash('sha256').update(canonicalJson(record.plan)).digest('hex');
}

function taskTransitionReceiptKey(input: {
  tenantId: string;
  task: TaskAuthorityScope;
  sourceFactId: string;
}): string {
  return tupleKey(
    input.tenantId,
    input.task.repositoryId,
    input.task.issueNumber,
    'task-effect-receipt',
    input.sourceFactId,
  );
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
  task: TaskIntentState;
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

interface StoredTaskEffectReceipt {
  canonicalDigest: string;
  task: TaskIntentState;
  effects: Array<{ key: string; canonicalDigest: string }>;
  plans: Array<{
    key: string;
    canonicalDigest: string;
    snapshot: TaskPresentationRecord;
  }>;
  obsoletedPlans: Array<{
    key: string;
    canonicalDigest: string;
    obsoleteAtTaskRevision: number;
    obsoleteReason: NonNullable<TaskPresentationRecord['obsoleteReason']>;
    snapshot: TaskPresentationRecord;
  }>;
}

const systemClock: AuthorityClock = {
  now: () => new Date().toISOString(),
};
const systemAttemptIds: AttemptIdFactory = {
  mint: () => randomBytes(16).toString('base64url'),
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
  private readonly validationWork = new Map<string, ValidationWorkRecord>();
  private readonly launchResolutionReceipts = new Map<string, string>();
  private readonly activations = new Map<string, ActivationRecord>();
  private readonly taskEffects = new Map<string, TaskEffectRecord>();
  private readonly taskPresentations = new Map<
    string,
    TaskPresentationRecord
  >();
  private readonly attemptPresentations = new Map<
    string,
    AttemptPresentationRecord
  >();
  private readonly attemptPresentationReceipts = new Map<
    string,
    {
      planKey: string;
      planDigest: string;
      outcomeDigest: string;
      snapshot: AttemptPresentationRecord;
    }
  >();
  private readonly taskEffectReceipts = new Map<
    string,
    StoredTaskEffectReceipt
  >();
  private readonly cancellationWork = new Map<string, CancellationWorkRecord>();
  private readonly cancellationReceipts = new Map<
    string,
    CancellationEffectResult
  >();

  constructor(
    private readonly clock: AuthorityClock = systemClock,
    private readonly attemptIds: AttemptIdFactory = systemAttemptIds,
  ) {
    registerTaskTestHydrator(this, (input) =>
      this.#bootstrapTaskForTest(input),
    );
    registerAttemptTestHydrator(this, (input) =>
      this.#hydrateAttemptForTest(input),
    );
  }

  #hydrateAttemptForTest(input: {
    lease: TaskAuthorityLease;
    expectedRevision: number;
    next: AttemptState;
  }): WriteResult {
    return this.writeAttemptTransaction(input);
  }

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

  private hasRegisteredActivationSync(input: {
    task: TaskAuthorityScope;
    activation: ActivationRecord;
    boundary: number;
  }): boolean {
    // A Task's activation provenance is immutable. Only an exact durable
    // receipt may recover work after a class cutover; activation rebind/history
    // is intentionally not implemented by this storage boundary.
    const registered = this.activations.get(
      activationKey({
        ...input.task,
        taskClassId: input.activation.taskClassId,
      }),
    );
    return (
      registered !== undefined &&
      same(registered, input.activation) &&
      input.boundary >= registered.effectiveBoundary &&
      registered.mode !== 'retired'
    );
  }

  async #bootstrapTaskForTest(input: {
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
      throw new AuthorityConflict('Task test bootstrap CAS failed');
    }
    this.tasks.set(key, clone(input.next));
    return 'applied';
  }

  async applyTaskEffectTransition(input: {
    lease: TaskAuthorityLease;
    transition: VerifiedTaskEffectTransition;
  }): Promise<TaskEffectTransitionResult> {
    if (!isVerifiedTaskEffectTransition(input.transition)) {
      throw new AuthorityConflict(
        'Task transition capability was not minted by authenticated ingress',
      );
    }
    const command = input.transition.input;
    const scope: TaskAuthorityScope = {
      tenantId: command.envelope.tenant.tenantId,
      repositoryId: command.envelope.tenant.repositoryId,
      issueNumber: command.envelope.task.issueNumber,
    };
    const now = this.now();
    this.assertLease(input.lease, scope, now);
    const digest = taskIntentInputDigest({
      envelope: command.envelope,
      policyDecision: command.policyDecision,
      activation: command.activation,
      ...(command.candidate === undefined
        ? {}
        : { candidate: command.candidate }),
    });
    if (digest !== command.canonicalDigest) {
      throw new AuthorityConflict(
        'Task transition canonical digest is invalid',
      );
    }
    const receiptKey = taskTransitionReceiptKey({
      tenantId: scope.tenantId,
      task: scope,
      sourceFactId: command.envelope.factId,
    });
    const prior = this.taskEffectReceipts.get(receiptKey);
    if (prior !== undefined) {
      if (prior.canonicalDigest !== command.canonicalDigest) {
        throw new AuthorityConflict(
          'Task fact was replayed with a different command',
        );
      }
      const effects = prior.effects.map(({ key }) => this.taskEffects.get(key));
      const plans = prior.plans.map(({ key }) =>
        this.taskPresentations.get(key),
      );
      const obsoletedPlans = prior.obsoletedPlans.map(({ key }) =>
        this.taskPresentations.get(key),
      );
      if (
        effects.some(
          (effect, index) =>
            effect === undefined ||
            effect.canonicalDigest !== prior.effects[index]?.canonicalDigest,
        )
      ) {
        throw new AuthorityConflict('Task effect receipt is inconsistent');
      }
      if (
        obsoletedPlans.some(
          (plan, index) =>
            plan === undefined ||
            taskPresentationDigest(plan) !==
              prior.obsoletedPlans[index]?.canonicalDigest ||
            plan.deliveryState !== 'obsolete' ||
            plan.obsoleteAtTaskRevision !==
              prior.obsoletedPlans[index]?.obsoleteAtTaskRevision ||
            plan.obsoleteReason !== prior.obsoletedPlans[index]?.obsoleteReason,
        )
      )
        throw new AuthorityConflict(
          'Task presentation obsoletion receipt is inconsistent',
        );
      if (
        plans.some(
          (plan, index) =>
            plan === undefined ||
            taskPresentationDigest(plan) !==
              prior.plans[index]?.canonicalDigest,
        )
      ) {
        throw new AuthorityConflict(
          'Task presentation receipt is inconsistent',
        );
      }
      if (
        plans.some((plan) => {
          const source = effects.find(
            (effect) => effect?.effectKey === plan?.plan.taskEffectKey,
          );
          return (
            source === undefined ||
            source.deliveryState !== 'complete' ||
            source.completion?.kind !== 'task-presentation-receipt' ||
            source.completion.operationId !== plan?.plan.operationId
          );
        })
      ) {
        throw new AuthorityConflict(
          'Task presentation source effect is incomplete',
        );
      }
      return {
        status: 'replay',
        task: clone(prior.task),
        effects: effects.map((effect) => clone(effect as TaskEffectRecord)),
        plans: prior.plans.map(({ snapshot }) => clone(snapshot)),
        obsoletedPlans: prior.obsoletedPlans.map(({ snapshot }) =>
          clone(snapshot),
        ),
      };
    }
    if (
      !this.hasRegisteredActivationSync({
        task: scope,
        activation: command.activation,
        boundary: command.expectedRevision + 1,
      })
    ) {
      throw new AuthorityConflict(
        'Task transition activation is not registered and current',
      );
    }
    const current = this.tasks.get(canonicalTaskKey(scope));
    const reduced = reduceTaskIntent(current, command);
    if (reduced.status === 'conflict') {
      throw new AuthorityConflict(`Task reducer conflict: ${reduced.message}`);
    }
    if (reduced.status === 'replay') {
      throw new AuthorityConflict('Task replay has no durable effect receipt');
    }
    if (
      reduced.effects.length > 0 &&
      !this.mayWriteEffectsSync({
        scope: { ...scope, taskClassId: reduced.state.activation.taskClassId },
        activation: reduced.state.activation,
        boundary: reduced.state.revision,
      })
    ) {
      throw new AuthorityConflict(
        'Task effects require the pinned active authority',
      );
    }
    const records = reduced.effects.map((effect): TaskEffectRecord => {
      const key = taskEffectKey({
        tenantId: scope.tenantId,
        task: scope,
        sourceFactId: command.envelope.factId,
        effectKey: effect.effectKey,
      });
      if (this.taskEffects.has(key)) {
        throw new AuthorityConflict('Task effect identity was reused');
      }
      return {
        tenantId: scope.tenantId,
        task: clone(scope),
        sourceFactId: command.envelope.factId,
        effectKey: effect.effectKey,
        canonicalDigest: createHash('sha256')
          .update(
            canonicalJson({ effect, commandDigest: command.canonicalDigest }),
          )
          .digest('hex'),
        taskRevision: reduced.state.revision,
        activation: clone(effect.activation),
        payload: clone(effect),
        deliveryState: 'pending',
      };
    });
    const plans = records.flatMap((effect) => {
      const plan = taskPresentationForEffect({
        tenant: reduced.state.tenant,
        effect,
        transitionDigest: command.canonicalDigest,
      });
      return plan === undefined
        ? []
        : [
            {
              tenantId: scope.tenantId,
              plan,
              deliveryState: 'pending' as const,
            },
          ];
    });
    for (const plan of plans) {
      const effect = records.find(
        (candidate) => candidate.effectKey === plan.plan.taskEffectKey,
      );
      if (effect === undefined)
        throw new AuthorityConflict('Task presentation effect is absent');
      effect.deliveryState = 'complete';
      effect.completion = {
        kind: 'task-presentation-receipt',
        operationId: plan.plan.operationId,
      };
    }
    for (const plan of plans) {
      const key = taskPresentationKey({
        tenantId: plan.tenantId,
        task: scope,
        operationId: plan.plan.operationId,
      });
      if (this.taskPresentations.has(key)) {
        throw new AuthorityConflict('Task presentation operation was reused');
      }
    }
    // All checks above occur before the contiguous in-memory transaction body.
    this.tasks.set(canonicalTaskKey(scope), clone(reduced.state));
    for (const record of records) {
      this.taskEffects.set(taskEffectKey(record), clone(record));
    }
    const obsoleteReason =
      plans.length > 0
        ? 'newer-presentation'
        : reduced.resolution.kind === 'desired'
          ? 'task-resumed'
          : reduced.resolution.kind === 'cancelled'
            ? 'task-cancelled'
            : undefined;
    const obsoletedPlans: TaskPresentationRecord[] = [];
    for (const [key, priorPlan] of this.taskPresentations) {
      if (
        priorPlan.tenantId === scope.tenantId &&
        same(priorPlan.plan.task, scope) &&
        priorPlan.deliveryState === 'pending' &&
        obsoleteReason !== undefined
      ) {
        const obsolete: TaskPresentationRecord = {
          ...priorPlan,
          deliveryState: 'obsolete',
          obsoleteAtTaskRevision: reduced.state.revision,
          obsoleteReason,
        };
        this.taskPresentations.set(key, obsolete);
        obsoletedPlans.push(obsolete);
      }
    }
    for (const plan of plans) {
      this.taskPresentations.set(
        taskPresentationKey({
          tenantId: plan.tenantId,
          task: scope,
          operationId: plan.plan.operationId,
        }),
        clone(plan),
      );
    }
    this.taskEffectReceipts.set(receiptKey, {
      canonicalDigest: command.canonicalDigest,
      task: clone(reduced.state),
      effects: records.map((record) => ({
        key: taskEffectKey(record),
        canonicalDigest: record.canonicalDigest,
      })),
      plans: plans.map((plan) => ({
        key: taskPresentationKey({
          tenantId: plan.tenantId,
          task: scope,
          operationId: plan.plan.operationId,
        }),
        canonicalDigest: taskPresentationDigest(plan),
        snapshot: clone(plan),
      })),
      obsoletedPlans: obsoletedPlans.map((plan) => ({
        key: taskPresentationKey({
          tenantId: plan.tenantId,
          task: scope,
          operationId: plan.plan.operationId,
        }),
        canonicalDigest: taskPresentationDigest(plan),
        obsoleteAtTaskRevision: plan.obsoleteAtTaskRevision as number,
        obsoleteReason: plan.obsoleteReason as NonNullable<
          TaskPresentationRecord['obsoleteReason']
        >,
        snapshot: clone(plan),
      })),
    });
    return {
      status: 'applied',
      task: clone(reduced.state),
      effects: clone(records),
      plans: clone(plans),
      obsoletedPlans: clone(obsoletedPlans),
    };
  }

  async listTaskEffects(input: {
    tenantId: string;
    task: TaskAuthorityScope;
    state?: TaskEffectRecord['deliveryState'];
  }): Promise<TaskEffectRecord[]> {
    if (input.tenantId !== input.task.tenantId) {
      throw new AuthorityConflict('Task effect tenant scope is invalid');
    }
    return [...this.taskEffects.values()]
      .filter(
        (effect) =>
          effect.tenantId === input.tenantId &&
          same(effect.task, input.task) &&
          (input.state === undefined || effect.deliveryState === input.state),
      )
      .map(clone);
  }

  async readTaskPresentation(input: {
    tenantId: string;
    task: TaskAuthorityScope;
    operationId: string;
  }): Promise<TaskPresentationRecord | undefined> {
    if (input.tenantId !== input.task.tenantId) {
      throw new AuthorityConflict('Task presentation tenant scope is invalid');
    }
    const value = this.taskPresentations.get(taskPresentationKey(input));
    return value === undefined ? undefined : clone(value);
  }

  async listTaskPresentations(input: {
    tenantId: string;
    task: TaskAuthorityScope;
    state?: TaskPresentationRecord['deliveryState'];
  }): Promise<TaskPresentationRecord[]> {
    if (input.tenantId !== input.task.tenantId) {
      throw new AuthorityConflict('Task presentation tenant scope is invalid');
    }
    return [...this.taskPresentations.values()]
      .filter(
        (record) =>
          record.tenantId === input.tenantId &&
          same(record.plan.task, input.task) &&
          (input.state === undefined || record.deliveryState === input.state),
      )
      .map(clone);
  }

  async readAttemptPresentation(input: {
    tenantId: string;
    attemptId: string;
    operationId: string;
  }): Promise<AttemptPresentationRecord | undefined> {
    const value = this.attemptPresentations.get(
      attemptPresentationKey(
        input.tenantId,
        input.attemptId,
        input.operationId,
      ),
    );
    return value === undefined ? undefined : clone(value);
  }

  async listAttemptPresentations(input: {
    tenantId: string;
    attemptId?: string;
    task?: TaskAuthorityScope;
  }): Promise<AttemptPresentationRecord[]> {
    if (input.task !== undefined && input.tenantId !== input.task.tenantId) {
      throw new AuthorityConflict(
        'Attempt presentation tenant scope is invalid',
      );
    }
    return [...this.attemptPresentations.values()]
      .filter(
        (record) =>
          record.tenantId === input.tenantId &&
          (input.attemptId === undefined ||
            record.plan.attemptId === input.attemptId) &&
          (input.task === undefined || same(record.plan.task, input.task)),
      )
      .map(clone);
  }

  private preflightNewAttemptPresentation(
    presentation: DerivedAttemptPresentation,
  ): void {
    const existingPlans = [...this.attemptPresentations.values()].filter(
      (record) =>
        record.tenantId === presentation.record.tenantId &&
        record.plan.attemptId === presentation.record.plan.attemptId,
    );
    if (
      existingPlans.length !== 0 ||
      this.attemptPresentations.has(presentation.key) ||
      this.attemptPresentationReceipts.has(presentation.receiptKey)
    ) {
      throw new AuthorityConflict('Attempt presentation operation exists');
    }
  }

  private persistAttemptPresentation(
    presentation: DerivedAttemptPresentation,
  ): void {
    this.attemptPresentations.set(presentation.key, clone(presentation.record));
    this.attemptPresentationReceipts.set(presentation.receiptKey, {
      planKey: presentation.key,
      planDigest: presentation.planDigest,
      outcomeDigest: presentation.outcomeDigest,
      snapshot: clone(presentation.record),
    });
  }

  private assertAttemptPresentationReplay(
    expected: DerivedAttemptPresentation,
  ): void {
    const receipt = this.attemptPresentationReceipts.get(expected.receiptKey);
    const live = this.attemptPresentations.get(expected.key);
    const plans = [...this.attemptPresentations.entries()].filter(
      (record) =>
        record[1].tenantId === expected.record.tenantId &&
        record[1].plan.attemptId === expected.record.plan.attemptId,
    );
    if (
      receipt === undefined ||
      live === undefined ||
      plans.length !== 1 ||
      plans[0]?.[0] !== expected.key ||
      receipt.planKey !== expected.key ||
      receipt.planDigest !== expected.planDigest ||
      receipt.outcomeDigest !== expected.outcomeDigest ||
      !same(receipt.snapshot, expected.record) ||
      createHash('sha256').update(canonicalJson(live.plan)).digest('hex') !==
        expected.planDigest ||
      !same(live, expected.record)
    ) {
      throw new AuthorityConflict(
        'Final outcome presentation receipt conflicts',
      );
    }
  }

  private assertCancellationReceiptIntegrity(
    identity: Pick<
      VerifiedCancellationEffect,
      'tenantId' | 'task' | 'sourceFactId' | 'effectKey'
    >,
    effect: TaskEffectRecord,
    receipt: CancellationEffectResult,
  ): void {
    if (!same(receipt.effect, effect)) {
      throw new AuthorityConflict('Cancellation effect receipt conflicts');
    }
    if (effect.payload.kind !== 'cancel-or-drain') {
      if (
        receipt.attempt !== undefined ||
        receipt.work !== undefined ||
        receipt.presentation !== undefined
      ) {
        throw new AuthorityConflict(
          'No-Attempt cancellation receipt contains Attempt state',
        );
      }
      return;
    }

    const liveAttempt = this.attempts.get(effect.payload.attemptId);
    const liveLaunch = this.launches.get(effect.payload.attemptId);
    if (
      liveAttempt === undefined ||
      liveLaunch === undefined ||
      receipt.attempt === undefined ||
      liveAttempt.spec.tenant.tenantId !== identity.tenantId ||
      !same(liveAttempt.spec.task, identity.task) ||
      liveAttempt.spec.local.intentId !== effect.payload.intentId ||
      liveAttempt.spec.local.generation !== effect.payload.intentRevision ||
      !same(receipt.attempt.spec, liveAttempt.spec) ||
      liveLaunch.tenantId !== identity.tenantId ||
      liveLaunch.attemptId !== effect.payload.attemptId ||
      liveLaunch.executionEpoch !== liveAttempt.executionEpoch ||
      liveLaunch.operationId !== liveAttempt.launch.operationId
    ) {
      throw new AuthorityConflict(
        'Cancellation receipt does not match the live Attempt and launch',
      );
    }

    const eventId = cancellationEventId(identity, effect.payload);
    const receiptIsDirectTerminal =
      receipt.attempt.phase === 'terminal' &&
      receipt.attempt.outcome?.execution === 'not_started' &&
      receipt.attempt.outcome.evidence.kind === 'lifecycle-decision' &&
      receipt.attempt.outcome.evidence.decisionFactId === eventId;
    const liveIsDirectTerminal =
      liveAttempt.phase === 'terminal' &&
      liveAttempt.outcome?.execution === 'not_started' &&
      liveAttempt.outcome.evidence.kind === 'lifecycle-decision' &&
      liveAttempt.outcome.evidence.decisionFactId === eventId;
    if (receipt.presentation === undefined) {
      if (receiptIsDirectTerminal) {
        throw new AuthorityConflict(
          'Direct cancellation terminal receipt is missing its presentation',
        );
      }
      if (receipt.attempt.phase === 'terminal') {
        if (!same(receipt.attempt, liveAttempt)) {
          throw new AuthorityConflict(
            'Terminal cancellation no-op receipt conflicts with the live Attempt',
          );
        }
        return;
      }
      const receiptCommand = receipt.attempt.commands.find(
        (command) => command.eventId === eventId,
      );
      const liveCommand = liveAttempt.commands.find(
        (command) => command.eventId === eventId,
      );
      if (
        receipt.attempt.cancellation?.eventId !== eventId ||
        liveAttempt.cancellation?.eventId !== eventId ||
        !receipt.attempt.futureGrantsDenied ||
        !liveAttempt.futureGrantsDenied ||
        receiptCommand === undefined ||
        liveCommand === undefined ||
        !same(receiptCommand, liveCommand)
      ) {
        throw new AuthorityConflict(
          'Cancellation transition receipt conflicts with the live Attempt',
        );
      }
      return;
    }
    if (
      !receiptIsDirectTerminal ||
      !liveIsDirectTerminal ||
      !same(receipt.attempt, liveAttempt) ||
      liveLaunch.state !== 'suppressed'
    ) {
      throw new AuthorityConflict(
        'Cancellation terminal receipt is not atomically converged',
      );
    }
    const expected = deriveAttemptPresentation(liveAttempt, {
      kind: 'lifecycle-decision',
      commandId: eventId,
      decision: 'cancel-unlaunched',
    });
    this.assertAttemptPresentationReplay(expected);
    if (!same(receipt.presentation, expected.record)) {
      throw new AuthorityConflict(
        'Cancellation presentation snapshot conflicts',
      );
    }
  }

  async readTaskEffect(input: {
    tenantId: string;
    task: TaskAuthorityScope;
    sourceFactId: string;
    effectKey: string;
  }): Promise<TaskEffectRecord | undefined> {
    if (input.tenantId !== input.task.tenantId) {
      throw new AuthorityConflict('Task effect tenant scope is invalid');
    }
    const value = this.taskEffects.get(taskEffectKey(input));
    return value === undefined ? undefined : clone(value);
  }

  async claimTaskEffect(input: {
    lease: TaskAuthorityLease;
    tenantId: string;
    task: TaskAuthorityScope;
    sourceFactId: string;
    effectKey: string;
  }): Promise<TaskEffectClaim> {
    this.assertLease(input.lease, input.task, this.now());
    const key = taskEffectKey(input);
    const current = this.taskEffects.get(key);
    if (current === undefined || current.tenantId !== input.tenantId) {
      throw new AuthorityConflict('Task effect is unknown');
    }
    if (
      current.deliveryState === 'complete' ||
      current.deliveryState === 'obsolete'
    ) {
      return { status: 'terminal', effect: clone(current) };
    }
    if (
      current.deliveryState === 'working' &&
      current.claimedFence === input.lease.fence
    ) {
      return { status: 'replay', effect: clone(current) };
    }
    if (
      current.deliveryState === 'working' &&
      current.claimedFence !== input.lease.fence &&
      (current.claimedFence ?? -1) > input.lease.fence
    ) {
      throw new AuthorityConflict('Task effect is claimed by a later fence');
    }
    const next: TaskEffectRecord = {
      ...current,
      deliveryState: 'working',
      claimedFence: input.lease.fence,
      claimToken: randomUUID(),
    };
    this.taskEffects.set(key, clone(next));
    return { status: 'claimed', effect: clone(next) };
  }

  async completeTaskEffect(input: {
    lease: TaskAuthorityLease;
    completion: VerifiedAdmissionEffectCompletion;
  }): Promise<TaskEffectRecord> {
    if (!isVerifiedAdmissionEffectCompletion(input.completion)) {
      throw new AuthorityConflict(
        'Task effect completion is not a trusted admission receipt',
      );
    }
    const completion = input.completion;
    this.assertLease(input.lease, completion.task, this.now());
    const key = taskEffectKey(completion);
    const current = this.taskEffects.get(key);
    if (current === undefined || current.tenantId !== completion.tenantId) {
      throw new AuthorityConflict('Task effect is unknown');
    }
    if (
      current.deliveryState === 'complete' &&
      current.claimedFence === input.lease.fence &&
      current.claimToken === completion.claimToken &&
      current.completion?.kind === 'admission-receipt' &&
      current.completion.attemptId === completion.attemptId
    ) {
      return clone(current);
    }
    if (
      current.payload.kind !== 'admit-attempt' ||
      current.deliveryState !== 'working' ||
      current.claimedFence !== input.lease.fence ||
      current.claimToken !== completion.claimToken
    ) {
      throw new AuthorityConflict(
        'Task effect completion requires its current claim fence',
      );
    }
    const acceptance = this.acceptances.get(
      tupleKey(
        completion.task.tenantId,
        completion.task.repositoryId,
        completion.task.issueNumber,
        current.payload.intentId,
        current.payload.intentRevision,
      ),
    );
    const attempt = this.attempts.get(completion.attemptId);
    const launch = this.launches.get(completion.attemptId);
    if (
      acceptance?.attemptId !== completion.attemptId ||
      attempt === undefined ||
      launch === undefined ||
      !same(attempt.spec.task, completion.task) ||
      attempt.spec.local.intentId !== current.payload.intentId ||
      attempt.spec.local.generation !== current.payload.intentRevision
    ) {
      throw new AuthorityConflict(
        'Admission receipt does not complete this effect',
      );
    }
    const next: TaskEffectRecord = {
      ...current,
      deliveryState: 'complete',
      completion: {
        kind: 'admission-receipt',
        attemptId: completion.attemptId,
      },
    };
    this.taskEffects.set(key, clone(next));
    return clone(next);
  }

  async obsoleteTaskEffect(input: {
    lease: TaskAuthorityLease;
    obsoletion: VerifiedTaskEffectObsoletion;
  }): Promise<TaskEffectRecord> {
    if (!isVerifiedTaskEffectObsoletion(input.obsoletion)) {
      throw new AuthorityConflict('Task effect obsoletion is not trusted');
    }
    const obsoletion = input.obsoletion;
    this.assertLease(input.lease, obsoletion.task, this.now());
    const key = taskEffectKey(obsoletion);
    const current = this.taskEffects.get(key);
    if (current === undefined || current.tenantId !== obsoletion.tenantId) {
      throw new AuthorityConflict('Task effect is unknown');
    }
    if (
      current.deliveryState === 'obsolete' &&
      current.claimedFence === input.lease.fence &&
      current.claimToken === obsoletion.claimToken &&
      current.obsoleteReason === obsoletion.reason
    ) {
      return clone(current);
    }
    if (
      current.deliveryState !== 'working' ||
      current.claimedFence !== input.lease.fence ||
      current.claimToken !== obsoletion.claimToken
    ) {
      throw new AuthorityConflict(
        'Task effect obsoletion requires its current claim fence',
      );
    }
    const task = this.tasks.get(canonicalTaskKey(obsoletion.task));
    if (
      current.payload.kind !== 'admit-attempt' ||
      task === undefined ||
      (obsoletion.reason === 'superseded' &&
        ((task.attempt.kind === 'unlaunched' &&
          task.attempt.intentId === current.payload.intentId &&
          task.desired?.intentId === current.payload.intentId &&
          task.desired.intentRevision === current.payload.intentRevision) ||
          (task.attempt.kind === 'launched' &&
            task.attempt.intentId === current.payload.intentId &&
            task.attempt.intentRevision === current.payload.intentRevision))) ||
      (obsoletion.reason === 'activation-no-longer-authoritative' &&
        this.mayWriteEffectsSync({
          scope: {
            ...obsoletion.task,
            taskClassId: current.activation.taskClassId,
          },
          activation: current.activation,
          boundary: task.revision,
        }))
    ) {
      throw new AuthorityConflict(
        'Task effect is not eligible for this obsoletion',
      );
    }
    const next: TaskEffectRecord = {
      ...current,
      deliveryState: 'obsolete',
      obsoleteReason: obsoletion.reason,
    };
    this.taskEffects.set(key, clone(next));
    return clone(next);
  }

  async applyVerifiedCancellationEffect(input: {
    lease: TaskAuthorityLease;
    cancellation: VerifiedCancellationEffect;
  }): Promise<CancellationEffectResult> {
    if (!isVerifiedCancellationEffect(input.cancellation)) {
      throw new AuthorityConflict(
        'Cancellation effect was not minted by its coordinator',
      );
    }
    const command = input.cancellation;
    this.assertLease(input.lease, command.task, this.now());
    const effect = this.taskEffects.get(taskEffectKey(command));
    const receipt = this.cancellationReceipts.get(taskEffectKey(command));
    if (
      receipt !== undefined &&
      effect?.deliveryState === 'complete' &&
      effect.canonicalDigest === command.canonicalDigest &&
      effect.claimToken === command.claimToken
    ) {
      this.assertCancellationReceiptIntegrity(command, effect, receipt);
      return clone(receipt);
    }
    if (
      effect === undefined ||
      effect.tenantId !== command.tenantId ||
      effect.canonicalDigest !== command.canonicalDigest ||
      effect.deliveryState !== 'working' ||
      effect.claimedFence !== input.lease.fence ||
      command.claimFence !== input.lease.fence ||
      effect.claimToken !== command.claimToken ||
      effect.payload.kind !== command.kind
    ) {
      throw new AuthorityConflict('Cancellation effect claim is invalid');
    }
    if (effect.payload.kind === 'cancel-unlaunched') {
      const accepted = this.acceptances.has(
        tupleKey(
          command.tenantId,
          command.task.repositoryId,
          command.task.issueNumber,
          effect.payload.intentId,
          effect.payload.intentRevision,
        ),
      );
      if (accepted)
        throw new AuthorityConflict(
          'Admission won the no-Attempt cancellation race',
        );
      const next = { ...effect, deliveryState: 'complete' as const };
      this.taskEffects.set(taskEffectKey(command), clone(next));
      const result = { effect: clone(next) };
      this.cancellationReceipts.set(taskEffectKey(command), clone(result));
      return result;
    }
    const target = effect.payload;
    const attempt = this.attempts.get(target.attemptId);
    const launch =
      attempt === undefined ? undefined : this.launches.get(target.attemptId);
    if (
      attempt === undefined ||
      launch === undefined ||
      attempt.spec.tenant.tenantId !== command.tenantId ||
      !same(attempt.spec.task, command.task) ||
      attempt.spec.local.intentId !== target.intentId ||
      attempt.spec.local.generation !== target.intentRevision
    )
      throw new AuthorityConflict(
        'Cancellation target is not the pinned Attempt',
      );
    const eventId = cancellationEventId(command, target);
    if (attempt.phase === 'terminal') {
      const next = { ...effect, deliveryState: 'complete' as const };
      this.taskEffects.set(taskEffectKey(command), clone(next));
      const result = { effect: clone(next), attempt: clone(attempt) };
      this.cancellationReceipts.set(taskEffectKey(command), clone(result));
      return result;
    }
    let event: AttemptEvent;
    let suppressed = false;
    if (
      launch.state === 'pending' &&
      launch.claimedFence === undefined &&
      attempt.binding === undefined &&
      attempt.pendingTerminal === undefined &&
      attempt.finalization === undefined
    ) {
      event = {
        kind: 'cancel-unlaunched',
        eventId,
        supersededByIntentId: target.supersededByIntentId,
        outcome: {
          schema: 'agent-lcars.attempt-outcome/v1',
          version: 1,
          attemptId: target.attemptId,
          terminalState:
            target.supersededByIntentId === undefined
              ? 'cancelled'
              : 'superseded',
          execution: 'not_started',
          result: 'none',
          evidence: { kind: 'lifecycle-decision', decisionFactId: eventId },
          evidenceValidation: { status: 'not-applicable' },
          finalizedAt: command.at,
        },
      };
      suppressed = true;
    } else {
      event = {
        kind: 'request-cancel',
        eventId,
        ...(target.supersededByIntentId === undefined
          ? {}
          : { supersededByIntentId: target.supersededByIntentId }),
      };
    }
    const reduced = reduceAttempt(attempt, {
      kind: 'transition',
      expectedRevision: attempt.revision,
      transitionedAt: command.at,
      canonicalDigest: attemptTransitionDigest(event),
      event,
    });
    if (reduced.status !== 'applied')
      throw new AuthorityConflict(
        'Cancellation reducer rejected the pinned Attempt',
      );
    const presentation = suppressed
      ? deriveAttemptPresentation(reduced.state, {
          kind: 'lifecycle-decision',
          commandId: eventId,
          decision: 'cancel-unlaunched',
        })
      : undefined;
    if (presentation !== undefined)
      this.preflightNewAttemptPresentation(presentation);
    const work: CancellationWorkRecord | undefined =
      suppressed || reduced.state.finalization !== undefined
        ? undefined
        : {
            tenantId: command.tenantId,
            attemptId: target.attemptId,
            eventId,
            executionEpoch: attempt.executionEpoch,
            state:
              reduced.state.binding === undefined
                ? 'awaiting-binding'
                : 'pending',
            ...(target.supersededByIntentId === undefined
              ? {}
              : { supersededByIntentId: target.supersededByIntentId }),
          };
    this.writeAttemptTransaction({
      lease: input.lease,
      expectedRevision: attempt.revision,
      next: reduced.state,
    });
    if (presentation !== undefined)
      this.persistAttemptPresentation(presentation);
    if (suppressed)
      this.launches.set(target.attemptId, { ...launch, state: 'suppressed' });
    if (work !== undefined)
      this.cancellationWork.set(
        tupleKey(command.tenantId, target.attemptId, eventId),
        clone(work),
      );
    const completed = { ...effect, deliveryState: 'complete' as const };
    this.taskEffects.set(taskEffectKey(command), clone(completed));
    const result = {
      effect: clone(completed),
      attempt: clone(reduced.state),
      ...(work === undefined ? {} : { work: clone(work) }),
      ...(presentation === undefined
        ? {}
        : { presentation: clone(presentation.record) }),
    };
    this.cancellationReceipts.set(taskEffectKey(command), clone(result));
    return result;
  }

  async readCancellationReceipt(input: {
    lease: TaskAuthorityLease;
    tenantId: string;
    task: TaskAuthorityScope;
    sourceFactId: string;
    effectKey: string;
  }): Promise<CancellationEffectResult | undefined> {
    if (input.tenantId !== input.task.tenantId) {
      throw new AuthorityConflict(
        'Cancellation receipt tenant scope is invalid',
      );
    }
    this.assertLease(input.lease, input.task, this.now());
    const key = taskEffectKey(input);
    const effect = this.taskEffects.get(key);
    if (effect === undefined || effect.tenantId !== input.tenantId) {
      throw new AuthorityConflict('Cancellation effect is unknown');
    }
    if (effect.deliveryState !== 'complete') return undefined;
    const receipt = this.cancellationReceipts.get(key);
    if (receipt !== undefined)
      this.assertCancellationReceiptIntegrity(input, effect, receipt);
    return receipt === undefined ? undefined : clone(receipt);
  }

  async listCancellationWork(input: {
    tenantId: string;
    state?: CancellationWorkRecord['state'];
  }): Promise<CancellationWorkRecord[]> {
    return [...this.cancellationWork.values()]
      .filter(
        (work) =>
          work.tenantId === input.tenantId &&
          (input.state === undefined || work.state === input.state),
      )
      .map(clone);
  }

  async admitVerifiedAttemptAndRecordLaunch(input: {
    lease: TaskAuthorityLease;
    admission: VerifiedAttemptAdmission;
  }): Promise<AdmissionResult> {
    if (!isVerifiedAttemptAdmission(input.admission)) {
      throw new AuthorityConflict(
        'Admission capability was not minted by a coordinator',
      );
    }
    const admission = input.admission;
    const now = this.now();
    this.assertLease(input.lease, admission.task, now);
    const commandDigest = admissionCommandDigest(admission);
    const localKey = admissionAcceptanceKey(admission);
    const accepted = this.acceptances.get(localKey);
    const current = this.tasks.get(canonicalTaskKey(admission.task));
    if (accepted !== undefined) {
      const attempt = this.attempts.get(accepted.attemptId);
      const launch = this.launches.get(accepted.attemptId);
      if (
        accepted.admissionDigest !== commandDigest ||
        attempt === undefined ||
        launch === undefined ||
        !same(attempt.spec.tenant, admission.tenant) ||
        !same(attempt.spec.task, admission.task) ||
        !same(attempt.spec.activation, admission.activation) ||
        !same(attempt.spec.execution, admission.execution) ||
        attempt.spec.local.intentId !== admission.intentId ||
        attempt.spec.local.generation !== admission.intentRevision
      ) {
        throw new AuthorityConflict(
          'Local acceptance tuple was reused differently',
        );
      }
      return {
        replay: true,
        task: clone(accepted.task),
        attempt: clone(attempt),
        launch: clone(launch),
      };
    }
    if (
      current === undefined ||
      current.revision !== admission.expectedTaskRevision ||
      !same(current.tenant, admission.tenant) ||
      !same(current.activation, admission.activation) ||
      current.desired?.intentId !== admission.intentId ||
      current.desired.intentRevision !== admission.intentRevision
    ) {
      throw new AuthorityConflict('Task admission CAS or authority failed');
    }
    const intent = current.intents.find(
      (candidate) =>
        candidate.intentId === admission.intentId &&
        candidate.revision === admission.intentRevision,
    );
    const source = current.facts.find(
      (fact) => fact.factId === intent?.sourceFactId,
    );
    if (
      intent === undefined ||
      intent.status !== 'desired' ||
      intent.policyDecision.decision !== 'accepted' ||
      !same(intent.activation, admission.activation) ||
      source === undefined
    ) {
      throw new AuthorityConflict('Attempt admission provenance is invalid');
    }
    const scope: EffectAuthorityScope = {
      ...admission.task,
      taskClassId: admission.activation.taskClassId,
    };
    if (
      !this.mayWriteEffectsSync({
        scope,
        activation: admission.activation,
        boundary: admission.expectedTaskRevision,
      })
    ) {
      throw new AuthorityConflict('Shadow, retired, or stale activation');
    }
    const attemptId = this.attemptIds.mint();
    if (!ATTEMPT_ID.test(attemptId) || this.attempts.has(attemptId)) {
      throw new AuthorityConflict(
        'Attempt id factory did not mint a unique global id',
      );
    }
    const spec: AcceptedAttemptSpec = {
      schema: 'agent-lcars.attempt-spec/v1',
      version: 1,
      requestId: source.requestId,
      attemptId,
      tenant: clone(admission.tenant),
      task: clone(admission.task),
      activation: {
        ...clone(admission.activation),
        mode: 'central-authoritative',
      },
      local: {
        intentId: admission.intentId,
        generation: admission.intentRevision,
        attemptMarker: formatAttemptId({
          generation: admission.intentRevision,
          intentId: admission.intentId,
        }),
        admissionRevision: admission.expectedTaskRevision,
        idempotencyKey: commandDigest,
      },
      execution: clone(admission.execution),
      authorization: clone(intent.policyDecision),
    };
    const parsedSpec = acceptedAttemptSpecSchema.safeParse(spec);
    if (!parsedSpec.success) {
      throw new AuthorityConflict(
        'Resolved admission execution plan is invalid',
      );
    }
    const acceptedSpec = parsedSpec.data;
    const specDigest = attemptSpecDigest(acceptedSpec);
    const task = admitTaskAttempt(current, {
      expectedRevision: admission.expectedTaskRevision,
      intentId: admission.intentId,
      intentRevision: admission.intentRevision,
      attemptId,
      activation: admission.activation,
      admittedAt: now,
    });
    const attempt = reduceAttempt(undefined, {
      kind: 'register',
      expectedRevision: 0,
      transitionedAt: now,
      spec: acceptedSpec,
      specDigest,
    });
    if (task.status !== 'applied' || attempt.status !== 'applied') {
      throw new AuthorityConflict(
        'Admission transition was not reducer-derived',
      );
    }
    const launch: LaunchOutboxRecord = {
      operationId: attemptId,
      attemptId,
      tenantId: spec.tenant.tenantId,
      repositoryId: spec.tenant.repositoryId,
      issueNumber: spec.task.issueNumber,
      executionEpoch: 1,
      state: 'pending',
    };
    // All validation completed above; this contiguous body is the transaction.
    this.tasks.set(canonicalTaskKey(admission.task), clone(task.state));
    this.attempts.set(attemptId, clone(attempt.state));
    this.acceptances.set(localKey, {
      attemptId,
      specDigest,
      admissionDigest: commandDigest,
      task: clone(task.state),
    });
    this.launches.set(attemptId, clone(launch));
    return {
      replay: false,
      task: clone(task.state),
      attempt: clone(attempt.state),
      launch: clone(launch),
    };
  }

  async readAttemptAdmission(input: {
    lease: TaskAuthorityLease;
    tenantId: string;
    task: TaskAuthorityScope;
    intentId: string;
    intentRevision: number;
  }): Promise<AdmissionResult | undefined> {
    this.assertLease(input.lease, input.task, this.now());
    const key = tupleKey(
      input.task.tenantId,
      input.task.repositoryId,
      input.task.issueNumber,
      input.intentId,
      input.intentRevision,
    );
    const accepted = this.acceptances.get(key);
    if (accepted === undefined) return undefined;
    const attempt = this.attempts.get(accepted.attemptId);
    const launch = this.launches.get(accepted.attemptId);
    if (
      attempt === undefined ||
      launch === undefined ||
      attempt.spec.tenant.tenantId !== input.tenantId ||
      !same(attempt.spec.task, input.task) ||
      attempt.spec.local.intentId !== input.intentId ||
      attempt.spec.local.generation !== input.intentRevision
    ) {
      throw new AuthorityConflict('Admission replay receipt is inconsistent');
    }
    return {
      replay: true,
      task: clone(accepted.task),
      attempt: clone(attempt),
      launch: clone(launch),
    };
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

  async applyFinalizationTransition(input: {
    lease: TaskAuthorityLease;
    transition: VerifiedFinalizationTransition;
  }): Promise<WriteResult> {
    if (!isVerifiedFinalizationTransition(input.transition)) {
      throw new AuthorityConflict(
        'Finalization transition capability was not minted by the coordinator',
      );
    }
    const transition = input.transition;
    const current = this.attempts.get(transition.attemptId);
    if (
      current === undefined ||
      transition.tenantId !== current.spec.tenant.tenantId
    ) {
      throw new AuthorityConflict('Attempt is unknown');
    }
    this.assertLease(input.lease, current.spec.task, this.now());

    let event: AttemptEvent;
    if (transition.kind === 'observation') {
      const { observation } = transition;
      const envelope = observation.envelope;
      if (
        envelope.attemptId !== transition.attemptId ||
        envelope.tenant.tenantId !== transition.tenantId ||
        !same(envelope.tenant, current.spec.tenant) ||
        !same(envelope.task, current.spec.task)
      ) {
        throw new AuthorityConflict(
          'Finalization observation scope is invalid',
        );
      }
      event = {
        kind: 'observation',
        envelope,
        ...('finalizationDeadline' in observation
          ? { finalizationDeadline: observation.finalizationDeadline }
          : {}),
      };
    } else if (transition.kind === 'start-validation') {
      const terminalFactId = current.finalization?.terminalFactId;
      if (terminalFactId === undefined) {
        throw new AuthorityConflict('Finalization window is absent');
      }
      event = {
        kind: 'start-validation',
        eventId: finalizationCommandId(
          'start-validation',
          transition.attemptId,
          terminalFactId,
        ),
        at: transition.at,
      };
      if (attemptHasCommand(current, event.eventId)) {
        this.assertCommandReplay(current, event);
        this.assertValidationWorkForState(current);
        return 'replay';
      }
    } else if (transition.kind === 'validate-claim') {
      const finalization = current.finalization;
      const evidence = finalization?.evidence.find(
        (candidate) => candidate.factId === transition.claimFactId,
      );
      if (finalization === undefined || evidence === undefined) {
        throw new AuthorityConflict('Validation claim is unknown');
      }
      const expectedValidationFactId = finalizationCommandId(
        'validate-claim',
        transition.attemptId,
        finalization.terminalFactId,
        transition.claimFactId,
      );
      if (transition.validationFactId !== expectedValidationFactId) {
        throw new AuthorityConflict('Validation fact identity is invalid');
      }
      const validation = validationForVerdict({
        verdict: transition.verdict,
        validationFactId: transition.validationFactId,
        validatedAt: transition.at,
      });
      event = {
        kind: 'validate-claim',
        eventId: transition.validationFactId,
        claimFactId: transition.claimFactId,
        validation,
      };
      if (evidence.validation !== undefined) {
        if (!same(evidence.validation, validation)) {
          throw new AuthorityConflict('Validation verdict conflicts');
        }
        this.assertCommandReplay(current, event);
        this.assertCompletedValidationWork(
          current,
          transition.claimFactId,
          transition.validationFactId,
        );
        return 'replay';
      }
      const work = this.validationWork.get(
        validationWorkKey(
          transition.tenantId,
          transition.attemptId,
          finalization.terminalFactId,
          transition.claimFactId,
        ),
      );
      if (
        work?.state !== 'resolving' ||
        work.claimedFence !== input.lease.fence
      ) {
        throw new AuthorityConflict(
          'Validation work must be claimed by the current fence',
        );
      }
    } else {
      const terminalFactId = current.finalization?.terminalFactId;
      const expectedEventId =
        terminalFactId === undefined
          ? undefined
          : finalizationCommandId(
              'finalize',
              transition.attemptId,
              terminalFactId,
            );
      if (
        expectedEventId === undefined ||
        transition.eventId !== expectedEventId
      ) {
        throw new AuthorityConflict('Finalization event identity is invalid');
      }
      let outcome;
      try {
        outcome = deriveFinalizedOutcome(
          current,
          transition.eventId,
          transition.at,
        );
      } catch {
        throw new AuthorityConflict('Final outcome cannot be derived');
      }
      event = { kind: 'finalize', eventId: transition.eventId, outcome };
      if (
        current.outcome !== undefined &&
        attemptHasCommand(current, expectedEventId)
      ) {
        if (!same(current.outcome, outcome)) {
          throw new AuthorityConflict('Final outcome replay conflicts');
        }
        this.assertCommandReplay(current, event);
        const expected = deriveAttemptPresentation(
          current,
          finalizationPresentationProvenance(current, event.eventId),
        );
        this.assertAttemptPresentationReplay(expected);
        return 'replay';
      }
    }

    const reduced = reduceAttempt(current, {
      kind: 'transition',
      expectedRevision: current.revision,
      transitionedAt: transition.at,
      canonicalDigest: attemptTransitionDigest(event),
      event,
    });
    if (reduced.status === 'conflict') {
      throw new AuthorityConflict(
        'Finalizer transition was not reducer-derived',
      );
    }
    const observation =
      event.kind === 'observation' ? event.envelope : undefined;
    const observationIdentity =
      observation === undefined
        ? undefined
        : this.finalizationObservationIdentity(observation, event);
    if (observationIdentity !== undefined) {
      this.preflightObservation(observationIdentity, current);
    }
    if (reduced.status === 'replay') {
      if (observationIdentity !== undefined)
        this.assertObservationReplay(observationIdentity);
      return 'replay';
    }
    const work = reduced.effects.filter(
      (effect) => effect.kind === 'validate-evidence',
    );
    for (const effect of work) {
      const key = validationWorkKey(
        current.spec.tenant.tenantId,
        effect.attemptId,
        effect.terminalFactId,
        effect.claimFactId,
      );
      const existing = this.validationWork.get(key);
      const record: ValidationWorkRecord = {
        tenantId: current.spec.tenant.tenantId,
        attemptId: effect.attemptId,
        terminalFactId: effect.terminalFactId,
        claimFactId: effect.claimFactId,
        claim: clone(effect.claim),
        state: 'pending' as const,
      };
      if (existing !== undefined && !same(existing, record))
        throw new AuthorityConflict('Validation work conflicts');
    }
    const presentation =
      event.kind === 'finalize'
        ? deriveAttemptPresentation(
            reduced.state,
            finalizationPresentationProvenance(reduced.state, event.eventId),
          )
        : undefined;
    if (presentation !== undefined)
      this.preflightNewAttemptPresentation(presentation);
    this.writeAttemptTransaction({
      lease: input.lease,
      expectedRevision: current.revision,
      next: reduced.state,
    });
    if (presentation !== undefined)
      this.persistAttemptPresentation(presentation);
    if (observationIdentity !== undefined)
      this.persistObservation(observationIdentity);
    for (const effect of work) {
      const key = validationWorkKey(
        current.spec.tenant.tenantId,
        effect.attemptId,
        effect.terminalFactId,
        effect.claimFactId,
      );
      this.validationWork.set(key, {
        tenantId: current.spec.tenant.tenantId,
        attemptId: effect.attemptId,
        terminalFactId: effect.terminalFactId,
        claimFactId: effect.claimFactId,
        claim: clone(effect.claim),
        state: 'pending',
      });
    }
    if (transition.kind === 'validate-claim') {
      const terminalFactId = current.finalization?.terminalFactId;
      if (terminalFactId === undefined) {
        throw new AuthorityConflict('Validation terminal fact is absent');
      }
      const key = validationWorkKey(
        transition.tenantId,
        transition.attemptId,
        terminalFactId,
        transition.claimFactId,
      );
      const prior = this.validationWork.get(key);
      if (prior === undefined) {
        throw new AuthorityConflict('Validation work is absent');
      }
      this.validationWork.set(key, {
        ...prior,
        state: 'complete',
        validationFactId: transition.validationFactId,
      });
    }
    return 'applied';
  }

  private finalizationObservationIdentity(
    envelope: import('@agent-lcars/dispatch-contracts').RuntimeObservationEnvelope,
    event: AttemptEvent,
  ): ObservationIdentity {
    if (
      !runtimeObservationEnvelopeSchema.safeParse(envelope).success ||
      !SHA256.test(envelope.payloadSha256) ||
      !SHA256.test(attemptTransitionDigest(event))
    ) {
      throw new AuthorityConflict('Finalization observation is invalid');
    }
    return {
      tenantId: envelope.tenant.tenantId,
      repositoryId: envelope.tenant.repositoryId,
      attemptId: envelope.attemptId,
      sourceIdentity: `${envelope.source.kind}:${envelope.source.sourceId}`,
      factId: envelope.factId,
      requestId: envelope.requestId,
      canonicalDigest: attemptTransitionDigest(event),
      payloadSha256: envelope.payloadSha256,
    };
  }

  private observationRecords(identity: ObservationIdentity): {
    factKey: string;
    requestKey: string;
    fact: StoredIdempotency;
    request: StoredIdempotency;
  } {
    const { factKey, requestKey } = observationKeys(identity);
    return {
      factKey,
      requestKey,
      fact: {
        counterpartId: identity.requestId,
        canonicalDigest: identity.canonicalDigest,
        payloadSha256: identity.payloadSha256,
        resourceId: identity.attemptId,
      },
      request: {
        counterpartId: identity.factId,
        canonicalDigest: identity.canonicalDigest,
        payloadSha256: identity.payloadSha256,
        resourceId: identity.attemptId,
      },
    };
  }

  private preflightObservation(
    identity: ObservationIdentity,
    attempt: AttemptState,
  ): void {
    if (
      attempt.spec.tenant.tenantId !== identity.tenantId ||
      attempt.spec.tenant.repositoryId !== identity.repositoryId
    ) {
      throw new AuthorityConflict('Finalization observation scope is invalid');
    }
    const { factKey, requestKey, fact, request } =
      this.observationRecords(identity);
    const priorFact = this.factKeys.get(factKey);
    const priorRequest = this.requestKeys.get(requestKey);
    if ((priorFact === undefined) !== (priorRequest === undefined)) {
      throw new AuthorityConflict(
        'Observation idempotency records are incomplete',
      );
    }
    if (
      priorFact !== undefined &&
      (!same(priorFact, fact) || !same(priorRequest, request))
    ) {
      throw new AuthorityConflict(
        'Fact/request identity was reused differently',
      );
    }
  }

  private assertObservationReplay(identity: ObservationIdentity): void {
    const { factKey, requestKey, fact, request } =
      this.observationRecords(identity);
    if (
      !same(this.factKeys.get(factKey), fact) ||
      !same(this.requestKeys.get(requestKey), request)
    ) {
      throw new AuthorityConflict(
        'Observation replay was not durably recorded',
      );
    }
  }

  private persistObservation(identity: ObservationIdentity): void {
    const { factKey, requestKey, fact, request } =
      this.observationRecords(identity);
    this.factKeys.set(factKey, fact);
    this.requestKeys.set(requestKey, request);
  }

  private assertValidationWorkForState(state: AttemptState): void {
    const finalization = state.finalization;
    if (finalization === undefined) {
      throw new AuthorityConflict('Finalization window is absent');
    }
    for (const evidence of finalization.evidence) {
      const work = this.validationWork.get(
        validationWorkKey(
          state.spec.tenant.tenantId,
          state.spec.attemptId,
          finalization.terminalFactId,
          evidence.factId,
        ),
      );
      if (work === undefined) {
        throw new AuthorityConflict('Validation work replay is incomplete');
      }
    }
  }

  private assertCommandReplay(state: AttemptState, event: AttemptEvent): void {
    if (event.kind === 'observation') {
      throw new AuthorityConflict('Observation replay uses fact identity');
    }
    const receipt = state.commands.find(
      (command) => command.eventId === event.eventId,
    );
    if (
      receipt === undefined ||
      receipt.canonicalDigest !== attemptTransitionDigest(event)
    ) {
      throw new AuthorityConflict('Finalization command replay conflicts');
    }
  }

  private assertCompletedValidationWork(
    state: AttemptState,
    claimFactId: string,
    validationFactId: string,
  ): void {
    const terminalFactId = state.finalization?.terminalFactId;
    const work =
      terminalFactId === undefined
        ? undefined
        : this.validationWork.get(
            validationWorkKey(
              state.spec.tenant.tenantId,
              state.spec.attemptId,
              terminalFactId,
              claimFactId,
            ),
          );
    if (
      work?.state !== 'complete' ||
      work.validationFactId !== validationFactId
    ) {
      throw new AuthorityConflict('Validation work replay is incomplete');
    }
  }

  async listValidationWork(input: {
    tenantId: string;
    state: ValidationWorkRecord['state'];
  }): Promise<ValidationWorkRecord[]> {
    return [...this.validationWork.values()]
      .filter(
        (work) =>
          work.tenantId === input.tenantId && work.state === input.state,
      )
      .map(clone);
  }

  async claimValidationWork(input: {
    lease: TaskAuthorityLease;
    tenantId: string;
    attemptId: string;
    terminalFactId: string;
    claimFactId: string;
  }): Promise<WriteResult> {
    const attempt = this.attempts.get(input.attemptId);
    if (
      attempt === undefined ||
      attempt.spec.tenant.tenantId !== input.tenantId
    ) {
      throw new AuthorityConflict('Validation attempt is unknown');
    }
    this.assertLease(input.lease, attempt.spec.task, this.now());
    const key = validationWorkKey(
      input.tenantId,
      input.attemptId,
      input.terminalFactId,
      input.claimFactId,
    );
    const work = this.validationWork.get(key);
    if (work === undefined) {
      throw new AuthorityConflict('Validation work is unknown');
    }
    if (work.state === 'complete') return 'replay';
    if (work.state === 'resolving') {
      if (work.claimedFence === input.lease.fence) return 'replay';
      if (
        work.claimedFence !== undefined &&
        work.claimedFence > input.lease.fence
      ) {
        throw new AuthorityConflict('Validation work has a newer claimant');
      }
    }
    this.validationWork.set(key, {
      ...work,
      state: 'resolving',
      claimedFence: input.lease.fence,
    });
    return 'applied';
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

  async claimLaunchWork(input: {
    lease: TaskAuthorityLease;
    tenantId: string;
    attemptId: string;
  }): Promise<LaunchWorkClaim> {
    const attempt = this.attempts.get(input.attemptId);
    const current = this.launches.get(input.attemptId);
    if (
      attempt === undefined ||
      current === undefined ||
      attempt.spec.tenant.tenantId !== input.tenantId
    ) {
      throw new AuthorityConflict('Launch operation is unknown');
    }
    this.assertLease(input.lease, attempt.spec.task, this.now());
    if (
      current.state === 'accepted' ||
      current.state === 'unknown' ||
      current.state === 'suppressed'
    ) {
      return { status: 'terminal' };
    }
    if (
      current.state === 'dispatching' &&
      current.claimedFence === input.lease.fence
    ) {
      return { status: 'replay' };
    }
    if (
      attempt.spec.activation.mode !== 'central-authoritative' ||
      current.tenantId !== attempt.spec.tenant.tenantId ||
      current.repositoryId !== attempt.spec.tenant.repositoryId ||
      current.issueNumber !== attempt.spec.task.issueNumber ||
      current.operationId !== attempt.launch.operationId ||
      current.executionEpoch !== attempt.executionEpoch ||
      attempt.phase !== 'launch-pending' ||
      attempt.launch.state !== 'recorded' ||
      attempt.binding !== undefined ||
      attempt.outcome !== undefined ||
      attempt.pendingTerminal !== undefined
    ) {
      throw new AuthorityConflict('Launch work contradicts the Attempt state');
    }
    const base = {
      tenantId: attempt.spec.tenant.tenantId,
      repositoryId: attempt.spec.tenant.repositoryId,
      task: attempt.spec.task,
      attemptId: attempt.spec.attemptId,
      operationId: current.operationId,
      executionEpoch: current.executionEpoch,
      localAttemptMarker: attempt.spec.local.attemptMarker,
      claimFence: input.lease.fence,
      claimToken: randomUUID(),
    } as const;
    if (current.state === 'pending') {
      const next = {
        ...current,
        state: 'dispatching' as const,
        claimedFence: input.lease.fence,
        claimToken: base.claimToken,
      };
      this.launches.set(input.attemptId, next);
      return {
        status: 'claimed',
        work: mintClaimedLaunchWork({ ...base, permission: 'dispatch' }),
      };
    }
    if (
      current.state !== 'dispatching' ||
      current.claimedFence === undefined ||
      current.claimedFence >= input.lease.fence
    ) {
      throw new AuthorityConflict('Launch operation is not claimable');
    }
    this.launches.set(input.attemptId, {
      ...current,
      claimedFence: input.lease.fence,
      claimToken: base.claimToken,
    });
    return {
      status: 'claimed',
      work: mintClaimedLaunchWork({ ...base, permission: 'reconcile-unknown' }),
    };
  }

  async resolveVerifiedLaunch(input: {
    lease: TaskAuthorityLease;
    resolution: VerifiedLaunchResolution;
  }): Promise<WriteResult> {
    if (!isVerifiedLaunchResolution(input.resolution)) {
      throw new AuthorityConflict(
        'Launch resolution was not verified at its boundary',
      );
    }
    const resolution = input.resolution;
    const work = resolution.work;
    if (!SHA256.test(resolution.responseSha256)) {
      throw new AuthorityConflict('Launch response digest is invalid');
    }
    const attempt = this.attempts.get(work.attemptId);
    const current = this.launches.get(work.attemptId);
    if (attempt === undefined || current === undefined) {
      throw new AuthorityConflict('Launch operation is unknown');
    }
    this.assertLease(input.lease, attempt.spec.task, this.now());
    if (
      attempt.spec.tenant.tenantId !== work.tenantId ||
      attempt.spec.tenant.repositoryId !== work.repositoryId ||
      !same(attempt.spec.task, work.task) ||
      attempt.spec.attemptId !== work.attemptId ||
      attempt.spec.local.attemptMarker !== work.localAttemptMarker ||
      current.operationId !== work.operationId ||
      current.executionEpoch !== work.executionEpoch
    ) {
      throw new AuthorityConflict('Launch resolution identity is invalid');
    }
    const event = {
      kind:
        resolution.kind === 'accepted'
          ? ('launch-accepted' as const)
          : ('launch-response-unknown' as const),
      eventId: launchResolutionEventId({
        attemptId: work.attemptId,
        operationId: work.operationId,
        executionEpoch: work.executionEpoch,
        kind: resolution.kind,
      }),
    };
    const receiptKey = tupleKey(work.attemptId, event.eventId);
    const priorResponseDigest = this.launchResolutionReceipts.get(receiptKey);
    if (
      current.state === resolution.kind &&
      attempt.launch.state ===
        (resolution.kind === 'accepted' ? 'accepted' : 'response-unknown') &&
      attempt.commands.some((command) => command.eventId === event.eventId) &&
      priorResponseDigest === resolution.responseSha256
    ) {
      return 'replay';
    }
    if (priorResponseDigest !== undefined) {
      throw new AuthorityConflict(
        'Launch response identity was reused differently',
      );
    }
    if (
      current.state !== 'dispatching' ||
      current.claimedFence !== input.lease.fence ||
      current.claimToken !== work.claimToken ||
      work.claimFence !== input.lease.fence ||
      (resolution.kind === 'accepted' && work.permission !== 'dispatch')
    ) {
      throw new AuthorityConflict('Launch outbox state conflict');
    }
    const reduced = reduceAttempt(attempt, {
      kind: 'transition',
      expectedRevision: attempt.revision,
      transitionedAt: resolution.resolvedAt,
      canonicalDigest: attemptTransitionDigest(event),
      event,
    });
    if (
      reduced.status !== 'applied' ||
      reduced.state.launch.state !==
        (resolution.kind === 'accepted' ? 'accepted' : 'response-unknown')
    ) {
      throw new AuthorityConflict(
        'Launch resolution contradicts Attempt reducer',
      );
    }
    this.writeAttemptTransaction({
      lease: input.lease,
      expectedRevision: attempt.revision,
      next: reduced.state,
    });
    this.launches.set(work.attemptId, {
      ...current,
      state: resolution.kind,
    });
    this.launchResolutionReceipts.set(receiptKey, resolution.responseSha256);
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
    for (const [key, work] of this.cancellationWork) {
      if (
        work.attemptId === envelope.attemptId &&
        work.state === 'awaiting-binding'
      ) {
        this.cancellationWork.set(key, { ...work, state: 'pending' });
      }
    }
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
}

/** Compatibility-free short alias for callers that do not name the backend. */
export type AuthorityStorage = LifecycleAuthorityStorage;
export { InMemoryLifecycleAuthorityStorage as InMemoryAuthorityStorage };
