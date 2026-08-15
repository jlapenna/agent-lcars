import { z } from 'zod';

import {
  type ActivationProvenance,
  activationProvenanceSchema,
} from './activation';
import {
  canonicalDurableJson,
  DurabilityCapacityError,
  type DurableJsonValue,
  LIFECYCLE_DURABILITY_LIMITS,
  normalizeDurableValue,
  validateDurableTransition,
  validateDurableValue,
} from './durability';
import {
  appendHistoryRecord,
  createGenesisHistoryHead,
  type HistoryHead,
  historyHeadSchema,
  HistoryIntegrityError,
  historyPayloadDigest,
  type HistoryRecord,
  type HistoryRecordReference,
  historyRecordReferenceSchema,
  sha256Digest,
  verifyHistoryRecord,
  verifyHistoryRecordPayload,
} from './history';
import {
  type CanonicalTaskIdentity,
  canonicalTaskIdentitySchema,
  type TenantRef,
  tenantRefSchema,
} from './identity';
import {
  type DesiredIntentRelation,
  desiredIntentRelationSchema,
  intentStatusSchema,
} from './intent';
import { type PolicyDecision, policyDecisionSchema } from './policy';
import {
  attemptIdSchema,
  nonnegativeSafeIntegerSchema,
  opaqueIdSchema,
  positiveSafeIntegerSchema,
  sha256Schema,
  utcDateTimeSchema,
} from './primitives';

const TASK_FACT_SCHEMA = 'agent-lcars.task-fact-history/v1' as const;
const TASK_INTENT_SCHEMA = 'agent-lcars.task-intent-history/v1' as const;
const TASK_HEAD_SCHEMA = 'agent-lcars.task-history-head/v1' as const;

/** Reducer situation, kept provider-neutral while retaining command semantics. */
export const taskFactSituationSchema = z.enum([
  'requested-work',
  'park',
  'cancel',
  'reconcile',
]);
export type TaskFactSituation = z.infer<typeof taskFactSituationSchema>;

export const taskIntentResolutionSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.enum(['desired', 'stale', 'semantic-duplicate']),
      taskRevision: positiveSafeIntegerSchema,
      intentId: opaqueIdSchema,
      intentRevision: positiveSafeIntegerSchema,
    }),
    z.strictObject({
      kind: z.enum(['parked', 'cancelled']),
      taskRevision: positiveSafeIntegerSchema,
      intentId: opaqueIdSchema.optional(),
      intentRevision: positiveSafeIntegerSchema.optional(),
    }),
    z.strictObject({
      kind: z.enum(['rejected', 'observed']),
      taskRevision: positiveSafeIntegerSchema,
    }),
  ])
  .superRefine((value, ctx) => {
    const withIntent = value as {
      intentId?: string;
      intentRevision?: number;
    };
    if (
      (withIntent.intentId === undefined) !==
      (withIntent.intentRevision === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['intentRevision'],
        message: 'Intent id and revision must be present together',
      });
    }
  });
export type TaskIntentResolution = z.infer<typeof taskIntentResolutionSchema>;

export const taskAttemptRelationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('unlaunched'), intentId: opaqueIdSchema }),
  z.strictObject({
    kind: z.literal('launched'),
    intentId: opaqueIdSchema,
    intentRevision: positiveSafeIntegerSchema,
    attemptId: attemptIdSchema,
    admissionRevision: nonnegativeSafeIntegerSchema,
    admittedAt: utcDateTimeSchema,
    staleForDesiredState: z.boolean(),
    cancellationRequested: z.boolean(),
    supersededByIntentId: opaqueIdSchema.optional(),
  }),
]);
export type TaskAttemptRelation = z.infer<typeof taskAttemptRelationSchema>;

export const taskFactHistoryPayloadSchema = z.strictObject({
  schema: z.literal(TASK_FACT_SCHEMA),
  version: z.literal(1),
  task: canonicalTaskIdentitySchema,
  factId: opaqueIdSchema,
  requestId: opaqueIdSchema,
  sourceKey: opaqueIdSchema,
  canonicalDigest: sha256Schema,
  situation: taskFactSituationSchema,
  policyDecision: policyDecisionSchema,
  resolution: taskIntentResolutionSchema,
  acceptedAt: utcDateTimeSchema,
});
export type TaskFactHistoryPayload = z.infer<
  typeof taskFactHistoryPayloadSchema
>;

const taskIntentOrderingKeySchema = z.strictObject({
  occurredAt: utcDateTimeSchema,
  tieBreaker: opaqueIdSchema,
});

