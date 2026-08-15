import {
  attemptFactPayloadSchema,
  type AttemptFactRecordPayload,
  type AttemptHistoryHead,
  attemptHistoryHeadSchema,
  type AttemptHistoryRecordReference,
  attemptHistoryRecordReference,
  attemptHistoryRecordReferenceSchema,
  attemptHistoryTransitionDigest,
  canonicalDurableJson,
  type CanonicalTaskIdentity,
  canonicalTaskIdentitySchema,
  type HistoryRecord,
  LIFECYCLE_DURABILITY_LIMITS,
  normalizeDurableValue,
  type ObservationSource,
  observationSourceSchema,
  type RunBinding,
  runBindingSchema,
  sha256Digest,
  utcDateTimeSchema,
  validateDurableValue,
  verifyAttemptHistoryHead,
  verifyAttemptHistoryPayload,
} from '@agent-lcars/dispatch-contracts';
import { z } from 'zod';

const POLICY_DOMAIN = 'agent-lcars.mark-lost-policy/v1';
const OBSERVATION_PAYLOAD_DOMAIN =
  'agent-lcars.mark-lost-observation-payload/v1';
const OBSERVATION_DOMAIN = 'agent-lcars.mark-lost-observation/v1';
const RECEIPT_DOMAIN = 'agent-lcars.mark-lost-eligibility-receipt/v1';
const HOUR_MS = 60 * 60 * 1_000;
const MINUTE_MS = 60 * 1_000;
const REQUIRED_OBSERVATIONS = 3;

const opaqueIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const positiveSafeIntegerSchema = z.number().int().safe().positive();

function domainDigest(domain: string, value: unknown): string {
  return sha256Digest(`${domain}\u0000${canonicalDurableJson(value)}`);
}

function frozenClone<T>(value: T): T {
  const freeze = (current: unknown): unknown => {
    if (current !== null && typeof current === 'object') {
      for (const child of Object.values(current as Record<string, unknown>))
        freeze(child);
      Object.freeze(current);
    }
    return current;
  };
  return freeze(structuredClone(value)) as T;
}

/** Deliberately terse: conflicts never echo provider evidence or fence values. */
export class MarkLostEligibilityConflict extends Error {
  override readonly name = 'MarkLostEligibilityConflict';
  constructor(readonly reason: MarkLostEligibilityConflictReason) {
    super(`Mark-lost eligibility rejected: ${reason}`);
  }
}

export type MarkLostEligibilityConflictReason =
  | 'invalid-input'
  | 'invalid-state'
  | 'authority-mismatch'
  | 'history-mismatch'
  | 'baseline-mismatch'
  | 'observation-mismatch'
  | 'policy-mismatch'
  | 'capacity-exceeded';

const terminalConclusionSchema = z.enum([
  'success',
  'failure',
  'cancelled',
  'timed_out',
  'skipped',
]);

/** Closed provider-neutral conclusion. No raw provider body is admissible. */
export const runStuckVerifierStatusSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('nonterminal') }),
  z.strictObject({
    kind: z.literal('terminal'),
    conclusion: terminalConclusionSchema,
  }),
  z.strictObject({ kind: z.literal('no-run') }),
  z.strictObject({ kind: z.literal('contradiction') }),
]);
export type RunStuckVerifierStatus = z.infer<
  typeof runStuckVerifierStatusSchema
>;

const observationUnsignedSchema = z.strictObject({
  schema: z.literal('agent-lcars.run-stuck-observation/v1'),
  version: z.literal(1),
  factId: opaqueIdSchema,
  requestId: opaqueIdSchema,
  source: observationSourceSchema,
  binding: runBindingSchema,
  status: runStuckVerifierStatusSchema,
  observedAt: utcDateTimeSchema,
  /** A trusted adapter's one-way proof commitment, never a provider body. */
  proofDigest: sha256Schema,
  payloadDigest: sha256Schema,
  canonicalDigest: sha256Schema,
});

function observationPayload(value: z.infer<typeof observationUnsignedSchema>) {
  return {
    schema: value.schema,
    version: value.version,
    factId: value.factId,
    requestId: value.requestId,
    source: value.source,
    binding: value.binding,
    status: value.status,
    observedAt: value.observedAt,
    proofDigest: value.proofDigest,
  };
}

