import { z } from 'zod';

import {
  type AcceptedAttemptSpec,
  acceptedAttemptSpecSchema,
  type RunBinding,
  runBindingSchema,
} from './attempt';
import {
  canonicalDurableJson,
  DurabilityCapacityError,
  type DurableJsonValue,
  LIFECYCLE_DURABILITY_LIMITS,
  normalizeDurableValue,
  validateDurableTransition,
  validateDurableValue,
} from './durability';
import { persistedFailureClassificationSchema } from './failure';
import {
  appendHistoryRecord,
  createGenesisHistoryHead,
  type HistoryHead,
  historyHeadSchema,
  HistoryIntegrityError,
  historyPayloadDigest,
  type HistoryRecord,
  historyRecordReference,
  sha256Digest,
  verifyHistoryRecordPayload,
} from './history';
import {
  agentResultClaimSchema,
  type AgentResultClaimV1,
  type AttemptOutcome,
  attemptOutcomeSchema,
  canonicalRuntimeObservationPayload,
  type EvidenceValidation,
  evidenceValidationSchema,
  type ObservationSource,
  observationSourceSchema,
  type RuntimeObservationPayload,
} from './observation';
import {
  nonnegativeSafeIntegerSchema,
  opaqueIdSchema,
  positiveSafeIntegerSchema,
  sha256Schema,
  utcDateTimeSchema,
} from './primitives';

export const ATTEMPT_HISTORY_STREAMS = [
  'fact',
  'command',
  'claim',
  'validation',
  'evidence',
] as const;
export type AttemptHistoryStream = (typeof ATTEMPT_HISTORY_STREAMS)[number];
export const attemptHistoryStreamSchema = z.enum(ATTEMPT_HISTORY_STREAMS);

export const attemptHistoryIdentitySchema = z.strictObject({
  tenantId: opaqueIdSchema,
  attemptId: opaqueIdSchema,
});
export type AttemptHistoryIdentity = z.infer<
  typeof attemptHistoryIdentitySchema
>;

const recordReferenceSchema = z.strictObject({
  schema: z.literal('agent-lcars.lifecycle-history-record-reference/v1'),
  version: z.literal(1),
  tenantId: opaqueIdSchema,
  aggregateKind: z.literal('attempt'),
  aggregateId: opaqueIdSchema,
  streamKind: attemptHistoryStreamSchema,
  sequence: positiveSafeIntegerSchema,
  recordDigest: sha256Schema,
});
export const attemptHistoryRecordReferenceSchema = recordReferenceSchema;
export type AttemptHistoryRecordReference = z.infer<
  typeof recordReferenceSchema
>;

const factPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('run-bound'),
    binding: runBindingSchema,
  }),
  z.strictObject({
    kind: z.literal('heartbeat'),
    grantId: opaqueIdSchema,
    at: utcDateTimeSchema,
    phase: z.enum([
      'bootstrap',
      'provider-admission',
      'provider-execution',
      'agent-execution',
    ]),
  }),
  z.strictObject({
    kind: z.literal('run-terminal'),
    binding: runBindingSchema,
    conclusion: z.enum([
      'success',
      'failure',
      'cancelled',
      'timed_out',
      'skipped',
    ]),
    observedAt: utcDateTimeSchema,
    finalizationDeadline: utcDateTimeSchema,
  }),
  z.strictObject({
    kind: z.literal('agent-result-claim'),
    claimFactId: opaqueIdSchema,
    claimDigest: sha256Schema,
    claim: agentResultClaimSchema,
  }),
  z.strictObject({
    kind: z.literal('adapter-failure'),
    failure: persistedFailureClassificationSchema,
  }),
]);
export type AttemptFactPayload = z.infer<typeof factPayloadSchema>;

export const attemptFactPayloadSchema = z
  .strictObject({
    schema: z.literal('agent-lcars.attempt-fact/v1'),
    version: z.literal(1),
    factId: opaqueIdSchema,
    requestId: opaqueIdSchema,
    source: observationSourceSchema,
    observedAt: utcDateTimeSchema,
    transitionedAt: utcDateTimeSchema,
    payloadSha256: sha256Schema,
    canonicalDigest: sha256Schema,
    payload: factPayloadSchema,
  })
  .superRefine((fact, ctx) => {
    if (
      fact.payload.kind === 'run-terminal' &&
      fact.payload.observedAt !== fact.observedAt
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['observedAt'],
        message: 'Terminal observation time must match its payload',
      });
    }
    if (
      fact.payloadSha256 !==
      sha256Digest(
        canonicalRuntimeObservationPayload(
          runtimeFactPayload(fact as AttemptFactRecordPayload),
        ),
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['payloadSha256'],
        message: 'Fact payload digest does not match runtime payload',
      });
    }
  });
export type AttemptFactRecordPayload = z.infer<typeof attemptFactPayloadSchema>;

const commandPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('attempt-registered'),
    commandId: opaqueIdSchema,
    specDigest: sha256Schema,
  }),
  z.strictObject({
    kind: z.literal('launch-accepted'),
    commandId: opaqueIdSchema,
  }),
  z.strictObject({
    kind: z.literal('launch-response-unknown'),
    commandId: opaqueIdSchema,
  }),
  z.strictObject({
    kind: z.literal('launch-rejected'),
    commandId: opaqueIdSchema,
    outcomeDigest: sha256Schema,
    outcome: attemptOutcomeSchema,
  }),
  z.strictObject({
    kind: z.literal('start-validation'),
    commandId: opaqueIdSchema,
    at: utcDateTimeSchema,
    terminalFactRef: recordReferenceSchema,
  }),
  z.strictObject({
    kind: z.literal('validate-claim-requested'),
    commandId: opaqueIdSchema,
    terminalFactRef: recordReferenceSchema,
    claimFactRef: recordReferenceSchema,
    validation: evidenceValidationSchema,
  }),
  z.strictObject({
    kind: z.literal('finalize'),
    commandId: opaqueIdSchema,
    outcomeDigest: sha256Schema,
    outcome: attemptOutcomeSchema,
  }),
  z.strictObject({
    kind: z.literal('cancel-unlaunched'),
    commandId: opaqueIdSchema,
    supersededByIntentId: opaqueIdSchema.optional(),
    outcomeDigest: sha256Schema,
    outcome: attemptOutcomeSchema,
  }),
  z.strictObject({
    kind: z.literal('request-cancel'),
    commandId: opaqueIdSchema,
    supersededByIntentId: opaqueIdSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('mark-lost'),
    commandId: opaqueIdSchema,
    outcomeDigest: sha256Schema,
    outcome: attemptOutcomeSchema,
  }),
]);
export type AttemptCommandPayload = z.infer<typeof commandPayloadSchema>;

export const attemptCommandPayloadSchema = z
  .strictObject({
    schema: z.literal('agent-lcars.attempt-command/v1'),
    version: z.literal(1),
    transitionedAt: utcDateTimeSchema,
    canonicalDigest: sha256Schema,
    payload: commandPayloadSchema,
  })
  .superRefine((command, ctx) => {
    if (
      'outcomeDigest' in command.payload &&
      command.payload.outcomeDigest !==
        historyPayloadDigest(command.payload.outcome)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['payload', 'outcomeDigest'],
        message: 'Outcome digest does not match command outcome',
      });
    }
  });
export type AttemptCommandRecordPayload = z.infer<
  typeof attemptCommandPayloadSchema
>;

export const attemptClaimPayloadSchema = z.strictObject({
  schema: z.literal('agent-lcars.attempt-claim/v1'),
  version: z.literal(1),
  claimFactId: opaqueIdSchema,
  factRef: recordReferenceSchema,
  requestId: opaqueIdSchema,
  observedAt: utcDateTimeSchema,
  transitionedAt: utcDateTimeSchema,
  claimDigest: sha256Schema,
  claim: agentResultClaimSchema,
});
export type AttemptClaimRecordPayload = z.infer<
  typeof attemptClaimPayloadSchema
>;

export const attemptValidationPayloadSchema = z.strictObject({
  schema: z.literal('agent-lcars.attempt-validation/v1'),
  version: z.literal(1),
  commandId: opaqueIdSchema,
  validationFactId: opaqueIdSchema,
  terminalFactRef: recordReferenceSchema,
  claimFactRef: recordReferenceSchema,
  validatedAt: utcDateTimeSchema,
  transitionedAt: utcDateTimeSchema,
  validation: evidenceValidationSchema,
});
export type AttemptValidationRecordPayload = z.infer<
  typeof attemptValidationPayloadSchema
>;

const referenceList = z
  .array(recordReferenceSchema)
  .max(LIFECYCLE_DURABILITY_LIMITS.transitionHistoryRecordCount);
export const attemptEvidencePayloadSchema = z
  .strictObject({
    schema: z.literal('agent-lcars.attempt-evidence/v1'),
    version: z.literal(1),
    finalizeCommandRef: recordReferenceSchema,
    terminalFactRef: recordReferenceSchema.optional(),
    claimRefs: referenceList,
    validationRefs: referenceList,
    outcomeDigest: sha256Schema,
    outcome: attemptOutcomeSchema,
    transitionedAt: utcDateTimeSchema,
  })
  .superRefine((evidence, ctx) => {
    if (evidence.outcomeDigest !== historyPayloadDigest(evidence.outcome)) {
      ctx.addIssue({
        code: 'custom',
        path: ['outcomeDigest'],
        message: 'Outcome digest does not match the immutable evidence',
      });
    }
  });
export type AttemptEvidenceRecordPayload = z.infer<
  typeof attemptEvidencePayloadSchema
>;

export const attemptHistoryRecordPayloadSchema = z.discriminatedUnion(
  'stream',
  [
    z.strictObject({
      stream: z.literal('fact'),
      payload: attemptFactPayloadSchema,
    }),
    z.strictObject({
      stream: z.literal('command'),
      payload: attemptCommandPayloadSchema,
    }),
    z.strictObject({
      stream: z.literal('claim'),
      payload: attemptClaimPayloadSchema,
    }),
    z.strictObject({
      stream: z.literal('validation'),
      payload: attemptValidationPayloadSchema,
    }),
    z.strictObject({
      stream: z.literal('evidence'),
      payload: attemptEvidencePayloadSchema,
    }),
  ],
);
export type AttemptHistoryRecordPayload = z.infer<
  typeof attemptHistoryRecordPayloadSchema
>;

const launchStateSchema = z.enum(['recorded', 'accepted', 'response-unknown']);
const attemptPhaseSchema = z.enum([
  'launch-pending',
  'launch-accepted',
  'launch-response-unknown',
  'launch-rejected',
  'active',
  'result-observed',
  'validating',
  'cancelling',
  'terminal',
]);

const streamHeadsSchema = z.strictObject({
  fact: historyHeadSchema,
  command: historyHeadSchema,
  claim: historyHeadSchema,
  validation: historyHeadSchema,
  evidence: historyHeadSchema,
});

const pendingTerminalSchema = z.strictObject({
  terminalFactRef: recordReferenceSchema,
  binding: runBindingSchema,
  conclusion: z.enum([
    'success',
    'failure',
    'cancelled',
    'timed_out',
    'skipped',
  ]),
  observedAt: utcDateTimeSchema,
  finalizationDeadline: utcDateTimeSchema,
});

const finalizationSchema = z.strictObject({
  terminalFactRef: recordReferenceSchema,
  terminalConclusion: z.enum([
    'success',
    'failure',
    'cancelled',
    'timed_out',
    'skipped',
  ]),
  openedAt: utcDateTimeSchema,
  closesAt: utcDateTimeSchema,
  claimRefs: referenceList,
  validationRefs: referenceList,
});