export const taskIntentHistoryPayloadSchema = z
  .strictObject({
    schema: z.literal(TASK_INTENT_SCHEMA),
    version: z.literal(1),
    task: canonicalTaskIdentitySchema,
    intentId: opaqueIdSchema,
    revision: positiveSafeIntegerSchema,
    status: intentStatusSchema,
    sourceFactId: opaqueIdSchema,
    policyDecision: policyDecisionSchema,
    activation: activationProvenanceSchema,
    createdAt: utcDateTimeSchema,
    semanticKey: opaqueIdSchema,
    semanticDigest: sha256Schema,
    orderingKey: taskIntentOrderingKeySchema,
  })
  .superRefine((value, ctx) => {
    if (value.sourceFactId !== value.policyDecision.sourceFactId) {
      ctx.addIssue({
        code: 'custom',
        path: ['policyDecision', 'sourceFactId'],
        message: 'Intent source fact must match policy source fact',
      });
    }
    if (
      (value.status === 'desired' || value.status === 'admitted') &&
      value.policyDecision.decision !== 'accepted'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['policyDecision', 'decision'],
        message: 'Desired intent requires accepted policy',
      });
    }
  });
export type TaskIntentHistoryPayload = z.infer<
  typeof taskIntentHistoryPayloadSchema
>;

const taskStreamHeadSchema = historyHeadSchema.superRefine((value, ctx) => {
  if (value.aggregateKind !== 'task') {
    ctx.addIssue({
      code: 'custom',
      path: ['aggregateKind'],
      message: 'Task only',
    });
  }
});

export const taskHistoryHeadSchema = z
  .strictObject({
    schema: z.literal(TASK_HEAD_SCHEMA),
    version: z.literal(1),
    tenant: tenantRefSchema,
    task: canonicalTaskIdentitySchema,
    aggregateId: opaqueIdSchema,
    activation: activationProvenanceSchema,
    aggregateRevision: nonnegativeSafeIntegerSchema,
    factHead: taskStreamHeadSchema,
    intentHead: taskStreamHeadSchema,
    desired: desiredIntentRelationSchema.optional(),
    attempt: taskAttemptRelationSchema,
    updatedAt: utcDateTimeSchema,
  })
  .superRefine((value, ctx) => {
    if (
      value.task.tenantId !== value.tenant.tenantId ||
      value.task.repositoryId !== value.tenant.repositoryId
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['task'],
        message: 'Task tenant mismatch',
      });
    }
    if (value.aggregateId !== taskHistoryAggregateId(value.task)) {
      ctx.addIssue({
        code: 'custom',
        path: ['aggregateId'],
        message: 'Task aggregate identity mismatch',
      });
    }
    for (const [path, head, streamKind] of [
      ['factHead', value.factHead, 'fact'],
      ['intentHead', value.intentHead, 'intent'],
    ] as const) {
      if (
        head.tenantId !== value.tenant.tenantId ||
        head.aggregateId !== value.aggregateId ||
        head.streamKind !== streamKind
      ) {
        ctx.addIssue({
          code: 'custom',
          path: [path],
          message: 'Task stream identity mismatch',
        });
      }
    }
    if (
      value.aggregateRevision < value.factHead.lastAppliedRevision ||
      value.aggregateRevision < value.intentHead.lastAppliedRevision
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['aggregateRevision'],
        message: 'Task revision cannot precede a stream revision',
      });
    }
    if (value.desired !== undefined) {
      if (value.desired.intentRevision === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['desired', 'intentRevision'],
          message: 'Task desired intent revision must be positive',
        });
      }
      if (
        value.desired.task.tenantId !== value.task.tenantId ||
        value.desired.task.repositoryId !== value.task.repositoryId ||
        value.desired.task.issueNumber !== value.task.issueNumber
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['desired'],
          message: 'Desired task mismatch',
        });
      }
    }
    if (value.desired === undefined) {
      if (value.attempt.kind === 'unlaunched') {
        ctx.addIssue({
          code: 'custom',
          path: ['attempt'],
          message: 'Unlaunched attempt requires desired state',
        });
      }
      if (
        value.attempt.kind === 'launched' &&
        (!value.attempt.staleForDesiredState ||
          !value.attempt.cancellationRequested)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['attempt'],
          message: 'Cleared desired state requires a cancelled attempt',
        });
      }
    }
    if (value.desired !== undefined && value.attempt.kind === 'none') {
      ctx.addIssue({
        code: 'custom',
        path: ['attempt'],
        message: 'Desired state requires an attempt relation',
      });
    }
    if (
      value.attempt.kind === 'unlaunched' &&
      (value.desired === undefined ||
        value.desired.intentId !== value.attempt.intentId)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['attempt'],
        message: 'Unlaunched attempt must be desired',
      });
    }
    if (value.attempt.kind === 'launched') {
      if (
        !value.attempt.staleForDesiredState &&
        !value.attempt.cancellationRequested &&
        (value.desired === undefined ||
          value.desired.intentId !== value.attempt.intentId ||
          value.desired.intentRevision !== value.attempt.intentRevision)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['attempt'],
          message: 'Fresh attempt must be the exact current desired intent',
        });
      }
      if (
        value.attempt.cancellationRequested &&
        !value.attempt.staleForDesiredState
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['attempt'],
          message: 'Cancellation requires stale desired state',
        });
      }
      if (
        !value.attempt.staleForDesiredState &&
        value.attempt.supersededByIntentId !== undefined
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['attempt'],
          message: 'Fresh attempt cannot be superseded',
        });
      }
      if (value.desired === undefined && !value.attempt.staleForDesiredState) {
        ctx.addIssue({
          code: 'custom',
          path: ['attempt'],
          message: 'Launched attempt without desired state must be stale',
        });
      }
      if (
        value.desired !== undefined &&
        value.desired.intentId === value.attempt.intentId &&
        value.desired.intentRevision !== value.attempt.intentRevision
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['attempt'],
          message:
            'Current desired attempt revision must match desired pointer',
        });
      }
      if (
        value.desired !== undefined &&
        value.desired.intentId === value.attempt.intentId &&
        (value.attempt.staleForDesiredState ||
          value.attempt.cancellationRequested ||
          value.attempt.supersededByIntentId !== undefined)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['attempt'],
          message: 'Current desired attempt cannot be stale',
        });
      }
      if (
        value.desired !== undefined &&
        value.desired.intentId !== value.attempt.intentId &&
        (!value.attempt.staleForDesiredState ||
          !value.attempt.cancellationRequested ||
          value.attempt.supersededByIntentId !== value.desired.intentId)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['attempt'],
          message: 'Superseded attempt relation is incomplete',
        });
      }
    }
  });