export const runStuckVerifierObservationSchema =
  observationUnsignedSchema.superRefine((value, ctx) => {
    const payloadDigest = domainDigest(
      OBSERVATION_PAYLOAD_DOMAIN,
      observationPayload(value),
    );
    if (value.payloadDigest !== payloadDigest) {
      ctx.addIssue({
        code: 'custom',
        path: ['payloadDigest'],
        message: 'Observation payload digest mismatch',
      });
    }
    if (
      value.canonicalDigest !==
      domainDigest(OBSERVATION_DOMAIN, {
        ...observationPayload(value),
        payloadDigest,
      })
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['canonicalDigest'],
        message: 'Observation canonical digest mismatch',
      });
    }
  });
export type RunStuckVerifierObservation = z.infer<
  typeof runStuckVerifierObservationSchema
>;

const verifiedObservations = new WeakSet<object>();

/**
 * The adapter is server-owned. Its implementation may obtain evidence however
 * it needs, but this boundary accepts only the closed, digest-only result.
 */
export interface RunStuckVerifier {
  verifyRunStuck(input: { readonly candidate: unknown }): unknown;
}

export interface VerifiedRunStuckObservation {
  readonly schema: 'agent-lcars.run-stuck-observation/v1';
  readonly version: 1;
  readonly factId: string;
  readonly requestId: string;
  readonly source: ObservationSource;
  readonly binding: RunBinding;
  readonly status: RunStuckVerifierStatus;
  readonly observedAt: string;
  readonly proofDigest: string;
  readonly payloadDigest: string;
  readonly canonicalDigest: string;
}

export function isVerifiedRunStuckObservation(
  value: unknown,
): value is VerifiedRunStuckObservation {
  return (
    value !== null &&
    typeof value === 'object' &&
    verifiedObservations.has(value)
  );
}

export class RunStuckObservationBoundary {
  constructor(private readonly verifier: RunStuckVerifier) {}

  verify(input: { readonly candidate: unknown }): VerifiedRunStuckObservation {
    let raw: unknown;
    try {
      raw = this.verifier.verifyRunStuck({ candidate: input.candidate });
      // `structuredClone` rejects Proxy values before a handler can provide a
      // deceptively plain object graph; normalize then enforces durable JSON.
      raw = normalizeDurableValue(structuredClone(raw));
    } catch {
      throw new MarkLostEligibilityConflict('observation-mismatch');
    }
    const parsed = runStuckVerifierObservationSchema.safeParse(raw);
    if (!parsed.success)
      throw new MarkLostEligibilityConflict('observation-mismatch');
    const observation = frozenClone(parsed.data);
    verifiedObservations.add(observation);
    return observation as VerifiedRunStuckObservation;
  }
}

export const runStuckPolicySchema = z.strictObject({
  schema: z.literal('agent-lcars.run-stuck-policy/v1'),
  version: z.literal(1),
  policyId: z.literal('run_stuck/v1'),
  graceMs: z.literal(4 * HOUR_MS),
  minimumIntervalMs: z.literal(30 * MINUTE_MS),
  requiredObservationCount: z.literal(REQUIRED_OBSERVATIONS),
  contentDigest: sha256Schema,
});
export type RunStuckPolicy = z.infer<typeof runStuckPolicySchema>;

const policyUnsigned = {
  schema: 'agent-lcars.run-stuck-policy/v1' as const,
  version: 1 as const,
  policyId: 'run_stuck/v1' as const,
  graceMs: 14_400_000 as const,
  minimumIntervalMs: 1_800_000 as const,
  requiredObservationCount: 3 as const,
};
export const RUN_STUCK_POLICY_V1: Readonly<RunStuckPolicy> = Object.freeze({
  ...policyUnsigned,
  contentDigest: domainDigest(POLICY_DOMAIN, policyUnsigned),
});

const authoritySchema = z.strictObject({
  authorityEpoch: positiveSafeIntegerSchema,
  attemptRevision: z.number().int().safe().nonnegative(),
  launchOperationId: opaqueIdSchema,
  executionEpoch: positiveSafeIntegerSchema,
  /** Commit-only opaque fence. It is intentionally excluded from the receipt. */
  fence: opaqueIdSchema,
});

const factHistoryEntrySchema = z.strictObject({
  reference: attemptHistoryRecordReferenceSchema,
  record: z.unknown(),
  payload: z.unknown(),
});

