import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type {
  AcceptedAttemptSpec,
  ActivationProvenance,
  ActivationRecord,
  AttemptHistoryHead,
  AttemptHistoryStream,
  AttemptPresentationPlan,
  CredentialGrantIssuance,
  HistoryHead,
  HistoryRecord,
  HistoryRecordReference,
  ReplayReceipt,
  RunBinding,
  TaskFactHistoryPayload,
  TaskHistoryHead,
  TaskIntentHistoryPayload,
  TaskPresentationPlan,
} from '@agent-lcars/dispatch-contracts';
import type { AgentResultClaimV1 } from '@agent-lcars/dispatch-contracts';
import {
  acceptedAttemptSpecSchema,
  appendAttemptHistoryTransition,
  appendHistoryRecord,
  appendTaskAttemptAdmissionHistoryTransition,
  attemptHistoryPayloadDigest,
  attemptHistoryRecordReference,
  attemptHistoryTransitionDigest,
  attemptPresentationPlanSchema,
  canonicalDurableJson,
  createGenesisHistoryHead,
  createGenesisTaskHistoryHead,
  createReplayReceipt,
  credentialGrantIssuanceSchema,
  formatAttemptId,
  hasValidRuntimeObservationPayloadDigest,
  historyRecordReference,
  inferTaskFactSituation,
  localAttemptMarkerSchema,
  registerAttemptHistory,
  runtimeObservationEnvelopeSchema,
  sha256Digest,
  taskHistoryHeadSchema,
  taskPresentationPlanSchema,
  upgradeLegacyTaskIntentState,
  validateDurableTransition,
  validateTaskHistoryTransition,
  verifyAttemptHistoryHead,
  verifyAttemptHistoryPayload,
  verifyHistoryAppend,
  verifyHistoryRecord,
  verifyHistoryRecordPayload,
  verifyReplayReceiptReferences,
} from '@agent-lcars/dispatch-contracts';

import {
  isVerifiedAttemptAdmission,
  type VerifiedAttemptAdmission,
} from './admission-capability';
import {
  type AttemptHistoryInspection,
  registerAttemptHistoryInspector,
} from './attempt-history-test-support';
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
  isVerifiedPresentationResolution,
  mintClaimedPresentationWork,
  type VerifiedClaimedPresentationWork,
  type VerifiedPresentationResolution,
} from './presentation-delivery-capability';
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
  registerTaskHistoryInspector,
  type TaskHistoryInspection,
} from './task-history-test-support';
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

export interface PresentationDeliveryRecord {
  source: 'task' | 'attempt';
  tenantId: string;
  task: TaskAuthorityScope;
  attemptId?: string;
  operationId: string;
  planDigest: string;
  state: 'pending' | 'in-flight' | 'converged' | 'unknown' | 'obsolete';
  claimedFence?: number;
  receiptSha256?: string;
  resolvedAt?: string;
}

export type PresentationDeliveryTarget =
  | {
      source: 'task';
      tenantId: string;
      task: TaskAuthorityScope;
      operationId: string;
    }
  | {
      source: 'attempt';
      tenantId: string;
      task: TaskAuthorityScope;
      attemptId: string;
      operationId: string;
    };