export type TaskHistoryHead = z.infer<typeof taskHistoryHeadSchema>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function parse<T>(
  schema: z.ZodType<T>,
  input: unknown,
  reason: 'invalid-record' | 'invalid-head',
): T {
  let normalized: DurableJsonValue;
  try {
    normalized = normalizeDurableValue(input);
  } catch (error) {
    if (error instanceof DurabilityCapacityError) throw error;
    throw new HistoryIntegrityError(reason);
  }
  const result = schema.safeParse(normalized);
  if (!result.success) throw new HistoryIntegrityError(reason);
  return deepFreeze(result.data);
}

function sameTask(
  left: CanonicalTaskIdentity,
  right: CanonicalTaskIdentity,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.repositoryId === right.repositoryId &&
    left.issueNumber === right.issueNumber
  );
}

function sameActivation(
  left: ActivationProvenance,
  right: ActivationProvenance,
): boolean {
  return (
    left.activationId === right.activationId &&
    left.taskClassId === right.taskClassId &&
    left.authorityEpoch === right.authorityEpoch &&
    left.mode === right.mode
  );
}

function verifyHead(input: unknown): TaskHistoryHead {
  const head = parse(taskHistoryHeadSchema, input, 'invalid-head');
  try {
    validateDurableValue(head, 'taskHeadBytes');
  } catch (error) {
    if (error instanceof DurabilityCapacityError) throw error;
    throw new HistoryIntegrityError('invalid-head');
  }
  return head;
}

function taskStreamIdentity(
  input: { tenant: TenantRef; aggregateId: string },
  streamKind: 'fact' | 'intent',
) {
  return {
    tenantId: input.tenant.tenantId,
    aggregateKind: 'task' as const,
    aggregateId: input.aggregateId,
    streamKind,
  };
}

export interface TaskHistoryHeadInput {
  readonly tenant: TenantRef;
  readonly task: CanonicalTaskIdentity;
  readonly activation: ActivationProvenance;
  readonly updatedAt: string;
}

/** Stable, opaque aggregate key; tenant remains separately scoped in records. */
export function taskHistoryAggregateId(task: CanonicalTaskIdentity): string {
  return sha256Digest(
    `agent-lcars.task-history-aggregate/v1\u0000${canonicalDurableJson(task)}`,
  );
}

export function createGenesisTaskHistoryHead(
  input: TaskHistoryHeadInput,
): TaskHistoryHead {
  const aggregateId = taskHistoryAggregateId(input.task);
  const factHead = createGenesisHistoryHead(
    taskStreamIdentity({ tenant: input.tenant, aggregateId }, 'fact'),
  );
  const intentHead = createGenesisHistoryHead(
    taskStreamIdentity({ tenant: input.tenant, aggregateId }, 'intent'),
  );
  return verifyHead({
    schema: TASK_HEAD_SCHEMA,
    version: 1,
    tenant: input.tenant,
    task: input.task,
    aggregateId: taskHistoryAggregateId(input.task),
    activation: input.activation,
    aggregateRevision: 0,
    factHead,
    intentHead,
    attempt: { kind: 'none' },
    updatedAt: input.updatedAt,
  });
}

function parseFactPayload(input: unknown): TaskFactHistoryPayload {
  return parse(taskFactHistoryPayloadSchema, input, 'invalid-record');
}

function parseIntentPayload(input: unknown): TaskIntentHistoryPayload {
  return parse(taskIntentHistoryPayloadSchema, input, 'invalid-record');
}

export interface TaskHistoryRecordInput {
  readonly head: HistoryHead;
  readonly payload: unknown;
  readonly appliedRevision: number;
}