/**
 * The serializable portion of a validator call. Verified observations stay
 * outside this schema so their nominal provenance cannot be forged by JSON.
 */
export const markLostEligibilityRequestSchema = z.strictObject({
  schema: z.literal('agent-lcars.mark-lost-eligibility-request/v1'),
  version: z.literal(1),
  receiptId: opaqueIdSchema,
  idempotencyKey: opaqueIdSchema,
  authority: authoritySchema,
  task: canonicalTaskIdentitySchema,
  head: attemptHistoryHeadSchema,
  baselineFactRef: attemptHistoryRecordReferenceSchema,
  factHistory: z
    .array(factHistoryEntrySchema)
    .min(1)
    .max(LIFECYCLE_DURABILITY_LIMITS.maxContainerItems),
});

export interface MarkLostEligibilityInput {
  readonly schema: 'agent-lcars.mark-lost-eligibility-request/v1';
  readonly version: 1;
  readonly receiptId: string;
  readonly idempotencyKey: string;
  readonly authority: {
    readonly authorityEpoch: number;
    readonly attemptRevision: number;
    readonly launchOperationId: string;
    readonly executionEpoch: number;
    readonly fence: string;
  };
  readonly task: unknown;
  readonly head: unknown;
  readonly baselineFactRef: unknown;
  readonly factHistory: readonly unknown[];
  readonly observations: readonly unknown[];
}

export interface MarkLostEligibilityReceipt {
  readonly schema: 'agent-lcars.mark-lost-eligibility-receipt/v1';
  readonly version: 1;
  readonly receiptId: string;
  readonly idempotencyKey: string;
  readonly tenantId: string;
  readonly attemptId: string;
  readonly task: CanonicalTaskIdentity;
  readonly authorityEpoch: number;
  readonly attemptRevision: number;
  readonly launchOperationId: string;
  readonly executionEpoch: number;
  readonly binding: RunBinding;
  readonly baseline: {
    readonly factId: string;
    readonly requestId: string;
    readonly observedAt: string;
    readonly reference: AttemptHistoryRecordReference;
    readonly recordDigest: string;
    readonly payloadDigest: string;
    readonly payloadSha256: string;
    readonly canonicalDigest: string;
  };
  readonly policy: RunStuckPolicy;
  readonly observations: readonly VerifiedRunStuckObservation[];
  readonly thresholdObservationNumber: 3;
  readonly eligibleAt: string;
  readonly causalDigest: string;
}

const eligibilityReceipts = new WeakSet<object>();
const receiptFences = new WeakMap<object, string>();

export function isMarkLostEligibilityReceipt(
  value: unknown,
): value is MarkLostEligibilityReceipt {
  return (
    value !== null &&
    typeof value === 'object' &&
    eligibilityReceipts.has(value)
  );
}

/** Internal commit seam: callers can test a receipt, but cannot recover its fence. */
export function hasMarkLostEligibilityFence(
  receipt: unknown,
  fence: unknown,
): boolean {
  return (
    isMarkLostEligibilityReceipt(receipt) &&
    typeof fence === 'string' &&
    receiptFences.get(receipt) === fence
  );
}

function fail(reason: MarkLostEligibilityConflictReason): never {
  throw new MarkLostEligibilityConflict(reason);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalDurableJson(left) === canonicalDurableJson(right);
}

function exactObservations(value: unknown): readonly unknown[] {
  try {
    if (!Array.isArray(value) || value.length !== REQUIRED_OBSERVATIONS) {
      return fail('observation-mismatch');
    }
    const names = Object.getOwnPropertyNames(value);
    if (
      Object.getOwnPropertySymbols(value).length !== 0 ||
      names.length !== REQUIRED_OBSERVATIONS + 1 ||
      names.some((name) => name !== 'length' && !/^[0-2]$/u.test(name))
    ) {
      return fail('observation-mismatch');
    }
    return Object.freeze(
      Array.from({ length: REQUIRED_OBSERVATIONS }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
        if (descriptor === undefined || !('value' in descriptor))
          return fail('observation-mismatch');
        return descriptor.value;
      }),
    );
  } catch {
    return fail('observation-mismatch');
  }
}