export const attemptHistoryHeadSchema = z.strictObject({
  schema: z.literal('agent-lcars.attempt-history-head/v1'),
  version: z.literal(1),
  tenantId: opaqueIdSchema,
  aggregateKind: z.literal('attempt'),
  attemptId: opaqueIdSchema,
  aggregateRevision: nonnegativeSafeIntegerSchema,
  phase: attemptPhaseSchema,
  updatedAt: utcDateTimeSchema,
  spec: acceptedAttemptSpecSchema,
  specDigest: sha256Schema,
  launch: z.strictObject({
    operationId: opaqueIdSchema,
    executionEpoch: positiveSafeIntegerSchema,
    state: launchStateSchema,
  }),
  executionEpoch: positiveSafeIntegerSchema,
  binding: runBindingSchema.optional(),
  streams: streamHeadsSchema,
  pendingTerminal: pendingTerminalSchema.optional(),
  pendingClaimRefs: referenceList,
  finalization: finalizationSchema.optional(),
  cancellation: z
    .strictObject({
      commandRef: recordReferenceSchema,
      supersededByIntentId: opaqueIdSchema.optional(),
    })
    .optional(),
  outcomeRef: recordReferenceSchema.optional(),
  outcomeDigest: sha256Schema.optional(),
  futureGrantsDenied: z.boolean(),
});
export type AttemptHistoryHead = z.infer<typeof attemptHistoryHeadSchema>;

export const AttemptHistoryCapacityError = DurabilityCapacityError;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      freeze(child);
    }
  }
  return value;
}

function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  reason: 'invalid-head' | 'invalid-record',
): T {
  let normalized: DurableJsonValue;
  try {
    normalized = normalizeDurableValue(value);
  } catch (error) {
    if (error instanceof DurabilityCapacityError) throw error;
    throw new HistoryIntegrityError(reason);
  }
  const result = schema.safeParse(normalized);
  if (!result.success) throw new HistoryIntegrityError(reason);
  return freeze(result.data);
}

function identityMatches(
  ref: AttemptHistoryRecordReference,
  identity: AttemptHistoryIdentity,
  stream?: AttemptHistoryStream,
): boolean {
  return (
    ref.tenantId === identity.tenantId &&
    ref.aggregateKind === 'attempt' &&
    ref.aggregateId === identity.attemptId &&
    (stream === undefined || ref.streamKind === stream)
  );
}

function assertReference(
  value: unknown,
  identity: AttemptHistoryIdentity,
  stream?: AttemptHistoryStream,
): AttemptHistoryRecordReference {
  const ref = parse(recordReferenceSchema, value, 'invalid-record');
  if (!identityMatches(ref, identity, stream)) {
    throw new HistoryIntegrityError('wrong-identity');
  }
  return ref;
}

function assertPayload(
  stream: AttemptHistoryStream,
  payload: unknown,
): DurableJsonValue {
  const wrapped = attemptHistoryRecordPayloadSchema.safeParse({
    stream,
    payload,
  });
  if (!wrapped.success) throw new HistoryIntegrityError('invalid-record');
  try {
    return validateDurableValue(wrapped.data.payload, 'historyRecordBytes');
  } catch (error) {
    if (error instanceof DurabilityCapacityError) throw error;
    throw new HistoryIntegrityError('invalid-record');
  }
}

/** Must stay byte-for-byte identical to lifecycle-control-plane's reducer. */
export function attemptSpecDigest(spec: AcceptedAttemptSpec): string {
  return sha256Digest(canonicalDurableJson(spec));
}

/** Canonical event digest shared with lifecycle-control-plane's reducer. */
export function attemptHistoryTransitionDigest(event: unknown): string {
  return sha256Digest(canonicalDurableJson(event));
}

function assertPayloadReferences(
  stream: AttemptHistoryStream,
  payload: unknown,
  identity: AttemptHistoryIdentity,
): void {
  if (stream === 'command') {
    const parsed = attemptCommandPayloadSchema.safeParse(payload);
    if (!parsed.success) throw new HistoryIntegrityError('invalid-record');
    const command = parsed.data.payload;
    if (command.kind === 'start-validation') {
      assertReference(command.terminalFactRef, identity, 'fact');
    } else if (command.kind === 'validate-claim-requested') {
      assertReference(command.terminalFactRef, identity, 'fact');
      assertReference(command.claimFactRef, identity, 'claim');
    }
  } else if (stream === 'claim') {
    const parsed = attemptClaimPayloadSchema.safeParse(payload);
    if (!parsed.success) throw new HistoryIntegrityError('invalid-record');
    assertReference(parsed.data.factRef, identity, 'fact');
    if (
      parsed.data.claimDigest !==
      historyPayloadDigest({
        kind: 'agent-result-claim',
        claim: parsed.data.claim,
      })
    ) {
      throw new HistoryIntegrityError('digest-mismatch');
    }
  } else if (stream === 'validation') {
    const parsed = attemptValidationPayloadSchema.safeParse(payload);
    if (!parsed.success) throw new HistoryIntegrityError('invalid-record');
    assertReference(parsed.data.terminalFactRef, identity, 'fact');
    assertReference(parsed.data.claimFactRef, identity, 'claim');
    if (
      parsed.data.validation.status !== 'not-applicable' &&
      parsed.data.validation.validationFactId !== parsed.data.validationFactId
    ) {
      throw new HistoryIntegrityError('invalid-record');
    }
  } else if (stream === 'evidence') {
    const parsed = attemptEvidencePayloadSchema.safeParse(payload);
    if (!parsed.success) throw new HistoryIntegrityError('invalid-record');
    assertReference(parsed.data.finalizeCommandRef, identity, 'command');
    if (parsed.data.terminalFactRef !== undefined) {
      assertReference(parsed.data.terminalFactRef, identity, 'fact');
    }
    for (const ref of parsed.data.claimRefs)
      assertReference(ref, identity, 'claim');
    for (const ref of parsed.data.validationRefs) {
      assertReference(ref, identity, 'validation');
    }
    if (parsed.data.outcome.attemptId !== identity.attemptId) {
      throw new HistoryIntegrityError('wrong-identity');
    }
  } else {
    const parsed = attemptFactPayloadSchema.safeParse(payload);
    if (!parsed.success) throw new HistoryIntegrityError('invalid-record');
  }
}

function runtimeFactPayload(
  fact: AttemptFactRecordPayload,
): RuntimeObservationPayload {
  switch (fact.payload.kind) {
    case 'run-bound':
      return { kind: 'run-bound', binding: fact.payload.binding };
    case 'heartbeat':
      return {
        kind: 'heartbeat',
        grantId: fact.payload.grantId,
        at: fact.payload.at,
        phase: fact.payload.phase,
      };
    case 'run-terminal':
      return {
        kind: 'run-terminal',
        binding: fact.payload.binding,
        conclusion: fact.payload.conclusion,
        observedAt: fact.payload.observedAt,
      };
    case 'agent-result-claim':
      return { kind: 'agent-result-claim', claim: fact.payload.claim };
    case 'adapter-failure':
      return { kind: 'adapter-failure', failure: fact.payload.failure };
  }
}

function expectedFactTransitionDigest(
  fact: AttemptFactRecordPayload,
  spec: AcceptedAttemptSpec,
): { canonicalDigest: string; payloadSha256: string } {
  const payload = runtimeFactPayload(fact);
  const envelope = {
    schema: 'agent-lcars.runtime-observation/v1' as const,
    version: 1 as const,
    requestId: fact.requestId,
    factId: fact.factId,
    attemptId: spec.attemptId,
    tenant: spec.tenant,
    task: spec.task,
    source: fact.source,
    observedAt: fact.observedAt,
    payloadSha256: sha256Digest(canonicalRuntimeObservationPayload(payload)),
    payload,
  };
  return {
    canonicalDigest: attemptHistoryTransitionDigest({
      kind: 'observation',
      envelope,
      ...(fact.payload.kind === 'run-terminal'
        ? { finalizationDeadline: fact.payload.finalizationDeadline }
        : {}),
    }),
    payloadSha256: envelope.payloadSha256,
  };
}

function expectedCommandTransitionDigest(
  command: AttemptCommandRecordPayload,
  spec: AcceptedAttemptSpec,
  claimFactId?: string,
): string {
  const payload = command.payload;
  switch (payload.kind) {
    case 'attempt-registered':
      return attemptHistoryTransitionDigest({
        kind: 'register',
        expectedRevision: 0,
        transitionedAt: command.transitionedAt,
        spec,
        specDigest: payload.specDigest,
      });
    case 'launch-accepted':
      return attemptHistoryTransitionDigest({
        kind: 'launch-accepted',
        eventId: payload.commandId,
      });
    case 'launch-response-unknown':
      return attemptHistoryTransitionDigest({
        kind: 'launch-response-unknown',
        eventId: payload.commandId,
      });
    case 'launch-rejected':
      return attemptHistoryTransitionDigest({
        kind: 'launch-rejected',
        eventId: payload.commandId,
        outcome: payload.outcome,
      });
    case 'start-validation':
      return attemptHistoryTransitionDigest({
        kind: 'start-validation',
        eventId: payload.commandId,
        at: payload.at,
      });
    case 'validate-claim-requested':
      return attemptHistoryTransitionDigest({
        kind: 'validate-claim',
        eventId: payload.commandId,
        claimFactId: claimFactId ?? payload.claimFactRef.recordDigest,
        validation: payload.validation,
      });
    case 'finalize':
    case 'cancel-unlaunched':
    case 'mark-lost':
      return attemptHistoryTransitionDigest({
        kind: payload.kind,
        eventId: payload.commandId,
        outcome: payload.outcome,
        ...(payload.kind === 'cancel-unlaunched' &&
        payload.supersededByIntentId !== undefined
          ? { supersededByIntentId: payload.supersededByIntentId }
          : {}),
      });
    case 'request-cancel':
      return attemptHistoryTransitionDigest({
        kind: 'request-cancel',
        eventId: payload.commandId,
        ...(payload.supersededByIntentId === undefined
          ? {}
          : { supersededByIntentId: payload.supersededByIntentId }),
      });
  }
}

interface ResolvedAttemptRecord {
  readonly record: HistoryRecord;
  readonly stream: AttemptHistoryStream;
  readonly payload: DurableJsonValue;
}

function buildKnownRecords(
  entries: readonly AttemptHistoryStoredRecord[] | undefined,
  identity: AttemptHistoryIdentity,
  head: AttemptHistoryHead,
): Map<string, ResolvedAttemptRecord> {
  const known = new Map<string, ResolvedAttemptRecord>();
  const byStream = new Map<AttemptHistoryStream, HistoryRecord[]>();
  for (const entry of entries ?? []) {
    const stream = attemptHistoryStreamSchema.safeParse(
      entry.record.streamKind,
    );
    if (!stream.success) throw new HistoryIntegrityError('wrong-identity');
    const payload = assertPayload(stream.data, entry.payload);
    const verified = verifyHistoryRecordPayload(entry.record, payload);
    if (
      verified.record.aggregateKind !== 'attempt' ||
      verified.record.aggregateId !== identity.attemptId ||
      verified.record.tenantId !== identity.tenantId ||
      verified.record.streamKind !== stream.data
    ) {
      throw new HistoryIntegrityError('wrong-identity');
    }
    if (known.has(verified.record.recordDigest))
      throw new HistoryIntegrityError('invalid-record');
    const streamRecords = byStream.get(stream.data) ?? [];
    streamRecords.push(verified.record);
    byStream.set(stream.data, streamRecords);
    known.set(verified.record.recordDigest, {
      record: verified.record,
      stream: stream.data,
      payload,
    });
  }
  // A prior bundle is useful only when it is a real suffix of the stream
  // named by the input head.  Verifying records as isolated aggregates would
  // allow a forged payload to masquerade as a referenced record.
  for (const [stream, streamRecords] of byStream) {
    streamRecords.sort((left, right) => left.sequence - right.sequence);
    let previous: HistoryRecord | undefined;
    for (const record of streamRecords) {
      if (previous !== undefined) {
        if (
          record.sequence !== previous.sequence + 1 ||
          record.previousRecordDigest !== previous.recordDigest
        ) {
          throw new HistoryIntegrityError('wrong-predecessor');
        }
      }
      previous = record;
    }
    const streamHead = head.streams[stream];
    const last = streamRecords[streamRecords.length - 1];
    if (
      last === undefined ||
      last.sequence !== streamHead.lastSequence ||
      last.recordDigest !== streamHead.headDigest
    ) {
      throw new HistoryIntegrityError('digest-mismatch');
    }
    // If the bundle reaches genesis, it must account for the complete count.
    // Otherwise its first record must explicitly point at an older chain.
    if (streamRecords[0]?.sequence === 1) {
      if (streamRecords.length !== streamHead.count) {
        throw new HistoryIntegrityError('missing-reference');
      }
    } else if (streamRecords[0]?.previousRecordDigest === null) {
      throw new HistoryIntegrityError('wrong-predecessor');
    }
  }
  return known;
}

