import { createHash } from 'node:crypto';

import {
  type AcceptedAttemptSpec,
  attemptHistoryPayloadDigest,
  type AttemptPresentationPlan,
  attemptPresentationPlanSchema,
  canonicalDurableJson,
  type HistoryRecord,
  type HistoryRecordReference,
  type RunBinding,
  sha256Digest,
  type TaskPresentationPlan,
  taskPresentationPlanSchema,
} from '@agent-lcars/dispatch-contracts';

import type { VerifiedAttemptAdmission } from './admission-capability';
import type { AttemptState } from './attempt-reducer';
import type {
  AttemptPresentationRecord,
  EffectAuthorityScope,
  MintIdentity,
  PresentationDeliveryRecord,
  PresentationDeliveryTarget,
  TaskAuthorityScope,
  TaskEffectRecord,
  TaskPresentationRecord,
} from './authority-port';
import type {
  StoredIdempotency,
  StoredPresentationDeliveryRecord,
} from './authority-records';
import type { VerifiedCancellationEffect } from './cancellation-effect-capability';
import type { TaskIntentEffect, TaskIntentState } from './task-intent-reducer';

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

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function taskSnapshotDigest(task: TaskIntentState): string {
  return sha256Digest(canonicalDurableJson(canonicalValue(task)));
}

export function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** History references are an optional shadow receipt, not idempotency input. */
export function sameObservationIdempotency(
  left: StoredIdempotency | undefined,
  right: StoredIdempotency | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  const { historyRecordRef: _leftHistoryRecordRef, ...leftIdentity } = left;
  const { historyRecordRef: _rightHistoryRecordRef, ...rightIdentity } = right;
  return same(leftIdentity, rightIdentity);
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

/** One stable identity string for an observation's trusted source. */
export function observationSourceIdentity(source: {
  kind: string;
  sourceId: string;
}): string {
  return `${source.kind}:${source.sourceId}`;
}

/** Avoid delimiter collisions: opaque ids are permitted to contain `:`. */
export function tupleKey(...parts: readonly (string | number)[]): string {
  return JSON.stringify(parts);
}

export function parsedTime(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new AuthorityConflict(`${field} must be a timestamp`);
  }
  return parsed;
}

export function canonicalTaskKey(scope: TaskAuthorityScope): string {
  return tupleKey(scope.tenantId, scope.repositoryId, scope.issueNumber);
}

export function activationKey(scope: EffectAuthorityScope): string {
  return tupleKey(scope.tenantId, scope.repositoryId, scope.taskClassId);
}

export function admissionAcceptanceKey(
  input: VerifiedAttemptAdmission,
): string {
  return tupleKey(
    input.task.tenantId,
    input.task.repositoryId,
    input.task.issueNumber,
    input.intentId,
    input.intentRevision,
  );
}

export function admissionCommandDigest(
  input: VerifiedAttemptAdmission,
): string {
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

export function bindingKey(
  spec: AcceptedAttemptSpec,
  binding: RunBinding,
): string {
  return tupleKey(
    spec.tenant.tenantId,
    spec.tenant.repositoryId,
    binding.runId,
    binding.runAttempt,
    binding.checkRunId,
  );
}

export function observationKeys(identity: {
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

export function validationWorkKey(
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

export function taskEffectKey(input: {
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

export function cancellationEventId(
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

export function taskPresentationKey(input: {
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

export function attemptPresentationKey(
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

export function presentationPlanDigest(
  plan: TaskPresentationPlan | AttemptPresentationPlan,
): string {
  return createHash('sha256').update(canonicalJson(plan)).digest('hex');
}

export function presentationClaimTokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function publicPresentationDeliveryRecord(
  record: StoredPresentationDeliveryRecord,
): PresentationDeliveryRecord {
  const { claimTokenSha256: _claimTokenSha256, ...publicRecord } = record;
  return clone(publicRecord);
}

export function presentationDeliveryKey(
  target: PresentationDeliveryTarget,
): string {
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

export function taskDeliveryTarget(
  record: TaskPresentationRecord,
): Extract<PresentationDeliveryTarget, { source: 'task' }> {
  return {
    source: 'task',
    tenantId: record.tenantId,
    task: clone(record.plan.task),
    operationId: record.plan.operationId,
  };
}

export function attemptDeliveryTarget(
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

export interface DerivedAttemptPresentation {
  key: string;
  receiptKey: string;
  planDigest: string;
  outcomeDigest: string;
  record: AttemptPresentationRecord;
}

export function finalizationPresentationProvenance(
  state: AttemptState,
  commandId: string,
): Extract<AttemptPresentationPlan['terminal'], { kind: 'finalization' }> {
  const terminalFactId = state.finalization?.terminalFactId;
  if (terminalFactId === undefined) {
    throw new AuthorityConflict('Final outcome terminal fact is absent');
  }
  return { kind: 'finalization', commandId, terminalFactId };
}

export function deriveAttemptPresentation(
  state: AttemptState,
  terminal: AttemptPresentationPlan['terminal'],
  historyBoundFinalization = false,
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
  const outcomeDigest =
    terminal.kind === 'finalization' && historyBoundFinalization
      ? attemptHistoryPayloadDigest(outcome)
      : createHash('sha256').update(canonicalJson(outcome)).digest('hex');
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

export function taskPresentationForEffect(input: {
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

export function taskPresentationDigest(record: TaskPresentationRecord): string {
  return createHash('sha256').update(canonicalJson(record.plan)).digest('hex');
}

export function taskTransitionReceiptKey(input: {
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

export function taskHistoryKey(task: TaskAuthorityScope): string {
  return canonicalTaskKey(task);
}

export function taskHistoryRecordKey(record: HistoryRecord): string {
  return tupleKey(
    record.tenantId,
    record.aggregateKind,
    record.aggregateId,
    record.streamKind,
    record.sequence,
  );
}

export function taskHistoryRecordReferenceKey(
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

export function mintKeys(
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