export function createTaskFactHistoryRecord(
  input: TaskHistoryRecordInput,
): HistoryRecord {
  if (input.head.aggregateKind !== 'task' || input.head.streamKind !== 'fact') {
    throw new HistoryIntegrityError('wrong-identity');
  }
  const payload = parseFactPayload(input.payload);
  assertFactSituation(payload);
  if (payload.policyDecision.sourceFactId !== payload.factId) {
    throw new HistoryIntegrityError('wrong-identity');
  }
  if (
    input.head.tenantId !== payload.task.tenantId ||
    input.head.aggregateId !== taskHistoryAggregateId(payload.task)
  ) {
    throw new HistoryIntegrityError('wrong-identity');
  }
  const result = appendHistoryRecord({
    head: input.head,
    payload,
    appliedRevision: input.appliedRevision,
  });
  if (
    result.record.aggregateKind !== 'task' ||
    result.record.streamKind !== 'fact'
  ) {
    throw new HistoryIntegrityError('wrong-identity');
  }
  return result.record;
}

export function createTaskIntentHistoryRecord(
  input: TaskHistoryRecordInput,
): HistoryRecord {
  if (
    input.head.aggregateKind !== 'task' ||
    input.head.streamKind !== 'intent'
  ) {
    throw new HistoryIntegrityError('wrong-identity');
  }
  const payload = parseIntentPayload(input.payload);
  if (
    input.head.tenantId !== payload.task.tenantId ||
    input.head.aggregateId !== taskHistoryAggregateId(payload.task)
  ) {
    throw new HistoryIntegrityError('wrong-identity');
  }
  const result = appendHistoryRecord({
    head: input.head,
    payload,
    appliedRevision: input.appliedRevision,
  });
  if (
    result.record.aggregateKind !== 'task' ||
    result.record.streamKind !== 'intent'
  ) {
    throw new HistoryIntegrityError('wrong-identity');
  }
  return result.record;
}

export function verifyTaskFactHistoryRecord(
  record: unknown,
  payload: unknown,
): TaskFactHistoryPayload {
  const valid = verifyHistoryRecord(record);
  if (valid.aggregateKind !== 'task' || valid.streamKind !== 'fact')
    throw new HistoryIntegrityError('wrong-identity');
  const parsed = parseFactPayload(
    verifyHistoryRecordPayload(valid, payload).payload,
  );
  assertFactSituation(parsed);
  if (parsed.policyDecision.sourceFactId !== parsed.factId) {
    throw new HistoryIntegrityError('wrong-identity');
  }
  if (
    valid.tenantId !== parsed.task.tenantId ||
    valid.aggregateId !== taskHistoryAggregateId(parsed.task)
  )
    throw new HistoryIntegrityError('wrong-identity');
  if (valid.payloadDigest !== historyPayloadDigest(parsed))
    throw new HistoryIntegrityError('digest-mismatch');
  return parsed;
}

export function verifyTaskIntentHistoryRecord(
  record: unknown,
  payload: unknown,
): TaskIntentHistoryPayload {
  const valid = verifyHistoryRecord(record);
  if (valid.aggregateKind !== 'task' || valid.streamKind !== 'intent')
    throw new HistoryIntegrityError('wrong-identity');
  const parsed = parseIntentPayload(
    verifyHistoryRecordPayload(valid, payload).payload,
  );
  if (
    valid.tenantId !== parsed.task.tenantId ||
    valid.aggregateId !== taskHistoryAggregateId(parsed.task)
  )
    throw new HistoryIntegrityError('wrong-identity');
  if (valid.payloadDigest !== historyPayloadDigest(parsed))
    throw new HistoryIntegrityError('digest-mismatch');
  return parsed;
}

function verifyReferenceList(
  refs: readonly unknown[],
  head: TaskHistoryHead,
  streamKind: 'effect' | 'command' | 'presentation',
): HistoryRecordReference[] {
  return refs.map((ref) => {
    const parsed = historyRecordReferenceSchema.safeParse(ref);
    if (!parsed.success) throw new HistoryIntegrityError('invalid-record');
    const value = parsed.data;
    if (
      value.tenantId !== head.tenant.tenantId ||
      value.aggregateKind !== 'task' ||
      value.aggregateId !== head.aggregateId ||
      value.streamKind !== streamKind
    )
      throw new HistoryIntegrityError('wrong-identity');
    return deepFreeze(value);
  });
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalDurableJson(left) === canonicalDurableJson(right);
}

function assertIntentMatch(
  intent: TaskIntentHistoryPayload | undefined,
  identity: { intentId?: string; intentRevision?: number },
  status?: TaskIntentHistoryPayload['status'],
): void {
  if (
    intent === undefined ||
    intent.intentId !== identity.intentId ||
    intent.revision !== identity.intentRevision ||
    (status !== undefined && intent.status !== status)
  )
    throw new HistoryIntegrityError('wrong-sequence');
}

function assertFactSituation(fact: TaskFactHistoryPayload): void {
  const accepted = fact.policyDecision.decision === 'accepted';
  const { kind } = fact.resolution;
  const valid =
    kind === 'parked'
      ? (accepted && fact.situation === 'park') ||
        (!accepted && fact.situation === 'requested-work')
      : kind === 'cancelled'
        ? accepted && fact.situation === 'cancel'
        : kind === 'observed'
          ? fact.situation === 'reconcile'
          : kind === 'rejected'
            ? !accepted && fact.situation === 'requested-work'
            : accepted &&
              (fact.situation === 'requested-work' ||
                fact.situation === 'reconcile');
  if (!valid) throw new HistoryIntegrityError('wrong-identity');
}