function resolveKnownRecord(
  ref: AttemptHistoryRecordReference,
  identity: AttemptHistoryIdentity,
  stream: AttemptHistoryStream,
  known: ReadonlyMap<string, ResolvedAttemptRecord>,
): ResolvedAttemptRecord {
  assertReference(ref, identity, stream);
  const resolved = known.get(ref.recordDigest);
  if (
    resolved === undefined ||
    resolved.stream !== stream ||
    !sameReference(
      attemptHistoryRecordReference(resolved.record, identity, stream),
      ref,
    )
  ) {
    throw new HistoryIntegrityError('missing-reference');
  }
  return resolved;
}

function assertResolvedPayloadSemantics(input: {
  readonly head: AttemptHistoryHead;
  readonly stream: AttemptHistoryStream;
  readonly payload: DurableJsonValue;
  readonly identity: AttemptHistoryIdentity;
  readonly known: ReadonlyMap<string, ResolvedAttemptRecord>;
}): void {
  const { head, stream, payload, identity, known } = input;
  if (stream === 'command') {
    const command = attemptCommandPayloadSchema.parse(payload).payload;
    if (command.kind === 'start-validation') {
      const terminal = attemptFactPayloadSchema.parse(
        resolveKnownRecord(command.terminalFactRef, identity, 'fact', known)
          .payload,
      );
      if (terminal.payload.kind !== 'run-terminal')
        throw new HistoryIntegrityError('invalid-record');
    } else if (command.kind === 'validate-claim-requested') {
      const terminal = attemptFactPayloadSchema.parse(
        resolveKnownRecord(command.terminalFactRef, identity, 'fact', known)
          .payload,
      );
      const claim = attemptClaimPayloadSchema.parse(
        resolveKnownRecord(command.claimFactRef, identity, 'claim', known)
          .payload,
      );
      if (
        terminal.payload.kind !== 'run-terminal' ||
        head.phase !== 'validating' ||
        head.finalization === undefined ||
        !sameReference(
          command.terminalFactRef,
          head.finalization.terminalFactRef,
        ) ||
        !head.finalization.claimRefs.some((ref) =>
          sameReference(ref, command.claimFactRef),
        ) ||
        claim.claim.localAttemptMarker !== head.spec.local.attemptMarker
      ) {
        throw new HistoryIntegrityError('invalid-record');
      }
    }
  } else if (stream === 'claim') {
    const claim = attemptClaimPayloadSchema.parse(payload);
    const fact = attemptFactPayloadSchema.parse(
      resolveKnownRecord(claim.factRef, identity, 'fact', known).payload,
    );
    if (
      fact.payload.kind !== 'agent-result-claim' ||
      fact.factId !== claim.claimFactId ||
      fact.payload.claimFactId !== claim.claimFactId ||
      fact.payload.claimDigest !== claim.claimDigest ||
      !sameClaimValue(fact.payload.claim, claim.claim) ||
      claim.claim.localAttemptMarker !== head.spec.local.attemptMarker
    ) {
      throw new HistoryIntegrityError('invalid-record');
    }
    const deadline =
      head.pendingTerminal?.finalizationDeadline ?? head.finalization?.closesAt;
    if (deadline !== undefined && claim.observedAt > deadline) {
      throw new HistoryIntegrityError('invalid-record');
    }
    for (const ref of [
      ...head.pendingClaimRefs,
      ...(head.finalization?.claimRefs ?? []),
    ]) {
      const prior = attemptClaimPayloadSchema.parse(
        resolveKnownRecord(ref, identity, 'claim', known).payload,
      );
      if (prior.claimFactId === claim.claimFactId)
        throw new HistoryIntegrityError('replay-conflict');
    }
  } else if (stream === 'validation') {
    const validation = attemptValidationPayloadSchema.parse(payload);
    const finalization = head.finalization;
    if (
      finalization === undefined ||
      head.phase !== 'validating' ||
      !sameReference(
        validation.terminalFactRef,
        finalization.terminalFactRef,
      ) ||
      !finalization.claimRefs.some((ref) =>
        sameReference(ref, validation.claimFactRef),
      ) ||
      validation.validation.status === 'not-applicable' ||
      validation.commandId !== validation.validationFactId ||
      validation.validation.validatedAt !== validation.validatedAt ||
      validation.validatedAt !== validation.transitionedAt
    ) {
      throw new HistoryIntegrityError('invalid-record');
    }
    const terminal = attemptFactPayloadSchema.parse(
      resolveKnownRecord(validation.terminalFactRef, identity, 'fact', known)
        .payload,
    );
    resolveKnownRecord(validation.claimFactRef, identity, 'claim', known);
    if (terminal.payload.kind !== 'run-terminal')
      throw new HistoryIntegrityError('invalid-record');
    const matchingCommand = [...known.values()].some((entry) => {
      if (entry.stream !== 'command') return false;
      const command = attemptCommandPayloadSchema.parse(entry.payload).payload;
      return (
        command.kind === 'validate-claim-requested' &&
        command.commandId === validation.commandId &&
        sameReference(command.terminalFactRef, validation.terminalFactRef) &&
        sameReference(command.claimFactRef, validation.claimFactRef)
      );
    });
    if (!matchingCommand) throw new HistoryIntegrityError('missing-reference');
    for (const ref of finalization.validationRefs) {
      const prior = attemptValidationPayloadSchema.parse(
        resolveKnownRecord(ref, identity, 'validation', known).payload,
      );
      if (
        prior.validationFactId === validation.validationFactId ||
        sameReference(prior.claimFactRef, validation.claimFactRef)
      ) {
        throw new HistoryIntegrityError('replay-conflict');
      }
    }
  } else if (stream === 'evidence') {
    const evidence = attemptEvidencePayloadSchema.parse(payload);
    const commandResolution = resolveKnownRecord(
      evidence.finalizeCommandRef,
      identity,
      'command',
      known,
    );
    const commandRecord = attemptCommandPayloadSchema.parse(
      commandResolution.payload,
    );
    const command = commandRecord.payload;
    if (
      command.kind !== 'finalize' &&
      command.kind !== 'launch-rejected' &&
      command.kind !== 'cancel-unlaunched' &&
      command.kind !== 'mark-lost'
    ) {
      throw new HistoryIntegrityError('invalid-record');
    }
    if (command.outcomeDigest !== evidence.outcomeDigest) {
      throw new HistoryIntegrityError('invalid-record');
    }
    if (
      evidence.transitionedAt !== commandRecord.transitionedAt ||
      evidence.outcome.finalizedAt !== evidence.transitionedAt
    ) {
      throw new HistoryIntegrityError('invalid-record');
    }
    const finalization = head.finalization;
    if (command.kind === 'finalize') {
      if (
        finalization === undefined ||
        !sameReference(
          evidence.terminalFactRef ?? finalization.terminalFactRef,
          finalization.terminalFactRef,
        ) ||
        canonicalDurableJson(evidence.claimRefs) !==
          canonicalDurableJson(finalization.claimRefs) ||
        canonicalDurableJson(evidence.validationRefs) !==
          canonicalDurableJson(finalization.validationRefs)
      ) {
        throw new HistoryIntegrityError('invalid-record');
      }
    } else {
      if (
        evidence.terminalFactRef !== undefined ||
        evidence.claimRefs.length !== 0 ||
        evidence.validationRefs.length !== 0 ||
        evidence.outcome.evidence.kind !== 'lifecycle-decision' ||
        evidence.outcome.evidence.decisionFactId !== command.commandId
      ) {
        throw new HistoryIntegrityError('invalid-record');
      }
      if (
        command.kind === 'launch-rejected' &&
        head.phase !== 'launch-pending' &&
        head.phase !== 'launch-response-unknown'
      ) {
        throw new HistoryIntegrityError('invalid-head');
      }
      if (
        command.kind === 'cancel-unlaunched' &&
        head.phase !== 'launch-pending'
      ) {
        throw new HistoryIntegrityError('invalid-head');
      }
      if (
        command.kind === 'mark-lost' &&
        ['terminal', 'launch-rejected'].includes(head.phase)
      ) {
        throw new HistoryIntegrityError('invalid-head');
      }
      const outcome = evidence.outcome;
      const noExecution =
        outcome.execution === 'not_started' &&
        (outcome.result === 'none' ||
          (command.kind === 'launch-rejected' &&
            outcome.result === 'startup-failure')) &&
        outcome.reference === undefined &&
        outcome.evidenceValidation.status === 'not-applicable';
      if (
        command.kind === 'launch-rejected' &&
        (!noExecution || outcome.terminalState !== 'failed')
      ) {
        throw new HistoryIntegrityError('invalid-record');
      }
      if (
        command.kind === 'cancel-unlaunched' &&
        (!noExecution ||
          outcome.terminalState !==
            (command.supersededByIntentId === undefined
              ? 'cancelled'
              : 'superseded'))
      ) {
        throw new HistoryIntegrityError('invalid-record');
      }
      if (
        command.kind === 'mark-lost' &&
        ((outcome.execution !== 'lost' && outcome.execution !== 'timed_out') ||
          outcome.terminalState !== 'lost' ||
          outcome.result !== 'none' ||
          outcome.reference !== undefined ||
          outcome.evidenceValidation.status !== 'not-applicable')
      ) {
        throw new HistoryIntegrityError('invalid-record');
      }
    }
    if (evidence.claimRefs.length !== evidence.validationRefs.length) {
      throw new HistoryIntegrityError('invalid-record');
    }
    const coveredClaims = new Set<string>();
    const validations: Array<{
      payload: AttemptValidationRecordPayload;
      claim: AttemptClaimRecordPayload;
    }> = [];
    for (const validationRef of evidence.validationRefs) {
      const validation = attemptValidationPayloadSchema.parse(
        resolveKnownRecord(validationRef, identity, 'validation', known)
          .payload,
      );
      if (
        !evidence.claimRefs.some((claimRef) =>
          sameReference(claimRef, validation.claimFactRef),
        ) ||
        coveredClaims.has(validation.claimFactRef.recordDigest)
      ) {
        throw new HistoryIntegrityError('invalid-record');
      }
      validations.push({
        payload: validation,
        claim: attemptClaimPayloadSchema.parse(
          resolveKnownRecord(validation.claimFactRef, identity, 'claim', known)
            .payload,
        ),
      });
      coveredClaims.add(validation.claimFactRef.recordDigest);
    }
    if (
      coveredClaims.size !== evidence.claimRefs.length ||
      evidence.claimRefs.some(
        (claimRef) => !coveredClaims.has(claimRef.recordDigest),
      )
    ) {
      throw new HistoryIntegrityError('invalid-record');
    }
    if (command.kind === 'finalize' && finalization !== undefined) {
      if (finalization.terminalConclusion === 'cancelled') {
        if (head.cancellation !== undefined) {
          const cancellationCommand = attemptCommandPayloadSchema.parse(
            resolveKnownRecord(
              head.cancellation.commandRef,
              identity,
              'command',
              known,
            ).payload,
          ).payload;
          if (
            evidence.outcome.evidence.kind !== 'lifecycle-decision' ||
            evidence.outcome.evidence.decisionFactId !==
              cancellationCommand.commandId
          ) {
            throw new HistoryIntegrityError('invalid-record');
          }
        } else if (
          evidence.outcome.evidence.kind !== 'terminal-run' ||
          head.binding === undefined ||
          !sameBinding(evidence.outcome.evidence.binding, head.binding)
        ) {
          throw new HistoryIntegrityError('invalid-record');
        }
      } else if (evidence.outcome.evidence.kind === 'validated-claim') {
        const validatedEvidence = evidence.outcome.evidence;
        const matched = validations.find(
          ({ payload, claim }) =>
            payload.validation.status === 'validated' &&
            payload.validation.validationFactId ===
              validatedEvidence.validationFactId &&
            canonicalDurableJson(claim.claim) ===
              canonicalDurableJson(validatedEvidence.claim),
        );
        if (matched === undefined)
          throw new HistoryIntegrityError('invalid-record');
      } else if (evidence.outcome.evidence.kind === 'no-deliverable') {
        const terminal = attemptFactPayloadSchema.parse(
          resolveKnownRecord(
            finalization.terminalFactRef,
            identity,
            'fact',
            known,
          ).payload,
        );
        if (
          terminal.payload.kind !== 'run-terminal' ||
          terminal.factId !== evidence.outcome.evidence.terminalFactId
        ) {
          throw new HistoryIntegrityError('invalid-record');
        }
      }
      if (
        !validFinalizedOutcomeProof({
          outcome: evidence.outcome,
          finalization,
          terminalFactId: attemptFactPayloadSchema.parse(
            resolveKnownRecord(
              finalization.terminalFactRef,
              identity,
              'fact',
              known,
            ).payload,
          ).factId,
          commandId: command.commandId,
          validations,
          claimCount: evidence.claimRefs.length,
          cancellation: head.cancellation,
          binding: head.binding,
        })
      ) {
        throw new HistoryIntegrityError('invalid-record');
      }
    }
  }
}