function parseRequest(
  input: MarkLostEligibilityInput,
): z.infer<typeof markLostEligibilityRequestSchema> {
  let normalized: unknown;
  try {
    if (!Array.isArray(input.factHistory)) return fail('invalid-input');
    normalized = normalizeDurableValue({
      schema: input.schema,
      version: input.version,
      receiptId: input.receiptId,
      idempotencyKey: input.idempotencyKey,
      authority: normalizeDurableValue(input.authority),
      task: normalizeDurableValue(input.task),
      // Normalize independently: an exact baseline reference intentionally
      // appears both as the selector and as its history entry.
      head: normalizeDurableValue(input.head),
      baselineFactRef: normalizeDurableValue(input.baselineFactRef),
      factHistory: input.factHistory.map((entry) =>
        normalizeDurableValue(entry),
      ),
    });
  } catch {
    return fail('invalid-input');
  }
  const parsed = markLostEligibilityRequestSchema.safeParse(normalized);
  if (!parsed.success) return fail('invalid-input');
  return parsed.data;
}

function parseHead(value: unknown): AttemptHistoryHead {
  try {
    return verifyAttemptHistoryHead(value);
  } catch {
    return fail('history-mismatch');
  }
}

function parseFactHistory(input: {
  readonly entries: readonly z.infer<typeof factHistoryEntrySchema>[];
  readonly head: AttemptHistoryHead;
}): ReadonlyMap<
  string,
  {
    readonly reference: AttemptHistoryRecordReference;
    readonly record: HistoryRecord;
    readonly payload: AttemptFactRecordPayload;
  }
> {
  const { head } = input;
  if (input.entries.length !== head.streams.fact.count)
    fail('history-mismatch');
  const records = new Map<
    string,
    {
      reference: AttemptHistoryRecordReference;
      record: HistoryRecord;
      payload: AttemptFactRecordPayload;
    }
  >();
  let previous: HistoryRecord | undefined;
  for (const entry of [...input.entries].sort(
    (left, right) => left.reference.sequence - right.reference.sequence,
  )) {
    let resolved: { readonly record: HistoryRecord; readonly payload: unknown };
    try {
      resolved = verifyAttemptHistoryPayload(
        'fact',
        entry.record,
        entry.payload,
        { tenantId: head.tenantId, attemptId: head.attemptId },
      );
    } catch {
      return fail('history-mismatch');
    }
    const payload = attemptFactPayloadSchema.safeParse(resolved.payload);
    const reference = attemptHistoryRecordReference(
      resolved.record,
      { tenantId: head.tenantId, attemptId: head.attemptId },
      'fact',
    );
    if (
      !payload.success ||
      !sameJson(entry.reference, reference) ||
      records.has(reference.recordDigest) ||
      (previous === undefined
        ? resolved.record.sequence !== 1 ||
          resolved.record.previousRecordDigest !== null
        : resolved.record.sequence !== previous.sequence + 1 ||
          resolved.record.previousRecordDigest !== previous.recordDigest ||
          resolved.record.appliedRevision < previous.appliedRevision)
    ) {
      return fail('history-mismatch');
    }
    previous = resolved.record;
    records.set(reference.recordDigest, {
      reference,
      record: resolved.record,
      payload: payload.data,
    });
  }
  if (
    previous === undefined ||
    previous.sequence !== head.streams.fact.lastSequence ||
    previous.recordDigest !== head.streams.fact.headDigest ||
    previous.appliedRevision !== head.streams.fact.lastAppliedRevision
  ) {
    return fail('history-mismatch');
  }
  return records;
}

function assertEligibleState(
  head: AttemptHistoryHead,
  authority: z.infer<typeof authoritySchema>,
  task: CanonicalTaskIdentity,
): void {
  if (
    head.phase !== 'active' ||
    head.binding === undefined ||
    head.cancellation !== undefined ||
    head.pendingTerminal !== undefined ||
    head.finalization !== undefined ||
    head.outcomeRef !== undefined ||
    head.outcomeDigest !== undefined ||
    head.launch.state !== 'accepted' ||
    head.futureGrantsDenied
  ) {
    fail('invalid-state');
  }
  if (
    !sameJson(task, head.spec.task) ||
    authority.authorityEpoch !== head.spec.activation.authorityEpoch ||
    authority.attemptRevision !== head.aggregateRevision ||
    authority.launchOperationId !== head.launch.operationId ||
    authority.executionEpoch !== head.executionEpoch ||
    head.launch.executionEpoch !== head.executionEpoch
  ) {
    fail('authority-mismatch');
  }
}