function assertTaskResolution(
  head: TaskHistoryHead,
  fact: TaskFactHistoryPayload,
  intents: readonly TaskIntentHistoryPayload[],
  desired: DesiredIntentRelation | undefined,
  attempt: TaskAttemptRelation,
): void {
  const resolution = fact.resolution;
  const first = intents[0];
  const second = intents[1];
  switch (resolution.kind) {
    case 'desired': {
      if (second !== undefined) {
        if (
          first === undefined ||
          first.status !== 'superseded' ||
          head.desired?.intentId !== first.intentId ||
          head.desired?.intentRevision === undefined ||
          head.desired.intentRevision === Number.MAX_SAFE_INTEGER ||
          first.revision !== head.desired.intentRevision + 1 ||
          second.intentId === first.intentId ||
          second.revision !== 1 ||
          desired?.supersedesIntentId !== first.intentId
        ) {
          throw new HistoryIntegrityError('wrong-identity');
        }
        assertIntentMatch(second, resolution, 'desired');
      } else {
        if (
          first === undefined ||
          first.status !== 'desired' ||
          head.desired !== undefined ||
          first.revision !== 1
        )
          throw new HistoryIntegrityError('wrong-sequence');
        assertIntentMatch(first, resolution, 'desired');
        if (desired?.supersedesIntentId !== undefined)
          throw new HistoryIntegrityError('wrong-identity');
      }
      if (
        desired === undefined ||
        desired.intentId !== resolution.intentId ||
        desired.intentRevision !== resolution.intentRevision
      ) {
        throw new HistoryIntegrityError('wrong-identity');
      }
      if (head.attempt.kind === 'launched') {
        if (
          attempt.kind !== 'launched' ||
          attempt.intentId !== head.attempt.intentId ||
          attempt.intentRevision !== head.attempt.intentRevision ||
          attempt.attemptId !== head.attempt.attemptId ||
          attempt.admissionRevision !== head.attempt.admissionRevision ||
          attempt.admittedAt !== head.attempt.admittedAt ||
          !attempt.staleForDesiredState ||
          !attempt.cancellationRequested ||
          attempt.supersededByIntentId !== resolution.intentId
        )
          throw new HistoryIntegrityError('wrong-identity');
      } else if (
        attempt.kind !== 'unlaunched' ||
        attempt.intentId !== resolution.intentId
      ) {
        throw new HistoryIntegrityError('wrong-identity');
      }
      return;
    }
    case 'stale':
      if (intents.length !== 1)
        throw new HistoryIntegrityError('wrong-sequence');
      assertIntentMatch(first, resolution, 'superseded');
      if (
        !sameValue(desired, head.desired) ||
        !sameValue(attempt, head.attempt)
      )
        throw new HistoryIntegrityError('wrong-identity');
      return;
    case 'semantic-duplicate':
      if (
        intents.length !== 0 ||
        !sameValue(desired, head.desired) ||
        !sameValue(attempt, head.attempt)
      )
        throw new HistoryIntegrityError('wrong-identity');
      return;
    case 'parked':
    case 'cancelled':
      if (intents.length > 1) throw new HistoryIntegrityError('wrong-sequence');
      if (
        resolution.kind === 'parked' &&
        fact.policyDecision.decision === 'rejected'
      ) {
        if (
          first === undefined ||
          first.status !== 'parked' ||
          first.revision !== 1 ||
          !sameValue(first.policyDecision, fact.policyDecision) ||
          !sameValue(desired, head.desired) ||
          !sameValue(attempt, head.attempt)
        )
          throw new HistoryIntegrityError('wrong-identity');
        assertIntentMatch(first, resolution, 'parked');
        return;
      }
      if (first !== undefined) {
        if (
          head.desired === undefined ||
          head.desired.intentId !== first.intentId ||
          head.desired.intentRevision === Number.MAX_SAFE_INTEGER ||
          first.revision !== head.desired.intentRevision + 1
        ) {
          throw new HistoryIntegrityError('wrong-identity');
        }
        assertIntentMatch(
          first,
          resolution,
          resolution.kind === 'parked' ? 'parked' : 'cancelled',
        );
      } else if (
        resolution.intentId !== undefined ||
        resolution.intentRevision !== undefined
      )
        throw new HistoryIntegrityError('missing-reference');
      else if (head.desired !== undefined)
        throw new HistoryIntegrityError('missing-reference');
      if (desired !== undefined)
        throw new HistoryIntegrityError('wrong-identity');
      if (head.attempt.kind === 'unlaunched') {
        if (attempt.kind !== 'none')
          throw new HistoryIntegrityError('wrong-identity');
      } else if (head.attempt.kind === 'launched') {
        if (
          attempt.kind !== 'launched' ||
          attempt.intentId !== head.attempt.intentId ||
          attempt.intentRevision !== head.attempt.intentRevision ||
          attempt.attemptId !== head.attempt.attemptId ||
          attempt.admissionRevision !== head.attempt.admissionRevision ||
          attempt.admittedAt !== head.attempt.admittedAt ||
          attempt.supersededByIntentId !== head.attempt.supersededByIntentId ||
          !attempt.staleForDesiredState ||
          !attempt.cancellationRequested
        )
          throw new HistoryIntegrityError('wrong-identity');
      } else if (!sameValue(attempt, head.attempt))
        throw new HistoryIntegrityError('wrong-identity');
      return;
    case 'rejected':
    case 'observed':
      if (
        intents.length !== 0 ||
        !sameValue(desired, head.desired) ||
        !sameValue(attempt, head.attempt)
      )
        throw new HistoryIntegrityError('wrong-identity');
  }
}