function sameBinding(left: RunBinding, right: RunBinding): boolean {
  return (
    left.runId === right.runId &&
    left.runAttempt === right.runAttempt &&
    left.checkRunId === right.checkRunId &&
    left.workflowPath === right.workflowPath &&
    left.workflowRef === right.workflowRef &&
    left.workflowSha === right.workflowSha &&
    left.jobWorkflowRef === right.jobWorkflowRef &&
    left.jobWorkflowSha === right.jobWorkflowSha
  );
}

function bindingMatchesSpec(
  binding: RunBinding,
  spec: AcceptedAttemptSpec,
): boolean {
  return (
    binding.workflowPath === spec.execution.workflowPath &&
    binding.workflowRef === spec.execution.workflowRef &&
    binding.workflowSha === spec.execution.workflowSha
  );
}

function sameReference(
  left: AttemptHistoryRecordReference,
  right: AttemptHistoryRecordReference,
): boolean {
  return canonicalDurableJson(left) === canonicalDurableJson(right);
}

function outcomeMatchesConclusion(
  outcome: AttemptOutcome,
  conclusion: NonNullable<
    AttemptHistoryHead['finalization']
  >['terminalConclusion'],
): boolean {
  switch (conclusion) {
    case 'success':
      return outcome.execution === 'exited';
    case 'failure':
      return (
        outcome.terminalState === 'failed' && outcome.execution === 'exited'
      );
    case 'cancelled':
      return (
        ['cancelled', 'superseded'].includes(outcome.terminalState) &&
        outcome.execution === 'cancelled'
      );
    case 'timed_out':
      return (
        ['failed', 'expired', 'lost'].includes(outcome.terminalState) &&
        outcome.execution === 'timed_out'
      );
    case 'skipped':
      return (
        outcome.terminalState === 'failed' &&
        outcome.execution === 'not_started'
      );
  }
}

function sameClaimValue(
  left: AgentResultClaimV1,
  right: AgentResultClaimV1,
): boolean {
  return canonicalDurableJson(left) === canonicalDurableJson(right);
}

function validFinalizedOutcomeProof(input: {
  outcome: AttemptOutcome;
  finalization: NonNullable<AttemptHistoryHead['finalization']>;
  terminalFactId: string;
  commandId: string;
  validations: ReadonlyArray<{
    payload: AttemptValidationRecordPayload;
    claim: AttemptClaimRecordPayload;
  }>;
  claimCount: number;
  cancellation: AttemptHistoryHead['cancellation'];
  binding: RunBinding | undefined;
}): boolean {
  const {
    outcome,
    finalization,
    terminalFactId,
    commandId,
    validations,
    claimCount,
    cancellation,
    binding,
  } = input;
  if (
    outcome.finalizedAt === undefined ||
    !outcomeMatchesConclusion(outcome, finalization.terminalConclusion)
  )
    return false;
  if (finalization.terminalConclusion === 'cancelled') {
    return (
      outcome.terminalState ===
        (cancellation?.supersededByIntentId === undefined
          ? 'cancelled'
          : 'superseded') &&
      outcome.execution === 'cancelled' &&
      outcome.result === 'none' &&
      outcome.evidenceValidation.status === 'not-applicable' &&
      (cancellation === undefined
        ? outcome.evidence.kind === 'terminal-run' &&
          binding !== undefined &&
          outcome.evidence.terminalFactId === terminalFactId &&
          sameBinding(outcome.evidence.binding, binding)
        : outcome.evidence.kind === 'lifecycle-decision' &&
          outcome.evidence.decisionFactId !== undefined)
    );
  }
  if (finalization.terminalConclusion !== 'success') {
    return (
      outcome.terminalState === 'failed' &&
      outcome.result === 'none' &&
      outcome.reference === undefined &&
      outcome.evidence.kind === 'no-deliverable' &&
      outcome.evidence.terminalFactId === terminalFactId &&
      outcome.evidenceValidation.status === 'not-applicable' &&
      ((finalization.terminalConclusion === 'failure' &&
        outcome.execution === 'exited') ||
        (finalization.terminalConclusion === 'timed_out' &&
          outcome.execution === 'timed_out') ||
        (finalization.terminalConclusion === 'skipped' &&
          outcome.execution === 'not_started'))
    );
  }
  const validated = validations.filter(
    ({ payload }) => payload.validation.status === 'validated',
  );
  if (validated.length === 1) {
    const item = validated[0];
    return (
      outcome.terminalState === 'succeeded' &&
      outcome.execution === 'exited' &&
      outcome.evidence.kind === 'validated-claim' &&
      outcome.evidence.validationFactId === item.payload.validationFactId &&
      sameClaimValue(outcome.evidence.claim, item.claim.claim) &&
      outcome.evidenceValidation.status === 'validated' &&
      canonicalDurableJson(outcome.evidenceValidation) ===
        canonicalDurableJson(item.payload.validation)
    );
  }
  if (validated.length > 1) {
    return (
      outcome.terminalState === 'failed' &&
      outcome.execution === 'exited' &&
      outcome.reference === undefined &&
      outcome.evidence.kind === 'no-deliverable' &&
      outcome.evidence.terminalFactId === terminalFactId &&
      outcome.evidenceValidation.status === 'ambiguous' &&
      outcome.evidenceValidation.validationFactId === commandId &&
      outcome.evidenceValidation.candidateCount === validated.length
    );
  }
  if (
    outcome.terminalState !== 'failed' ||
    outcome.execution !== 'exited' ||
    outcome.result !== 'none' ||
    outcome.reference !== undefined ||
    outcome.evidence.kind !== 'no-deliverable' ||
    outcome.evidence.terminalFactId !== terminalFactId
  )
    return false;
  if (claimCount === 0) {
    return (
      outcome.evidenceValidation.status === 'absent' &&
      outcome.evidenceValidation.validationFactId === commandId
    );
  }
  return validations.some(
    ({ payload }) =>
      payload.validation.status !== 'not-applicable' &&
      canonicalDurableJson(payload.validation) ===
        canonicalDurableJson(outcome.evidenceValidation),
  );
}

function requireDistinct(refs: readonly AttemptHistoryRecordReference[]): void {
  if (new Set(refs.map((ref) => ref.recordDigest)).size !== refs.length) {
    throw new HistoryIntegrityError('invalid-head');
  }
}

const attemptHistoryIdentityReceiptSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('fact'),
    tenantId: opaqueIdSchema,
    attemptId: opaqueIdSchema,
    factId: opaqueIdSchema,
    requestId: opaqueIdSchema,
    canonicalDigest: sha256Schema,
  }),
  z.strictObject({
    kind: z.literal('command'),
    tenantId: opaqueIdSchema,
    attemptId: opaqueIdSchema,
    commandId: opaqueIdSchema,
    canonicalDigest: sha256Schema,
  }),
  z.strictObject({
    kind: z.literal('claim'),
    tenantId: opaqueIdSchema,
    attemptId: opaqueIdSchema,
    claimFactId: opaqueIdSchema,
    canonicalDigest: sha256Schema,
  }),
  z.strictObject({
    kind: z.literal('validation'),
    tenantId: opaqueIdSchema,
    attemptId: opaqueIdSchema,
    validationFactId: opaqueIdSchema,
    canonicalDigest: sha256Schema,
  }),
  // There is one terminal outcome/evidence identity for an attempt. The
  // persisted record lives on the evidence stream, but the external receipt
  // uses the domain identity `outcome` so there is only one key.
  z.strictObject({
    kind: z.literal('outcome'),
    tenantId: opaqueIdSchema,
    attemptId: opaqueIdSchema,
    canonicalDigest: sha256Schema,
  }),
]);
export type AttemptHistoryIdentityReceipt = z.infer<
  typeof attemptHistoryIdentityReceiptSchema
>;

function assertFreshIdentity(
  receipts: readonly AttemptHistoryIdentityReceipt[],
  identity: AttemptHistoryIdentity,
  stream: AttemptHistoryStream,
  payload: DurableJsonValue,
  seenFacts: Set<string>,
  seenRequests: Set<string>,
  seenCommands: Set<string>,
  seenClaims: Set<string>,
  seenValidations: Set<string>,
  seenOutcomes: Set<string>,
): void {
  if (
    receipts.some(
      (entry) =>
        entry.tenantId !== identity.tenantId ||
        entry.attemptId !== identity.attemptId,
    )
  ) {
    throw new HistoryIntegrityError('wrong-identity');
  }
  if (stream === 'fact') {
    const fact = attemptFactPayloadSchema.parse(payload);
    if (
      receipts.some(
        (entry) =>
          entry.kind === 'fact' &&
          (entry.factId === fact.factId || entry.requestId === fact.requestId),
      ) ||
      seenFacts.has(fact.factId) ||
      seenRequests.has(fact.requestId)
    ) {
      throw new HistoryIntegrityError('replay-conflict');
    }
    seenFacts.add(fact.factId);
    seenRequests.add(fact.requestId);
  } else if (stream === 'command') {
    const command = attemptCommandPayloadSchema.parse(payload).payload;
    if (
      receipts.some(
        (entry) =>
          entry.kind === 'command' && entry.commandId === command.commandId,
      ) ||
      seenCommands.has(command.commandId)
    ) {
      throw new HistoryIntegrityError('replay-conflict');
    }
    seenCommands.add(command.commandId);
  } else if (stream === 'claim') {
    const claim = attemptClaimPayloadSchema.parse(payload);
    if (
      receipts.some(
        (entry) =>
          entry.kind === 'claim' && entry.claimFactId === claim.claimFactId,
      ) ||
      seenClaims.has(claim.claimFactId)
    ) {
      throw new HistoryIntegrityError('replay-conflict');
    }
    seenClaims.add(claim.claimFactId);
  } else if (stream === 'validation') {
    const validation = attemptValidationPayloadSchema.parse(payload);
    if (
      receipts.some(
        (entry) =>
          entry.kind === 'validation' &&
          entry.validationFactId === validation.validationFactId,
      ) ||
      seenValidations.has(validation.validationFactId)
    ) {
      throw new HistoryIntegrityError('replay-conflict');
    }
    seenValidations.add(validation.validationFactId);
  } else if (stream === 'evidence') {
    attemptEvidencePayloadSchema.parse(payload);
    if (
      receipts.some((entry) => entry.kind === 'outcome') ||
      seenOutcomes.has('outcome')
    ) {
      throw new HistoryIntegrityError('replay-conflict');
    }
    // Outcome identity is the tenant/attempt pair; the digest is its
    // immutable content and is checked by the resolver.
    seenOutcomes.add('outcome');
  }
}