function validateBaseline(input: {
  readonly head: AttemptHistoryHead;
  readonly baselineFactRef: AttemptHistoryRecordReference;
  readonly history: ReadonlyMap<
    string,
    {
      readonly reference: AttemptHistoryRecordReference;
      readonly record: HistoryRecord;
      readonly payload: AttemptFactRecordPayload;
    }
  >;
}): {
  readonly reference: AttemptHistoryRecordReference;
  readonly record: HistoryRecord;
  readonly fact: AttemptFactRecordPayload & {
    readonly payload: {
      readonly kind: 'run-bound';
      readonly binding: RunBinding;
    };
  };
} {
  const baseline = input.history.get(input.baselineFactRef.recordDigest);
  if (
    baseline === undefined ||
    !sameJson(baseline.reference, input.baselineFactRef)
  )
    return fail('baseline-mismatch');
  if (baseline.payload.payload.kind !== 'run-bound')
    return fail('baseline-mismatch');
  const runBoundFacts = [...input.history.values()].filter(
    (entry) => entry.payload.payload.kind === 'run-bound',
  );
  if (
    runBoundFacts.length !== 1 ||
    input.head.binding === undefined ||
    !sameJson(baseline.payload.payload.binding, input.head.binding) ||
    baseline.payload.payload.binding.workflowPath !==
      input.head.spec.execution.workflowPath ||
    baseline.payload.payload.binding.workflowRef !==
      input.head.spec.execution.workflowRef ||
    baseline.payload.payload.binding.workflowSha !==
      input.head.spec.execution.workflowSha ||
    baseline.record.appliedRevision > input.head.aggregateRevision ||
    baseline.payload.transitionedAt > input.head.updatedAt
  ) {
    return fail('baseline-mismatch');
  }
  const expected = attemptHistoryTransitionDigest({
    kind: 'observation',
    envelope: {
      schema: 'agent-lcars.runtime-observation/v1' as const,
      version: 1 as const,
      requestId: baseline.payload.requestId,
      factId: baseline.payload.factId,
      attemptId: input.head.attemptId,
      tenant: input.head.spec.tenant,
      task: input.head.spec.task,
      source: baseline.payload.source,
      observedAt: baseline.payload.observedAt,
      payloadSha256: baseline.payload.payloadSha256,
      payload: {
        kind: 'run-bound' as const,
        binding: baseline.payload.payload.binding,
      },
    },
  });
  if (baseline.payload.canonicalDigest !== expected)
    return fail('baseline-mismatch');
  return {
    reference: baseline.reference,
    record: baseline.record,
    fact: baseline.payload as AttemptFactRecordPayload & {
      readonly payload: {
        readonly kind: 'run-bound';
        readonly binding: RunBinding;
      };
    },
  };
}

function epochMillis(value: string): number {
  const parsed = utcDateTimeSchema.safeParse(value);
  const milliseconds = parsed.success ? Date.parse(parsed.data) : Number.NaN;
  if (!Number.isSafeInteger(milliseconds)) return fail('observation-mismatch');
  return milliseconds;
}

function validateObservations(input: {
  readonly raw: unknown;
  readonly binding: RunBinding;
  readonly baselineAt: string;
}): readonly VerifiedRunStuckObservation[] {
  const observations = exactObservations(input.raw);
  if (!observations.every(isVerifiedRunStuckObservation))
    fail('observation-mismatch');
  const verified = observations as readonly VerifiedRunStuckObservation[];
  const factIds = new Set<string>();
  const requestIds = new Set<string>();
  const canonicalDigests = new Set<string>();
  const baselineMillis = epochMillis(input.baselineAt);
  let previous = baselineMillis + RUN_STUCK_POLICY_V1.graceMs;
  for (let index = 0; index < verified.length; index += 1) {
    const observation = verified[index];
    if (
      !sameJson(observation.binding, input.binding) ||
      observation.status.kind !== 'nonterminal' ||
      factIds.has(observation.factId) ||
      requestIds.has(observation.requestId) ||
      canonicalDigests.has(observation.canonicalDigest)
    ) {
      fail('observation-mismatch');
    }
    const observedAt = epochMillis(observation.observedAt);
    const deadline =
      baselineMillis +
      RUN_STUCK_POLICY_V1.graceMs +
      index * RUN_STUCK_POLICY_V1.minimumIntervalMs;
    if (observedAt < previous || observedAt > deadline)
      fail('observation-mismatch');
    factIds.add(observation.factId);
    requestIds.add(observation.requestId);
    canonicalDigests.add(observation.canonicalDigest);
    previous = observedAt + RUN_STUCK_POLICY_V1.minimumIntervalMs;
  }
  return frozenClone(verified);
}

