import { randomBytes } from 'node:crypto';

import type {
  AcceptedAttemptSpec,
  AttemptHistoryHead,
  AttemptHistoryStream,
  CredentialGrantIssuance,
  HistoryHead,
  HistoryRecord,
  HistoryRecordReference,
  ReplayReceipt,
  RunBinding,
  TaskHistoryHead,
} from '@agent-lcars/dispatch-contracts';

import type {
  AttemptIdFactory,
  AuthorityClock,
  CancellationEffectResult,
  MintIdentity,
  PresentationDeliveryRecord,
  TaskAuthorityScope,
  TaskPresentationRecord,
} from './authority-port';
import type { TaskIntentState } from './task-intent-reducer';

export interface StoredAcceptance {
  attemptId: string;
  specDigest: string;
  admissionDigest: string;
  taskSnapshotDigest: string;
  task: TaskIntentState;
}

export interface StoredAttemptAdmissionHistoryReceipt {
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

export interface StoredIdempotency {
  counterpartId: string;
  canonicalDigest: string;
  payloadSha256?: string;
  resourceId: string;
  historyRecordRef?: HistoryRecordReference;
}

export interface StoredMint {
  tenantId: string;
  repositoryId: number;
  identity: MintIdentity;
  grant: CredentialGrantIssuance;
}

export interface StoredTaskEffectReceipt {
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

export interface StoredPresentationDeliveryReceipt {
  planDigest: string;
  kind: 'converged' | 'unknown';
  receiptSha256: string;
  resolvedAt: string;
  snapshot: PresentationDeliveryRecord;
}

export interface StoredTaskHistoryRecord {
  record: HistoryRecord;
  payload: unknown;
}

export interface StoredTaskHistory {
  head: TaskHistoryHead;
  factRecords: StoredTaskHistoryRecord[];
  intentRecords: StoredTaskHistoryRecord[];
  effectRecords: StoredTaskHistoryRecord[];
  workRecords: StoredTaskHistoryRecord[];
  presentationRecords: StoredTaskHistoryRecord[];
  replayReceipts: Map<string, ReplayReceipt>;
  auxHeads: Map<'effect' | 'command' | 'presentation', HistoryHead>;
}

export interface StoredAttemptHistoryRecord {
  record: HistoryRecord;
  payload: unknown;
}

/** Shadow-only Attempt history. Legacy Attempt state remains authoritative. */
export interface StoredAttemptHistory {
  head: AttemptHistoryHead;
  records: Map<AttemptHistoryStream, StoredAttemptHistoryRecord[]>;
}

export interface StoredCancellationReceipt {
  result: CancellationEffectResult;
  /** Private exact refs; never exposed through the authority API. */
  history?: {
    commandRef: HistoryRecordReference;
    evidenceRef?: HistoryRecordReference;
  };
}

export interface StoredLaunchResolutionReceipt {
  responseSha256: string;
  /** Private exact ref; never exposed through the authority API. */
  history?: { commandRef: HistoryRecordReference };
}

/** Private exact replay material for a definitive no-run terminal decision. */
export interface StoredLaunchRejectionReceipt {
  proofSha256: string;
  rejectedAt: string;
  canonicalDigest: string;
  outcomeDigest: string;
  history?: {
    commandRef: HistoryRecordReference;
    evidenceRef: HistoryRecordReference;
  };
}

/**
 * One recorded non-terminal run observation. It holds the observation's exact
 * identity, binding, trusted time, and one-way digests — never a provider body
 * and never the commit fence.
 */
export interface StoredRunStuckObservation {
  tenantId: string;
  attemptId: string;
  factId: string;
  requestId: string;
  sourceIdentity: string;
  binding: RunBinding;
  observedAt: string;
  proofDigest: string;
  payloadDigest: string;
  canonicalDigest: string;
}

/**
 * Private exact replay material for a verified loss decision. Only the
 * receipt's stable causal commitment is kept; observations, provider evidence,
 * and the commit fence never become durable state.
 */
export interface StoredMarkLostReceipt {
  receiptId: string;
  idempotencyKey: string;
  causalDigest: string;
  terminatedAt: string;
  canonicalDigest: string;
  outcomeDigest: string;
  history: {
    commandRef: HistoryRecordReference;
    evidenceRef: HistoryRecordReference;
  };
}

/**
 * Private exact history pointers for finalization commands.  They are kept
 * beside the mutable work queue rather than exposed as part of its public
 * record, so a replay proves the same durable transition without turning a
 * storage detail into an API capability.
 */
export interface StoredValidationHistoryReceipt {
  attemptId: string;
  commandId: string;
  commandRef: HistoryRecordReference;
  validationRef?: HistoryRecordReference;
}

/** Private exact refs for the one terminal finalization outcome. */
export interface StoredFinalizationHistoryReceipt {
  attemptId: string;
  commandId: string;
  commandRef: HistoryRecordReference;
  evidenceRef: HistoryRecordReference;
}

export interface StoredPresentationDeliveryRecord extends PresentationDeliveryRecord {
  /** One-way proof for the opaque work capability; never returned or logged. */
  claimTokenSha256?: string;
}

export const systemClock: AuthorityClock = {
  now: () => new Date().toISOString(),
};
export const systemAttemptIds: AttemptIdFactory = {
  mint: () => randomBytes(16).toString('base64url'),
};