function assertTransitionSemantics(input: {
  readonly head: AttemptHistoryHead;
  readonly nextHead: AttemptHistoryHead;
  readonly emitted: readonly AttemptHistoryEmission[];
  readonly records: readonly HistoryRecord[];
}): void {
  const { head, nextHead, emitted, records } = input;
  let factIndex = 0;
  let claimIndex = 0;
  let validationIndex = 0;
  let evidenceIndex = 0;
  let terminalCommandSeen = false;
  let evidenceSeen = false;
  for (const emission of emitted) {
    if (emission.stream === 'fact') {
      const payload = attemptFactPayloadSchema.parse(emission.payload);
      const record = records.filter(
        (candidate) => candidate.streamKind === 'fact',
      )[factIndex];
      if (record === undefined)
        throw new HistoryIntegrityError('missing-reference');
      const ref = historyRecordReference(record);
      factIndex += 1;
      if (
        (payload.payload.kind === 'heartbeat' ||
          payload.payload.kind === 'adapter-failure') &&
        !['active', 'result-observed', 'validating', 'cancelling'].includes(
          head.phase,
        )
      ) {
        throw new HistoryIntegrityError('invalid-head');
      }
      if (
        payload.payload.kind === 'agent-result-claim' &&
        ['validating', 'terminal', 'launch-rejected'].includes(head.phase)
      ) {
        throw new HistoryIntegrityError('invalid-head');
      }
      if (payload.payload.kind === 'run-bound') {
        if (
          ['terminal', 'launch-rejected'].includes(head.phase) ||
          (['result-observed', 'validating'].includes(head.phase) &&
            head.binding !== undefined)
        ) {
          throw new HistoryIntegrityError('invalid-head');
        }
        if (!bindingMatchesSpec(payload.payload.binding, head.spec)) {
          throw new HistoryIntegrityError('wrong-identity');
        }
        if (
          head.binding !== undefined &&
          !sameBinding(head.binding, payload.payload.binding)
        ) {
          throw new HistoryIntegrityError('wrong-identity');
        }
        if (head.pendingTerminal !== undefined) {
          if (
            !sameBinding(head.pendingTerminal.binding, payload.payload.binding)
          ) {
            throw new HistoryIntegrityError('wrong-identity');
          }
          if (
            nextHead.pendingTerminal !== undefined ||
            nextHead.finalization?.terminalFactRef.recordDigest !==
              head.pendingTerminal.terminalFactRef.recordDigest
          ) {
            throw new HistoryIntegrityError('invalid-head');
          }
        }
        if (
          nextHead.binding === undefined ||
          !sameBinding(nextHead.binding, payload.payload.binding)
        ) {
          throw new HistoryIntegrityError('invalid-head');
        }
      }
      if (payload.payload.kind === 'run-terminal') {
        if (
          Date.parse(payload.payload.finalizationDeadline) <=
          Math.max(
            Date.parse(payload.payload.observedAt),
            Date.parse(payload.observedAt),
            Date.parse(payload.transitionedAt),
          )
        ) {
          throw new HistoryIntegrityError('invalid-record');
        }
        if (!bindingMatchesSpec(payload.payload.binding, head.spec)) {
          throw new HistoryIntegrityError('wrong-identity');
        }
        if (head.binding === undefined) {
          if (
            nextHead.pendingTerminal?.terminalFactRef.recordDigest !==
              ref.recordDigest ||
            !sameBinding(
              nextHead.pendingTerminal.binding,
              payload.payload.binding,
            ) ||
            nextHead.pendingTerminal.conclusion !==
              payload.payload.conclusion ||
            nextHead.pendingTerminal.observedAt !==
              payload.payload.observedAt ||
            nextHead.pendingTerminal.finalizationDeadline !==
              payload.payload.finalizationDeadline
          ) {
            throw new HistoryIntegrityError('invalid-head');
          }
        } else if (
          !sameBinding(head.binding, payload.payload.binding) ||
          nextHead.finalization?.terminalFactRef.recordDigest !==
            ref.recordDigest
        ) {
          throw new HistoryIntegrityError('wrong-identity');
        }
      }
    } else if (emission.stream === 'claim') {
      const payload = attemptClaimPayloadSchema.parse(emission.payload);
      const record = records.filter(
        (candidate) => candidate.streamKind === 'claim',
      )[claimIndex];
      if (record === undefined)
        throw new HistoryIntegrityError('missing-reference');
      const ref = historyRecordReference(record);
      claimIndex += 1;
      if (['validating', 'terminal', 'launch-rejected'].includes(head.phase)) {
        throw new HistoryIntegrityError('invalid-head');
      }
      if (
        !nextHead.pendingClaimRefs.some(
          (candidate) => candidate.recordDigest === ref.recordDigest,
        ) &&
        !nextHead.finalization?.claimRefs.some(
          (candidate) => candidate.recordDigest === ref.recordDigest,
        )
      ) {
        throw new HistoryIntegrityError('invalid-head');
      }
      if (payload.claim.localAttemptMarker !== head.spec.local.attemptMarker) {
        throw new HistoryIntegrityError('invalid-record');
      }
    } else if (emission.stream === 'validation') {
      const payload = attemptValidationPayloadSchema.parse(emission.payload);
      const record = records.filter(
        (candidate) => candidate.streamKind === 'validation',
      )[validationIndex];
      if (record === undefined)
        throw new HistoryIntegrityError('missing-reference');
      const ref = historyRecordReference(record);
      validationIndex += 1;
      if (
        nextHead.finalization === undefined ||
        !nextHead.finalization.validationRefs.some(
          (candidate) => candidate.recordDigest === ref.recordDigest,
        ) ||
        !nextHead.finalization.claimRefs.some(
          (candidate) =>
            candidate.recordDigest === payload.claimFactRef.recordDigest,
        )
      ) {
        throw new HistoryIntegrityError('invalid-head');
      }
      if (
        payload.validation.status === 'not-applicable' ||
        payload.validation.validatedAt !== payload.validatedAt
      ) {
        throw new HistoryIntegrityError('invalid-record');
      }
    } else if (emission.stream === 'evidence') {
      evidenceSeen = true;
      const payload = attemptEvidencePayloadSchema.parse(emission.payload);
      const record = records.filter(
        (candidate) => candidate.streamKind === 'evidence',
      )[evidenceIndex];
      if (record === undefined)
        throw new HistoryIntegrityError('missing-reference');
      const ref = historyRecordReference(record);
      evidenceIndex += 1;
      if (nextHead.outcomeRef?.recordDigest !== ref.recordDigest) {
        throw new HistoryIntegrityError('invalid-head');
      }
      if (
        payload.claimRefs.length !== payload.validationRefs.length &&
        nextHead.phase === 'terminal'
      ) {
        throw new HistoryIntegrityError('invalid-head');
      }
    } else {
      const payload = attemptCommandPayloadSchema.parse(
        emission.payload,
      ).payload;
      if (payload.kind === 'request-cancel' && !nextHead.futureGrantsDenied) {
        throw new HistoryIntegrityError('invalid-head');
      }
      if (
        payload.kind === 'launch-rejected' ||
        payload.kind === 'cancel-unlaunched' ||
        payload.kind === 'mark-lost' ||
        payload.kind === 'finalize'
      ) {
        if (nextHead.phase !== 'terminal') {
          throw new HistoryIntegrityError('invalid-head');
        }
        terminalCommandSeen = true;
      }
    }
  }
  if (
    terminalCommandSeen &&
    (!evidenceSeen || nextHead.outcomeRef === undefined)
  ) {
    throw new HistoryIntegrityError('invalid-head');
  }
  if (
    nextHead.finalization !== undefined &&
    nextHead.finalization.validationRefs.length >
      nextHead.finalization.claimRefs.length
  ) {
    throw new HistoryIntegrityError('invalid-head');
  }
  requireDistinct(nextHead.pendingClaimRefs);
  if (nextHead.finalization !== undefined) {
    requireDistinct(nextHead.finalization.claimRefs);
    requireDistinct(nextHead.finalization.validationRefs);
  }
}

function parseHead(value: unknown): AttemptHistoryHead {
  const parsed = parse(attemptHistoryHeadSchema, value, 'invalid-head');
  validateDurableValue(parsed, 'attemptHeadBytes');
  if (
    parsed.spec.attemptId !== parsed.attemptId ||
    parsed.spec.tenant.tenantId !== parsed.tenantId ||
    parsed.specDigest !== attemptSpecDigest(parsed.spec)
  ) {
    throw new HistoryIntegrityError('wrong-identity');
  }
  const identity = { tenantId: parsed.tenantId, attemptId: parsed.attemptId };
  for (const stream of ATTEMPT_HISTORY_STREAMS) {
    const current = parse(
      historyHeadSchema,
      parsed.streams[stream],
      'invalid-head',
    );
    if (
      current.aggregateKind !== 'attempt' ||
      current.aggregateId !== identity.attemptId ||
      current.tenantId !== identity.tenantId ||
      current.streamKind !== stream ||
      current.lastAppliedRevision > parsed.aggregateRevision
    ) {
      throw new HistoryIntegrityError('wrong-identity');
    }
  }
  for (const ref of parsed.pendingClaimRefs)
    assertReference(ref, identity, 'claim');
  requireDistinct(parsed.pendingClaimRefs);
  if (parsed.pendingTerminal !== undefined) {
    assertReference(parsed.pendingTerminal.terminalFactRef, identity, 'fact');
    if (parsed.finalization !== undefined)
      throw new HistoryIntegrityError('invalid-head');
  }
  if (parsed.finalization !== undefined) {
    assertReference(parsed.finalization.terminalFactRef, identity, 'fact');
    for (const ref of parsed.finalization.claimRefs)
      assertReference(ref, identity, 'claim');
    for (const ref of parsed.finalization.validationRefs)
      assertReference(ref, identity, 'validation');
    requireDistinct(parsed.finalization.claimRefs);
    requireDistinct(parsed.finalization.validationRefs);
    if (
      parsed.finalization.validationRefs.length >
      parsed.finalization.claimRefs.length
    ) {
      throw new HistoryIntegrityError('invalid-head');
    }
  }
  if (parsed.cancellation !== undefined)
    assertReference(parsed.cancellation.commandRef, identity, 'command');
  if (parsed.outcomeRef !== undefined)
    assertReference(parsed.outcomeRef, identity, 'evidence');
  if (
    (parsed.outcomeRef === undefined) !==
    (parsed.outcomeDigest === undefined)
  ) {
    throw new HistoryIntegrityError('invalid-head');
  }
  return parsed;
}

export function verifyAttemptHistoryHead(value: unknown): AttemptHistoryHead {
  return parseHead(value);
}

