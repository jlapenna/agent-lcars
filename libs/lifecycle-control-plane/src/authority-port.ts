import type {
  ActivationProvenance,
  ActivationRecord,
  AgentResultClaimV1,
  AttemptPresentationPlan,
  CredentialGrantIssuance,
  RunBinding,
  TaskPresentationPlan,
} from '@agent-lcars/dispatch-contracts';

import type { VerifiedAttemptAdmission } from './admission-capability';
import type { AttemptState } from './attempt-reducer';
import type { VerifiedCancellationEffect } from './cancellation-effect-capability';
import type { VerifiedFinalizationTransition } from './finalization-capability';
import type { VerifiedLaunchRejection } from './launch-rejection-capability';
import type {
  VerifiedClaimedLaunchWork,
  VerifiedLaunchResolution,
} from './launch-resolution-capability';
import type { VerifiedMarkLostTermination } from './mark-lost-capability';
import type { VerifiedRunStuckObservation } from './mark-lost-eligibility';
import type { VerifiedMintResolution } from './mint-resolution';
import type {
  VerifiedClaimedPresentationWork,
  VerifiedPresentationResolution,
} from './presentation-delivery-capability';
import type { VerifiedRunBindingIngress } from './run-binding-ingress';
import type {
  VerifiedAdmissionEffectCompletion,
  VerifiedTaskEffectObsoletion,
  VerifiedTaskEffectTransition,
} from './task-effect-capability';
import type { TaskIntentEffect, TaskIntentState } from './task-intent-reducer';

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
  /** Server-minted definitive no-run terminal decision; no provider call. */
  rejectVerifiedLaunch(input: {
    lease: TaskAuthorityLease;
    rejection: VerifiedLaunchRejection;
  }): Promise<WriteResult>;
  /**
   * Durable, lease-scoped record of one verified non-terminal run
   * observation. It records evidence only: no phase, grant, outcome, or
   * presentation changes, and no reducer transition is applied.
   */
  recordRunStuckObservation(input: {
    lease: TaskAuthorityLease;
    tenantId: string;
    attemptId: string;
    observation: VerifiedRunStuckObservation;
  }): Promise<WriteResult>;
  /**
   * Server-verified loss decision for an exact bound run. The eligibility
   * receipt authorizes it; this transaction still re-checks live authority,
   * binding, and bounded history itself.
   */
  terminateLostAttempt(input: {
    lease: TaskAuthorityLease;
    termination: VerifiedMarkLostTermination;
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