/**
 * Pure, fail-closed eligibility decision. It neither reads nor writes state;
 * persistence/commit code must independently re-check its own current fence.
 */
export function validateMarkLostEligibility(
  input: MarkLostEligibilityInput,
): MarkLostEligibilityReceipt {
  let request: z.infer<typeof markLostEligibilityRequestSchema>;
  try {
    request = parseRequest(input);
  } catch (error) {
    if (error instanceof MarkLostEligibilityConflict) throw error;
    return fail('invalid-input');
  }
  const head = parseHead(request.head);
  assertEligibleState(head, request.authority, request.task);
  const history = parseFactHistory({ entries: request.factHistory, head });
  const baseline = validateBaseline({
    head,
    baselineFactRef: request.baselineFactRef,
    history,
  });
  const observations = validateObservations({
    raw: input.observations,
    binding: baseline.fact.payload.binding,
    baselineAt: baseline.fact.observedAt,
  });
  const eligibleAt = observations[REQUIRED_OBSERVATIONS - 1].observedAt;
  const receiptWithoutDigest = {
    schema: 'agent-lcars.mark-lost-eligibility-receipt/v1' as const,
    version: 1 as const,
    receiptId: request.receiptId,
    idempotencyKey: request.idempotencyKey,
    tenantId: head.tenantId,
    attemptId: head.attemptId,
    task: request.task,
    authorityEpoch: request.authority.authorityEpoch,
    attemptRevision: request.authority.attemptRevision,
    launchOperationId: request.authority.launchOperationId,
    executionEpoch: request.authority.executionEpoch,
    binding: baseline.fact.payload.binding,
    baseline: {
      factId: baseline.fact.factId,
      requestId: baseline.fact.requestId,
      observedAt: baseline.fact.observedAt,
      reference: baseline.reference,
      recordDigest: baseline.record.recordDigest,
      payloadDigest: baseline.record.payloadDigest,
      payloadSha256: baseline.fact.payloadSha256,
      canonicalDigest: baseline.fact.canonicalDigest,
    },
    policy: RUN_STUCK_POLICY_V1,
    observations,
    thresholdObservationNumber: 3 as const,
    eligibleAt,
  };
  let receipt: MarkLostEligibilityReceipt;
  try {
    receipt = frozenClone({
      ...receiptWithoutDigest,
      causalDigest: domainDigest(RECEIPT_DOMAIN, receiptWithoutDigest),
    });
    validateDurableValue(receipt, 'replayReceiptBytes');
  } catch {
    return fail('capacity-exceeded');
  }
  eligibilityReceipts.add(receipt);
  receiptFences.set(receipt, request.authority.fence);
  return receipt;
}

/** Same receipt identity is replayable only when its evidence commitment agrees. */
export function markLostReceiptReplayMatches(
  left: unknown,
  right: unknown,
): boolean {
  return (
    isMarkLostEligibilityReceipt(left) &&
    isMarkLostEligibilityReceipt(right) &&
    left.receiptId === right.receiptId &&
    left.idempotencyKey === right.idempotencyKey &&
    left.causalDigest === right.causalDigest
  );
}

/** A matching idempotency identity may only reproduce its original evidence. */
export function assertMarkLostReceiptReplay(
  existing: unknown,
  candidate: unknown,
): void {
  if (
    !isMarkLostEligibilityReceipt(existing) ||
    !isMarkLostEligibilityReceipt(candidate) ||
    existing.receiptId !== candidate.receiptId ||
    existing.idempotencyKey !== candidate.idempotencyKey ||
    existing.causalDigest !== candidate.causalDigest
  ) {
    fail('observation-mismatch');
  }
}