export function createGenesisAttemptHistoryHead(input: {
  tenantId: string;
  attemptId: string;
  spec: AcceptedAttemptSpec;
  specDigest: string;
  updatedAt: string;
}): AttemptHistoryHead {
  if (
    input.spec.attemptId !== input.attemptId ||
    input.spec.tenant.tenantId !== input.tenantId ||
    input.specDigest !== attemptSpecDigest(input.spec)
  ) {
    throw new HistoryIntegrityError('wrong-identity');
  }
  const streams = Object.fromEntries(
    ATTEMPT_HISTORY_STREAMS.map((stream) => [
      stream,
      createGenesisHistoryHead({
        tenantId: input.tenantId,
        aggregateKind: 'attempt',
        aggregateId: input.attemptId,
        streamKind: stream,
      }),
    ]),
  ) as AttemptHistoryHead['streams'];
  return parseHead({
    schema: 'agent-lcars.attempt-history-head/v1',
    version: 1,
    tenantId: input.tenantId,
    aggregateKind: 'attempt',
    attemptId: input.attemptId,
    aggregateRevision: 0,
    phase: 'launch-pending',
    updatedAt: input.updatedAt,
    spec: input.spec,
    specDigest: input.specDigest,
    launch: {
      operationId: input.attemptId,
      executionEpoch: 1,
      state: 'recorded',
    },
    executionEpoch: 1,
    streams,
    pendingClaimRefs: [],
    futureGrantsDenied: false,
  });
}
export const createAttemptHistoryGenesis = createGenesisAttemptHistoryHead;

export function registerAttemptHistory(input: {
  readonly tenantId: string;
  readonly attemptId: string;
  readonly spec: AcceptedAttemptSpec;
  readonly specDigest: string;
  readonly updatedAt: string;
}): {
  readonly head: AttemptHistoryHead;
  readonly records: readonly HistoryRecord[];
} {
  const genesis = createGenesisAttemptHistoryHead(input);
  const command: AttemptCommandRecordPayload = {
    schema: 'agent-lcars.attempt-command/v1',
    version: 1,
    transitionedAt: input.updatedAt,
    canonicalDigest: attemptHistoryTransitionDigest({
      kind: 'register',
      expectedRevision: 0,
      transitionedAt: input.updatedAt,
      spec: input.spec,
      specDigest: input.specDigest,
    }),
    payload: {
      kind: 'attempt-registered',
      commandId: input.attemptId,
      specDigest: input.specDigest,
    },
  };
  return appendAttemptHistoryTransition({
    head: genesis,
    nextRevision: 1,
    transitionedAt: input.updatedAt,
    emitted: [{ stream: 'command', payload: command }],
  });
}

export interface AttemptHistoryEmission {
  readonly stream: AttemptHistoryStream;
  readonly payload: unknown;
}

interface AttemptHistoryTransitionInput {
  readonly head: AttemptHistoryHead;
  readonly nextRevision: number;
  readonly transitionedAt: string;
  readonly emitted: readonly AttemptHistoryEmission[];
  /**
   * The bounded, verified records needed to resolve semantic references.  A
   * history pointer is not proof by itself: callers must provide the exact
   * referenced payload when a transition relies on it.
   */
  readonly priorRecords?: readonly AttemptHistoryStoredRecord[];
  readonly idempotencyReceipts?: readonly AttemptHistoryIdentityReceipt[];
  readonly nextHead: AttemptHistoryHead;
}

export interface AttemptHistoryStoredRecord {
  readonly record: HistoryRecord;
  readonly payload: unknown;
}

function validateAttemptHistoryTransition(
  input: AttemptHistoryTransitionInput,
): AttemptHistoryHead {
  const head = parseHead(input.head);
  const nextHead = parseHead(input.nextHead);
  if (
    input.nextRevision !== head.aggregateRevision + 1 ||
    nextHead.aggregateRevision !== input.nextRevision ||
    nextHead.updatedAt !== input.transitionedAt
  ) {
    throw new HistoryIntegrityError('wrong-sequence');
  }
  if (
    input.emitted.length >
    LIFECYCLE_DURABILITY_LIMITS.transitionHistoryRecordCount
  ) {
    throw new AttemptHistoryCapacityError(
      'transitionHistoryRecordCount',
      input.emitted.length,
      LIFECYCLE_DURABILITY_LIMITS.transitionHistoryRecordCount,
      'items',
    );
  }
  const priorDurable = (input.priorRecords ?? []).map((entry) => ({
    record: entry.record,
    payload: entry.payload,
  }));
  validateDurableValue({ priorRecords: priorDurable }, 'transitionBytes');
  const working = { ...head.streams } as AttemptHistoryHead['streams'];
  const records: HistoryRecord[] = [];
  const identity = { tenantId: head.tenantId, attemptId: head.attemptId };
  for (const emission of input.emitted) {
    const payload = assertPayload(emission.stream, emission.payload);
    assertPayloadReferences(emission.stream, payload, identity);
    const result = appendHistoryRecord({
      head: working[emission.stream] as HistoryHead,
      payload,
      appliedRevision: input.nextRevision,
    });
    validateDurableValue(
      { record: result.record, payload },
      'historyRecordBytes',
    );
    working[emission.stream] = result.head;
    records.push(result.record);
  }
  for (const stream of ATTEMPT_HISTORY_STREAMS) {
    if (
      canonicalDurableJson(working[stream]) !==
      canonicalDurableJson(nextHead.streams[stream])
    ) {
      throw new HistoryIntegrityError('digest-mismatch');
    }
  }
  assertTransitionSemantics({
    head,
    nextHead,
    emitted: input.emitted,
    records,
  });
  return nextHead;
}