export interface TaskHistoryTransitionInput {
  readonly head: TaskHistoryHead;
  readonly fact: TaskFactHistoryPayload;
  readonly intents: readonly TaskIntentHistoryPayload[];
  readonly appliedRevision: number;
  readonly desired?: DesiredIntentRelation;
  readonly attempt: TaskAttemptRelation;
  readonly updatedAt: string;
  readonly effectRefs: readonly HistoryRecordReference[];
  readonly workRefs: readonly HistoryRecordReference[];
  readonly presentationRefs: readonly HistoryRecordReference[];
}

export interface TaskHistoryTransitionResult {
  readonly head: TaskHistoryHead;
  readonly factRecord: HistoryRecord;
  readonly intentRecords: readonly HistoryRecord[];
  readonly effectRefs: readonly HistoryRecordReference[];
  readonly workRefs: readonly HistoryRecordReference[];
  readonly presentationRefs: readonly HistoryRecordReference[];
  readonly bytes: number;
}

export function validateTaskHistoryTransition(
  input: TaskHistoryTransitionInput,
): TaskHistoryTransitionResult {
  const head = verifyHead(input.head);
  const fact = parseFactPayload(input.fact);
  const intents = input.intents.map(parseIntentPayload);
  if (intents.length > 2)
    throw new DurabilityCapacityError(
      'transitionHistoryRecordCount',
      intents.length + 1,
      3,
      'items',
    );
  if (head.aggregateRevision === Number.MAX_SAFE_INTEGER)
    throw new HistoryIntegrityError('sequence-overflow');
  if (input.appliedRevision !== head.aggregateRevision + 1)
    throw new HistoryIntegrityError('wrong-sequence');
  if (fact.resolution.taskRevision !== input.appliedRevision)
    throw new HistoryIntegrityError('wrong-sequence');
  if (
    !sameTask(fact.task, head.task) ||
    fact.policyDecision.sourceFactId !== fact.factId
  )
    throw new HistoryIntegrityError('wrong-identity');
  assertFactSituation(fact);
  for (const intent of intents) {
    if (
      !sameTask(intent.task, head.task) ||
      intent.sourceFactId !== fact.factId ||
      !sameActivation(intent.activation, head.activation) ||
      !sameValue(intent.policyDecision, fact.policyDecision) ||
      intent.createdAt !== fact.acceptedAt
    )
      throw new HistoryIntegrityError('missing-reference');
  }
  assertTaskResolution(head, fact, intents, input.desired, input.attempt);
  const effectRefs = verifyReferenceList(input.effectRefs, head, 'effect');
  const workRefs = verifyReferenceList(input.workRefs, head, 'command');
  const presentationRefs = verifyReferenceList(
    input.presentationRefs,
    head,
    'presentation',
  );
  const factResult = appendHistoryRecord({
    head: head.factHead,
    payload: fact,
    appliedRevision: input.appliedRevision,
  });
  let intentHead = head.intentHead;
  const intentRecords: HistoryRecord[] = [];
  for (const intent of intents) {
    const appended = appendHistoryRecord({
      head: intentHead,
      payload: intent,
      appliedRevision: input.appliedRevision,
    });
    intentHead = appended.head;
    intentRecords.push(appended.record);
  }
  const transition = validateDurableTransition({
    effects: [...effectRefs, ...presentationRefs],
    historyRecords: [
      { record: factResult.record, payload: fact },
      ...intentRecords.map((record, index) => ({
        record,
        payload: intents[index],
      })),
    ],
    workRecords: workRefs,
  });
  const { desired: _previousDesired, ...headWithoutDesired } = head;
  const nextHead = verifyHead({
    ...headWithoutDesired,
    aggregateRevision: input.appliedRevision,
    factHead: factResult.head,
    intentHead,
    attempt: input.attempt,
    updatedAt: input.updatedAt,
    ...(input.desired === undefined ? {} : { desired: input.desired }),
  });
  return deepFreeze({
    head: nextHead,
    factRecord: factResult.record,
    intentRecords,
    effectRefs,
    workRefs,
    presentationRefs,
    bytes: transition.bytes,
  });
}