export interface PresentationDeliveryClaim {
  status: 'claimed' | 'replay' | 'terminal';
  record: PresentationDeliveryRecord;
  work?: VerifiedClaimedPresentationWork;
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
  readPresentationDelivery(
    input: PresentationDeliveryTarget,
  ): Promise<PresentationDeliveryRecord | undefined>;
  listPresentationDelivery(input: {
    tenantId: string;
    source?: PresentationDeliveryRecord['source'];
    task?: TaskAuthorityScope;
    attemptId?: string;
    state?: PresentationDeliveryRecord['state'];
  }): Promise<PresentationDeliveryRecord[]>;
  claimPresentationDelivery(input: {
    lease: TaskAuthorityLease;
    target: PresentationDeliveryTarget;
  }): Promise<PresentationDeliveryClaim>;
  resolveVerifiedPresentationDelivery(input: {
    lease: TaskAuthorityLease;
    resolution: VerifiedPresentationResolution;
  }): Promise<'applied' | 'replay'>;
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

function taskSnapshotDigest(task: TaskIntentState): string {
  return sha256Digest(canonicalDurableJson(canonicalValue(task)));
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** History references are an optional shadow receipt, not idempotency input. */
function sameObservationIdempotency(
  left: StoredIdempotency | undefined,
  right: StoredIdempotency | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  const { historyRecordRef: _leftHistoryRecordRef, ...leftIdentity } = left;
  const { historyRecordRef: _rightHistoryRecordRef, ...rightIdentity } = right;
  return same(leftIdentity, rightIdentity);
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

function presentationPlanDigest(
  plan: TaskPresentationPlan | AttemptPresentationPlan,
): string {
  return createHash('sha256').update(canonicalJson(plan)).digest('hex');
}

function presentationClaimTokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function publicPresentationDeliveryRecord(
  record: StoredPresentationDeliveryRecord,
): PresentationDeliveryRecord {
  const { claimTokenSha256: _claimTokenSha256, ...publicRecord } = record;
  return clone(publicRecord);
}

function presentationDeliveryKey(target: PresentationDeliveryTarget): string {
  return target.source === 'task'
    ? tupleKey(
        target.tenantId,
        'presentation-delivery',
        'task',
        target.task.repositoryId,
        target.task.issueNumber,
        target.operationId,
      )
    : tupleKey(
        target.tenantId,
        'presentation-delivery',
        'attempt',
        target.task.repositoryId,
        target.task.issueNumber,
        target.attemptId,
        target.operationId,
      );
}

function taskDeliveryTarget(
  record: TaskPresentationRecord,
): Extract<PresentationDeliveryTarget, { source: 'task' }> {
  return {
    source: 'task',
    tenantId: record.tenantId,
    task: clone(record.plan.task),
    operationId: record.plan.operationId,
  };
}

function attemptDeliveryTarget(
  record: AttemptPresentationRecord,
): Extract<PresentationDeliveryTarget, { source: 'attempt' }> {
  return {
    source: 'attempt',
    tenantId: record.tenantId,
    task: clone(record.plan.task),
    attemptId: record.plan.attemptId,
    operationId: record.plan.operationId,
  };
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

function taskHistoryKey(task: TaskAuthorityScope): string {
  return canonicalTaskKey(task);
}

function taskHistoryRecordKey(record: HistoryRecord): string {
  return tupleKey(
    record.tenantId,
    record.aggregateKind,
    record.aggregateId,
    record.streamKind,
    record.sequence,
  );
}

function taskHistoryRecordReferenceKey(
  reference: HistoryRecordReference,
): string {
  return tupleKey(
    reference.tenantId,
    reference.aggregateKind,
    reference.aggregateId,
    reference.streamKind,
    reference.sequence,
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
  taskSnapshotDigest: string;
  task: TaskIntentState;
}

interface StoredAttemptAdmissionHistoryReceipt {
  tenantId: string;
  tenant: AcceptedAttemptSpec['tenant'];
  task: TaskAuthorityScope;
  intentId: string;
  intentRevision: number;
  taskRevision: number;
  attemptId: string;
  admittedAt: string;
  specDigest: string;
  admissionDigest: string;
  taskSnapshotDigest: string;
  taskAdmissionRecordRef: HistoryRecordReference;
  attemptRegistrationRecordRef: HistoryRecordReference;
}

interface StoredIdempotency {
  counterpartId: string;
  canonicalDigest: string;
  payloadSha256?: string;
  resourceId: string;
  historyRecordRef?: HistoryRecordReference;
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

interface StoredPresentationDeliveryReceipt {
  planDigest: string;
  kind: 'converged' | 'unknown';
  receiptSha256: string;
  resolvedAt: string;
  snapshot: PresentationDeliveryRecord;
}

interface StoredTaskHistoryRecord {
  record: HistoryRecord;
  payload: unknown;
}

interface StoredTaskHistory {
  head: TaskHistoryHead;
  factRecords: StoredTaskHistoryRecord[];
  intentRecords: StoredTaskHistoryRecord[];
  effectRecords: StoredTaskHistoryRecord[];
  workRecords: StoredTaskHistoryRecord[];
  presentationRecords: StoredTaskHistoryRecord[];
  replayReceipts: Map<string, ReplayReceipt>;
  auxHeads: Map<'effect' | 'command' | 'presentation', HistoryHead>;
}

interface StoredAttemptHistoryRecord {
  record: HistoryRecord;
  payload: unknown;
}

/** Shadow-only Attempt history. Legacy Attempt state remains authoritative. */
interface StoredAttemptHistory {
  head: AttemptHistoryHead;
  records: Map<AttemptHistoryStream, StoredAttemptHistoryRecord[]>;
}

interface StoredCancellationReceipt {
  result: CancellationEffectResult;
  /** Private exact refs; never exposed through the authority API. */
  history?: {
    commandRef: HistoryRecordReference;
    evidenceRef?: HistoryRecordReference;
  };
}

interface StoredLaunchResolutionReceipt {
  responseSha256: string;
  /** Private exact ref; never exposed through the authority API. */
  history?: { commandRef: HistoryRecordReference };
}

/**
 * Private exact history pointers for finalization commands.  They are kept
 * beside the mutable work queue rather than exposed as part of its public
 * record, so a replay proves the same durable transition without turning a
 * storage detail into an API capability.
 */
interface StoredValidationHistoryReceipt {
  attemptId: string;
  commandId: string;
  commandRef: HistoryRecordReference;
  validationRef?: HistoryRecordReference;
}

interface StoredPresentationDeliveryRecord extends PresentationDeliveryRecord {
  /** One-way proof for the opaque work capability; never returned or logged. */
  claimTokenSha256?: string;
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
  private readonly attemptAdmissionHistoryReceipts = new Map<
    string,
    StoredAttemptAdmissionHistoryReceipt
  >();
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
  private readonly launchResolutionReceipts = new Map<
    string,
    StoredLaunchResolutionReceipt
  >();
  private readonly validationHistoryReceipts = new Map<
    string,
    StoredValidationHistoryReceipt
  >();
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
  private readonly presentationDeliveries = new Map<
    string,
    StoredPresentationDeliveryRecord
  >();
  private readonly presentationDeliveryReceipts = new Map<
    string,
    StoredPresentationDeliveryReceipt
  >();
  private readonly taskEffectReceipts = new Map<
    string,
    StoredTaskEffectReceipt
  >();
  /** Shadow-only history; `tasks` remains the sole reducer authority. */
  private readonly taskHistories = new Map<string, StoredTaskHistory>();
  /** Shadow-only history; `attempts` remains the sole reducer authority. */
  private readonly attemptHistories = new Map<string, StoredAttemptHistory>();
  private readonly cancellationWork = new Map<string, CancellationWorkRecord>();
  private readonly cancellationReceipts = new Map<
    string,
    StoredCancellationReceipt
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
    registerAttemptHistoryInspector(this, async (input) =>
      this.#inspectAttemptHistoryForTest(input),
    );
    registerTaskHistoryInspector(this, async (input) =>
      this.#inspectTaskHistoryForTest(input),
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

  private assertCurrentClaimLease(
    lease: TaskAuthorityLease,
    scope: TaskAuthorityScope,
  ): void {
    if (lease.taskKey !== canonicalTaskKey(scope)) {
      throw new AuthorityConflict('Lease belongs to another task');
    }
    const current = this.leases.get(lease.taskKey);
    if (current === undefined || !same(current, lease)) {
      throw new AuthorityConflict('Claim lease has been replaced or released');
    }
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
    const priorHistory = this.taskHistories.get(key);
    const rebuiltHistory =
      priorHistory === undefined
        ? undefined
        : this.makeLegacyTaskHistory(input.next);
    if (rebuiltHistory !== undefined && priorHistory !== undefined) {
      // Structural hydration may replace the legacy reducer snapshot, but it
      // cannot invent or discard the shadow-only auxiliary command/effect
      // chains. Preserve those immutable chains and their heads so admission
      // pointers remain resolvable after a test advances the Task revision.
      rebuiltHistory.effectRecords = priorHistory.effectRecords.map(clone);
      rebuiltHistory.workRecords = priorHistory.workRecords.map(clone);
      rebuiltHistory.presentationRecords =
        priorHistory.presentationRecords.map(clone);
      rebuiltHistory.auxHeads = new Map(
        [...priorHistory.auxHeads.entries()].map(([stream, head]) => [
          stream,
          clone(head),
        ]),
      );
    }
    this.tasks.set(key, clone(input.next));
    // Test-only structural hydration may seed a Task after history has been
    // created. Rebuild the inactive mirror from the new legacy authority so a
    // later real transition never observes a stale head. Production has no
    // equivalent raw writer.
    if (rebuiltHistory !== undefined)
      this.taskHistories.set(key, rebuiltHistory);
    return 'applied';
  }

  #inspectTaskHistoryForTest(input: {
    lease: TaskAuthorityLease;
    tenantId: string;
    task: TaskAuthorityScope;
  }): TaskHistoryInspection | undefined {
    this.assertLease(input.lease, input.task, this.now());
    if (input.tenantId !== input.task.tenantId) {
      throw new AuthorityConflict('Task history tenant scope is invalid');
    }
    const history = this.taskHistories.get(taskHistoryKey(input.task));
    if (history === undefined) return undefined;
    this.assertStoredTaskHistoryIntegrity(input.task, history);
    return {
      head: clone(history.head),
      factRecords: history.factRecords.map(({ record }) => clone(record)),
      intentRecords: history.intentRecords.map(({ record }) => clone(record)),
      effectRecords: history.effectRecords.map(({ record }) => clone(record)),
      workRecords: history.workRecords.map(({ record }) => clone(record)),
      presentationRecords: history.presentationRecords.map(({ record }) =>
        clone(record),
      ),
      replayReceipts: [...history.replayReceipts.values()].map(clone),
      workRecordEntries: history.workRecords.map(clone),
    };
  }

  #inspectAttemptHistoryForTest(input: {
    lease: TaskAuthorityLease;
    tenantId: string;
    attemptId: string;
  }): AttemptHistoryInspection | undefined {
    const attempt = this.attempts.get(input.attemptId);
    if (attempt === undefined) return undefined;
    this.assertLease(input.lease, attempt.spec.task, this.now());
    if (input.tenantId !== attempt.spec.tenant.tenantId) {
      throw new AuthorityConflict('Attempt history tenant scope is invalid');
    }
    const history = this.attemptHistories.get(input.attemptId);
    if (history === undefined) return undefined;
    this.assertStoredAttemptHistoryIntegrity(history, attempt);
    const records = {
      fact: history.records.get('fact')?.map(clone) ?? [],
      command: history.records.get('command')?.map(clone) ?? [],
      claim: history.records.get('claim')?.map(clone) ?? [],
      validation: history.records.get('validation')?.map(clone) ?? [],
      evidence: history.records.get('evidence')?.map(clone) ?? [],
    } as const;
    return {
      head: clone(history.head),
      records,
    };
  }

  private assertStoredAttemptHistoryIntegrity(
    history: StoredAttemptHistory,
    attempt: AttemptState,
  ): void {
    try {
      const head = verifyAttemptHistoryHead(history.head);
      if (
        head.tenantId !== attempt.spec.tenant.tenantId ||
        head.attemptId !== attempt.spec.attemptId ||
        head.specDigest !== attempt.specDigest ||
        !same(head.spec, attempt.spec) ||
        head.launch.operationId !== head.attemptId ||
        head.launch.operationId !== attempt.spec.attemptId ||
        head.executionEpoch !== 1 ||
        head.launch.executionEpoch !== head.executionEpoch ||
        head.aggregateRevision > attempt.revision ||
        (head.binding === undefined && attempt.binding !== undefined) ||
        (head.binding !== undefined &&
          (attempt.binding === undefined ||
            !same(head.binding, attempt.binding))) ||
        (head.cancellation !== undefined &&
          (head.cancellation.supersededByIntentId !==
            attempt.cancellation?.supersededByIntentId ||
            attempt.cancellation === undefined ||
            !attempt.commands.some(
              (command) => command.eventId === attempt.cancellation?.eventId,
            ))) ||
        (head.cancellation !== undefined && !attempt.futureGrantsDenied) ||
        (head.outcomeRef !== undefined && attempt.outcome === undefined) ||
        (head.outcomeDigest !== undefined && attempt.outcome === undefined) ||
        (attempt.outcome !== undefined &&
          head.outcomeRef !== undefined &&
          head.outcomeDigest !==
            attemptHistoryPayloadDigest(attempt.outcome)) ||
        (head.outcomeRef !== undefined && head.phase !== 'terminal')
      ) {
        throw new AuthorityConflict(
          'Attempt history head conflicts with legacy Attempt',
        );
      }
      const identity = {
        tenantId: head.tenantId,
        attemptId: head.attemptId,
      };
      for (const stream of [
        'fact',
        'command',
        'claim',
        'validation',
        'evidence',
      ] as const) {
        const entries = history.records.get(stream);
        if (entries === undefined) {
          throw new AuthorityConflict('Attempt history stream is missing');
        }
        let expected = createGenesisHistoryHead({
          tenantId: identity.tenantId,
          aggregateKind: 'attempt',
          aggregateId: identity.attemptId,
          streamKind: stream,
        });
        // Stored records are ordered by append sequence. Verify each payload,
        // chain predecessor, and the exact stream head rather than trusting
        // the pointer alone.
        let previous: HistoryRecord | undefined;
        for (const entry of entries) {
          const verified = verifyAttemptHistoryPayload(
            stream,
            entry.record,
            entry.payload,
            identity,
          );
          if (
            previous !== undefined &&
            (verified.record.sequence !== previous.sequence + 1 ||
              verified.record.previousRecordDigest !== previous.recordDigest)
          ) {
            throw new AuthorityConflict(
              'Attempt history predecessor is invalid',
            );
          }
          expected = verifyHistoryAppend({
            head: expected,
            record: verified.record,
          }).head;
          previous = verified.record;
        }
        if (!same(expected, head.streams[stream])) {
          throw new AuthorityConflict('Attempt history stream head is invalid');
        }
      }
      const commands = history.records.get('command') ?? [];
      if (commands.length < 1) {
        throw new AuthorityConflict(
          'Attempt registration history is incomplete',
        );
      }
      const registration = commands[0];
      const command = (
        registration?.payload as {
          payload?: { kind?: string; commandId?: string; specDigest?: string };
        }
      )?.payload;
      if (
        command?.kind !== 'attempt-registered' ||
        command.commandId !== attempt.spec.attemptId ||
        command.specDigest !== attempt.specDigest ||
        registration?.record.sequence !== 1
      ) {
        throw new AuthorityConflict('Attempt registration history is invalid');
      }
      const transitionCommands = commands.slice(1).map((entry) => {
        const value = entry.payload as {
          schema?: string;
          payload?: {
            kind?: string;
            commandId?: string;
            supersededByIntentId?: string;
          };
          canonicalDigest?: string;
        };
        if (
          value.schema !== 'agent-lcars.attempt-command/v1' ||
          ![
            'request-cancel',
            'cancel-unlaunched',
            'launch-accepted',
            'launch-response-unknown',
            'start-validation',
            'validate-claim-requested',
          ].includes(value.payload?.kind ?? '') ||
          value.payload?.commandId === undefined
        ) {
          throw new AuthorityConflict(
            'Attempt history contains an unsupported command',
          );
        }
        const legacy = attempt.commands.find(
          (candidate) => candidate.eventId === value.payload?.commandId,
        );
        if (
          legacy === undefined ||
          legacy.canonicalDigest !== value.canonicalDigest
        ) {
          throw new AuthorityConflict(
            'Attempt command does not match legacy state',
          );
        }
        if (
          value.payload?.kind === 'launch-accepted' ||
          value.payload?.kind === 'launch-response-unknown'
        ) {
          const resolutionKind =
            value.payload.kind === 'launch-accepted' ? 'accepted' : 'unknown';
          const expectedEventId = launchResolutionEventId({
            attemptId: attempt.spec.attemptId,
            operationId: attempt.launch.operationId,
            executionEpoch: attempt.executionEpoch,
            kind: resolutionKind,
          });
          if (
            value.payload.commandId !== expectedEventId ||
            value.canonicalDigest !==
              attemptTransitionDigest({
                kind:
                  value.payload.kind === 'launch-accepted'
                    ? 'launch-accepted'
                    : 'launch-response-unknown',
                eventId: expectedEventId,
              })
          ) {
            throw new AuthorityConflict(
              'Attempt launch command is not deterministic',
            );
          }
        }
        return { entry, value };
      });
      const cancellationCommands = transitionCommands.filter(({ value }) =>
        ['request-cancel', 'cancel-unlaunched'].includes(
          value.payload?.kind ?? '',
        ),
      );
      const launchCommands = transitionCommands.filter(({ value }) =>
        ['launch-accepted', 'launch-response-unknown'].includes(
          value.payload?.kind ?? '',
        ),
      );
      const startValidationCommands = transitionCommands.filter(
        ({ value }) => value.payload?.kind === 'start-validation',
      );
      const validateClaimCommands = transitionCommands.filter(
        ({ value }) => value.payload?.kind === 'validate-claim-requested',
      );
      if (launchCommands.length > 1) {
        throw new AuthorityConflict('Attempt launch history is duplicated');
      }
      const launchCommand = launchCommands[0];
      const launchKind = launchCommand?.value.payload?.kind;
      if (
        launchKind === 'launch-accepted' &&
        attempt.launch.state !== 'accepted'
      ) {
        throw new AuthorityConflict(
          'Attempt launch acceptance history is ahead',
        );
      }
      if (
        launchKind === 'launch-response-unknown' &&
        (!['response-unknown', 'accepted'].includes(attempt.launch.state) ||
          (attempt.launch.state === 'accepted' &&
            attempt.binding === undefined))
      ) {
        throw new AuthorityConflict('Attempt unknown launch history is ahead');
      }
      if (
        launchCommand === undefined &&
        head.binding === undefined &&
        head.launch.state !== 'recorded'
      ) {
        throw new AuthorityConflict(
          'Attempt launch command history is missing',
        );
      }
      if (
        launchKind === undefined &&
        head.binding !== undefined &&
        head.launch.state !== 'accepted'
      ) {
        throw new AuthorityConflict('Bound Attempt launch history is invalid');
      }
      if (
        launchKind === 'launch-accepted' &&
        head.launch.state !== 'accepted'
      ) {
        throw new AuthorityConflict('Attempt launch head is invalid');
      }
      if (
        launchKind === 'launch-response-unknown' &&
        head.binding === undefined &&
        head.launch.state !== 'response-unknown'
      ) {
        throw new AuthorityConflict('Attempt unknown launch head is invalid');
      }
      if (head.binding !== undefined && head.launch.state !== 'accepted') {
        throw new AuthorityConflict('Bound Attempt launch head is invalid');
      }
      if (
        head.cancellation !== undefined &&
        attempt.cancellation === undefined
      ) {
        throw new AuthorityConflict('Attempt cancellation history is ahead');
      }
      if (
        head.outcomeRef === undefined &&
        attempt.outcome !== undefined &&
        head.phase === 'terminal'
      ) {
        throw new AuthorityConflict('Attempt terminal history is incomplete');
      }
      if (head.finalization !== undefined) {
        if (attempt.finalization === undefined) {
          throw new AuthorityConflict(
            'Attempt finalization history is ahead of legacy state',
          );
        }
        if (
          attempt.phase === 'result-observed' &&
          (head.phase !== 'result-observed' ||
            startValidationCommands.length !== 0 ||
            validateClaimCommands.length !== 0)
        ) {
          throw new AuthorityConflict(
            'Attempt validation history is ahead of legacy state',
          );
        }
        if (
          attempt.phase === 'validating' &&
          (head.phase !== 'validating' || startValidationCommands.length !== 1)
        ) {
          throw new AuthorityConflict(
            'Attempt validation history is incomplete',
          );
        }
        if (
          !['result-observed', 'validating', 'terminal'].includes(attempt.phase)
        ) {
          throw new AuthorityConflict('Attempt finalization phase is invalid');
        }
      } else if (
        head.outcomeRef === undefined &&
        attempt.outcome === undefined
      ) {
        const expectedPhase =
          head.cancellation !== undefined
            ? 'cancelling'
            : head.binding !== undefined
              ? 'active'
              : head.launch.state === 'accepted'
                ? 'launch-accepted'
                : head.launch.state === 'response-unknown'
                  ? 'launch-response-unknown'
                  : 'launch-pending';
        if (head.phase !== expectedPhase) {
          throw new AuthorityConflict(
            'Attempt launch phase history is invalid',
          );
        }
      }
      if (
        attempt.cancellation !== undefined &&
        head.cancellation !== undefined
      ) {
        const cancellation = cancellationCommands.find(
          ({ value }) =>
            value.payload?.commandId === attempt.cancellation?.eventId,
        );
        if (
          cancellation === undefined ||
          cancellation.value.payload?.supersededByIntentId !==
            attempt.cancellation.supersededByIntentId
        ) {
          throw new AuthorityConflict(
            'Attempt cancellation command history is missing',
          );
        }
        if (
          !same(
            head.cancellation.commandRef,
            attemptHistoryRecordReference(
              cancellation.entry.record,
              identity,
              'command',
            ),
          )
        ) {
          throw new AuthorityConflict(
            'Attempt cancellation head pointer is invalid',
          );
        }
      } else if (cancellationCommands.length !== 0) {
        throw new AuthorityConflict(
          'Attempt cancellation history exists without legacy cancellation',
        );
      }
      const bindingRecords = (history.records.get('fact') ?? []).filter(
        ({ payload }) =>
          (payload as { payload?: { kind?: string } }).payload?.kind ===
          'run-bound',
      );
      if (bindingRecords.length > 1) {
        throw new AuthorityConflict('Attempt binding history is duplicated');
      }
      if (head.binding === undefined && bindingRecords.length !== 0) {
        throw new AuthorityConflict(
          'Unbound Attempt history contains a binding fact',
        );
      }
      const facts = history.records.get('fact') ?? [];
      const unsupportedFact = facts.some(({ payload }) => {
        const kind = (payload as { payload?: { kind?: string } }).payload?.kind;
        return !['run-bound', 'run-terminal', 'agent-result-claim'].includes(
          kind ?? '',
        );
      });
      if (unsupportedFact) {
        throw new AuthorityConflict(
          'Attempt history fact mirror contains unsupported data',
        );
      }
      const terminalRecords = facts.filter(
        ({ payload }) =>
          (payload as { payload?: { kind?: string } }).payload?.kind ===
          'run-terminal',
      );
      const claimFactRecords = facts.filter(
        ({ payload }) =>
          (payload as { payload?: { kind?: string } }).payload?.kind ===
          'agent-result-claim',
      );
      if (
        facts.length !==
          (head.binding === undefined ? 0 : 1) +
            terminalRecords.length +
            claimFactRecords.length ||
        terminalRecords.length > 1
      ) {
        throw new AuthorityConflict('Attempt history fact mirror is invalid');
      }
      const evidenceRecords = history.records.get('evidence') ?? [];
      if (evidenceRecords.length > 1) {
        throw new AuthorityConflict('Attempt history evidence is duplicated');
      }
      const claimRecords = history.records.get('claim') ?? [];
      if (claimRecords.length !== claimFactRecords.length)
        throw new AuthorityConflict('Attempt claim history mirror is invalid');
      const validationRecords = history.records.get('validation') ?? [];
      const expectedTerminalFactId =
        attempt.pendingTerminal?.factId ?? attempt.finalization?.terminalFactId;
      if (
        (expectedTerminalFactId === undefined &&
          terminalRecords.length !== 0) ||
        (expectedTerminalFactId !== undefined &&
          (terminalRecords.length > 1 ||
            (terminalRecords.length === 1 &&
              (terminalRecords[0]?.payload as { factId?: string }).factId !==
                expectedTerminalFactId)))
      ) {
        throw new AuthorityConflict('Attempt terminal history is invalid');
      }
      const trackedClaimRefs = [
        ...head.pendingClaimRefs,
        ...(head.finalization?.claimRefs ?? []),
      ];
      const trackedClaimIds = trackedClaimRefs
        .map((ref) => {
          const matches = claimRecords.filter(({ record }) =>
            same(attemptHistoryRecordReference(record, identity, 'claim'), ref),
          );
          if (matches.length !== 1) {
            throw new AuthorityConflict(
              'Attempt claim history reference is invalid',
            );
          }
          const claimFactId = (matches[0]?.payload as { claimFactId?: string })
            .claimFactId;
          if (claimFactId === undefined) {
            throw new AuthorityConflict(
              'Attempt claim history payload is invalid',
            );
          }
          return claimFactId;
        })
        .sort();
      const legacyClaimIds = (
        head.finalization === undefined
          ? attempt.pendingClaims
          : (attempt.finalization?.evidence ?? [])
      )
        .map((claim) => claim.factId)
        .sort();
      // A pre-history Attempt can have legacy claims without any mirrored
      // claim refs. Once a ref is tracked — or terminal history exists — it
      // must mirror the reducer's selected prefix exactly. Late claims stay
      // in fact/claim streams but are omitted only after finalization opens.
      if (
        (trackedClaimRefs.length !== 0 ||
          head.pendingTerminal !== undefined ||
          head.finalization !== undefined) &&
        !same(legacyClaimIds, trackedClaimIds)
      ) {
        throw new AuthorityConflict(
          'Attempt claim history conflicts with legacy state',
        );
      }
      if (head.finalization === undefined) {
        if (
          startValidationCommands.length !== 0 ||
          validateClaimCommands.length !== 0 ||
          validationRecords.length !== 0
        ) {
          throw new AuthorityConflict('Attempt validation history is orphaned');
        }
      } else {
        const historyFinalization = head.finalization;
        const expectedStartId = finalizationCommandId(
          'start-validation',
          attempt.spec.attemptId,
          attempt.finalization?.terminalFactId ?? '',
        );
        const start = startValidationCommands[0];
        if (
          startValidationCommands.length > 1 ||
          (start !== undefined &&
            (start.value.payload?.commandId !== expectedStartId ||
              !same(
                (
                  start.entry.payload as {
                    payload?: { terminalFactRef?: HistoryRecordReference };
                  }
                ).payload?.terminalFactRef,
                historyFinalization.terminalFactRef,
              )))
        ) {
          throw new AuthorityConflict(
            'Attempt start validation history is invalid',
          );
        }
        const legacyValidations = (attempt.finalization?.evidence ?? [])
          .filter((evidence) => evidence.validation !== undefined)
          .map((evidence) => ({
            claimFactId: evidence.factId,
            validation: evidence.validation as NonNullable<
              typeof evidence.validation
            >,
          }));
        if (
          validationRecords.length !== legacyValidations.length ||
          validateClaimCommands.length !== legacyValidations.length ||
          head.finalization.validationRefs.length !== legacyValidations.length
        ) {
          throw new AuthorityConflict(
            'Attempt validation history is incomplete',
          );
        }
        const seenValidationClaims = new Set<string>();
        for (const validationRef of head.finalization.validationRefs) {
          const entry = validationRecords.find(({ record }) =>
            same(
              attemptHistoryRecordReference(record, identity, 'validation'),
              validationRef,
            ),
          );
          const payload = (entry?.payload ?? {}) as {
            commandId?: string;
            validationFactId?: string;
            terminalFactRef?: HistoryRecordReference;
            claimFactRef?: HistoryRecordReference;
            validation?: { validationFactId?: string };
          };
          const claimEntry =
            payload.claimFactRef === undefined
              ? undefined
              : claimRecords.find(({ record }) =>
                  same(
                    attemptHistoryRecordReference(record, identity, 'claim'),
                    payload.claimFactRef as HistoryRecordReference,
                  ),
                );
          const claimFactId = (claimEntry?.payload as { claimFactId?: string })
            ?.claimFactId;
          const legacy = legacyValidations.find(
            (item) =>
              item.claimFactId === claimFactId &&
              item.validation.validationFactId === payload.validationFactId,
          );
          const expectedValidationId =
            claimFactId === undefined
              ? undefined
              : finalizationCommandId(
                  'validate-claim',
                  attempt.spec.attemptId,
                  attempt.finalization?.terminalFactId ?? '',
                  claimFactId,
                );
          const matchingCommand = validateClaimCommands.find(
            ({ entry: commandEntry, value }) =>
              value.payload?.commandId === payload.commandId &&
              same(
                (
                  commandEntry.payload as {
                    payload?: {
                      terminalFactRef?: HistoryRecordReference;
                      claimFactRef?: HistoryRecordReference;
                    };
                  }
                ).payload?.terminalFactRef,
                historyFinalization.terminalFactRef,
              ) &&
              same(
                (
                  commandEntry.payload as {
                    payload?: { claimFactRef?: HistoryRecordReference };
                  }
                ).payload?.claimFactRef,
                payload.claimFactRef,
              ),
          );
          if (
            entry === undefined ||
            payload.commandId !== payload.validationFactId ||
            payload.validation?.validationFactId !== payload.validationFactId ||
            payload.validationFactId !== expectedValidationId ||
            !same(
              payload.terminalFactRef,
              historyFinalization.terminalFactRef,
            ) ||
            legacy === undefined ||
            matchingCommand === undefined ||
            claimFactId === undefined ||
            seenValidationClaims.has(claimFactId)
          ) {
            throw new AuthorityConflict(
              'Attempt validation history conflicts with legacy state',
            );
          }
          seenValidationClaims.add(claimFactId);
        }
      }
      for (const entry of facts) {
        const payload = entry.payload as {
          factId?: string;
          requestId?: string;
          canonicalDigest?: string;
          payload?: { kind?: string };
        };
        if (
          payload.payload?.kind !== 'run-bound' &&
          payload.payload?.kind !== 'run-terminal' &&
          payload.payload?.kind !== 'agent-result-claim'
        )
          continue;
        if (
          !attempt.facts.some(
            (fact) =>
              fact.factId === payload.factId &&
              fact.requestId === payload.requestId &&
              fact.canonicalDigest === payload.canonicalDigest,
          )
        ) {
          throw new AuthorityConflict(
            'Attempt fact history conflicts with legacy state',
          );
        }
      }
      const directCancellation = cancellationCommands.find(
        ({ value }) => value.payload?.kind === 'cancel-unlaunched',
      );
      if (directCancellation === undefined && evidenceRecords.length !== 0)
        throw new AuthorityConflict(
          'Attempt history has an outcome without legacy truth',
        );
      if (directCancellation !== undefined) {
        const evidence = evidenceRecords[0];
        const value = evidence?.payload as
          | {
              finalizeCommandRef?: HistoryRecordReference;
              outcomeDigest?: string;
              outcome?: unknown;
            }
          | undefined;
        const commandRecord = cancellationCommands.find(
          ({ value: candidate }) =>
            candidate.payload?.commandId === attempt.cancellation?.eventId,
        );
        if (
          evidence === undefined ||
          value?.finalizeCommandRef === undefined ||
          commandRecord === undefined ||
          !same(
            value.finalizeCommandRef,
            attemptHistoryRecordReference(
              commandRecord.entry.record,
              identity,
              'command',
            ),
          ) ||
          head.outcomeRef === undefined ||
          !same(
            head.outcomeRef,
            attemptHistoryRecordReference(
              evidence.record,
              identity,
              'evidence',
            ),
          ) ||
          head.outcomeDigest !== value.outcomeDigest ||
          value.outcomeDigest !==
            attemptHistoryPayloadDigest(attempt.outcome) ||
          !same(value.outcome, attempt.outcome)
        ) {
          throw new AuthorityConflict(
            'Attempt cancellation evidence is invalid',
          );
        }
      }
      if (head.binding !== undefined) {
        const bindingRecord = bindingRecords[0];
        const payload = bindingRecord?.payload as {
          factId?: string;
          requestId?: string;
          canonicalDigest?: string;
          payload?: { kind?: string; binding?: RunBinding };
        };
        if (
          bindingRecord === undefined ||
          bindingRecord.record.appliedRevision > head.aggregateRevision ||
          payload.payload?.kind !== 'run-bound' ||
          !same(payload.payload.binding, head.binding) ||
          !attempt.facts.some(
            (fact) =>
              fact.factId === payload.factId &&
              fact.requestId === payload.requestId &&
              fact.canonicalDigest === payload.canonicalDigest,
          )
        ) {
          throw new AuthorityConflict('Attempt binding history is invalid');
        }
      }
    } catch (error) {
      if (error instanceof AuthorityConflict) throw error;
      throw new AuthorityConflict('Attempt history integrity failed');
    }
  }

  private assertStoredAttemptAdmissionHistoryReceipt(input: {
    receipt: StoredAttemptAdmissionHistoryReceipt;
    taskHistory: StoredTaskHistory;
    attemptHistory: StoredAttemptHistory;
    attempt: AttemptState;
  }): void {
    const { receipt, taskHistory, attemptHistory, attempt } = input;
    const taskRecord = taskHistory.workRecords.find(({ record }) =>
      same(historyRecordReference(record), receipt.taskAdmissionRecordRef),
    );
    if (taskRecord === undefined) {
      throw new AuthorityConflict('Task admission history pointer is missing');
    }
    try {
      const verifiedTaskRecord = verifyHistoryRecordPayload(
        taskRecord.record,
        taskRecord.payload,
      );
      if (
        !same(verifiedTaskRecord.payload, {
          schema: 'agent-lcars.task-attempt-admission-history/v1',
          version: 1,
          tenant: receipt.tenant,
          task: receipt.task,
          intentId: receipt.intentId,
          intentRevision: receipt.intentRevision,
          attemptId: receipt.attemptId,
          admissionRevision: receipt.taskRevision - 1,
          admittedAt: receipt.admittedAt,
          taskSnapshotDigest: receipt.taskSnapshotDigest,
          inputDigest: receipt.admissionDigest,
          specDigest: receipt.specDigest,
          attemptRegistrationRef: receipt.attemptRegistrationRecordRef,
        })
      ) {
        throw new AuthorityConflict('Task admission history pointer conflicts');
      }
    } catch (error) {
      if (error instanceof AuthorityConflict) throw error;
      throw new AuthorityConflict('Task admission history pointer is corrupt');
    }
    const attemptRecord = attemptHistory.records
      .get('command')
      ?.find(({ record }) =>
        same(
          historyRecordReference(record),
          receipt.attemptRegistrationRecordRef,
        ),
      );
    if (attemptRecord === undefined) {
      throw new AuthorityConflict('Attempt registration pointer is missing');
    }
    const verifiedAttemptRecord = verifyAttemptHistoryPayload(
      'command',
      attemptRecord.record,
      attemptRecord.payload,
      {
        tenantId: attempt.spec.tenant.tenantId,
        attemptId: attempt.spec.attemptId,
      },
    );
    if (
      verifiedAttemptRecord.record.sequence !== 1 ||
      !same(
        historyRecordReference(verifiedAttemptRecord.record),
        receipt.attemptRegistrationRecordRef,
      )
    ) {
      throw new AuthorityConflict('Attempt registration pointer conflicts');
    }
  }

  private assertStoredTaskHistoryIntegrity(
    task: TaskAuthorityScope,
    history: StoredTaskHistory,
  ): Map<string, StoredTaskHistoryRecord> {
    const legacy = this.tasks.get(canonicalTaskKey(task));
    if (legacy === undefined) {
      throw new AuthorityConflict('Task history exists without legacy Task');
    }
    let upgraded;
    try {
      const { desired: legacyDesired, ...legacyFields } = legacy;
      const upgradeState = {
        ...legacyFields,
        ...(legacyDesired === undefined ? {} : { desired: legacyDesired }),
        revision: history.head.aggregateRevision,
        updatedAt: history.head.updatedAt,
        attempt:
          history.head.desired === undefined
            ? { kind: 'none' }
            : {
                kind: 'unlaunched',
                intentId: history.head.desired.intentId,
              },
        intents: legacy.intents.map((intent) => {
          const { schema: _schema, version: _version, ...fields } = intent;
          return fields;
        }),
      };
      upgraded = upgradeLegacyTaskIntentState({
        state: JSON.parse(JSON.stringify(upgradeState)),
      });
    } catch {
      throw new AuthorityConflict('Legacy Task cannot be upgraded to history');
    }
    if (
      history.head.aggregateRevision !== legacy.revision ||
      !same(history.head.task, legacy.task) ||
      !same(history.head.tenant, legacy.tenant) ||
      !same(history.head.activation, legacy.activation) ||
      !same(history.head.desired, legacy.desired) ||
      !same(history.head.attempt, legacy.attempt) ||
      history.head.updatedAt !== legacy.updatedAt ||
      !same(history.head.factHead, upgraded.head.factHead) ||
      !same(history.head.intentHead, upgraded.head.intentHead)
    ) {
      throw new AuthorityConflict(
        'Task history head conflicts with legacy Task',
      );
    }
    const assertRecord = (entry: StoredTaskHistoryRecord): void => {
      const valid = verifyHistoryRecord(entry.record);
      verifyHistoryRecordPayload(valid, entry.payload);
    };
    const recordIndex = new Map<string, StoredTaskHistoryRecord>();
    for (const entry of [
      ...history.factRecords,
      ...history.intentRecords,
      ...history.effectRecords,
      ...history.workRecords,
      ...history.presentationRecords,
    ]) {
      try {
        assertRecord(entry);
        const key = taskHistoryRecordKey(entry.record);
        if (recordIndex.has(key)) {
          throw new AuthorityConflict('Task history record key collision');
        }
        recordIndex.set(key, entry);
      } catch {
        throw new AuthorityConflict('Task history record integrity failed');
      }
    }
    const compareRecords = (
      actual: readonly StoredTaskHistoryRecord[],
      expected: readonly HistoryRecord[],
    ): void => {
      if (
        actual.length !== expected.length ||
        actual.some(({ record }, index) => !same(record, expected[index]))
      ) {
        throw new AuthorityConflict(
          'Task history records conflict with legacy Task',
        );
      }
    };
    compareRecords(history.factRecords, upgraded.factRecords);
    compareRecords(history.intentRecords, upgraded.intentRecords);
    const auxiliaryStreams = ['effect', 'command', 'presentation'] as const;
    if (
      history.auxHeads.size !== auxiliaryStreams.length ||
      [...history.auxHeads.keys()].some(
        (stream) => !auxiliaryStreams.includes(stream),
      )
    ) {
      throw new AuthorityConflict(
        'Task auxiliary history heads are incomplete or unexpected',
      );
    }
    for (const stream of auxiliaryStreams) {
      const head = history.auxHeads.get(stream);
      if (head === undefined) {
        throw new AuthorityConflict('Task auxiliary history head is missing');
      }
      const records =
        stream === 'effect'
          ? history.effectRecords
          : stream === 'command'
            ? history.workRecords
            : history.presentationRecords;
      let expected = createGenesisHistoryHead({
        tenantId: history.head.tenant.tenantId,
        aggregateKind: 'task',
        aggregateId: history.head.aggregateId,
        streamKind: stream,
      });
      for (const { record } of records) {
        expected = verifyHistoryAppend({ head: expected, record }).head;
      }
      if (!same(expected, head)) {
        throw new AuthorityConflict('Task auxiliary history head is invalid');
      }
    }
    for (const receipt of history.replayReceipts.values()) {
      try {
        verifyReplayReceiptReferences(receipt, (reference) => {
          const entry = recordIndex.get(
            taskHistoryRecordReferenceKey(reference),
          );
          if (entry === undefined) return undefined;
          verifyHistoryRecordPayload(entry.record, entry.payload);
          return entry.record;
        });
      } catch {
        throw new AuthorityConflict(
          'Task history replay receipt integrity failed',
        );
      }
    }
    return recordIndex;
  }

  private makeLegacyTaskHistory(task: TaskIntentState): StoredTaskHistory {
    let upgraded;
    try {
      const { desired: taskDesired, ...taskFields } = task;
      const upgradeState = {
        ...taskFields,
        ...(taskDesired === undefined ? {} : { desired: taskDesired }),
        attempt:
          taskDesired === undefined
            ? { kind: 'none' as const }
            : { kind: 'unlaunched' as const, intentId: taskDesired.intentId },
        facts: task.facts.map((fact) => ({ ...fact })),
        intents: task.intents.map((intent) => {
          const { schema: _schema, version: _version, ...fields } = intent;
          return fields;
        }),
      };
      upgraded = upgradeLegacyTaskIntentState({
        state: JSON.parse(JSON.stringify(upgradeState)),
      });
    } catch {
      throw new AuthorityConflict('Legacy Task cannot be upgraded to history');
    }
    const factPayloads = task.facts.map((fact) => ({
      schema: 'agent-lcars.task-fact-history/v1' as const,
      version: 1 as const,
      task: task.task,
      ...fact,
      situation: inferTaskFactSituation(fact),
    }));
    const intentPayloads = task.intents.map((intent) => {
      const { schema: _schema, version: _version, ...intentFields } = intent;
      return {
        schema: 'agent-lcars.task-intent-history/v1' as const,
        version: 1 as const,
        ...intentFields,
      };
    });
    const auxHeads = new Map<
      'effect' | 'command' | 'presentation',
      HistoryHead
    >();
    for (const stream of ['effect', 'command', 'presentation'] as const) {
      auxHeads.set(
        stream,
        createGenesisHistoryHead({
          tenantId: task.tenant.tenantId,
          aggregateKind: 'task',
          aggregateId: upgraded.head.aggregateId,
          streamKind: stream,
        }),
      );
    }
    return {
      head: taskHistoryHeadSchema.parse({
        ...upgraded.head,
        aggregateRevision: task.revision,
        attempt: task.attempt,
        updatedAt: task.updatedAt,
      }),
      factRecords: upgraded.factRecords.map((record, index) => ({
        record: clone(record),
        payload: clone(factPayloads[index] as TaskFactHistoryPayload),
      })),
      intentRecords: upgraded.intentRecords.map((record, index) => ({
        record: clone(record),
        payload: clone(intentPayloads[index] as TaskIntentHistoryPayload),
      })),
      effectRecords: [],
      workRecords: [],
      presentationRecords: [],
      replayReceipts: new Map(),
      auxHeads,
    };
  }

  private appendAuxiliaryHistoryRecord(
    history: StoredTaskHistory,
    stream: 'effect' | 'command' | 'presentation',
    payload: unknown,
    appliedRevision: number,
  ): { record: HistoryRecord; reference: HistoryRecordReference } {
    const head = history.auxHeads.get(stream);
    if (head === undefined)
      throw new AuthorityConflict('Task history stream is absent');
    let appended;
    try {
      appended = appendHistoryRecord({ head, payload, appliedRevision });
    } catch {
      throw new AuthorityConflict('Task auxiliary history append failed');
    }
    const entry = { record: appended.record, payload: clone(payload) };
    const target =
      stream === 'effect'
        ? history.effectRecords
        : stream === 'command'
          ? history.workRecords
          : history.presentationRecords;
    if (target.some(({ record }) => same(record, appended.record))) {
      throw new AuthorityConflict('Task auxiliary history record collision');
    }
    target.push(entry);
    history.auxHeads.set(stream, appended.head);
    return {
      record: appended.record,
      reference: historyRecordReference(appended.record),
    };
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
      const history = this.taskHistories.get(taskHistoryKey(scope));
      const historyReceipt = history?.replayReceipts.get(receiptKey);
      if (history === undefined || historyReceipt === undefined) {
        throw new AuthorityConflict('Task history replay receipt is missing');
      }
      const recordIndex = this.assertStoredTaskHistoryIntegrity(scope, history);
      try {
        if (historyReceipt.canonicalInputDigest !== command.canonicalDigest) {
          throw new AuthorityConflict('Task history replay input conflicts');
        }
        if (historyReceipt.appliedRevision !== prior.task.revision) {
          throw new AuthorityConflict('Task history replay revision conflicts');
        }
        verifyReplayReceiptReferences(historyReceipt, (reference) => {
          const entry = recordIndex.get(
            taskHistoryRecordReferenceKey(reference),
          );
          if (entry === undefined) return undefined;
          verifyHistoryRecordPayload(entry.record, entry.payload);
          return entry.record;
        });
        const expectedResponseRefs = [
          ...history.factRecords.filter(
            ({ payload }) =>
              (payload as { factId?: string }).factId ===
              command.envelope.factId,
          ),
          ...history.intentRecords.filter(
            ({ payload }) =>
              (payload as { sourceFactId?: string }).sourceFactId ===
              command.envelope.factId,
          ),
        ].map(({ record }) => historyRecordReference(record));
        if (!same(historyReceipt.responseRecordRefs, expectedResponseRefs)) {
          throw new AuthorityConflict(
            'Task history response references conflict',
          );
        }
        const expectedEffectRefs = prior.effects.map((expected) => {
          const entry = history.effectRecords.find(
            ({ payload }) =>
              (payload as TaskEffectRecord).sourceFactId ===
                command.envelope.factId &&
              (payload as TaskEffectRecord).effectKey ===
                this.taskEffects.get(expected.key)?.effectKey &&
              (payload as TaskEffectRecord).canonicalDigest ===
                expected.canonicalDigest,
          );
          if (entry === undefined)
            throw new AuthorityConflict(
              'Task history effect reference is missing',
            );
          return historyRecordReference(entry.record);
        });
        const expectedPresentationRefs = [
          ...prior.plans,
          ...prior.obsoletedPlans,
        ].map((expected) => {
          const entry = [...history.presentationRecords]
            .reverse()
            .find(
              ({ payload }) =>
                (payload as TaskPresentationRecord).plan.operationId ===
                  expected.snapshot.plan.operationId &&
                same(payload, expected.snapshot),
            );
          if (entry === undefined)
            throw new AuthorityConflict(
              'Task history presentation reference is missing',
            );
          return historyRecordReference(entry.record);
        });
        if (
          !same(historyReceipt.emittedEffectRefs, expectedEffectRefs) ||
          !same(
            historyReceipt.emittedPresentationRefs,
            expectedPresentationRefs,
          ) ||
          (historyReceipt.emittedWorkRefs?.length ?? 0) !== 0
        ) {
          throw new AuthorityConflict(
            'Task history output references conflict',
          );
        }
      } catch (error) {
        if (error instanceof AuthorityConflict) throw error;
        throw new AuthorityConflict('Task history replay receipt is corrupt');
      }
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
      for (const plan of plans) {
        if (plan !== undefined) {
          this.assertPresentationDeliveryPlan(
            taskDeliveryTarget(plan),
            plan.plan,
          );
        }
      }
      for (const plan of obsoletedPlans) {
        if (plan !== undefined) {
          const delivery = this.assertPresentationDeliveryPlan(
            taskDeliveryTarget(plan),
            plan.plan,
          );
          if (delivery.state !== 'obsolete') {
            throw new AuthorityConflict(
              'Obsolete Task presentation delivery conflicts',
            );
          }
        }
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
    const existingHistory = this.taskHistories.get(taskHistoryKey(scope));
    if (current === undefined && existingHistory !== undefined) {
      throw new AuthorityConflict('Task history exists without legacy Task');
    }
    if (existingHistory !== undefined) {
      this.assertStoredTaskHistoryIntegrity(scope, existingHistory);
    }
    const history: StoredTaskHistory =
      existingHistory === undefined
        ? current === undefined
          ? (() => {
              const head = createGenesisTaskHistoryHead({
                tenant: reduced.state.tenant,
                task: reduced.state.task,
                activation: reduced.state.activation,
                updatedAt: reduced.state.updatedAt,
              });
              const auxHeads = new Map<
                'effect' | 'command' | 'presentation',
                HistoryHead
              >();
              for (const stream of [
                'effect',
                'command',
                'presentation',
              ] as const) {
                auxHeads.set(
                  stream,
                  createGenesisHistoryHead({
                    tenantId: head.tenant.tenantId,
                    aggregateKind: 'task',
                    aggregateId: head.aggregateId,
                    streamKind: stream,
                  }),
                );
              }
              return {
                head,
                factRecords: [],
                intentRecords: [],
                effectRecords: [],
                workRecords: [],
                presentationRecords: [],
                replayReceipts: new Map(),
                auxHeads,
              };
            })()
          : this.makeLegacyTaskHistory(current)
        : clone(existingHistory);
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
    const newPlanDeliveries = plans.map((plan) => {
      const target = taskDeliveryTarget(plan);
      return {
        key: presentationDeliveryKey(target),
        record: this.preflightNewPresentationDelivery(target, plan.plan),
      };
    });
    const obsoleteReason =
      plans.length > 0
        ? 'newer-presentation'
        : reduced.resolution.kind === 'desired'
          ? 'task-resumed'
          : reduced.resolution.kind === 'cancelled'
            ? 'task-cancelled'
            : undefined;
    const pendingObsoletions: Array<{
      planKey: string;
      plan: TaskPresentationRecord;
      deliveryKey: string;
      delivery: PresentationDeliveryRecord;
    }> = [];
    for (const [key, priorPlan] of this.taskPresentations) {
      if (
        priorPlan.tenantId === scope.tenantId &&
        same(priorPlan.plan.task, scope) &&
        priorPlan.deliveryState === 'pending' &&
        obsoleteReason !== undefined
      ) {
        const target = taskDeliveryTarget(priorPlan);
        const delivery = this.assertPresentationDeliveryPlan(
          target,
          priorPlan.plan,
        );
        if (delivery.state !== 'pending') continue;
        const obsolete: TaskPresentationRecord = {
          ...priorPlan,
          deliveryState: 'obsolete',
          obsoleteAtTaskRevision: reduced.state.revision,
          obsoleteReason,
        };
        pendingObsoletions.push({
          planKey: key,
          plan: obsolete,
          deliveryKey: presentationDeliveryKey(target),
          delivery: { ...delivery, state: 'obsolete' },
        });
      }
    }
    const fact = reduced.state.facts.find(
      (candidate) => candidate.factId === command.envelope.factId,
    );
    if (fact === undefined) {
      throw new AuthorityConflict('Task reducer fact is absent');
    }
    const situation =
      command.envelope.signal.kind === 'park'
        ? 'park'
        : command.envelope.signal.kind === 'cancel'
          ? 'cancel'
          : command.envelope.signal.kind === 'reconcile'
            ? 'reconcile'
            : 'requested-work';
    const factPayload: TaskFactHistoryPayload = {
      schema: 'agent-lcars.task-fact-history/v1',
      version: 1,
      task: clone(reduced.state.task),
      factId: fact.factId,
      requestId: fact.requestId,
      sourceKey: fact.sourceKey,
      canonicalDigest: fact.canonicalDigest,
      situation,
      policyDecision: clone(fact.policyDecision),
      resolution: clone(fact.resolution),
      acceptedAt: fact.acceptedAt,
    };
    const intentPayloads: TaskIntentHistoryPayload[] = reduced.state.intents
      .filter((intent) => intent.sourceFactId === fact.factId)
      .map((intent) => ({
        schema: 'agent-lcars.task-intent-history/v1' as const,
        version: 1 as const,
        task: clone(intent.task),
        intentId: intent.intentId,
        revision: intent.revision,
        status: intent.status,
        sourceFactId: intent.sourceFactId,
        policyDecision: clone(intent.policyDecision),
        activation: clone(intent.activation),
        createdAt: intent.createdAt,
        semanticKey: intent.semanticKey,
        semanticDigest: intent.semanticDigest,
        orderingKey: clone(intent.orderingKey),
      }));
    const effectRefs: HistoryRecordReference[] = [];
    const workRefs: HistoryRecordReference[] = [];
    const presentationRefs: HistoryRecordReference[] = [];
    const newAuxiliaryRecords: HistoryRecord[] = [];
    for (const record of records) {
      effectRefs.push(
        this.appendAuxiliaryHistoryRecord(
          history,
          'effect',
          record,
          reduced.state.revision,
        ).reference,
      );
      const effectRecord = history.effectRecords.at(-1)?.record;
      if (effectRecord !== undefined) newAuxiliaryRecords.push(effectRecord);
    }
    for (const plan of [
      ...plans,
      ...pendingObsoletions.map(({ plan }) => plan),
    ]) {
      presentationRefs.push(
        this.appendAuxiliaryHistoryRecord(
          history,
          'presentation',
          plan,
          reduced.state.revision,
        ).reference,
      );
      const presentationRecord = history.presentationRecords.at(-1)?.record;
      if (presentationRecord !== undefined)
        newAuxiliaryRecords.push(presentationRecord);
    }
    let historyTransition: ReturnType<typeof validateTaskHistoryTransition>;
    try {
      historyTransition = validateTaskHistoryTransition({
        head: history.head,
        fact: factPayload,
        intents: intentPayloads,
        appliedRevision: reduced.state.revision,
        desired: reduced.state.desired,
        attempt: reduced.state.attempt,
        updatedAt: reduced.state.updatedAt,
        effectRefs,
        workRefs,
        presentationRefs,
      });
      validateDurableTransition({
        effects: [...effectRefs, ...presentationRefs],
        historyRecords: [
          historyTransition.factRecord,
          ...historyTransition.intentRecords,
          ...newAuxiliaryRecords,
        ],
        workRecords: workRefs,
      });
    } catch {
      throw new AuthorityConflict('Task history transition is invalid');
    }
    history.factRecords.push({
      record: historyTransition.factRecord,
      payload: factPayload,
    });
    history.intentRecords.push(
      ...historyTransition.intentRecords.map((record, index) => ({
        record,
        payload: intentPayloads[index] as TaskIntentHistoryPayload,
      })),
    );
    history.head = historyTransition.head;
    let historyReceipt: ReplayReceipt;
    try {
      historyReceipt = createReplayReceipt({
        operationId: `task-transition:${command.envelope.factId}`,
        replayKey: command.envelope.factId,
        tenantId: scope.tenantId,
        aggregateKind: 'task',
        aggregateId: history.head.aggregateId,
        canonicalInputDigest: command.canonicalDigest,
        appliedRevision: reduced.state.revision,
        responseRecordRefs: [
          historyTransition.factRecord,
          ...historyTransition.intentRecords,
        ].map(historyRecordReference),
        emittedEffectRefs: effectRefs,
        emittedWorkRefs: workRefs,
        emittedPresentationRefs: presentationRefs,
      });
    } catch {
      throw new AuthorityConflict('Task history replay receipt is invalid');
    }
    if (history.replayReceipts.has(receiptKey)) {
      throw new AuthorityConflict('Task history replay receipt collision');
    }
    history.replayReceipts.set(receiptKey, historyReceipt);
    // All checks above occur before the contiguous in-memory transaction body.
    const obsoletedPlans = pendingObsoletions.map(({ plan }) => plan);
    const taskKey = canonicalTaskKey(scope);
    const previousTask = this.tasks.get(taskKey);
    const previousHistory = this.taskHistories.get(taskKey);
    const effectKeys = records.map((record) => taskEffectKey(record));
    const previousEffects = effectKeys.map((key) => this.taskEffects.get(key));
    const planKeys = [
      ...pendingObsoletions.map(({ planKey }) => planKey),
      ...plans.map((plan) =>
        taskPresentationKey({
          tenantId: plan.tenantId,
          task: scope,
          operationId: plan.plan.operationId,
        }),
      ),
    ];
    const previousPlans = planKeys.map((key) =>
      this.taskPresentations.get(key),
    );
    const deliveryKeys = [
      ...pendingObsoletions.map(({ deliveryKey }) => deliveryKey),
      ...newPlanDeliveries.map(({ key }) => key),
    ];
    const previousDeliveries = deliveryKeys.map((key) =>
      this.presentationDeliveries.get(key),
    );
    try {
      this.tasks.set(taskKey, clone(reduced.state));
      for (const record of records) {
        this.taskEffects.set(taskEffectKey(record), clone(record));
      }
      for (const obsolete of pendingObsoletions) {
        this.taskPresentations.set(obsolete.planKey, clone(obsolete.plan));
        this.presentationDeliveries.set(
          obsolete.deliveryKey,
          clone(obsolete.delivery),
        );
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
      for (const delivery of newPlanDeliveries) {
        this.presentationDeliveries.set(delivery.key, clone(delivery.record));
      }
      this.taskHistories.set(taskKey, clone(history));
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
    } catch (error) {
      const restore = <T>(
        map: Map<string, T>,
        key: string,
        value: T | undefined,
      ): void => {
        if (value === undefined) Map.prototype.delete.call(map, key);
        else Map.prototype.set.call(map, key, value);
      };
      restore(this.tasks, taskKey, previousTask);
      effectKeys.forEach((key, index) =>
        restore(this.taskEffects, key, previousEffects[index]),
      );
      planKeys.forEach((key, index) =>
        restore(this.taskPresentations, key, previousPlans[index]),
      );
      deliveryKeys.forEach((key, index) =>
        restore(this.presentationDeliveries, key, previousDeliveries[index]),
      );
      restore(this.taskHistories, taskKey, previousHistory);
      this.taskEffectReceipts.delete(receiptKey);
      throw error;
    }
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

  private presentationPlanForTarget(target: PresentationDeliveryTarget):
    | {
        plan: TaskPresentationPlan | AttemptPresentationPlan;
        deliveryState: 'pending' | 'obsolete';
      }
    | undefined {
    if (target.source === 'task') {
      const record = this.taskPresentations.get(
        taskPresentationKey({
          tenantId: target.tenantId,
          task: target.task,
          operationId: target.operationId,
        }),
      );
      return record === undefined
        ? undefined
        : { plan: record.plan, deliveryState: record.deliveryState };
    }
    const record = this.attemptPresentations.get(
      attemptPresentationKey(
        target.tenantId,
        target.attemptId,
        target.operationId,
      ),
    );
    if (record === undefined || !same(record.plan.task, target.task)) {
      return undefined;
    }
    return { plan: record.plan, deliveryState: record.deliveryState };
  }

  private pendingPresentationDelivery(
    target: PresentationDeliveryTarget,
    plan: TaskPresentationPlan | AttemptPresentationPlan,
  ): StoredPresentationDeliveryRecord {
    return {
      source: target.source,
      tenantId: target.tenantId,
      task: clone(target.task),
      ...(target.source === 'attempt' ? { attemptId: target.attemptId } : {}),
      operationId: target.operationId,
      planDigest: presentationPlanDigest(plan),
      state: 'pending',
    };
  }

  private preflightNewPresentationDelivery(
    target: PresentationDeliveryTarget,
    plan: TaskPresentationPlan | AttemptPresentationPlan,
  ): StoredPresentationDeliveryRecord {
    const record = this.pendingPresentationDelivery(target, plan);
    if (this.presentationDeliveries.has(presentationDeliveryKey(target))) {
      throw new AuthorityConflict('Presentation delivery operation exists');
    }
    return record;
  }

  private assertPresentationDeliveryPlan(
    target: PresentationDeliveryTarget,
    plan: TaskPresentationPlan | AttemptPresentationPlan,
  ): StoredPresentationDeliveryRecord {
    const record = this.presentationDeliveries.get(
      presentationDeliveryKey(target),
    );
    if (
      record === undefined ||
      record.source !== target.source ||
      record.tenantId !== target.tenantId ||
      !same(record.task, target.task) ||
      record.attemptId !==
        (target.source === 'attempt' ? target.attemptId : undefined) ||
      record.operationId !== target.operationId ||
      record.planDigest !== presentationPlanDigest(plan)
    ) {
      throw new AuthorityConflict(
        'Presentation delivery does not match its immutable plan',
      );
    }
    return record;
  }

  private assertPresentationDeliveryReceipt(
    key: string,
    record: StoredPresentationDeliveryRecord,
  ): void {
    const receipt = this.presentationDeliveryReceipts.get(key);
    if (record.state === 'converged' || record.state === 'unknown') {
      if (
        receipt === undefined ||
        receipt.planDigest !== record.planDigest ||
        receipt.kind !== record.state ||
        receipt.receiptSha256 !== record.receiptSha256 ||
        receipt.resolvedAt !== record.resolvedAt ||
        !same(receipt.snapshot, publicPresentationDeliveryRecord(record))
      ) {
        throw new AuthorityConflict(
          'Presentation delivery receipt conflicts with live state',
        );
      }
      return;
    }
    if (receipt !== undefined) {
      throw new AuthorityConflict(
        'Nonterminal presentation delivery has a terminal receipt',
      );
    }
  }

  async readPresentationDelivery(
    input: PresentationDeliveryTarget,
  ): Promise<PresentationDeliveryRecord | undefined> {
    if (input.tenantId !== input.task.tenantId) {
      throw new AuthorityConflict('Presentation delivery tenant is invalid');
    }
    const value = this.presentationDeliveries.get(
      presentationDeliveryKey(input),
    );
    if (value === undefined) return undefined;
    const presentation = this.presentationPlanForTarget(input);
    if (presentation === undefined) {
      throw new AuthorityConflict('Presentation plan is unknown');
    }
    this.assertPresentationDeliveryPlan(input, presentation.plan);
    this.assertPresentationDeliveryReceipt(
      presentationDeliveryKey(input),
      value,
    );
    return publicPresentationDeliveryRecord(value);
  }

  async listPresentationDelivery(input: {
    tenantId: string;
    source?: PresentationDeliveryRecord['source'];
    task?: TaskAuthorityScope;
    attemptId?: string;
    state?: PresentationDeliveryRecord['state'];
  }): Promise<PresentationDeliveryRecord[]> {
    if (input.task !== undefined && input.tenantId !== input.task.tenantId) {
      throw new AuthorityConflict('Presentation delivery tenant is invalid');
    }
    return [...this.presentationDeliveries.values()]
      .filter(
        (record) =>
          record.tenantId === input.tenantId &&
          (input.source === undefined || record.source === input.source) &&
          (input.task === undefined || same(record.task, input.task)) &&
          (input.attemptId === undefined ||
            record.attemptId === input.attemptId) &&
          (input.state === undefined || record.state === input.state),
      )
      .map((record) => {
        const target: PresentationDeliveryTarget =
          record.source === 'task'
            ? {
                source: 'task',
                tenantId: record.tenantId,
                task: record.task,
                operationId: record.operationId,
              }
            : record.attemptId === undefined
              ? (() => {
                  throw new AuthorityConflict(
                    'Attempt delivery identity is incomplete',
                  );
                })()
              : {
                  source: 'attempt',
                  tenantId: record.tenantId,
                  task: record.task,
                  attemptId: record.attemptId,
                  operationId: record.operationId,
                };
        const presentation = this.presentationPlanForTarget(target);
        if (presentation === undefined) {
          throw new AuthorityConflict('Presentation plan is unknown');
        }
        this.assertPresentationDeliveryPlan(target, presentation.plan);
        this.assertPresentationDeliveryReceipt(
          presentationDeliveryKey(target),
          record,
        );
        return publicPresentationDeliveryRecord(record);
      });
  }

  async claimPresentationDelivery(input: {
    lease: TaskAuthorityLease;
    target: PresentationDeliveryTarget;
  }): Promise<PresentationDeliveryClaim> {
    const { target } = input;
    const now = this.now();
    this.assertLease(input.lease, target.task, now);
    if (target.tenantId !== target.task.tenantId) {
      throw new AuthorityConflict('Presentation delivery tenant is invalid');
    }
    const presentation = this.presentationPlanForTarget(target);
    if (presentation === undefined) {
      throw new AuthorityConflict('Presentation plan is unknown');
    }
    const current = this.assertPresentationDeliveryPlan(
      target,
      presentation.plan,
    );
    if (presentation.deliveryState === 'obsolete') {
      if (current.state !== 'obsolete') {
        throw new AuthorityConflict(
          'Obsolete presentation has active delivery work',
        );
      }
      return {
        status: 'terminal',
        record: publicPresentationDeliveryRecord(current),
      };
    }
    if (
      current.state === 'converged' ||
      current.state === 'unknown' ||
      current.state === 'obsolete'
    ) {
      this.assertPresentationDeliveryReceipt(
        presentationDeliveryKey(target),
        current,
      );
      return {
        status: 'terminal',
        record: publicPresentationDeliveryRecord(current),
      };
    }
    if (current.state === 'in-flight') {
      if (current.claimedFence === input.lease.fence) {
        return {
          status: 'replay',
          record: publicPresentationDeliveryRecord(current),
        };
      }
      if ((current.claimedFence ?? -1) > input.lease.fence) {
        throw new AuthorityConflict(
          'Presentation delivery is claimed by a later fence',
        );
      }
      const receiptSha256 = createHash('sha256')
        .update(
          canonicalJson({
            source: current.source,
            tenantId: current.tenantId,
            attemptId: current.attemptId,
            operationId: current.operationId,
            planDigest: current.planDigest,
            kind: 'abandoned-in-flight',
          }),
        )
        .digest('hex');
      const unknown: StoredPresentationDeliveryRecord = {
        ...current,
        state: 'unknown',
        claimedFence: input.lease.fence,
        claimTokenSha256: undefined,
        receiptSha256,
        resolvedAt: now,
      };
      this.presentationDeliveries.set(
        presentationDeliveryKey(target),
        clone(unknown),
      );
      this.presentationDeliveryReceipts.set(presentationDeliveryKey(target), {
        planDigest: unknown.planDigest,
        kind: 'unknown',
        receiptSha256,
        resolvedAt: now,
        snapshot: publicPresentationDeliveryRecord(unknown),
      });
      return {
        status: 'terminal',
        record: publicPresentationDeliveryRecord(unknown),
      };
    }
    const claimToken = randomUUID();
    const claimed: StoredPresentationDeliveryRecord = {
      ...current,
      state: 'in-flight',
      claimedFence: input.lease.fence,
      claimTokenSha256: presentationClaimTokenDigest(claimToken),
    };
    const workInput: VerifiedClaimedPresentationWork =
      target.source === 'task'
        ? {
            source: 'task',
            tenantId: target.tenantId,
            repositoryId: target.task.repositoryId,
            issueNumber: target.task.issueNumber,
            operationId: target.operationId,
            planDigest: claimed.planDigest,
            claimFence: input.lease.fence,
            claimToken,
            permission: 'submit',
            plan: clone(presentation.plan as TaskPresentationPlan),
          }
        : {
            source: 'attempt',
            tenantId: target.tenantId,
            repositoryId: target.task.repositoryId,
            issueNumber: target.task.issueNumber,
            attemptId: target.attemptId,
            operationId: target.operationId,
            planDigest: claimed.planDigest,
            claimFence: input.lease.fence,
            claimToken,
            permission: 'submit',
            plan: clone(presentation.plan as AttemptPresentationPlan),
          };
    this.presentationDeliveries.set(
      presentationDeliveryKey(target),
      clone(claimed),
    );
    let work: VerifiedClaimedPresentationWork;
    try {
      work = mintClaimedPresentationWork(workInput);
    } catch (error) {
      this.presentationDeliveries.set(
        presentationDeliveryKey(target),
        clone(current),
      );
      throw error;
    }
    return {
      status: 'claimed',
      record: publicPresentationDeliveryRecord(claimed),
      work,
    };
  }

  async resolveVerifiedPresentationDelivery(input: {
    lease: TaskAuthorityLease;
    resolution: VerifiedPresentationResolution;
  }): Promise<'applied' | 'replay'> {
    if (!isVerifiedPresentationResolution(input.resolution)) {
      throw new AuthorityConflict('Presentation resolution is not trusted');
    }
    const { resolution } = input;
    const { work } = resolution;
    const target: PresentationDeliveryTarget =
      work.source === 'task'
        ? {
            source: 'task',
            tenantId: work.tenantId,
            task: clone(work.plan.task),
            operationId: work.operationId,
          }
        : {
            source: 'attempt',
            tenantId: work.tenantId,
            task: clone(work.plan.task),
            attemptId: work.attemptId,
            operationId: work.operationId,
          };
    // A known response may arrive after expiry, but only while the original
    // claim remains the latest durable fence. Any takeover replaces the lease
    // and makes the sealed result stale.
    this.assertCurrentClaimLease(input.lease, target.task);
    const presentation = this.presentationPlanForTarget(target);
    if (presentation === undefined) {
      throw new AuthorityConflict('Presentation plan is unknown');
    }
    const key = presentationDeliveryKey(target);
    const current = this.assertPresentationDeliveryPlan(
      target,
      presentation.plan,
    );
    const prior = this.presentationDeliveryReceipts.get(key);
    if (prior !== undefined) {
      if (
        prior.planDigest !== work.planDigest ||
        prior.kind !== resolution.kind ||
        prior.receiptSha256 !== resolution.receiptSha256 ||
        prior.resolvedAt !== resolution.resolvedAt ||
        current.claimedFence !== work.claimFence ||
        work.claimFence !== input.lease.fence ||
        current.claimTokenSha256 !==
          presentationClaimTokenDigest(work.claimToken) ||
        !same(work.plan, presentation.plan) ||
        !same(prior.snapshot, publicPresentationDeliveryRecord(current))
      ) {
        throw new AuthorityConflict('Presentation resolution replay conflicts');
      }
      return 'replay';
    }
    if (
      current.state !== 'in-flight' ||
      current.claimedFence !== input.lease.fence ||
      work.claimFence !== input.lease.fence ||
      current.claimTokenSha256 !==
        presentationClaimTokenDigest(work.claimToken) ||
      current.planDigest !== work.planDigest ||
      !same(work.plan, presentation.plan)
    ) {
      throw new AuthorityConflict(
        'Presentation resolution does not own the in-flight work',
      );
    }
    const next: StoredPresentationDeliveryRecord = {
      ...current,
      state: resolution.kind,
      receiptSha256: resolution.receiptSha256,
      resolvedAt: resolution.resolvedAt,
    };
    this.presentationDeliveries.set(key, clone(next));
    this.presentationDeliveryReceipts.set(key, {
      planDigest: next.planDigest,
      kind: resolution.kind,
      receiptSha256: resolution.receiptSha256,
      resolvedAt: resolution.resolvedAt,
      snapshot: publicPresentationDeliveryRecord(next),
    });
    return 'applied';
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
    this.preflightNewPresentationDelivery(
      attemptDeliveryTarget(presentation.record),
      presentation.record.plan,
    );
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
    const target = attemptDeliveryTarget(presentation.record);
    this.presentationDeliveries.set(
      presentationDeliveryKey(target),
      this.pendingPresentationDelivery(target, presentation.record.plan),
    );
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
    this.assertPresentationDeliveryPlan(
      attemptDeliveryTarget(expected.record),
      expected.record.plan,
    );
  }

  private assertCancellationReceiptIntegrity(
    identity: Pick<
      VerifiedCancellationEffect,
      'tenantId' | 'task' | 'sourceFactId' | 'effectKey'
    >,
    effect: TaskEffectRecord,
    receipt: StoredCancellationReceipt,
  ): void {
    const result = receipt.result;
    if (!same(result.effect, effect)) {
      throw new AuthorityConflict('Cancellation effect receipt conflicts');
    }
    if (effect.payload.kind !== 'cancel-or-drain') {
      if (
        result.attempt !== undefined ||
        result.work !== undefined ||
        result.presentation !== undefined
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
      result.attempt === undefined ||
      liveAttempt.spec.tenant.tenantId !== identity.tenantId ||
      !same(liveAttempt.spec.task, identity.task) ||
      liveAttempt.spec.local.intentId !== effect.payload.intentId ||
      liveAttempt.spec.local.generation !== effect.payload.intentRevision ||
      !same(result.attempt.spec, liveAttempt.spec) ||
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
    const history = this.attemptHistories.get(effect.payload.attemptId);
    const storedHistoryReceipt = receipt.history;
    const resultCommand = result.attempt?.commands.find(
      (candidate) => candidate.eventId === eventId,
    );
    if (history !== undefined)
      this.assertStoredAttemptHistoryIntegrity(history, liveAttempt);
    if (
      history !== undefined &&
      resultCommand !== undefined &&
      storedHistoryReceipt === undefined
    ) {
      throw new AuthorityConflict(
        'Cancellation receipt is missing history references',
      );
    }
    if (storedHistoryReceipt !== undefined) {
      if (history === undefined) {
        throw new AuthorityConflict('Cancellation history receipt is orphaned');
      }
      const historyIdentity = {
        tenantId:
          effect.payload.attemptId === liveAttempt.spec.attemptId
            ? liveAttempt.spec.tenant.tenantId
            : identity.tenantId,
        attemptId: effect.payload.attemptId,
      };
      const commandEntry = history.records
        .get('command')
        ?.find(({ record }) =>
          same(
            attemptHistoryRecordReference(record, historyIdentity, 'command'),
            storedHistoryReceipt.commandRef,
          ),
        );
      if (commandEntry === undefined || resultCommand === undefined) {
        throw new AuthorityConflict(
          'Cancellation command reference is missing',
        );
      }
      const payload = verifyAttemptHistoryPayload(
        'command',
        commandEntry.record,
        commandEntry.payload,
        historyIdentity,
      ).payload as {
        canonicalDigest: string;
        payload: {
          kind: 'request-cancel' | 'cancel-unlaunched';
          commandId: string;
          supersededByIntentId?: string;
          outcome?: AttemptState['outcome'];
        };
      };
      const expectedEvent =
        payload.payload.kind === 'cancel-unlaunched'
          ? {
              kind: 'cancel-unlaunched' as const,
              eventId,
              ...(payload.payload.supersededByIntentId === undefined
                ? {}
                : {
                    supersededByIntentId: payload.payload.supersededByIntentId,
                  }),
              outcome: payload.payload.outcome as NonNullable<
                AttemptState['outcome']
              >,
            }
          : {
              kind: 'request-cancel' as const,
              eventId,
              ...(payload.payload.supersededByIntentId === undefined
                ? {}
                : {
                    supersededByIntentId: payload.payload.supersededByIntentId,
                  }),
            };
      if (
        payload.payload.commandId !== eventId ||
        payload.canonicalDigest !== attemptTransitionDigest(expectedEvent)
      ) {
        throw new AuthorityConflict('Cancellation command reference conflicts');
      }
      const evidenceRef = storedHistoryReceipt.evidenceRef;
      if (
        payload.payload.kind === 'request-cancel' &&
        evidenceRef !== undefined
      ) {
        throw new AuthorityConflict(
          'Request cancellation receipt contains outcome reference',
        );
      }
      if (
        payload.payload.kind === 'cancel-unlaunched' &&
        evidenceRef === undefined
      ) {
        throw new AuthorityConflict(
          'Cancellation receipt is missing outcome reference',
        );
      }
      if (evidenceRef !== undefined) {
        const evidenceEntry = history.records
          .get('evidence')
          ?.find(({ record }) =>
            same(
              attemptHistoryRecordReference(
                record,
                historyIdentity,
                'evidence',
              ),
              evidenceRef,
            ),
          );
        const evidence =
          evidenceEntry === undefined
            ? undefined
            : (verifyAttemptHistoryPayload(
                'evidence',
                evidenceEntry.record,
                evidenceEntry.payload,
                historyIdentity,
              ).payload as {
                finalizeCommandRef: HistoryRecordReference;
                outcomeDigest: string;
              });
        if (
          evidence === undefined ||
          !same(evidence.finalizeCommandRef, storedHistoryReceipt.commandRef) ||
          evidence.outcomeDigest !==
            attemptHistoryPayloadDigest(result.attempt?.outcome)
        ) {
          throw new AuthorityConflict(
            'Cancellation evidence reference conflicts',
          );
        }
      }
    }
    const receiptIsDirectTerminal =
      result.attempt.phase === 'terminal' &&
      result.attempt.outcome?.execution === 'not_started' &&
      result.attempt.outcome.evidence.kind === 'lifecycle-decision' &&
      result.attempt.outcome.evidence.decisionFactId === eventId;
    const liveIsDirectTerminal =
      liveAttempt.phase === 'terminal' &&
      liveAttempt.outcome?.execution === 'not_started' &&
      liveAttempt.outcome.evidence.kind === 'lifecycle-decision' &&
      liveAttempt.outcome.evidence.decisionFactId === eventId;
    if (result.presentation === undefined) {
      if (receiptIsDirectTerminal) {
        throw new AuthorityConflict(
          'Direct cancellation terminal receipt is missing its presentation',
        );
      }
      if (result.attempt.phase === 'terminal') {
        if (!same(result.attempt, liveAttempt)) {
          throw new AuthorityConflict(
            'Terminal cancellation no-op receipt conflicts with the live Attempt',
          );
        }
        return;
      }
      const receiptCommand = result.attempt.commands.find(
        (command) => command.eventId === eventId,
      );
      const liveCommand = liveAttempt.commands.find(
        (command) => command.eventId === eventId,
      );
      if (
        result.attempt.cancellation?.eventId !== eventId ||
        liveAttempt.cancellation?.eventId !== eventId ||
        !result.attempt.futureGrantsDenied ||
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
      !same(result.attempt, liveAttempt) ||
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
    if (!same(result.presentation, expected.record)) {
      throw new AuthorityConflict(
        'Cancellation presentation snapshot conflicts',
      );
    }
  }

  private assertLaunchResolutionHistoryReceipt(
    history: StoredAttemptHistory,
    attempt: AttemptState,
    event: Extract<
      AttemptEvent,
      { kind: 'launch-accepted' | 'launch-response-unknown' }
    >,
    receipt: StoredLaunchResolutionReceipt,
  ): void {
    this.assertStoredAttemptHistoryIntegrity(history, attempt);
    const identity = {
      tenantId: attempt.spec.tenant.tenantId,
      attemptId: attempt.spec.attemptId,
    };
    const ref = receipt.history?.commandRef;
    if (ref === undefined) {
      throw new AuthorityConflict(
        'Launch resolution history reference is missing',
      );
    }
    const entry = history.records
      .get('command')
      ?.find(({ record }) =>
        same(attemptHistoryRecordReference(record, identity, 'command'), ref),
      );
    if (entry === undefined) {
      throw new AuthorityConflict(
        'Launch resolution history reference is missing',
      );
    }
    const payload = verifyAttemptHistoryPayload(
      'command',
      entry.record,
      entry.payload,
      identity,
    ).payload as {
      schema: 'agent-lcars.attempt-command/v1';
      canonicalDigest: string;
      payload: {
        kind: 'launch-accepted' | 'launch-response-unknown';
        commandId: string;
      };
    };
    const expectedEventId = launchResolutionEventId({
      attemptId: attempt.spec.attemptId,
      operationId: attempt.launch.operationId,
      executionEpoch: attempt.executionEpoch,
      kind: event.kind === 'launch-accepted' ? 'accepted' : 'unknown',
    });
    if (
      payload.payload.kind !== event.kind ||
      payload.payload.commandId !== event.eventId ||
      payload.payload.commandId !== expectedEventId ||
      payload.canonicalDigest !== attemptTransitionDigest(event) ||
      !attempt.commands.some(
        (command) =>
          command.eventId === event.eventId &&
          command.canonicalDigest === attemptTransitionDigest(event),
      ) ||
      !same(
        attemptHistoryRecordReference(entry.record, identity, 'command'),
        ref,
      )
    ) {
      throw new AuthorityConflict(
        'Launch resolution history reference conflicts with legacy state',
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
      return clone(receipt.result);
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
      this.cancellationReceipts.set(taskEffectKey(command), {
        result: clone(result),
      });
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
    const localKey = tupleKey(
      attempt.spec.task.tenantId,
      attempt.spec.task.repositoryId,
      attempt.spec.task.issueNumber,
      attempt.spec.local.intentId,
      attempt.spec.local.generation,
    );
    const existingHistory = this.attemptHistories.get(target.attemptId);
    const admissionHistoryReceipt =
      this.attemptAdmissionHistoryReceipts.get(localKey);
    const hasAdmissionLineage =
      admissionHistoryReceipt !== undefined || existingHistory !== undefined;
    if (hasAdmissionLineage) {
      const acceptance = this.acceptances.get(localKey);
      const taskHistory = this.taskHistories.get(
        canonicalTaskKey(attempt.spec.task),
      );
      if (
        acceptance === undefined ||
        admissionHistoryReceipt === undefined ||
        existingHistory === undefined ||
        taskHistory === undefined ||
        acceptance.attemptId !== target.attemptId ||
        acceptance.specDigest !== attempt.specDigest ||
        admissionHistoryReceipt.attemptId !== target.attemptId ||
        admissionHistoryReceipt.tenantId !== attempt.spec.tenant.tenantId ||
        !same(admissionHistoryReceipt.task, attempt.spec.task) ||
        admissionHistoryReceipt.specDigest !== attempt.specDigest
      ) {
        throw new AuthorityConflict(
          'Attempt admission history lineage is invalid',
        );
      }
      this.assertStoredTaskHistoryIntegrity(attempt.spec.task, taskHistory);
      this.assertStoredAttemptHistoryIntegrity(existingHistory, attempt);
      this.assertStoredAttemptAdmissionHistoryReceipt({
        receipt: admissionHistoryReceipt,
        taskHistory,
        attemptHistory: existingHistory,
        attempt,
      });
    }
    if (
      existingHistory !== undefined &&
      existingHistory.head.cancellation === undefined &&
      attempt.cancellation !== undefined &&
      attempt.phase !== 'terminal'
    ) {
      throw new AuthorityConflict(
        'Attempt cancellation history is missing before a new cancellation',
      );
    }
    const eventId = cancellationEventId(command, target);
    if (attempt.phase === 'terminal') {
      const next = { ...effect, deliveryState: 'complete' as const };
      this.taskEffects.set(taskEffectKey(command), clone(next));
      const result = { effect: clone(next), attempt: clone(attempt) };
      this.cancellationReceipts.set(taskEffectKey(command), {
        result: clone(result),
      });
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
        ...(target.supersededByIntentId === undefined
          ? {}
          : { supersededByIntentId: target.supersededByIntentId }),
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
    let nextHistory: StoredAttemptHistory | undefined;
    let historyReceipt: StoredCancellationReceipt['history'] | undefined;
    if (existingHistory !== undefined) {
      const commandPayload = {
        schema: 'agent-lcars.attempt-command/v1' as const,
        version: 1 as const,
        transitionedAt: command.at,
        canonicalDigest: attemptTransitionDigest(event),
        payload:
          event.kind === 'cancel-unlaunched'
            ? {
                kind: 'cancel-unlaunched' as const,
                commandId: event.eventId,
                ...(event.supersededByIntentId === undefined
                  ? {}
                  : { supersededByIntentId: event.supersededByIntentId }),
                outcomeDigest: attemptHistoryPayloadDigest(
                  reduced.state.outcome,
                ),
                outcome: reduced.state.outcome as NonNullable<
                  AttemptState['outcome']
                >,
              }
            : {
                kind: 'request-cancel' as const,
                commandId: event.eventId,
                ...(event.supersededByIntentId === undefined
                  ? {}
                  : { supersededByIntentId: event.supersededByIntentId }),
              },
      };
      try {
        const commandRecord = appendHistoryRecord({
          head: existingHistory.head.streams.command,
          payload: commandPayload,
          appliedRevision: reduced.state.revision,
        }).record;
        const emitted: Array<{
          stream: AttemptHistoryStream;
          payload: unknown;
        }> = [{ stream: 'command', payload: commandPayload }];
        let evidencePayload: unknown;
        if (event.kind === 'cancel-unlaunched') {
          evidencePayload = {
            schema: 'agent-lcars.attempt-evidence/v1' as const,
            version: 1 as const,
            finalizeCommandRef: attemptHistoryRecordReference(
              commandRecord,
              {
                tenantId: attempt.spec.tenant.tenantId,
                attemptId: attempt.spec.attemptId,
              },
              'command',
            ),
            claimRefs: [],
            validationRefs: [],
            outcomeDigest: attemptHistoryPayloadDigest(reduced.state.outcome),
            outcome: reduced.state.outcome as NonNullable<
              AttemptState['outcome']
            >,
            transitionedAt: command.at,
          };
          emitted.push({ stream: 'evidence', payload: evidencePayload });
        }
        const transition = appendAttemptHistoryTransition({
          head: existingHistory.head,
          nextRevision: reduced.state.revision,
          transitionedAt: command.at,
          emitted,
        });
        const records = new Map(existingHistory.records);
        const payloadsByStream = new Map<AttemptHistoryStream, unknown[]>();
        for (const emission of emitted) {
          const payloads = payloadsByStream.get(emission.stream) ?? [];
          payloads.push(emission.payload);
          payloadsByStream.set(emission.stream, payloads);
        }
        for (const entry of transition.records) {
          const stream = entry.streamKind as AttemptHistoryStream;
          const payloads = payloadsByStream.get(stream);
          const payload = payloads?.shift();
          if (payload === undefined) {
            throw new AuthorityConflict(
              'Cancellation history record payload is missing',
            );
          }
          records.set(stream, [
            ...(existingHistory.records.get(stream) ?? []),
            { record: clone(entry), payload: clone(payload) },
          ]);
        }
        const commandRef = attemptHistoryRecordReference(
          transition.records.find(
            (record) => record.streamKind === 'command',
          ) as HistoryRecord,
          {
            tenantId: attempt.spec.tenant.tenantId,
            attemptId: attempt.spec.attemptId,
          },
          'command',
        );
        const evidenceRecord = transition.records.find(
          (record) => record.streamKind === 'evidence',
        );
        historyReceipt = {
          commandRef,
          ...(evidenceRecord === undefined
            ? {}
            : {
                evidenceRef: attemptHistoryRecordReference(
                  evidenceRecord,
                  {
                    tenantId: attempt.spec.tenant.tenantId,
                    attemptId: attempt.spec.attemptId,
                  },
                  'evidence',
                ),
              }),
        };
        nextHistory = {
          head: clone(transition.head),
          records,
        };
      } catch {
        throw new AuthorityConflict(
          'Cancellation history transition is invalid',
        );
      }
    }
    const effectKey = taskEffectKey(command);
    const workKey = tupleKey(command.tenantId, target.attemptId, eventId);
    const presentationKey = presentation?.key;
    const presentationReceiptKey = presentation?.receiptKey;
    const deliveryKey = presentation
      ? presentationDeliveryKey(attemptDeliveryTarget(presentation.record))
      : undefined;
    const restore = <T>(
      map: Map<string, T>,
      key: string,
      value: T | undefined,
    ): void => {
      if (value === undefined) Map.prototype.delete.call(map, key);
      else Map.prototype.set.call(map, key, value);
    };
    const previousAttempt = this.attempts.get(target.attemptId);
    const previousLaunch = this.launches.get(target.attemptId);
    const previousWork = this.cancellationWork.get(workKey);
    const previousEffect = this.taskEffects.get(effectKey);
    const previousReceipt = this.cancellationReceipts.get(effectKey);
    const previousHistory = this.attemptHistories.get(target.attemptId);
    const previousOutcome = this.outcomes.get(target.attemptId);
    const previousPresentation =
      presentationKey === undefined
        ? undefined
        : this.attemptPresentations.get(presentationKey);
    const previousPresentationReceipt =
      presentationReceiptKey === undefined
        ? undefined
        : this.attemptPresentationReceipts.get(presentationReceiptKey);
    const previousDelivery =
      deliveryKey === undefined
        ? undefined
        : this.presentationDeliveries.get(deliveryKey);
    const completed = { ...effect, deliveryState: 'complete' as const };
    const result: CancellationEffectResult = {
      effect: clone(completed),
      attempt: clone(reduced.state),
      ...(work === undefined ? {} : { work: clone(work) }),
      ...(presentation === undefined
        ? {}
        : { presentation: clone(presentation.record) }),
    };
    try {
      this.writeAttemptTransaction({
        lease: input.lease,
        expectedRevision: attempt.revision,
        next: reduced.state,
      });
      if (presentation !== undefined)
        this.persistAttemptPresentation(presentation);
      if (suppressed)
        this.launches.set(target.attemptId, { ...launch, state: 'suppressed' });
      if (work !== undefined) this.cancellationWork.set(workKey, clone(work));
      this.taskEffects.set(effectKey, clone(completed));
      this.cancellationReceipts.set(effectKey, {
        result: clone(result),
        ...(historyReceipt === undefined
          ? {}
          : { history: clone(historyReceipt) }),
      });
      if (nextHistory !== undefined)
        this.attemptHistories.set(target.attemptId, nextHistory);
      return result;
    } catch (error) {
      restore(this.attempts, target.attemptId, previousAttempt);
      restore(this.launches, target.attemptId, previousLaunch);
      restore(this.cancellationWork, workKey, previousWork);
      restore(this.taskEffects, effectKey, previousEffect);
      restore(this.cancellationReceipts, effectKey, previousReceipt);
      restore(this.attemptHistories, target.attemptId, previousHistory);
      restore(this.outcomes, target.attemptId, previousOutcome);
      if (presentationKey !== undefined)
        restore(
          this.attemptPresentations,
          presentationKey,
          previousPresentation,
        );
      if (presentationReceiptKey !== undefined)
        restore(
          this.attemptPresentationReceipts,
          presentationReceiptKey,
          previousPresentationReceipt,
        );
      if (deliveryKey !== undefined)
        restore(this.presentationDeliveries, deliveryKey, previousDelivery);
      throw error;
    }
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
    return receipt === undefined ? undefined : clone(receipt.result);
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
        accepted.specDigest !== (attempt?.specDigest ?? '') ||
        accepted.taskSnapshotDigest !== taskSnapshotDigest(accepted.task) ||
        attempt === undefined ||
        launch === undefined ||
        launch.tenantId !== attempt.spec.tenant.tenantId ||
        launch.repositoryId !== attempt.spec.tenant.repositoryId ||
        launch.issueNumber !== attempt.spec.task.issueNumber ||
        launch.attemptId !== attempt.spec.attemptId ||
        launch.operationId !== attempt.launch.operationId ||
        launch.executionEpoch !== attempt.executionEpoch ||
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
      const history = this.taskHistories.get(canonicalTaskKey(admission.task));
      if (history === undefined) {
        throw new AuthorityConflict(
          'Task history admission receipt is missing',
        );
      }
      this.assertStoredTaskHistoryIntegrity(admission.task, history);
      const attemptHistory = this.attemptHistories.get(accepted.attemptId);
      if (attemptHistory === undefined) {
        throw new AuthorityConflict(
          'Attempt history admission receipt is missing',
        );
      }
      this.assertStoredAttemptHistoryIntegrity(
        attemptHistory,
        attempt as AttemptState,
      );
      const historyReceipt = this.attemptAdmissionHistoryReceipts.get(localKey);
      if (
        historyReceipt === undefined ||
        historyReceipt.attemptId !== accepted.attemptId ||
        historyReceipt.tenantId !== admission.tenant.tenantId ||
        !same(historyReceipt.task, admission.task) ||
        historyReceipt.intentId !== admission.intentId ||
        historyReceipt.intentRevision !== admission.intentRevision ||
        historyReceipt.taskRevision !== accepted.task.revision ||
        historyReceipt.specDigest !== attempt.specDigest ||
        accepted.specDigest !== attempt.specDigest ||
        historyReceipt.taskSnapshotDigest !==
          taskSnapshotDigest(accepted.task) ||
        historyReceipt.admissionDigest !== commandDigest ||
        attemptHistory.head.updatedAt !== historyReceipt.admittedAt
      ) {
        throw new AuthorityConflict(
          'Task admission history receipt is invalid',
        );
      }
      this.assertStoredAttemptAdmissionHistoryReceipt({
        receipt: historyReceipt,
        taskHistory: history,
        attemptHistory,
        attempt,
      });
      const acceptedAttempt = accepted.task.attempt;
      const headAttempt = history.head.attempt;
      if (
        history.head.aggregateRevision < accepted.task.revision ||
        (history.head.aggregateRevision === accepted.task.revision &&
          (acceptedAttempt.kind !== 'launched' ||
            headAttempt.kind !== 'launched' ||
            headAttempt.attemptId !== acceptedAttempt.attemptId ||
            headAttempt.intentId !== acceptedAttempt.intentId ||
            headAttempt.intentRevision !== acceptedAttempt.intentRevision ||
            headAttempt.admissionRevision !==
              acceptedAttempt.admissionRevision ||
            headAttempt.admittedAt !== acceptedAttempt.admittedAt))
      ) {
        throw new AuthorityConflict('Task history admission attempt conflicts');
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
    let attemptHistory: StoredAttemptHistory;
    try {
      const registration = registerAttemptHistory({
        tenantId: spec.tenant.tenantId,
        attemptId: spec.attemptId,
        spec,
        specDigest,
        updatedAt: now,
      });
      const records = new Map<
        AttemptHistoryStream,
        StoredAttemptHistoryRecord[]
      >();
      for (const stream of [
        'fact',
        'command',
        'claim',
        'validation',
        'evidence',
      ] as const) {
        records.set(stream, []);
      }
      const commandRecord = registration.records[0];
      if (commandRecord === undefined) {
        throw new AuthorityConflict('Attempt registration history is empty');
      }
      records.set('command', [
        {
          record: clone(commandRecord),
          payload: clone({
            schema: 'agent-lcars.attempt-command/v1',
            version: 1,
            transitionedAt: now,
            canonicalDigest: attemptHistoryTransitionDigest({
              kind: 'register',
              expectedRevision: 0,
              transitionedAt: now,
              spec,
              specDigest,
            }),
            payload: {
              kind: 'attempt-registered',
              commandId: spec.attemptId,
              specDigest,
            },
          }),
        },
      ]);
      attemptHistory = { head: clone(registration.head), records };
      this.assertStoredAttemptHistoryIntegrity(attemptHistory, attempt.state);
    } catch (error) {
      if (error instanceof AuthorityConflict) throw error;
      throw new AuthorityConflict('Attempt registration history is invalid');
    }
    const taskKey = canonicalTaskKey(admission.task);
    const existingHistory = this.taskHistories.get(taskKey);
    if (existingHistory !== undefined) {
      this.assertStoredTaskHistoryIntegrity(admission.task, existingHistory);
    }
    const admissionHistory =
      existingHistory === undefined
        ? this.makeLegacyTaskHistory(current)
        : clone(existingHistory);
    const registrationRecord = attemptHistory.records.get('command')?.[0];
    const commandHead = admissionHistory.auxHeads.get('command');
    if (registrationRecord === undefined || commandHead === undefined) {
      throw new AuthorityConflict(
        'Admission history command stream is missing',
      );
    }
    let admissionTransition: ReturnType<
      typeof appendTaskAttemptAdmissionHistoryTransition
    >;
    const admissionPayload = {
      schema: 'agent-lcars.task-attempt-admission-history/v1' as const,
      version: 1 as const,
      tenant: clone(admission.tenant),
      task: clone(admission.task),
      intentId: admission.intentId,
      intentRevision: admission.intentRevision,
      attemptId,
      admissionRevision: admission.expectedTaskRevision,
      admittedAt: now,
      taskSnapshotDigest: taskSnapshotDigest(task.state),
      inputDigest: commandDigest,
      specDigest,
      attemptRegistrationRef: attemptHistoryRecordReference(
        registrationRecord.record,
        { tenantId: admission.tenant.tenantId, attemptId },
        'command',
      ),
    };
    try {
      admissionTransition = appendTaskAttemptAdmissionHistoryTransition({
        head: admissionHistory.head,
        workHead: commandHead,
        payload: admissionPayload,
      });
      admissionHistory.head = admissionTransition.head;
      admissionHistory.auxHeads.set('command', admissionTransition.workHead);
      admissionHistory.workRecords.push({
        record: admissionTransition.workRecord,
        payload: clone(admissionPayload),
      });
    } catch {
      throw new AuthorityConflict(
        'Task admission history transition is invalid',
      );
    }
    // All validation completed above; this contiguous body is the transaction.
    const previousTask = this.tasks.get(taskKey);
    const previousAttempt = this.attempts.get(attemptId);
    const previousAcceptance = this.acceptances.get(localKey);
    const previousAdmissionHistoryReceipt =
      this.attemptAdmissionHistoryReceipts.get(localKey);
    const previousLaunch = this.launches.get(attemptId);
    const previousHistory = this.taskHistories.get(taskKey);
    const previousAttemptHistory = this.attemptHistories.get(attemptId);
    const restore = <T>(
      map: Map<string, T>,
      key: string,
      value: T | undefined,
    ): void => {
      if (value === undefined) Map.prototype.delete.call(map, key);
      else Map.prototype.set.call(map, key, value);
    };
    try {
      this.tasks.set(taskKey, clone(task.state));
      this.attempts.set(attemptId, clone(attempt.state));
      this.acceptances.set(localKey, {
        attemptId,
        specDigest,
        admissionDigest: commandDigest,
        taskSnapshotDigest: taskSnapshotDigest(task.state),
        task: clone(task.state),
      });
      this.attemptAdmissionHistoryReceipts.set(localKey, {
        tenantId: admission.tenant.tenantId,
        tenant: clone(admission.tenant),
        task: clone(admission.task),
        intentId: admission.intentId,
        intentRevision: admission.intentRevision,
        taskRevision: task.state.revision,
        attemptId,
        admittedAt: now,
        specDigest,
        admissionDigest: commandDigest,
        taskSnapshotDigest: taskSnapshotDigest(task.state),
        taskAdmissionRecordRef: clone(admissionTransition.workRecordRef),
        attemptRegistrationRecordRef: clone(
          admissionPayload.attemptRegistrationRef,
        ),
      });
      this.launches.set(attemptId, clone(launch));
      this.taskHistories.set(taskKey, clone(admissionHistory));
      this.attemptHistories.set(attemptId, clone(attemptHistory));
    } catch (error) {
      restore(this.tasks, taskKey, previousTask);
      restore(this.attempts, attemptId, previousAttempt);
      restore(this.acceptances, localKey, previousAcceptance);
      restore(
        this.attemptAdmissionHistoryReceipts,
        localKey,
        previousAdmissionHistoryReceipt,
      );
      restore(this.launches, attemptId, previousLaunch);
      restore(this.taskHistories, taskKey, previousHistory);
      restore(this.attemptHistories, attemptId, previousAttemptHistory);
      throw error;
    }
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
      attempt.spec.local.generation !== input.intentRevision ||
      launch.tenantId !== attempt.spec.tenant.tenantId ||
      launch.repositoryId !== attempt.spec.tenant.repositoryId ||
      launch.issueNumber !== attempt.spec.task.issueNumber ||
      launch.attemptId !== attempt.spec.attemptId ||
      launch.operationId !== attempt.launch.operationId ||
      launch.executionEpoch !== attempt.executionEpoch
    ) {
      throw new AuthorityConflict('Admission replay receipt is inconsistent');
    }
    const taskHistory = this.taskHistories.get(canonicalTaskKey(input.task));
    if (taskHistory === undefined) {
      throw new AuthorityConflict('Task history replay receipt is missing');
    }
    this.assertStoredTaskHistoryIntegrity(input.task, taskHistory);
    if (
      accepted.task.attempt.kind !== 'launched' ||
      accepted.task.attempt.attemptId !== accepted.attemptId ||
      accepted.task.attempt.intentId !== input.intentId ||
      accepted.task.attempt.intentRevision !== input.intentRevision ||
      accepted.task.attempt.admissionRevision !==
        (this.attemptAdmissionHistoryReceipts.get(key)?.taskRevision ?? 0) -
          1 ||
      accepted.task.attempt.admittedAt !==
        this.attemptAdmissionHistoryReceipts.get(key)?.admittedAt ||
      launch.operationId !== accepted.attemptId ||
      launch.attemptId !== accepted.attemptId
    ) {
      throw new AuthorityConflict('Task admission replay pointer is invalid');
    }
    const attemptHistory = this.attemptHistories.get(accepted.attemptId);
    if (attemptHistory === undefined) {
      throw new AuthorityConflict('Attempt history replay receipt is missing');
    }
    this.assertStoredAttemptHistoryIntegrity(attemptHistory, attempt);
    const historyReceipt = this.attemptAdmissionHistoryReceipts.get(key);
    if (
      historyReceipt === undefined ||
      historyReceipt.attemptId !== accepted.attemptId ||
      historyReceipt.tenantId !== input.tenantId ||
      !same(historyReceipt.task, input.task) ||
      historyReceipt.intentId !== input.intentId ||
      historyReceipt.intentRevision !== input.intentRevision ||
      historyReceipt.specDigest !== attempt.specDigest ||
      accepted.specDigest !== attempt.specDigest ||
      accepted.taskSnapshotDigest !== taskSnapshotDigest(accepted.task) ||
      historyReceipt.taskSnapshotDigest !== taskSnapshotDigest(accepted.task) ||
      historyReceipt.admissionDigest !== accepted.admissionDigest ||
      attemptHistory.head.updatedAt !== historyReceipt.admittedAt
    ) {
      throw new AuthorityConflict('Task admission history receipt is invalid');
    }
    this.assertStoredAttemptAdmissionHistoryReceipt({
      receipt: historyReceipt,
      taskHistory,
      attemptHistory,
      attempt,
    });
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
    this.assertFinalizationHistoryLineage(current);

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
        this.assertValidationHistoryReplay(current, event);
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
        this.assertValidationHistoryReplay(current, event);
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
    const validationHistory =
      event.kind === 'start-validation' || event.kind === 'validate-claim'
        ? this.appendValidationCommandHistory({
            attempt: current,
            next: reduced.state,
            event,
            transitionedAt: transition.at,
          })
        : undefined;
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
      if (observationIdentity !== undefined) {
        this.assertObservationReplay(observationIdentity);
        this.assertFinalizationObservationHistoryReplay(
          observationIdentity,
          current,
        );
      }
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
    const historyTransition =
      observation === undefined
        ? undefined
        : this.appendFinalizationObservationHistory({
            attempt: current,
            next: reduced.state,
            event: event as Extract<AttemptEvent, { kind: 'observation' }>,
            transitionedAt: transition.at,
          });
    const previousAttempt = this.attempts.get(current.spec.attemptId);
    const previousOutcome = this.outcomes.get(current.spec.attemptId);
    const previousHistory = this.attemptHistories.get(current.spec.attemptId);
    const validationReceiptKey =
      event.kind === 'start-validation' || event.kind === 'validate-claim'
        ? tupleKey(current.spec.attemptId, event.eventId)
        : undefined;
    const previousValidationReceipt =
      validationReceiptKey === undefined
        ? undefined
        : this.validationHistoryReceipts.get(validationReceiptKey);
    const previousFact =
      observationIdentity === undefined
        ? undefined
        : this.factKeys.get(observationKeys(observationIdentity).factKey);
    const previousRequest =
      observationIdentity === undefined
        ? undefined
        : this.requestKeys.get(observationKeys(observationIdentity).requestKey);
    const presentationKey = presentation?.key;
    const presentationReceiptKey = presentation?.receiptKey;
    const deliveryKey = presentation
      ? presentationDeliveryKey(attemptDeliveryTarget(presentation.record))
      : undefined;
    const previousPresentation =
      presentationKey === undefined
        ? undefined
        : this.attemptPresentations.get(presentationKey);
    const previousPresentationReceipt =
      presentationReceiptKey === undefined
        ? undefined
        : this.attemptPresentationReceipts.get(presentationReceiptKey);
    const previousDelivery =
      deliveryKey === undefined
        ? undefined
        : this.presentationDeliveries.get(deliveryKey);
    const previousWork = new Map<string, ValidationWorkRecord | undefined>();
    for (const effect of work) {
      const key = validationWorkKey(
        current.spec.tenant.tenantId,
        effect.attemptId,
        effect.terminalFactId,
        effect.claimFactId,
      );
      previousWork.set(key, this.validationWork.get(key));
    }
    if (transition.kind === 'validate-claim') {
      const terminalFactId = current.finalization?.terminalFactId;
      if (terminalFactId !== undefined) {
        const key = validationWorkKey(
          transition.tenantId,
          transition.attemptId,
          terminalFactId,
          transition.claimFactId,
        );
        previousWork.set(key, this.validationWork.get(key));
      }
    }
    const restore = <T>(
      map: Map<string, T>,
      key: string,
      value: T | undefined,
    ): void => {
      if (value === undefined) Map.prototype.delete.call(map, key);
      else Map.prototype.set.call(map, key, value);
    };
    try {
      this.writeAttemptTransaction({
        lease: input.lease,
        expectedRevision: current.revision,
        next: reduced.state,
      });
      if (presentation !== undefined)
        this.persistAttemptPresentation(presentation);
      if (observationIdentity !== undefined)
        this.persistObservation(
          observationIdentity,
          historyTransition?.factRef,
        );
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
      if (historyTransition !== undefined)
        this.attemptHistories.set(
          current.spec.attemptId,
          historyTransition.history,
        );
      if (validationHistory !== undefined) {
        this.attemptHistories.set(
          current.spec.attemptId,
          validationHistory.history,
        );
        if (validationReceiptKey === undefined) {
          throw new AuthorityConflict(
            'Validation history receipt key is absent',
          );
        }
        this.validationHistoryReceipts.set(
          validationReceiptKey,
          clone(validationHistory.receipt),
        );
      } else if (
        validationReceiptKey !== undefined &&
        previousValidationReceipt !== undefined
      ) {
        throw new AuthorityConflict('Validation history receipt is orphaned');
      }
    } catch (error) {
      restore(this.attempts, current.spec.attemptId, previousAttempt);
      restore(this.outcomes, current.spec.attemptId, previousOutcome);
      restore(this.attemptHistories, current.spec.attemptId, previousHistory);
      if (validationReceiptKey !== undefined)
        restore(
          this.validationHistoryReceipts,
          validationReceiptKey,
          previousValidationReceipt,
        );
      if (observationIdentity !== undefined) {
        const { factKey, requestKey } = observationKeys(observationIdentity);
        restore(this.factKeys, factKey, previousFact);
        restore(this.requestKeys, requestKey, previousRequest);
      }
      for (const [key, value] of previousWork)
        restore(this.validationWork, key, value);
      if (presentationKey !== undefined)
        restore(
          this.attemptPresentations,
          presentationKey,
          previousPresentation,
        );
      if (presentationReceiptKey !== undefined)
        restore(
          this.attemptPresentationReceipts,
          presentationReceiptKey,
          previousPresentationReceipt,
        );
      if (deliveryKey !== undefined)
        restore(this.presentationDeliveries, deliveryKey, previousDelivery);
      throw error;
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

  /**
   * Compatibility is only for Attempts created before history existed. Once
   * admission has durable lineage, a missing sibling is corruption, never a
   * reason to silently stop shadowing terminal evidence.
   */
  private assertFinalizationHistoryLineage(attempt: AttemptState): void {
    const localKey = tupleKey(
      attempt.spec.task.tenantId,
      attempt.spec.task.repositoryId,
      attempt.spec.task.issueNumber,
      attempt.spec.local.intentId,
      attempt.spec.local.generation,
    );
    const receipt = this.attemptAdmissionHistoryReceipts.get(localKey);
    const history = this.attemptHistories.get(attempt.spec.attemptId);
    if (receipt === undefined && history === undefined) return;
    const acceptance = this.acceptances.get(localKey);
    const taskHistory = this.taskHistories.get(
      canonicalTaskKey(attempt.spec.task),
    );
    if (
      receipt === undefined ||
      history === undefined ||
      acceptance === undefined ||
      taskHistory === undefined ||
      acceptance.attemptId !== attempt.spec.attemptId ||
      acceptance.specDigest !== attempt.specDigest ||
      receipt.attemptId !== attempt.spec.attemptId ||
      receipt.tenantId !== attempt.spec.tenant.tenantId ||
      !same(receipt.task, attempt.spec.task) ||
      receipt.specDigest !== attempt.specDigest
    ) {
      throw new AuthorityConflict(
        'Attempt admission history lineage is invalid',
      );
    }
    this.assertStoredTaskHistoryIntegrity(attempt.spec.task, taskHistory);
    this.assertStoredAttemptHistoryIntegrity(history, attempt);
    this.assertStoredAttemptAdmissionHistoryReceipt({
      receipt,
      taskHistory,
      attemptHistory: history,
      attempt,
    });
    this.assertValidationHistoryReceiptBijection(history, attempt);
    if (attempt.phase === 'validating') {
      this.assertValidationWorkForState(attempt);
    }
  }

  /**
   * The legacy reducer remains the source of truth.  When this Attempt has
   * history lineage, mirror a finalizer observation in the same durable
   * transition so the history head cannot get ahead of the legacy state.
   */
  private appendFinalizationObservationHistory(input: {
    attempt: AttemptState;
    next: AttemptState;
    event: Extract<AttemptEvent, { kind: 'observation' }>;
    transitionedAt: string;
  }):
    | {
        history: StoredAttemptHistory;
        factRef: HistoryRecordReference;
      }
    | undefined {
    const existing = this.attemptHistories.get(input.attempt.spec.attemptId);
    if (existing === undefined) return undefined;
    this.assertStoredAttemptHistoryIntegrity(existing, input.attempt);
    const envelope = input.event.envelope;
    const payload =
      envelope.payload.kind === 'run-terminal'
        ? {
            kind: 'run-terminal' as const,
            binding: envelope.payload.binding,
            conclusion: envelope.payload.conclusion,
            observedAt: envelope.payload.observedAt,
            finalizationDeadline: input.event.finalizationDeadline,
          }
        : envelope.payload.kind === 'agent-result-claim'
          ? {
              kind: 'agent-result-claim' as const,
              claimFactId: envelope.factId,
              claimDigest: attemptHistoryPayloadDigest({
                kind: 'agent-result-claim',
                claim: envelope.payload.claim,
              }),
              claim: envelope.payload.claim,
            }
          : undefined;
    if (payload === undefined) {
      throw new AuthorityConflict('Finalization observation kind is invalid');
    }
    const factPayload = {
      schema: 'agent-lcars.attempt-fact/v1' as const,
      version: 1 as const,
      factId: envelope.factId,
      requestId: envelope.requestId,
      source: envelope.source,
      observedAt: envelope.observedAt,
      transitionedAt: input.transitionedAt,
      payloadSha256: envelope.payloadSha256,
      canonicalDigest: attemptTransitionDigest(input.event),
      payload,
    };
    const identity = {
      tenantId: input.attempt.spec.tenant.tenantId,
      attemptId: input.attempt.spec.attemptId,
    };
    try {
      const factRecord = appendHistoryRecord({
        head: existing.head.streams.fact,
        payload: factPayload,
        appliedRevision: input.next.revision,
      }).record;
      const factRef = attemptHistoryRecordReference(
        factRecord,
        identity,
        'fact',
      );
      const emitted: Array<{ stream: AttemptHistoryStream; payload: unknown }> =
        [{ stream: 'fact', payload: factPayload }];
      if (payload.kind === 'agent-result-claim') {
        emitted.push({
          stream: 'claim',
          payload: {
            schema: 'agent-lcars.attempt-claim/v1' as const,
            version: 1 as const,
            claimFactId: payload.claimFactId,
            factRef,
            requestId: envelope.requestId,
            observedAt: envelope.observedAt,
            transitionedAt: input.transitionedAt,
            claimDigest: payload.claimDigest,
            claim: payload.claim,
          },
        });
      }
      const transition = appendAttemptHistoryTransition({
        head: existing.head,
        nextRevision: input.next.revision,
        transitionedAt: input.transitionedAt,
        emitted,
        priorRecords: [...existing.records.values()].flatMap((entries) =>
          entries.map(({ record, payload }) => ({ record, payload })),
        ),
      });
      const payloadsByStream = new Map<AttemptHistoryStream, unknown[]>();
      for (const emission of emitted) {
        const values = payloadsByStream.get(emission.stream) ?? [];
        values.push(emission.payload);
        payloadsByStream.set(emission.stream, values);
      }
      const records = new Map(existing.records);
      for (const record of transition.records) {
        const stream = record.streamKind as AttemptHistoryStream;
        const historyPayload = payloadsByStream.get(stream)?.shift();
        if (historyPayload === undefined)
          throw new AuthorityConflict(
            'Finalization history payload is missing',
          );
        records.set(stream, [
          ...(existing.records.get(stream) ?? []),
          { record: clone(record), payload: clone(historyPayload) },
        ]);
      }
      const stored = { head: clone(transition.head), records };
      this.assertStoredAttemptHistoryIntegrity(stored, input.next);
      return { history: stored, factRef };
    } catch (error) {
      if (error instanceof AuthorityConflict) throw error;
      throw new AuthorityConflict('Finalization history transition is invalid');
    }
  }

  /**
   * Mirror reducer-owned validation commands in the same transaction as the
   * legacy Attempt mutation.  A nonempty attempt history is a commitment to
   * a complete prefix: do not manufacture a command from a head pointer
   * alone, and do not let the legacy state advance if its immutable refs
   * cannot be resolved from the stored record bundle.
   */
  private appendValidationCommandHistory(input: {
    attempt: AttemptState;
    next: AttemptState;
    event: Extract<
      AttemptEvent,
      { kind: 'start-validation' | 'validate-claim' }
    >;
    transitionedAt: string;
  }):
    | { history: StoredAttemptHistory; receipt: StoredValidationHistoryReceipt }
    | undefined {
    const existing = this.attemptHistories.get(input.attempt.spec.attemptId);
    if (existing === undefined) return undefined;
    this.assertStoredAttemptHistoryIntegrity(existing, input.attempt);
    const finalization = input.attempt.finalization;
    const historyFinalization = existing.head.finalization;
    if (finalization === undefined || historyFinalization === undefined) {
      throw new AuthorityConflict('Validation history lineage is incomplete');
    }
    const identity = {
      tenantId: input.attempt.spec.tenant.tenantId,
      attemptId: input.attempt.spec.attemptId,
    };
    const terminalFactRef = historyFinalization.terminalFactRef;
    const terminal = existing.records
      .get('fact')
      ?.find(({ record }) =>
        same(
          attemptHistoryRecordReference(record, identity, 'fact'),
          terminalFactRef,
        ),
      );
    const terminalPayload =
      terminal === undefined
        ? undefined
        : (verifyAttemptHistoryPayload(
            'fact',
            terminal.record,
            terminal.payload,
            identity,
          ).payload as { factId?: string; payload?: { kind?: string } });
    if (
      terminalPayload?.factId !== finalization.terminalFactId ||
      terminalPayload.payload?.kind !== 'run-terminal'
    ) {
      throw new AuthorityConflict('Validation terminal history is invalid');
    }

    let claimFactRef: HistoryRecordReference | undefined;
    if (input.event.kind === 'validate-claim') {
      const validationEvent = input.event;
      claimFactRef = historyFinalization.claimRefs.find((ref) => {
        const entry = existing.records
          .get('claim')
          ?.find(({ record }) =>
            same(attemptHistoryRecordReference(record, identity, 'claim'), ref),
          );
        if (entry === undefined) return false;
        const payload = verifyAttemptHistoryPayload(
          'claim',
          entry.record,
          entry.payload,
          identity,
        ).payload as { claimFactId?: string };
        return payload.claimFactId === validationEvent.claimFactId;
      });
      if (claimFactRef === undefined) {
        throw new AuthorityConflict('Validation claim history is invalid');
      }
    }

    const commandPayload = {
      schema: 'agent-lcars.attempt-command/v1' as const,
      version: 1 as const,
      transitionedAt: input.transitionedAt,
      canonicalDigest: attemptTransitionDigest(input.event),
      payload:
        input.event.kind === 'start-validation'
          ? {
              kind: 'start-validation' as const,
              commandId: input.event.eventId,
              at: input.event.at,
              terminalFactRef,
            }
          : {
              kind: 'validate-claim-requested' as const,
              commandId: input.event.eventId,
              terminalFactRef,
              claimFactRef: claimFactRef as HistoryRecordReference,
              validation: input.event.validation,
            },
    };
    const emitted: Array<{ stream: AttemptHistoryStream; payload: unknown }> = [
      { stream: 'command', payload: commandPayload },
    ];
    if (input.event.kind === 'validate-claim') {
      const validationEvent = input.event;
      emitted.push({
        stream: 'validation',
        payload: {
          schema: 'agent-lcars.attempt-validation/v1' as const,
          version: 1 as const,
          commandId: input.event.eventId,
          validationFactId: validationEvent.eventId,
          terminalFactRef,
          claimFactRef: claimFactRef as HistoryRecordReference,
          validatedAt: validationEvent.validation.validatedAt,
          transitionedAt: input.transitionedAt,
          validation: validationEvent.validation,
        },
      });
    }
    try {
      const transition = appendAttemptHistoryTransition({
        head: existing.head,
        nextRevision: input.next.revision,
        transitionedAt: input.transitionedAt,
        emitted,
        priorRecords: [...existing.records.values()].flatMap((entries) =>
          entries.map(({ record, payload }) => ({ record, payload })),
        ),
      });
      const records = new Map(existing.records);
      const payloadsByStream = new Map<AttemptHistoryStream, unknown[]>();
      for (const emission of emitted) {
        const values = payloadsByStream.get(emission.stream) ?? [];
        values.push(emission.payload);
        payloadsByStream.set(emission.stream, values);
      }
      for (const record of transition.records) {
        const stream = record.streamKind as AttemptHistoryStream;
        const payload = payloadsByStream.get(stream)?.shift();
        if (payload === undefined) {
          throw new AuthorityConflict('Validation history payload is missing');
        }
        records.set(stream, [
          ...(existing.records.get(stream) ?? []),
          { record: clone(record), payload: clone(payload) },
        ]);
      }
      const commandRecord = transition.records.find(
        (record) => record.streamKind === 'command',
      );
      const validationRecord = transition.records.find(
        (record) => record.streamKind === 'validation',
      );
      if (
        commandRecord === undefined ||
        (input.event.kind === 'validate-claim' &&
          validationRecord === undefined)
      ) {
        throw new AuthorityConflict('Validation history receipt is missing');
      }
      const stored = { head: clone(transition.head), records };
      this.assertStoredAttemptHistoryIntegrity(stored, input.next);
      return {
        history: stored,
        receipt: {
          attemptId: input.attempt.spec.attemptId,
          commandId: input.event.eventId,
          commandRef: attemptHistoryRecordReference(
            commandRecord,
            identity,
            'command',
          ),
          ...(validationRecord === undefined
            ? {}
            : {
                validationRef: attemptHistoryRecordReference(
                  validationRecord,
                  identity,
                  'validation',
                ),
              }),
        },
      };
    } catch (error) {
      if (error instanceof AuthorityConflict) throw error;
      throw new AuthorityConflict('Validation history transition is invalid');
    }
  }

  private assertValidationHistoryReplay(
    attempt: AttemptState,
    event: Extract<
      AttemptEvent,
      { kind: 'start-validation' | 'validate-claim' }
    >,
  ): void {
    const history = this.attemptHistories.get(attempt.spec.attemptId);
    const receipt = this.validationHistoryReceipts.get(
      tupleKey(attempt.spec.attemptId, event.eventId),
    );
    if (history === undefined) {
      if (receipt !== undefined) {
        throw new AuthorityConflict('Validation history receipt is orphaned');
      }
      return;
    }
    if (receipt === undefined) {
      throw new AuthorityConflict('Validation history receipt is missing');
    }
    this.assertStoredAttemptHistoryIntegrity(history, attempt);
    const identity = {
      tenantId: attempt.spec.tenant.tenantId,
      attemptId: attempt.spec.attemptId,
    };
    const command = history.records
      .get('command')
      ?.find(({ record }) =>
        same(
          attemptHistoryRecordReference(record, identity, 'command'),
          receipt.commandRef,
        ),
      );
    if (command === undefined) {
      throw new AuthorityConflict('Validation history command is missing');
    }
    const commandPayload = verifyAttemptHistoryPayload(
      'command',
      command.record,
      command.payload,
      identity,
    ).payload as {
      canonicalDigest?: string;
      payload?: {
        kind?: string;
        commandId?: string;
        terminalFactRef?: HistoryRecordReference;
        claimFactRef?: HistoryRecordReference;
      };
    };
    const expectedKind =
      event.kind === 'start-validation'
        ? 'start-validation'
        : 'validate-claim-requested';
    if (
      commandPayload.payload?.kind !== expectedKind ||
      commandPayload.payload.commandId !== event.eventId ||
      commandPayload.canonicalDigest !== attemptTransitionDigest(event) ||
      !attempt.commands.some(
        (command) =>
          command.eventId === event.eventId &&
          command.canonicalDigest === attemptTransitionDigest(event),
      )
    ) {
      throw new AuthorityConflict('Validation history command conflicts');
    }
    if (event.kind === 'start-validation') {
      if (receipt.validationRef !== undefined) {
        throw new AuthorityConflict('Start validation history is malformed');
      }
      return;
    }
    const validationEvent = event;
    if (receipt.validationRef === undefined) {
      throw new AuthorityConflict('Validation history record is missing');
    }
    const validation = history.records
      .get('validation')
      ?.find(({ record }) =>
        same(
          attemptHistoryRecordReference(record, identity, 'validation'),
          receipt.validationRef as HistoryRecordReference,
        ),
      );
    if (validation === undefined) {
      throw new AuthorityConflict('Validation history record is missing');
    }
    const validationPayload = verifyAttemptHistoryPayload(
      'validation',
      validation.record,
      validation.payload,
      identity,
    ).payload as {
      commandId?: string;
      validationFactId?: string;
      validatedAt?: string;
      transitionedAt?: string;
      terminalFactRef?: HistoryRecordReference;
      claimFactRef?: HistoryRecordReference;
      validation?: unknown;
    };
    if (
      validationPayload.commandId !== event.eventId ||
      validationPayload.validationFactId !== validationEvent.eventId ||
      validationPayload.validatedAt !==
        validationEvent.validation.validatedAt ||
      validationPayload.transitionedAt !==
        validationEvent.validation.validatedAt ||
      !same(validationPayload.validation, validationEvent.validation) ||
      !same(
        validationPayload.terminalFactRef,
        commandPayload.payload.terminalFactRef,
      ) ||
      !same(validationPayload.claimFactRef, commandPayload.payload.claimFactRef)
    ) {
      throw new AuthorityConflict('Validation history record conflicts');
    }
  }

  /** Every mirrored validation command has one and only one private receipt. */
  private assertValidationHistoryReceiptBijection(
    history: StoredAttemptHistory,
    attempt: AttemptState,
  ): void {
    const identity = {
      tenantId: attempt.spec.tenant.tenantId,
      attemptId: attempt.spec.attemptId,
    };
    const commands = (history.records.get('command') ?? []).filter(
      ({ payload }) => {
        const kind = (payload as { payload?: { kind?: string } }).payload?.kind;
        return (
          kind === 'start-validation' || kind === 'validate-claim-requested'
        );
      },
    );
    const receipts = [...this.validationHistoryReceipts.values()].filter(
      (receipt) => receipt.attemptId === attempt.spec.attemptId,
    );
    if (receipts.length !== commands.length) {
      throw new AuthorityConflict(
        'Validation history receipt bijection is invalid',
      );
    }
    const receiptIds = new Set<string>();
    for (const { record, payload } of commands) {
      const command = payload as {
        canonicalDigest?: string;
        payload?: { kind?: string; commandId?: string };
      };
      const commandId = command.payload?.commandId;
      if (commandId === undefined || receiptIds.has(commandId)) {
        throw new AuthorityConflict(
          'Validation history command identity is invalid',
        );
      }
      receiptIds.add(commandId);
      const receipt = this.validationHistoryReceipts.get(
        tupleKey(attempt.spec.attemptId, commandId),
      );
      if (
        receipt === undefined ||
        receipt.attemptId !== attempt.spec.attemptId ||
        receipt.commandId !== commandId ||
        !same(
          receipt.commandRef,
          attemptHistoryRecordReference(record, identity, 'command'),
        )
      ) {
        throw new AuthorityConflict('Validation history receipt is missing');
      }
      if (command.payload?.kind === 'start-validation') {
        if (receipt.validationRef !== undefined) {
          throw new AuthorityConflict('Start validation receipt is malformed');
        }
        continue;
      }
      const validation = (history.records.get('validation') ?? []).filter(
        ({ payload: value }) =>
          (value as { commandId?: string }).commandId === commandId,
      );
      const validationRecord = validation[0];
      if (
        validation.length !== 1 ||
        validationRecord === undefined ||
        receipt.validationRef === undefined ||
        !same(
          receipt.validationRef,
          attemptHistoryRecordReference(
            validationRecord.record,
            identity,
            'validation',
          ),
        )
      ) {
        throw new AuthorityConflict('Validation history receipt is invalid');
      }
    }
    for (const receipt of receipts) {
      if (!receiptIds.has(receipt.commandId)) {
        throw new AuthorityConflict('Validation history receipt is orphaned');
      }
    }
  }

  private assertFinalizationObservationHistoryReplay(
    identity: ObservationIdentity,
    attempt: AttemptState,
  ): void {
    const history = this.attemptHistories.get(identity.attemptId);
    const { factKey, requestKey } = observationKeys(identity);
    const fact = this.factKeys.get(factKey);
    const request = this.requestKeys.get(requestKey);
    const ref = fact?.historyRecordRef ?? request?.historyRecordRef;
    if (history === undefined) {
      if (ref !== undefined)
        throw new AuthorityConflict('Finalization history receipt is orphaned');
      return;
    }
    this.assertStoredAttemptHistoryIntegrity(history, attempt);
    if (
      ref === undefined ||
      !same(fact?.historyRecordRef, ref) ||
      !same(request?.historyRecordRef, ref)
    ) {
      throw new AuthorityConflict('Finalization history receipt is missing');
    }
    const entry = history.records
      .get('fact')
      ?.find(({ record }) =>
        same(
          attemptHistoryRecordReference(
            record,
            { tenantId: identity.tenantId, attemptId: identity.attemptId },
            'fact',
          ),
          ref,
        ),
      );
    if (entry === undefined)
      throw new AuthorityConflict('Finalization history fact is missing');
    const payload = verifyAttemptHistoryPayload(
      'fact',
      entry.record,
      entry.payload,
      { tenantId: identity.tenantId, attemptId: identity.attemptId },
    ).payload as {
      factId: string;
      requestId: string;
      payloadSha256: string;
      canonicalDigest: string;
      payload: { kind: string; claimFactId?: string };
    };
    if (
      payload.factId !== identity.factId ||
      payload.requestId !== identity.requestId ||
      payload.payloadSha256 !== identity.payloadSha256 ||
      payload.canonicalDigest !== identity.canonicalDigest ||
      !['run-terminal', 'agent-result-claim'].includes(payload.payload.kind)
    ) {
      throw new AuthorityConflict('Finalization history fact conflicts');
    }
    if (payload.payload.kind === 'agent-result-claim') {
      const claim = history.records
        .get('claim')
        ?.find(
          ({ payload: value }) =>
            (value as { claimFactId?: string }).claimFactId === identity.factId,
        );
      if (claim === undefined)
        throw new AuthorityConflict('Finalization claim history is missing');
    }
  }

  private observationRecords(
    identity: ObservationIdentity,
    historyRecordRef?: HistoryRecordReference,
  ): {
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
        ...(historyRecordRef === undefined ? {} : { historyRecordRef }),
      },
      request: {
        counterpartId: identity.factId,
        canonicalDigest: identity.canonicalDigest,
        payloadSha256: identity.payloadSha256,
        resourceId: identity.attemptId,
        ...(historyRecordRef === undefined ? {} : { historyRecordRef }),
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
      (!sameObservationIdempotency(priorFact, fact) ||
        !sameObservationIdempotency(priorRequest, request))
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
      !sameObservationIdempotency(this.factKeys.get(factKey), fact) ||
      !sameObservationIdempotency(this.requestKeys.get(requestKey), request)
    ) {
      throw new AuthorityConflict(
        'Observation replay was not durably recorded',
      );
    }
  }

  private persistObservation(
    identity: ObservationIdentity,
    historyRecordRef?: HistoryRecordReference,
  ): void {
    const { factKey, requestKey, fact, request } = this.observationRecords(
      identity,
      historyRecordRef,
    );
    this.factKeys.set(factKey, fact);
    this.requestKeys.set(requestKey, request);
  }

  private assertValidationWorkForState(state: AttemptState): void {
    const finalization = state.finalization;
    if (finalization === undefined || state.phase !== 'validating') {
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
      if (
        work === undefined ||
        work.tenantId !== state.spec.tenant.tenantId ||
        work.attemptId !== state.spec.attemptId ||
        work.terminalFactId !== finalization.terminalFactId ||
        work.claimFactId !== evidence.factId ||
        !same(work.claim, evidence.claim) ||
        (evidence.validation === undefined
          ? work.state === 'complete' || work.validationFactId !== undefined
          : work.state !== 'complete' ||
            work.validationFactId !== evidence.validation.validationFactId)
      ) {
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
      work.validationFactId !== validationFactId ||
      work.claimFactId !== claimFactId ||
      work.terminalFactId !== terminalFactId ||
      work.tenantId !== state.spec.tenant.tenantId ||
      work.attemptId !== state.spec.attemptId
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
    // Claiming the work is itself a durable state transition.  Verify the
    // complete history/receipt prefix before changing pending -> resolving,
    // otherwise a corrupt private receipt could strand an otherwise valid
    // work item before the later result transaction notices it.
    this.assertFinalizationHistoryLineage(attempt);
    const key = validationWorkKey(
      input.tenantId,
      input.attemptId,
      input.terminalFactId,
      input.claimFactId,
    );
    const work = this.validationWork.get(key);
    const finalization = attempt.finalization;
    const evidence = finalization?.evidence.find(
      (candidate) => candidate.factId === input.claimFactId,
    );
    if (
      attempt.phase !== 'validating' ||
      finalization === undefined ||
      finalization.terminalFactId !== input.terminalFactId ||
      evidence === undefined ||
      evidence.validation !== undefined ||
      work === undefined ||
      work.tenantId !== input.tenantId ||
      work.attemptId !== input.attemptId ||
      work.terminalFactId !== input.terminalFactId ||
      work.claimFactId !== input.claimFactId ||
      work.state === 'complete' ||
      !same(work.claim, evidence.claim)
    ) {
      throw new AuthorityConflict('Validation work is unknown');
    }
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
    const localKey = tupleKey(
      attempt.spec.task.tenantId,
      attempt.spec.task.repositoryId,
      attempt.spec.task.issueNumber,
      attempt.spec.local.intentId,
      attempt.spec.local.generation,
    );
    const existingHistory = this.attemptHistories.get(work.attemptId);
    const admissionHistoryReceipt =
      this.attemptAdmissionHistoryReceipts.get(localKey);
    const hasAdmissionLineage =
      admissionHistoryReceipt !== undefined || existingHistory !== undefined;
    if (hasAdmissionLineage) {
      const acceptance = this.acceptances.get(localKey);
      const taskHistory = this.taskHistories.get(
        canonicalTaskKey(attempt.spec.task),
      );
      if (
        acceptance === undefined ||
        admissionHistoryReceipt === undefined ||
        existingHistory === undefined ||
        taskHistory === undefined ||
        acceptance.attemptId !== work.attemptId ||
        acceptance.specDigest !== attempt.specDigest ||
        !same(acceptance.task.task, attempt.spec.task) ||
        admissionHistoryReceipt.attemptId !== work.attemptId ||
        admissionHistoryReceipt.tenantId !== attempt.spec.tenant.tenantId ||
        !same(admissionHistoryReceipt.task, attempt.spec.task) ||
        admissionHistoryReceipt.specDigest !== attempt.specDigest
      ) {
        throw new AuthorityConflict(
          'Attempt admission history lineage is invalid',
        );
      }
      this.assertStoredTaskHistoryIntegrity(attempt.spec.task, taskHistory);
      this.assertStoredAttemptHistoryIntegrity(existingHistory, attempt);
      this.assertStoredAttemptAdmissionHistoryReceipt({
        receipt: admissionHistoryReceipt,
        taskHistory,
        attemptHistory: existingHistory,
        attempt,
      });
    }
    if (
      existingHistory !== undefined &&
      attempt.cancellation !== undefined &&
      existingHistory.head.cancellation === undefined &&
      attempt.phase !== 'terminal'
    ) {
      throw new AuthorityConflict(
        'Attempt cancellation history is missing before launch resolution',
      );
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
    const priorReceipt = this.launchResolutionReceipts.get(receiptKey);
    const currentClaimMatches =
      current.claimedFence === input.lease.fence &&
      current.claimToken === work.claimToken &&
      work.claimFence === input.lease.fence &&
      (resolution.kind === 'accepted'
        ? work.permission === 'dispatch'
        : ['dispatch', 'reconcile-unknown'].includes(work.permission));
    const existingCommand = attempt.commands.find(
      (command) => command.eventId === event.eventId,
    );
    const replayLaunchConverged =
      resolution.kind === 'accepted'
        ? current.state === 'accepted' && attempt.launch.state === 'accepted'
        : (current.state === 'unknown' &&
            attempt.launch.state === 'response-unknown') ||
          (current.state === 'accepted' &&
            attempt.launch.state === 'accepted' &&
            attempt.binding !== undefined);
    if (
      priorReceipt !== undefined &&
      replayLaunchConverged &&
      existingCommand !== undefined &&
      existingCommand.canonicalDigest === attemptTransitionDigest(event) &&
      currentClaimMatches &&
      priorReceipt.responseSha256 === resolution.responseSha256
    ) {
      if (existingHistory !== undefined) {
        this.assertLaunchResolutionHistoryReceipt(
          existingHistory,
          attempt,
          event,
          priorReceipt,
        );
      } else if (priorReceipt.history !== undefined) {
        throw new AuthorityConflict('Launch history receipt is orphaned');
      }
      return 'replay';
    }
    if (priorReceipt !== undefined || existingCommand !== undefined) {
      throw new AuthorityConflict(
        'Launch response identity was reused differently',
      );
    }
    if (current.state !== 'dispatching' || !currentClaimMatches) {
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
    let nextHistory: StoredAttemptHistory | undefined;
    let historyReceipt: StoredLaunchResolutionReceipt['history'] | undefined;
    if (existingHistory !== undefined) {
      const commandPayload = {
        schema: 'agent-lcars.attempt-command/v1' as const,
        version: 1 as const,
        transitionedAt: resolution.resolvedAt,
        canonicalDigest: attemptTransitionDigest(event),
        payload: {
          kind:
            resolution.kind === 'accepted'
              ? ('launch-accepted' as const)
              : ('launch-response-unknown' as const),
          commandId: event.eventId,
        },
      };
      try {
        const transition = appendAttemptHistoryTransition({
          head: existingHistory.head,
          nextRevision: reduced.state.revision,
          transitionedAt: resolution.resolvedAt,
          emitted: [{ stream: 'command', payload: commandPayload }],
        });
        const commandRecord = transition.records[0];
        if (
          commandRecord === undefined ||
          commandRecord.streamKind !== 'command'
        )
          throw new AuthorityConflict(
            'Launch history command record is missing',
          );
        const commandRef = attemptHistoryRecordReference(
          commandRecord,
          {
            tenantId: attempt.spec.tenant.tenantId,
            attemptId: attempt.spec.attemptId,
          },
          'command',
        );
        historyReceipt = { commandRef };
        nextHistory = {
          head: clone(transition.head),
          records: new Map(existingHistory.records),
        };
        nextHistory.records.set('command', [
          ...(existingHistory.records.get('command') ?? []),
          { record: clone(commandRecord), payload: clone(commandPayload) },
        ]);
      } catch (error) {
        if (error instanceof AuthorityConflict) throw error;
        throw new AuthorityConflict('Launch history transition is invalid');
      }
    }
    const previousAttempt = this.attempts.get(work.attemptId);
    const previousLaunch = this.launches.get(work.attemptId);
    const previousReceipt = this.launchResolutionReceipts.get(receiptKey);
    const previousHistory = this.attemptHistories.get(work.attemptId);
    const restore = <T>(
      map: Map<string, T>,
      key: string,
      value: T | undefined,
    ): void => {
      if (value === undefined) Map.prototype.delete.call(map, key);
      else Map.prototype.set.call(map, key, value);
    };
    try {
      this.writeAttemptTransaction({
        lease: input.lease,
        expectedRevision: attempt.revision,
        next: reduced.state,
      });
      this.launches.set(work.attemptId, {
        ...current,
        state: resolution.kind,
      });
      this.launchResolutionReceipts.set(receiptKey, {
        responseSha256: resolution.responseSha256,
        ...(historyReceipt === undefined ? {} : { history: historyReceipt }),
      });
      if (nextHistory !== undefined)
        this.attemptHistories.set(work.attemptId, nextHistory);
    } catch (error) {
      restore(this.attempts, work.attemptId, previousAttempt);
      restore(this.launches, work.attemptId, previousLaunch);
      restore(this.launchResolutionReceipts, receiptKey, previousReceipt);
      restore(this.attemptHistories, work.attemptId, previousHistory);
      throw error;
    }
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
    const localKey = tupleKey(
      attempt.spec.task.tenantId,
      attempt.spec.task.repositoryId,
      attempt.spec.task.issueNumber,
      attempt.spec.local.intentId,
      attempt.spec.local.generation,
    );
    const acceptance = this.acceptances.get(localKey);
    const admissionHistoryReceipt =
      this.attemptAdmissionHistoryReceipts.get(localKey);
    const existingAttemptHistory = this.attemptHistories.get(
      envelope.attemptId,
    );
    const hasAdmissionLineage =
      admissionHistoryReceipt !== undefined ||
      existingAttemptHistory !== undefined;
    const envelopeBinding = envelope.payload.binding;
    if (hasAdmissionLineage) {
      const admissionHistory = this.taskHistories.get(
        canonicalTaskKey(attempt.spec.task),
      );
      if (
        acceptance === undefined ||
        admissionHistoryReceipt === undefined ||
        acceptance.attemptId !== envelope.attemptId ||
        acceptance.specDigest !== attempt.specDigest ||
        !same(acceptance.task.task, attempt.spec.task) ||
        admissionHistory === undefined ||
        admissionHistoryReceipt.attemptId !== envelope.attemptId ||
        admissionHistoryReceipt.tenantId !== attempt.spec.tenant.tenantId ||
        !same(admissionHistoryReceipt.task, attempt.spec.task) ||
        admissionHistoryReceipt.specDigest !== attempt.specDigest ||
        admissionHistoryReceipt.admissionDigest !== acceptance.admissionDigest
      ) {
        throw new AuthorityConflict(
          'Attempt admission history lineage is invalid',
        );
      }
      this.assertStoredTaskHistoryIntegrity(
        attempt.spec.task,
        admissionHistory,
      );
      const admissionAttemptHistory = this.attemptHistories.get(
        envelope.attemptId,
      );
      if (admissionAttemptHistory === undefined)
        throw new AuthorityConflict('Binding attempt history is missing');
      this.assertStoredAttemptHistoryIntegrity(
        admissionAttemptHistory,
        attempt,
      );
      this.assertStoredAttemptAdmissionHistoryReceipt({
        receipt: admissionHistoryReceipt,
        taskHistory: admissionHistory,
        attemptHistory: admissionAttemptHistory,
        attempt,
      });
    }
    if (priorFact !== undefined || priorRequest !== undefined) {
      const history = this.attemptHistories.get(envelope.attemptId);
      if (history !== undefined)
        this.assertStoredAttemptHistoryIntegrity(history, attempt);
      const storedRef =
        priorFact?.historyRecordRef ?? priorRequest?.historyRecordRef;
      if (storedRef !== undefined) {
        fact.historyRecordRef = storedRef;
        request.historyRecordRef = storedRef;
      }
      const storedRecord =
        storedRef === undefined || history === undefined
          ? undefined
          : history.records.get('fact')?.find(({ record }) =>
              same(
                attemptHistoryRecordReference(
                  record,
                  {
                    tenantId: attempt.spec.tenant.tenantId,
                    attemptId: attempt.spec.attemptId,
                  },
                  'fact',
                ),
                storedRef,
              ),
            );
      let historicalBinding = false;
      if (storedRecord !== undefined) {
        try {
          const verified = verifyAttemptHistoryPayload(
            'fact',
            storedRecord.record,
            storedRecord.payload,
            {
              tenantId: attempt.spec.tenant.tenantId,
              attemptId: attempt.spec.attemptId,
            },
          );
          const value = verified.payload as {
            factId: string;
            requestId: string;
            payloadSha256: string;
            canonicalDigest: string;
            payload: { kind: string; binding?: RunBinding };
          };
          historicalBinding =
            value.payload.kind === 'run-bound' &&
            value.factId === envelope.factId &&
            value.requestId === envelope.requestId &&
            value.payloadSha256 === envelope.payloadSha256 &&
            value.canonicalDigest === canonicalDigest &&
            same(value.payload.binding, envelopeBinding);
        } catch {
          historicalBinding = false;
        }
      }
      const converged =
        attempt.launch.state === 'accepted' &&
        launch.state === 'accepted' &&
        attempt.binding !== undefined &&
        same(attempt.binding, envelopeBinding) &&
        ((historicalBinding && storedRecord !== undefined) ||
          !hasAdmissionLineage) &&
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
    const existingHistory = this.attemptHistories.get(envelope.attemptId);
    if (existingHistory === undefined && hasAdmissionLineage) {
      throw new AuthorityConflict('Binding attempt history is missing');
    }
    if (hasAdmissionLineage && existingHistory !== undefined) {
      const taskHistory = this.taskHistories.get(
        canonicalTaskKey(attempt.spec.task),
      );
      const receipt = this.attemptAdmissionHistoryReceipts.get(localKey);
      if (taskHistory === undefined || receipt === undefined)
        throw new AuthorityConflict(
          'Attempt admission history lineage is missing',
        );
      this.assertStoredTaskHistoryIntegrity(attempt.spec.task, taskHistory);
      this.assertStoredAttemptAdmissionHistoryReceipt({
        receipt,
        taskHistory,
        attemptHistory: existingHistory,
        attempt,
      });
    }
    const bindingFact = {
      schema: 'agent-lcars.attempt-fact/v1' as const,
      version: 1 as const,
      factId: envelope.factId,
      requestId: envelope.requestId,
      source: envelope.source,
      observedAt: envelope.observedAt,
      transitionedAt: envelope.observedAt,
      payloadSha256: envelope.payloadSha256,
      canonicalDigest,
      payload: {
        kind: 'run-bound' as const,
        binding: envelope.payload.binding,
      },
    };
    let historyTransition:
      ReturnType<typeof appendAttemptHistoryTransition> | undefined;
    try {
      if (existingHistory !== undefined) {
        this.assertStoredAttemptHistoryIntegrity(existingHistory, attempt);
        historyTransition = appendAttemptHistoryTransition({
          head: existingHistory.head,
          nextRevision: nextAttempt.revision,
          transitionedAt: envelope.observedAt,
          emitted: [{ stream: 'fact', payload: bindingFact }],
          priorRecords: [...existingHistory.records.values()].flatMap(
            (entries) =>
              entries.map(({ record, payload }) => ({ record, payload })),
          ),
        });
      }
    } catch {
      throw new AuthorityConflict('Binding history transition is invalid');
    }
    const nextHistory =
      existingHistory === undefined || historyTransition === undefined
        ? undefined
        : {
            head: clone(historyTransition.head),
            records: new Map(existingHistory.records),
          };
    if (
      nextHistory !== undefined &&
      existingHistory !== undefined &&
      historyTransition !== undefined
    ) {
      const bindingRecord = historyTransition.records[0];
      if (bindingRecord === undefined)
        throw new AuthorityConflict('Binding history record is missing');
      nextHistory.records.set('fact', [
        ...(existingHistory.records.get('fact') ?? []),
        { record: clone(bindingRecord), payload: clone(bindingFact) },
      ]);
      const historyRecordRef = attemptHistoryRecordReference(
        bindingRecord,
        { tenantId: envelope.tenant.tenantId, attemptId: envelope.attemptId },
        'fact',
      );
      fact.historyRecordRef = historyRecordRef;
      request.historyRecordRef = historyRecordRef;
    }
    const previousAttempt = this.attempts.get(envelope.attemptId);
    const previousFact = this.factKeys.get(factKey);
    const previousRequest = this.requestKeys.get(requestKey);
    const previousLaunch = this.launches.get(envelope.attemptId);
    const previousHistory = this.attemptHistories.get(envelope.attemptId);
    const previousBinding = this.bindings.get(nextBindingKey);
    const promotedCancellation = [...this.cancellationWork.entries()]
      .filter(
        ([, work]) =>
          work.attemptId === envelope.attemptId &&
          work.state === 'awaiting-binding',
      )
      .map(([key, work]) => [key, work] as const);
    try {
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
      if (nextHistory !== undefined)
        this.attemptHistories.set(envelope.attemptId, nextHistory);
    } catch (error) {
      if (previousAttempt !== undefined)
        Map.prototype.set.call(
          this.attempts,
          envelope.attemptId,
          previousAttempt,
        );
      if (previousFact === undefined) this.factKeys.delete(factKey);
      else Map.prototype.set.call(this.factKeys, factKey, previousFact);
      if (previousRequest === undefined) this.requestKeys.delete(requestKey);
      else
        Map.prototype.set.call(this.requestKeys, requestKey, previousRequest);
      if (previousLaunch === undefined)
        this.launches.delete(envelope.attemptId);
      else
        Map.prototype.set.call(
          this.launches,
          envelope.attemptId,
          previousLaunch,
        );
      if (previousHistory === undefined)
        Map.prototype.delete.call(this.attemptHistories, envelope.attemptId);
      else
        Map.prototype.set.call(
          this.attemptHistories,
          envelope.attemptId,
          previousHistory,
        );
      if (previousBinding === undefined)
        Map.prototype.delete.call(this.bindings, nextBindingKey);
      else
        Map.prototype.set.call(this.bindings, nextBindingKey, previousBinding);
      for (const [key, work] of promotedCancellation)
        Map.prototype.set.call(this.cancellationWork, key, work);
      throw error;
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