export function appendAttemptHistoryTransition(input: {
  readonly head: AttemptHistoryHead;
  readonly nextRevision: number;
  readonly transitionedAt: string;
  readonly emitted: readonly AttemptHistoryEmission[];
  readonly priorRecords?: readonly AttemptHistoryStoredRecord[];
  readonly idempotencyReceipts?: readonly AttemptHistoryIdentityReceipt[];
}): {
  readonly head: AttemptHistoryHead;
  readonly records: readonly HistoryRecord[];
} {
  const base = parseHead(input.head);
  if (!utcDateTimeSchema.safeParse(input.transitionedAt).success) {
    throw new HistoryIntegrityError('invalid-record');
  }
  if (
    input.emitted.length >
    LIFECYCLE_DURABILITY_LIMITS.transitionHistoryRecordCount
  ) {
    throw new AttemptHistoryCapacityError(
      'transitionHistoryRecordCount',
      input.emitted.length,
      LIFECYCLE_DURABILITY_LIMITS.transitionHistoryRecordCount,
      'items',
    );
  }
  const priorDurable = (input.priorRecords ?? []).map((entry) => ({
    record: entry.record,
    payload: entry.payload,
  }));
  const receipts = (input.idempotencyReceipts ?? []).map((receipt) =>
    parse(attemptHistoryIdentityReceiptSchema, receipt, 'invalid-record'),
  );
  // Resolver inputs and idempotency receipts are bounded by the durable JSON
  // container/byte ceilings, but are not mutation records and do not consume
  // the 64-record transition fan-out budget.
  validateDurableValue(
    { priorRecords: priorDurable, receipts },
    'transitionBytes',
  );
  const nextStreams = { ...base.streams } as AttemptHistoryHead['streams'];
  const records: HistoryRecord[] = [];
  const appendedPayloads: DurableJsonValue[] = [];
  const identity = { tenantId: base.tenantId, attemptId: base.attemptId };
  const primaryCount = input.emitted.filter(
    (emission) => emission.stream === 'fact' || emission.stream === 'command',
  ).length;
  if (
    primaryCount !== 1 ||
    input.emitted.filter((emission) => emission.stream === 'fact').length > 1 ||
    input.emitted.filter((emission) => emission.stream === 'command').length > 1
  ) {
    throw new HistoryIntegrityError('invalid-record');
  }
  const factEmissions = input.emitted.filter(
    (emission) => emission.stream === 'fact',
  );
  const commandEmissions = input.emitted.filter(
    (emission) => emission.stream === 'command',
  );
  const claimEmissions = input.emitted.filter(
    (emission) => emission.stream === 'claim',
  );
  const validationEmissions = input.emitted.filter(
    (emission) => emission.stream === 'validation',
  );
  const evidenceEmissions = input.emitted.filter(
    (emission) => emission.stream === 'evidence',
  );
  if (
    claimEmissions.length > 0 &&
    (claimEmissions.length !== 1 ||
      factEmissions.length !== 1 ||
      attemptFactPayloadSchema.parse(factEmissions[0]?.payload).payload.kind !==
        'agent-result-claim')
  ) {
    throw new HistoryIntegrityError('invalid-record');
  }
  if (
    validationEmissions.length > 0 &&
    (validationEmissions.length !== 1 ||
      commandEmissions.length !== 1 ||
      attemptCommandPayloadSchema.parse(commandEmissions[0]?.payload).payload
        .kind !== 'validate-claim-requested')
  ) {
    throw new HistoryIntegrityError('invalid-record');
  }
  if (evidenceEmissions.length > 0) {
    const command = commandEmissions[0]
      ? attemptCommandPayloadSchema.parse(commandEmissions[0].payload).payload
      : undefined;
    if (
      evidenceEmissions.length !== 1 ||
      command === undefined ||
      ![
        'finalize',
        'launch-rejected',
        'cancel-unlaunched',
        'mark-lost',
      ].includes(command.kind)
    ) {
      throw new HistoryIntegrityError('invalid-record');
    }
  }
  const known = buildKnownRecords(input.priorRecords, identity, base);
  const seenFacts = new Set<string>();
  const seenRequests = new Set<string>();
  const seenCommands = new Set<string>();
  const seenClaims = new Set<string>();
  const seenValidations = new Set<string>();
  const seenOutcomes = new Set<string>();
  for (const emission of input.emitted) {
    const payload = assertPayload(emission.stream, emission.payload);
    if (
      (payload as { transitionedAt?: string }).transitionedAt !==
      input.transitionedAt
    ) {
      throw new HistoryIntegrityError('invalid-record');
    }
    assertPayloadReferences(emission.stream, payload, identity);
    if (emission.stream === 'fact') {
      const fact = attemptFactPayloadSchema.parse(payload);
      const expected = expectedFactTransitionDigest(fact, base.spec);
      if (
        fact.canonicalDigest !== expected.canonicalDigest ||
        fact.payloadSha256 !== expected.payloadSha256
      ) {
        throw new HistoryIntegrityError('digest-mismatch');
      }
    } else if (emission.stream === 'command') {
      const command = attemptCommandPayloadSchema.parse(payload);
      let claimFactId: string | undefined;
      if (command.payload.kind === 'validate-claim-requested') {
        claimFactId = attemptClaimPayloadSchema.parse(
          resolveKnownRecord(
            command.payload.claimFactRef,
            identity,
            'claim',
            known,
          ).payload,
        ).claimFactId;
      }
      if (
        command.canonicalDigest !==
        expectedCommandTransitionDigest(command, base.spec, claimFactId)
      ) {
        throw new HistoryIntegrityError('digest-mismatch');
      }
    }
    const result = appendHistoryRecord({
      head: nextStreams[emission.stream] as HistoryHead,
      payload,
      appliedRevision: input.nextRevision,
    });
    assertFreshIdentity(
      receipts,
      identity,
      emission.stream,
      payload,
      seenFacts,
      seenRequests,
      seenCommands,
      seenClaims,
      seenValidations,
      seenOutcomes,
    );
    validateDurableValue(
      { record: result.record, payload },
      'historyRecordBytes',
    );
    nextStreams[emission.stream] = result.head;
    records.push(result.record);
    appendedPayloads.push(payload);
    known.set(result.record.recordDigest, {
      record: result.record,
      stream: emission.stream,
      payload,
    });
    assertResolvedPayloadSemantics({
      head: base,
      stream: emission.stream,
      payload,
      identity,
      known,
    });
  }
  const emittedClaimRefs = records
    .filter((record) => record.streamKind === 'claim')
    .map((record) =>
      attemptHistoryRecordReference(
        record,
        {
          tenantId: base.tenantId,
          attemptId: base.attemptId,
        },
        'claim',
      ),
    );
  const emittedValidationRefs = records
    .filter((record) => record.streamKind === 'validation')
    .map((record) =>
      attemptHistoryRecordReference(
        record,
        {
          tenantId: base.tenantId,
          attemptId: base.attemptId,
        },
        'validation',
      ),
    );
  // The head is reducer-owned.  In particular, never accept a caller supplied
  // spec, launch, epoch, binding, phase, or outcome pointer as a "patch".
  // Those values are authority state and must be derived below from the
  // immutable old head and closed record payloads.
  const patch = { ...base, updatedAt: input.transitionedAt } as Omit<
    AttemptHistoryHead,
    'streams' | 'aggregateRevision'
  >;
  const terminalEmission = input.emitted.find(
    (emission) =>
      emission.stream === 'fact' &&
      attemptFactPayloadSchema.parse(emission.payload).payload.kind ===
        'run-terminal',
  );
  if (
    terminalEmission !== undefined &&
    (base.pendingTerminal !== undefined ||
      base.finalization !== undefined ||
      base.outcomeRef !== undefined)
  ) {
    throw new HistoryIntegrityError('invalid-head');
  }
  const evidenceRecord = records.find(
    (record) => record.streamKind === 'evidence',
  );
  if (evidenceRecord !== undefined && base.outcomeRef !== undefined) {
    throw new HistoryIntegrityError('invalid-head');
  }
  if (evidenceRecord !== undefined && patch.outcomeRef === undefined) {
    const evidencePayload = attemptEvidencePayloadSchema.parse(
      input.emitted.find((emission) => emission.stream === 'evidence')?.payload,
    );
    patch.outcomeRef = attemptHistoryRecordReference(
      evidenceRecord,
      {
        tenantId: base.tenantId,
        attemptId: base.attemptId,
      },
      'evidence',
    );
    patch.outcomeDigest = evidencePayload.outcomeDigest;
    patch.phase = 'terminal';
    patch.futureGrantsDenied = true;
  }
  if (
    terminalEmission !== undefined &&
    base.binding === undefined &&
    patch.pendingTerminal === undefined
  ) {
    const terminalPayload = attemptFactPayloadSchema.parse(
      terminalEmission.payload,
    );
    if (terminalPayload.payload.kind !== 'run-terminal') {
      throw new HistoryIntegrityError('invalid-record');
    }
    const terminalRecord = records.find(
      (record) => record.streamKind === 'fact',
    );
    if (terminalRecord === undefined)
      throw new HistoryIntegrityError('missing-reference');
    patch.pendingTerminal = {
      terminalFactRef: attemptHistoryRecordReference(
        terminalRecord,
        {
          tenantId: base.tenantId,
          attemptId: base.attemptId,
        },
        'fact',
      ),
      binding: terminalPayload.payload.binding,
      conclusion: terminalPayload.payload.conclusion,
      observedAt: terminalPayload.payload.observedAt,
      finalizationDeadline: terminalPayload.payload.finalizationDeadline,
    };
  }
  const bindingEmission = input.emitted.find(
    (emission) =>
      emission.stream === 'fact' &&
      attemptFactPayloadSchema.parse(emission.payload).payload.kind ===
        'run-bound',
  );
  if (bindingEmission !== undefined && base.pendingTerminal !== undefined) {
    const bindingPayload = attemptFactPayloadSchema.parse(
      bindingEmission.payload,
    );
    if (bindingPayload.payload.kind !== 'run-bound') {
      throw new HistoryIntegrityError('invalid-record');
    }
    if (patch.finalization === undefined) {
      patch.finalization = {
        terminalFactRef: base.pendingTerminal.terminalFactRef,
        terminalConclusion: base.pendingTerminal.conclusion,
        openedAt: patch.updatedAt,
        closesAt: base.pendingTerminal.finalizationDeadline,
        claimRefs: base.pendingClaimRefs,
        validationRefs: [],
      };
    }
    delete patch.pendingTerminal;
    patch.pendingClaimRefs = [];
    patch.phase = 'result-observed';
  }
  if (bindingEmission !== undefined) {
    const bindingPayload = attemptFactPayloadSchema.parse(
      bindingEmission.payload,
    );
    if (bindingPayload.payload.kind !== 'run-bound') {
      throw new HistoryIntegrityError('invalid-record');
    }
    patch.binding = bindingPayload.payload.binding;
    patch.launch = { ...base.launch, state: 'accepted' };
    // A binding confirms the run, but must not erase an already requested
    // cancellation while the run is being drained.
    if (
      base.pendingTerminal === undefined &&
      !['cancelling', 'result-observed', 'validating'].includes(base.phase)
    )
      patch.phase = 'active';
  }
  if (
    terminalEmission !== undefined &&
    base.binding !== undefined &&
    patch.finalization === undefined
  ) {
    const terminalPayload = attemptFactPayloadSchema.parse(
      terminalEmission.payload,
    );
    if (terminalPayload.payload.kind !== 'run-terminal') {
      throw new HistoryIntegrityError('invalid-record');
    }
    const terminalRecord = records.find(
      (record) => record.streamKind === 'fact',
    );
    if (terminalRecord === undefined)
      throw new HistoryIntegrityError('missing-reference');
    patch.finalization = {
      terminalFactRef: attemptHistoryRecordReference(
        terminalRecord,
        {
          tenantId: base.tenantId,
          attemptId: base.attemptId,
        },
        'fact',
      ),
      terminalConclusion: terminalPayload.payload.conclusion,
      openedAt: patch.updatedAt,
      closesAt: terminalPayload.payload.finalizationDeadline,
      claimRefs: base.pendingClaimRefs,
      validationRefs: [],
    };
    patch.pendingClaimRefs = [];
    patch.phase = 'result-observed';
  }
  if (
    canonicalDurableJson(patch.pendingClaimRefs) ===
    canonicalDurableJson(base.pendingClaimRefs)
  ) {
    patch.pendingClaimRefs = [
      ...base.pendingClaimRefs,
      ...emittedClaimRefs.map((ref) => ({ ...ref })),
    ];
  }
  const finalization = patch.finalization;
  if (finalization !== undefined && base.finalization !== undefined) {
    if (
      canonicalDurableJson(finalization.claimRefs) ===
      canonicalDurableJson(base.finalization.claimRefs)
    ) {
      patch.finalization = {
        ...finalization,
        claimRefs: [
          ...base.finalization.claimRefs,
          ...emittedClaimRefs.map((ref) => ({ ...ref })),
        ],
      };
    }
    if (
      canonicalDurableJson(finalization.validationRefs) ===
      canonicalDurableJson(base.finalization.validationRefs)
    ) {
      const currentFinalization = patch.finalization;
      if (currentFinalization === undefined) {
        throw new HistoryIntegrityError('invalid-head');
      }
      patch.finalization = {
        ...currentFinalization,
        validationRefs: [
          ...base.finalization.validationRefs,
          ...emittedValidationRefs.map((ref) => ({ ...ref })),
        ],
      };
    }
  }
  let commandIndex = 0;
  for (const emission of input.emitted) {
    if (emission.stream !== 'command') continue;
    const command = attemptCommandPayloadSchema.parse(emission.payload).payload;
    const record = records.filter(
      (candidate) => candidate.streamKind === 'command',
    )[commandIndex++];
    if (record === undefined)
      throw new HistoryIntegrityError('missing-reference');
    if (command.kind === 'launch-accepted') {
      if (!['launch-pending', 'cancelling'].includes(base.phase)) {
        throw new HistoryIntegrityError('invalid-head');
      }
      patch.launch = { ...base.launch, state: 'accepted' };
      if (base.phase === 'launch-pending') patch.phase = 'launch-accepted';
    } else if (command.kind === 'launch-response-unknown') {
      if (!['launch-pending', 'cancelling'].includes(base.phase)) {
        throw new HistoryIntegrityError('invalid-head');
      }
      patch.launch = { ...base.launch, state: 'response-unknown' };
      if (base.phase === 'launch-pending')
        patch.phase = 'launch-response-unknown';
    } else if (command.kind === 'request-cancel') {
      if (base.phase === 'terminal' || base.outcomeRef !== undefined)
        throw new HistoryIntegrityError('invalid-head');
      if (
        base.cancellation !== undefined &&
        base.cancellation.supersededByIntentId !== command.supersededByIntentId
      ) {
        throw new HistoryIntegrityError('replay-conflict');
      }
      patch.futureGrantsDenied = true;
      if (base.finalization === undefined) patch.phase = 'cancelling';
      if (base.cancellation === undefined) {
        patch.cancellation = {
          commandRef: attemptHistoryRecordReference(
            record,
            identity,
            'command',
          ),
          ...(command.supersededByIntentId === undefined
            ? {}
            : { supersededByIntentId: command.supersededByIntentId }),
        };
      }
    } else if (command.kind === 'start-validation') {
      if (
        base.phase !== 'result-observed' ||
        base.finalization === undefined ||
        !sameReference(
          command.terminalFactRef,
          base.finalization.terminalFactRef,
        ) ||
        command.at !== input.transitionedAt ||
        command.at < base.finalization.closesAt
      ) {
        throw new HistoryIntegrityError('invalid-head');
      }
      patch.phase = 'validating';
    } else if (command.kind === 'validate-claim-requested') {
      if (
        base.phase !== 'validating' ||
        base.finalization === undefined ||
        !sameReference(
          command.terminalFactRef,
          base.finalization.terminalFactRef,
        ) ||
        !base.finalization.claimRefs.some((ref) =>
          sameReference(ref, command.claimFactRef),
        )
      ) {
        throw new HistoryIntegrityError('invalid-head');
      }
    } else if (command.kind === 'finalize') {
      if (
        base.phase !== 'validating' ||
        base.finalization === undefined ||
        base.finalization.claimRefs.length !==
          base.finalization.validationRefs.length
      ) {
        throw new HistoryIntegrityError('invalid-head');
      }
    } else if (command.kind === 'launch-rejected') {
      if (!['launch-pending', 'launch-response-unknown'].includes(base.phase)) {
        throw new HistoryIntegrityError('invalid-head');
      }
      if (
        base.binding !== undefined ||
        base.pendingTerminal !== undefined ||
        base.finalization !== undefined ||
        base.outcomeRef !== undefined
      ) {
        throw new HistoryIntegrityError('invalid-head');
      }
    } else if (command.kind === 'cancel-unlaunched') {
      if (
        base.phase !== 'launch-pending' ||
        base.binding !== undefined ||
        base.pendingTerminal !== undefined ||
        base.finalization !== undefined
      ) {
        throw new HistoryIntegrityError('invalid-head');
      }
      patch.cancellation = {
        commandRef: attemptHistoryRecordReference(record, identity, 'command'),
        ...(command.supersededByIntentId === undefined
          ? {}
          : { supersededByIntentId: command.supersededByIntentId }),
      };
    } else if (command.kind === 'mark-lost') {
      if (
        ['terminal', 'launch-rejected'].includes(base.phase) ||
        base.pendingTerminal !== undefined ||
        base.finalization !== undefined
      ) {
        throw new HistoryIntegrityError('invalid-head');
      }
    }
  }
  const next = parseHead({
    ...patch,
    streams: nextStreams,
    aggregateRevision: input.nextRevision,
  });
  validateAttemptHistoryTransition({
    head: base,
    nextRevision: input.nextRevision,
    transitionedAt: input.transitionedAt,
    emitted: input.emitted,
    nextHead: next,
  });
  // Count and byte checks apply to the complete durable mutation, before it
  // is returned to a storage adapter.  There is no truncation path.
  const transitionRecords = records.map((record, index) => ({
    record,
    payload: appendedPayloads[index],
  }));
  validateDurableTransition({
    effects: [],
    historyRecords: transitionRecords,
    workRecords: [],
  });
  validateDurableValue(
    {
      head: next,
      priorRecords: priorDurable,
      historyRecords: transitionRecords,
    },
    'transitionBytes',
  );
  assertTransitionSemantics({
    head: base,
    nextHead: next,
    emitted: input.emitted,
    records,
  });
  return freeze({ head: next, records });
}