export interface LegacyTaskFact {
  readonly factId: string;
  readonly requestId: string;
  readonly sourceKey: string;
  readonly canonicalDigest: string;
  readonly situation?: TaskFactSituation;
  readonly policyDecision: PolicyDecision;
  readonly resolution: TaskIntentResolution;
  readonly acceptedAt: string;
}

export interface LegacyTaskIntent {
  readonly task: CanonicalTaskIdentity;
  readonly intentId: string;
  readonly revision: number;
  readonly status: z.infer<typeof intentStatusSchema>;
  readonly sourceFactId: string;
  readonly policyDecision: PolicyDecision;
  readonly activation: ActivationProvenance;
  readonly createdAt: string;
  readonly semanticKey: string;
  readonly semanticDigest: string;
  readonly orderingKey: { occurredAt: string; tieBreaker: string };
}

export interface LegacyTaskIntentState {
  readonly schema: 'agent-lcars.task-intent-state/v1';
  readonly version: 1;
  readonly tenant: TenantRef;
  readonly task: CanonicalTaskIdentity;
  readonly revision: number;
  readonly activation: ActivationProvenance;
  readonly facts: readonly LegacyTaskFact[];
  readonly intents: readonly LegacyTaskIntent[];
  readonly desired?: DesiredIntentRelation;
  readonly attempt: TaskAttemptRelation;
  readonly updatedAt: string;
}

export interface LegacyTaskHistoryUpgradeInput {
  readonly state: LegacyTaskIntentState;
}

export interface LegacyTaskHistoryUpgradeResult {
  readonly head: TaskHistoryHead;
  readonly factRecords: readonly HistoryRecord[];
  readonly intentRecords: readonly HistoryRecord[];
}

export function upgradeLegacyTaskIntentState(
  input: LegacyTaskHistoryUpgradeInput,
): LegacyTaskHistoryUpgradeResult {
  const state = input.state;
  // Close and size the complete legacy value before deriving any records. This
  // guarantees malformed/cyclic/over-capacity input cannot partially migrate.
  try {
    validateDurableValue(state, 'taskHeadBytes');
  } catch (error) {
    if (error instanceof DurabilityCapacityError) throw error;
    throw new HistoryIntegrityError('invalid-head');
  }
  const maximumLegacyItems = LIFECYCLE_DURABILITY_LIMITS.maxContainerItems;
  if (state.facts.length > maximumLegacyItems)
    throw new DurabilityCapacityError(
      'maxContainerItems',
      state.facts.length,
      maximumLegacyItems,
      'items',
    );
  if (state.intents.length > maximumLegacyItems)
    throw new DurabilityCapacityError(
      'maxContainerItems',
      state.intents.length,
      maximumLegacyItems,
      'items',
    );
  if (!Number.isSafeInteger(state.revision) || state.revision < 0)
    throw new HistoryIntegrityError('invalid-head');
  if (
    !sameTask(state.task, {
      tenantId: state.tenant.tenantId,
      repositoryId: state.tenant.repositoryId,
      issueNumber: state.task.issueNumber,
    })
  )
    throw new HistoryIntegrityError('wrong-identity');
  const head = createGenesisTaskHistoryHead({
    tenant: state.tenant,
    task: state.task,
    activation: state.activation,
    updatedAt: state.updatedAt,
  });
  let factHead = head.factHead;
  let intentHead = head.intentHead;
  const factRecords: HistoryRecord[] = [];
  const intentRecords: HistoryRecord[] = [];
  const factRevisions = new Map<string, number>();
  const factPayloads = new Map<string, TaskFactHistoryPayload>();
  const requestIds = new Set<string>();
  const sourceKeys = new Set<string>();
  let lastFactRevision = 0;
  for (const legacyFact of state.facts) {
    const payload = parseFactPayload({
      schema: TASK_FACT_SCHEMA,
      version: 1,
      task: state.task,
      ...legacyFact,
      situation:
        legacyFact.situation ??
        (legacyFact.resolution.kind === 'cancelled'
          ? 'cancel'
          : legacyFact.resolution.kind === 'parked' &&
              legacyFact.policyDecision.decision === 'accepted'
            ? 'park'
            : 'requested-work'),
    });
    assertFactSituation(payload);
    if (factRevisions.has(payload.factId))
      throw new HistoryIntegrityError('wrong-sequence');
    if (
      payload.policyDecision.sourceFactId !== payload.factId ||
      requestIds.has(payload.requestId) ||
      sourceKeys.has(payload.sourceKey) ||
      payload.resolution.taskRevision <= lastFactRevision
    )
      throw new HistoryIntegrityError('replay-conflict');
    const result = appendHistoryRecord({
      head: factHead,
      payload,
      appliedRevision: payload.resolution.taskRevision,
    });
    factHead = result.head;
    factRecords.push(result.record);
    factRevisions.set(payload.factId, payload.resolution.taskRevision);
    factPayloads.set(payload.factId, payload);
    requestIds.add(payload.requestId);
    sourceKeys.add(payload.sourceKey);
    lastFactRevision = payload.resolution.taskRevision;
  }
  const intentRevisions = new Map<string, number>();
  const intentSemantics = new Map<
    string,
    {
      semanticKey: string;
      semanticDigest: string;
      orderingKey: { occurredAt: string; tieBreaker: string };
    }
  >();
  const semanticDigests = new Map<string, string>();
  let lastIntentAppliedRevision = 0;
  for (const legacyIntent of state.intents) {
    const appliedRevision = factRevisions.get(legacyIntent.sourceFactId);
    if (appliedRevision === undefined)
      throw new HistoryIntegrityError('missing-reference');
    const payload = parseIntentPayload({
      schema: TASK_INTENT_SCHEMA,
      version: 1,
      ...legacyIntent,
    });
    if (
      !sameTask(payload.task, state.task) ||
      !sameActivation(payload.activation, state.activation) ||
      payload.createdAt !==
        factPayloads.get(payload.sourceFactId)?.acceptedAt ||
      !sameValue(
        payload.policyDecision,
        factPayloads.get(payload.sourceFactId)?.policyDecision,
      )
    )
      throw new HistoryIntegrityError('wrong-identity');
    const expectedRevision = (intentRevisions.get(payload.intentId) ?? 0) + 1;
    if (payload.revision !== expectedRevision)
      throw new HistoryIntegrityError('wrong-sequence');
    if (appliedRevision < lastIntentAppliedRevision)
      throw new HistoryIntegrityError('wrong-sequence');
    const priorSemantic = intentSemantics.get(payload.intentId);
    if (
      priorSemantic !== undefined &&
      !sameValue(priorSemantic, {
        semanticKey: payload.semanticKey,
        semanticDigest: payload.semanticDigest,
        orderingKey: payload.orderingKey,
      })
    )
      throw new HistoryIntegrityError('replay-conflict');
    const priorDigest = semanticDigests.get(payload.semanticKey);
    if (priorDigest !== undefined && priorDigest !== payload.semanticDigest)
      throw new HistoryIntegrityError('replay-conflict');
    const result = appendHistoryRecord({
      head: intentHead,
      payload,
      appliedRevision,
    });
    intentHead = result.head;
    intentRecords.push(result.record);
    intentRevisions.set(payload.intentId, payload.revision);
    intentSemantics.set(payload.intentId, {
      semanticKey: payload.semanticKey,
      semanticDigest: payload.semanticDigest,
      orderingKey: payload.orderingKey,
    });
    semanticDigests.set(payload.semanticKey, payload.semanticDigest);
    lastIntentAppliedRevision = appliedRevision;
  }
  const intentPayloads = state.intents.map((legacyIntent) =>
    parseIntentPayload({
      schema: TASK_INTENT_SCHEMA,
      version: 1,
      ...legacyIntent,
    }),
  );
  if (state.desired !== undefined) {
    const selected = intentPayloads.find(
      (candidate) =>
        candidate.intentId === state.desired?.intentId &&
        candidate.revision === state.desired?.intentRevision,
    );
    if (selected === undefined || selected.status !== 'desired')
      throw new HistoryIntegrityError('missing-reference');
    if (
      state.desired.supersedesIntentId !== undefined &&
      !intentPayloads.some(
        (candidate) =>
          candidate.intentId === state.desired?.supersedesIntentId &&
          candidate.status === 'superseded',
      )
    )
      throw new HistoryIntegrityError('missing-reference');
  }
  if (state.attempt.kind === 'unlaunched') {
    if (
      state.desired === undefined ||
      state.desired.intentId !== state.attempt.intentId
    )
      throw new HistoryIntegrityError('wrong-identity');
  }
  if (state.attempt.kind === 'launched') {
    const launchedAttempt = state.attempt;
    const launched = intentPayloads.find(
      (candidate) =>
        candidate.intentId === launchedAttempt.intentId &&
        candidate.revision === launchedAttempt.intentRevision,
    );
    if (launched === undefined)
      throw new HistoryIntegrityError('missing-reference');
    if (
      !launchedAttempt.staleForDesiredState &&
      !launchedAttempt.cancellationRequested &&
      (state.desired === undefined ||
        state.desired.intentId !== launchedAttempt.intentId ||
        state.desired.intentRevision !== launchedAttempt.intentRevision ||
        launched.status !== 'admitted')
    )
      throw new HistoryIntegrityError('wrong-identity');
  }
  const { desired: _previousDesired, ...headWithoutDesired } = head;
  const upgraded = verifyHead({
    ...headWithoutDesired,
    aggregateRevision: state.revision,
    factHead,
    intentHead,
    attempt: state.attempt,
    ...(state.desired === undefined ? {} : { desired: state.desired }),
  });
  return deepFreeze({ head: upgraded, factRecords, intentRecords });
}

export const taskFactPayloadSchema = taskFactHistoryPayloadSchema;
export const taskIntentPayloadSchema = taskIntentHistoryPayloadSchema;
export const taskHistoryHeadSchemaV1 = taskHistoryHeadSchema;
export const createTaskFactRecord = createTaskFactHistoryRecord;
export const createTaskIntentRecord = createTaskIntentHistoryRecord;
export const upgradeTaskIntentState = upgradeLegacyTaskIntentState;