export function verifyAttemptHistoryPayload(
  stream: AttemptHistoryStream,
  record: unknown,
  payload: unknown,
  identity: AttemptHistoryIdentity,
): { readonly record: HistoryRecord; readonly payload: DurableJsonValue } {
  const parsedPayload = assertPayload(stream, payload);
  assertPayloadReferences(stream, parsedPayload, identity);
  const verified = verifyHistoryRecordPayload(record, parsedPayload);
  if (
    verified.record.streamKind !== stream ||
    verified.record.aggregateKind !== 'attempt' ||
    verified.record.aggregateId !== identity.attemptId ||
    verified.record.tenantId !== identity.tenantId
  ) {
    throw new HistoryIntegrityError('wrong-identity');
  }
  // The generic verifier already normalizes and freezes, but clone once more
  // at this public boundary so callers never receive an object graph that can
  // alias provider input or a storage adapter's cache.
  return freeze({
    record: structuredClone(verified.record),
    payload: structuredClone(verified.payload),
  });
}

export function attemptFactIdentityKey(input: {
  tenantId: string;
  attemptId: string;
  source: ObservationSource;
  factId: string;
}): string {
  return canonicalDurableJson([
    'attempt-fact',
    input.tenantId,
    input.attemptId,
    input.source.kind,
    input.source.sourceId,
    input.factId,
  ]);
}

export function attemptRequestIdentityKey(input: {
  tenantId: string;
  attemptId: string;
  source: ObservationSource;
  requestId: string;
}): string {
  return canonicalDurableJson([
    'attempt-request',
    input.tenantId,
    input.attemptId,
    input.source.kind,
    input.source.sourceId,
    input.requestId,
  ]);
}

export function attemptCommandIdentityKey(input: {
  tenantId: string;
  attemptId: string;
  commandId: string;
}): string {
  return canonicalDurableJson([
    'attempt-command',
    input.tenantId,
    input.attemptId,
    input.commandId,
  ]);
}

export function attemptClaimIdentityKey(input: {
  tenantId: string;
  attemptId: string;
  claimFactId: string;
}): string {
  return canonicalDurableJson([
    'attempt-claim',
    input.tenantId,
    input.attemptId,
    input.claimFactId,
  ]);
}

export function attemptValidationIdentityKey(input: {
  tenantId: string;
  attemptId: string;
  validationFactId: string;
}): string {
  return canonicalDurableJson([
    'attempt-validation',
    input.tenantId,
    input.attemptId,
    input.validationFactId,
  ]);
}

export function attemptOutcomeIdentityKey(input: {
  tenantId: string;
  attemptId: string;
}): string {
  return canonicalDurableJson([
    'attempt-outcome',
    input.tenantId,
    input.attemptId,
  ]);
}

export function assertAttemptReplay(input: {
  readonly existingDigest: string | undefined;
  readonly incomingDigest: string;
}): 'replay' | 'new' {
  if (input.existingDigest === undefined) return 'new';
  if (input.existingDigest !== input.incomingDigest) {
    throw new HistoryIntegrityError('replay-conflict');
  }
  return 'replay';
}

/**
 * Resolve an ingress identity before asking the append writer to mutate a
 * stream. Facts intentionally key on factId first, matching the reducer;
 * requestId is only the fallback idempotency key.
 */
export function resolveAttemptHistoryIdentityReplay(input: {
  readonly receipts: readonly AttemptHistoryIdentityReceipt[];
  readonly incoming:
    | {
        readonly kind: 'fact';
        readonly tenantId: string;
        readonly attemptId: string;
        readonly factId: string;
        readonly requestId: string;
        readonly canonicalDigest: string;
      }
    | {
        readonly kind: 'command';
        readonly tenantId: string;
        readonly attemptId: string;
        readonly commandId: string;
        readonly canonicalDigest: string;
      }
    | {
        readonly kind: 'claim';
        readonly tenantId: string;
        readonly attemptId: string;
        readonly claimFactId: string;
        readonly canonicalDigest: string;
      }
    | {
        readonly kind: 'validation';
        readonly tenantId: string;
        readonly attemptId: string;
        readonly validationFactId: string;
        readonly canonicalDigest: string;
      }
    | {
        readonly kind: 'outcome' | 'evidence';
        readonly tenantId: string;
        readonly attemptId: string;
        readonly canonicalDigest: string;
      };
}): 'replay' | 'new' {
  if (
    input.receipts.some(
      (receipt) =>
        receipt.tenantId !== input.incoming.tenantId ||
        receipt.attemptId !== input.incoming.attemptId,
    )
  ) {
    throw new HistoryIntegrityError('wrong-identity');
  }
  const matching = input.receipts.find((receipt) => {
    if (input.incoming.kind === 'fact') {
      return (
        receipt.kind === 'fact' &&
        (receipt.factId === input.incoming.factId ||
          receipt.requestId === input.incoming.requestId)
      );
    }
    if (input.incoming.kind === 'command') {
      return (
        receipt.kind === 'command' &&
        attemptCommandIdentityKey(receipt) ===
          attemptCommandIdentityKey(input.incoming)
      );
    }
    if (input.incoming.kind === 'claim') {
      return (
        receipt.kind === 'claim' &&
        attemptClaimIdentityKey(receipt) ===
          attemptClaimIdentityKey(input.incoming)
      );
    }
    if (input.incoming.kind === 'validation') {
      return (
        receipt.kind === 'validation' &&
        attemptValidationIdentityKey(receipt) ===
          attemptValidationIdentityKey(input.incoming)
      );
    }
    return (
      receipt.kind === 'outcome' &&
      attemptOutcomeIdentityKey(receipt) ===
        attemptOutcomeIdentityKey(input.incoming)
    );
  });
  if (matching === undefined) return 'new';
  if (matching.canonicalDigest !== input.incoming.canonicalDigest) {
    throw new HistoryIntegrityError('replay-conflict');
  }
  return 'replay';
}

export interface LegacyAttemptFactReceipt {
  factId: string;
  requestId: string;
  payloadSha256: string;
  canonicalDigest: string;
  observedAt: string;
  kind: RuntimeObservationPayload['kind'];
}
export interface LegacyAttemptCommandReceipt {
  eventId: string;
  canonicalDigest: string;
}
export interface LegacyAttemptState {
  schema: 'agent-lcars.attempt-state/v1';
  version: 1;
  spec: AcceptedAttemptSpec;
  specDigest: string;
  revision: number;
  phase: z.infer<typeof attemptPhaseSchema>;
  launch: {
    operationId: string;
    executionEpoch: number;
    state: z.infer<typeof launchStateSchema>;
  };
  executionEpoch: number;
  binding?: RunBinding;
  facts: LegacyAttemptFactReceipt[];
  commands: LegacyAttemptCommandReceipt[];
  pendingTerminal?: {
    factId: string;
    binding: RunBinding;
    conclusion: z.infer<typeof pendingTerminalSchema>['conclusion'];
    observedAt: string;
    finalizationDeadline: string;
  };
  pendingClaims: Array<{
    factId: string;
    claim: AgentResultClaimV1;
    observedAt: string;
    validation?: Exclude<EvidenceValidation, { status: 'not-applicable' }>;
  }>;
  finalization?: {
    terminalFactId: string;
    terminalConclusion: z.infer<
      typeof finalizationSchema
    >['terminalConclusion'];
    openedAt: string;
    closesAt: string;
    evidence: LegacyAttemptState['pendingClaims'];
  };
  cancellation?: { eventId: string; supersededByIntentId?: string };
  outcome?: AttemptOutcome;
  futureGrantsDenied: boolean;
  updatedAt: string;
}

export interface LegacyAttemptProjection {
  readonly head: AttemptHistoryHead;
  readonly inline: Readonly<{
    /** Exact detached v1 snapshot; never use this as input to a history writer. */
    state: LegacyAttemptState;
    facts: readonly LegacyAttemptFactReceipt[];
    commands: readonly LegacyAttemptCommandReceipt[];
    pendingClaims: readonly LegacyAttemptState['pendingClaims'][number][];
    finalizationEvidence: readonly LegacyAttemptState['pendingClaims'][number][];
    pendingTerminal?: LegacyAttemptState['pendingTerminal'];
    finalization?: Omit<
      NonNullable<LegacyAttemptState['finalization']>,
      'evidence'
    >;
    cancellation?: LegacyAttemptState['cancellation'];
    outcome?: AttemptOutcome;
  }>;
  readonly legacyInline: true;
}

/**
 * Read-only compatibility boundary. It deliberately does not synthesize fake
 * history records for v1 snapshots, because their payloads were not stored.
 * New writers must use appendAttemptHistoryTransition instead.
 */
export function projectLegacyAttemptState(
  state: LegacyAttemptState,
): LegacyAttemptProjection {
  const head = createGenesisAttemptHistoryHead({
    tenantId: state.spec.tenant.tenantId,
    attemptId: state.spec.attemptId,
    spec: state.spec,
    specDigest: state.specDigest,
    updatedAt: state.updatedAt,
  });
  const projected = parseHead({
    ...head,
    aggregateRevision: state.revision,
    phase: state.phase,
    launch: state.launch,
    executionEpoch: state.executionEpoch,
    ...(state.binding === undefined ? {} : { binding: state.binding }),
    pendingClaimRefs: [],
    futureGrantsDenied: state.futureGrantsDenied,
    updatedAt: state.updatedAt,
  });
  return freeze({
    head: projected,
    inline: {
      state: structuredClone(state),
      facts: structuredClone(state.facts),
      commands: structuredClone(state.commands),
      pendingClaims: structuredClone(state.pendingClaims),
      finalizationEvidence: structuredClone(state.finalization?.evidence ?? []),
      ...(state.pendingTerminal === undefined
        ? {}
        : { pendingTerminal: structuredClone(state.pendingTerminal) }),
      ...(state.finalization === undefined
        ? {}
        : {
            finalization: {
              terminalFactId: state.finalization.terminalFactId,
              terminalConclusion: state.finalization.terminalConclusion,
              openedAt: state.finalization.openedAt,
              closesAt: state.finalization.closesAt,
            },
          }),
      ...(state.cancellation === undefined
        ? {}
        : { cancellation: structuredClone(state.cancellation) }),
      ...(state.outcome === undefined
        ? {}
        : { outcome: structuredClone(state.outcome) }),
    },
    legacyInline: true as const,
  });
}
export const adaptLegacyAttemptState = projectLegacyAttemptState;

export function attemptHistoryRecordReference(
  record: HistoryRecord,
  identity: AttemptHistoryIdentity,
  stream: AttemptHistoryStream,
): AttemptHistoryRecordReference {
  const ref = historyRecordReference(record);
  return assertReference(ref, identity, stream);
}

export function attemptHistoryPayloadDigest(payload: unknown): string {
  return historyPayloadDigest(normalizeDurableValue(payload));
}

export type {
  AgentResultClaimV1,
  AttemptOutcome,
  EvidenceValidation,
  RunBinding,
};
