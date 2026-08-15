import { z } from 'zod';

import {
  canonicalDurableJson,
  DurabilityCapacityError,
  DurableJsonValue,
  normalizeDurableValue,
  validateDurableValue,
} from './durability';
import {
  nonnegativeSafeIntegerSchema,
  opaqueIdSchema,
  positiveSafeIntegerSchema,
  sha256Schema,
} from './primitives';

/** The only aggregate namespaces understood by the generic history layer. */
export const HISTORY_AGGREGATE_KINDS = ['task', 'attempt'] as const;
export type HistoryAggregateKind = (typeof HISTORY_AGGREGATE_KINDS)[number];
export const historyAggregateKindSchema = z.enum(HISTORY_AGGREGATE_KINDS);

/**
 * Streams are deliberately semantic, but payload unions belong to the Task
 * and Attempt children.  A stream name is not permission to put arbitrary
 * provider data in a record.
 */
export const HISTORY_STREAM_KINDS = [
  'fact',
  'intent',
  'command',
  'claim',
  'validation',
  'evidence',
  'effect',
  'presentation',
] as const;
export type HistoryStreamKind = (typeof HISTORY_STREAM_KINDS)[number];
export const historyStreamKindSchema = z.enum(HISTORY_STREAM_KINDS);

const historyRecordSchemaId = z.literal(
  'agent-lcars.lifecycle-history-record/v1',
);
const historyRecordReferenceSchemaId = z.literal(
  'agent-lcars.lifecycle-history-record-reference/v1',
);
const historyHeadSchemaId = z.literal('agent-lcars.lifecycle-history-head/v1');
const replayReceiptSchemaId = z.literal(
  'agent-lcars.lifecycle-replay-receipt/v1',
);
const idempotencyTombstoneSchemaId = z.literal(
  'agent-lcars.lifecycle-idempotency-tombstone/v1',
);

export const HISTORY_DOMAINS = Object.freeze({
  genesis: 'agent-lcars.lifecycle-history/genesis/v1',
  input: 'agent-lcars.lifecycle-history/input/v1',
  payload: 'agent-lcars.lifecycle-history/payload/v1',
  record: 'agent-lcars.lifecycle-history/record/v1',
  response: 'agent-lcars.lifecycle-history/response/v1',
} as const);

const digestOrGenesisSchema = z.union([z.literal(null), sha256Schema]);
const _identitySchema = z.strictObject({
  tenantId: opaqueIdSchema,
  aggregateKind: historyAggregateKindSchema,
  aggregateId: opaqueIdSchema,
  streamKind: historyStreamKindSchema,
});
export const historyIdentitySchema = _identitySchema;
export type HistoryIdentity = z.infer<typeof _identitySchema>;

/** An immutable reference which can be resolved without copying its payload. */
export const historyRecordReferenceSchema = z.strictObject({
  schema: historyRecordReferenceSchemaId,
  version: z.literal(1),
  tenantId: opaqueIdSchema,
  aggregateKind: historyAggregateKindSchema,
  aggregateId: opaqueIdSchema,
  streamKind: historyStreamKindSchema,
  sequence: positiveSafeIntegerSchema,
  recordDigest: sha256Schema,
});
export type HistoryRecordReference = z.infer<
  typeof historyRecordReferenceSchema
>;

/**
 * The immutable stream record.  `payload` is intentionally not part of this
 * generic contract: semantic children own their closed payload schemas and
 * persist only their canonical payload digest here.
 */
export const historyRecordSchema = z.strictObject({
  schema: historyRecordSchemaId,
  version: z.literal(1),
  domain: z.literal(HISTORY_DOMAINS.record),
  tenantId: opaqueIdSchema,
  aggregateKind: historyAggregateKindSchema,
  aggregateId: opaqueIdSchema,
  streamKind: historyStreamKindSchema,
  sequence: positiveSafeIntegerSchema,
  previousRecordDigest: digestOrGenesisSchema,
  payloadDigest: sha256Schema,
  appliedRevision: positiveSafeIntegerSchema,
  recordDigest: sha256Schema,
});
export type HistoryRecord = z.infer<typeof historyRecordSchema>;

/** A bounded immutable stream head and cursor. */
export const historyHeadSchema = z
  .strictObject({
    schema: historyHeadSchemaId,
    version: z.literal(1),
    domain: z.literal(HISTORY_DOMAINS.genesis),
    tenantId: opaqueIdSchema,
    aggregateKind: historyAggregateKindSchema,
    aggregateId: opaqueIdSchema,
    streamKind: historyStreamKindSchema,
    count: nonnegativeSafeIntegerSchema,
    lastSequence: nonnegativeSafeIntegerSchema,
    headDigest: digestOrGenesisSchema,
    lastAppliedRevision: nonnegativeSafeIntegerSchema,
  })
  .superRefine((head, ctx) => {
    if (head.count !== head.lastSequence) {
      ctx.addIssue({
        code: 'custom',
        path: ['lastSequence'],
        message: 'History count and last sequence must agree',
      });
    }
    if (
      head.count === 0 &&
      (head.headDigest !== null || head.lastAppliedRevision !== 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['headDigest'],
        message: 'Genesis history head must have no digest or applied revision',
      });
    }
    if (head.count > 0) {
      if (head.headDigest === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['headDigest'],
          message: 'Non-empty history head must have a digest',
        });
      }
      if (head.lastAppliedRevision === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['lastAppliedRevision'],
          message: 'Non-empty history head must have an applied revision',
        });
      }
    }
  });
export type HistoryHead = z.infer<typeof historyHeadSchema>;
export type HistoryCursor = HistoryHead;
export const historyCursorSchema = historyHeadSchema;

const recordPointerSchema = historyRecordReferenceSchema;

const durableJsonValueSchema = z.any().transform((value, ctx) => {
  try {
    return normalizeDurableValue(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Must be canonical durable JSON' });
    return z.NEVER;
  }
});

/** Compact replay receipt; response is either a bounded snapshot or pointers. */
export const replayReceiptSchema = z
  .strictObject({
    schema: replayReceiptSchemaId,
    version: z.literal(1),
    operationId: opaqueIdSchema,
    replayKey: opaqueIdSchema,
    tenantId: opaqueIdSchema,
    aggregateKind: historyAggregateKindSchema,
    aggregateId: opaqueIdSchema,
    canonicalInputDigest: sha256Schema,
    appliedRevision: nonnegativeSafeIntegerSchema,
    responseDigest: sha256Schema,
    responseSnapshot: durableJsonValueSchema.optional(),
    responseRecordRefs: z.array(recordPointerSchema).max(64).optional(),
    emittedEffectRefs: z.array(recordPointerSchema).max(32).optional(),
    emittedWorkRefs: z.array(recordPointerSchema).max(32).optional(),
    emittedPresentationRefs: z.array(recordPointerSchema).max(32).optional(),
  })
  .superRefine((receipt, ctx) => {
    const hasSnapshot = receipt.responseSnapshot !== undefined;
    const hasRefs = receipt.responseRecordRefs !== undefined;
    if (hasSnapshot === hasRefs) {
      ctx.addIssue({
        code: 'custom',
        path: ['responseSnapshot'],
        message: 'Receipt needs exactly one response snapshot or reference set',
      });
    }
    if (
      receipt.responseSnapshot !== undefined &&
      receipt.responseRecordRefs !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['responseRecordRefs'],
        message: 'Receipt cannot contain both response forms',
      });
    }
  });
export type ReplayReceipt = z.infer<typeof replayReceiptSchema>;

export const IDEMPOTENCY_RESULT_DISPOSITIONS = [
  'applied',
  'replayed',
  'rejected',
  'no-op',
] as const;
export type IdempotencyResultDisposition =
  (typeof IDEMPOTENCY_RESULT_DISPOSITIONS)[number];
export const idempotencyResultDispositionSchema = z.enum(
  IDEMPOTENCY_RESULT_DISPOSITIONS,
);

/** Permanent key record.  `receiptPointer` may survive receipt retention. */
export const idempotencyTombstoneSchema = z.strictObject({
  schema: idempotencyTombstoneSchemaId,
  version: z.literal(1),
  tenantId: opaqueIdSchema,
  aggregateKind: historyAggregateKindSchema,
  aggregateId: opaqueIdSchema,
  replayKey: opaqueIdSchema,
  canonicalInputDigest: sha256Schema,
  receiptPointer: opaqueIdSchema.nullable(),
  disposition: idempotencyResultDispositionSchema,
});
export type IdempotencyTombstone = z.infer<typeof idempotencyTombstoneSchema>;

/** Generic typed error.  Deliberately carries no rejected value or provider data. */
export class HistoryIntegrityError extends Error {
  override readonly name = 'HistoryIntegrityError';
  readonly reason: HistoryIntegrityReason;

  constructor(reason: HistoryIntegrityReason) {
    super(`Lifecycle history integrity check failed: ${reason}`);
    this.reason = reason;
  }
}

export type HistoryIntegrityReason =
  | 'invalid-record'
  | 'invalid-head'
  | 'invalid-receipt'
  | 'invalid-tombstone'
  | 'wrong-identity'
  | 'wrong-predecessor'
  | 'wrong-sequence'
  | 'sequence-gap'
  | 'sequence-overflow'
  | 'digest-mismatch'
  | 'missing-reference'
  | 'replay-conflict'
  | 'response-mismatch';

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      freeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function parseFrozen<T>(
  schema: z.ZodType<T>,
  input: unknown,
  reason: HistoryIntegrityReason,
): T {
  let normalized: DurableJsonValue;
  try {
    normalized = normalizeDurableValue(input);
  } catch {
    throw new HistoryIntegrityError(reason);
  }
  const parsed = schema.safeParse(normalized);
  if (!parsed.success) throw new HistoryIntegrityError(reason);
  return freeze(parsed.data);
}

/* SHA-256 is kept dependency-free so this provider-neutral package remains usable in browser code. */
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;
function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}
function sha256Hex(value: string): string {
  const input = new TextEncoder().encode(value);
  const bitLength = input.length * 8;
  const paddedLength = ((input.length + 9 + 63) >> 6) << 6;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  let h0 = 0x6a09e667,
    h1 = 0xbb67ae85,
    h2 = 0x3c6ef372,
    h3 = 0xa54ff53a;
  let h4 = 0x510e527f,
    h5 = 0x9b05688c,
    h6 = 0x1f83d9ab,
    h7 = 0x5be0cd19;
  const words = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 =
        rotr(words[i - 15], 7) ^
        rotr(words[i - 15], 18) ^
        (words[i - 15] >>> 3);
      const s1 =
        rotr(words[i - 2], 17) ^ rotr(words[i - 2], 19) ^ (words[i - 2] >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      h = h7;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[i] + words[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => x.toString(16).padStart(8, '0'))
    .join('');
}

/** Provider-neutral synchronous SHA-256 over UTF-8 text. */
export const sha256Digest = sha256Hex;

function digestDomain(domain: string, value: unknown): string {
  return sha256Hex(`${domain}\u0000${canonicalDurableJson(value)}`);
}

export function historyPayloadDigest(payload: unknown): string {
  return digestDomain(HISTORY_DOMAINS.payload, normalizeDurableValue(payload));
}
export const durablePayloadDigest = historyPayloadDigest;

function identityOf(
  input: Pick<
    HistoryIdentity,
    'tenantId' | 'aggregateKind' | 'aggregateId' | 'streamKind'
  >,
): HistoryIdentity {
  return {
    tenantId: input.tenantId,
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    streamKind: input.streamKind,
  };
}

export interface HistoryRecordInput extends HistoryIdentity {
  readonly sequence: number;
  readonly previousRecordDigest: string | null;
  readonly payload: unknown;
  readonly appliedRevision: number;
}

export function deriveHistoryRecordDigest(
  record: Omit<HistoryRecord, 'recordDigest'>,
): string {
  return digestDomain(HISTORY_DOMAINS.record, {
    schema: record.schema,
    version: record.version,
    domain: record.domain,
    tenantId: record.tenantId,
    aggregateKind: record.aggregateKind,
    aggregateId: record.aggregateId,
    streamKind: record.streamKind,
    sequence: record.sequence,
    previousRecordDigest: record.previousRecordDigest,
    appliedRevision: record.appliedRevision,
    payloadDigest: record.payloadDigest,
  });
}
export const historyRecordDigest = deriveHistoryRecordDigest;

export function createHistoryRecord(input: HistoryRecordInput): HistoryRecord {
  const payload = validateDurableValue(input.payload, 'historyRecordBytes');
  const payloadDigest = historyPayloadDigest(payload);
  const unsigned: Omit<HistoryRecord, 'recordDigest'> = {
    schema: 'agent-lcars.lifecycle-history-record/v1',
    version: 1,
    domain: HISTORY_DOMAINS.record,
    ...identityOf(input),
    sequence: input.sequence,
    previousRecordDigest: input.previousRecordDigest,
    payloadDigest,
    appliedRevision: input.appliedRevision,
  };
  const record = parseFrozen(
    historyRecordSchema,
    { ...unsigned, recordDigest: deriveHistoryRecordDigest(unsigned) },
    'invalid-record',
  );
  return verifyHistoryRecordPayload(record, payload).record;
}

export function verifyHistoryRecord(record: unknown): HistoryRecord {
  const parsed = parseFrozen(historyRecordSchema, record, 'invalid-record');
  if (
    (parsed.sequence === 1 && parsed.previousRecordDigest !== null) ||
    (parsed.sequence > 1 && parsed.previousRecordDigest === null)
  ) {
    throw new HistoryIntegrityError('wrong-predecessor');
  }
  if (deriveHistoryRecordDigest(parsed) !== parsed.recordDigest) {
    throw new HistoryIntegrityError('digest-mismatch');
  }
  validateDurableValue(parsed, 'historyRecordBytes');
  return parsed;
}
export const validateHistoryRecord = verifyHistoryRecord;

/** Verify the exact semantic payload and the complete persisted entry budget. */
export function verifyHistoryRecordPayload(
  record: unknown,
  payload: unknown,
): Readonly<{ record: HistoryRecord; payload: DurableJsonValue }> {
  const parsedRecord = verifyHistoryRecord(record);
  let normalizedPayload: DurableJsonValue;
  try {
    normalizedPayload = normalizeDurableValue(payload);
  } catch {
    throw new HistoryIntegrityError('invalid-record');
  }
  if (historyPayloadDigest(normalizedPayload) !== parsedRecord.payloadDigest) {
    throw new HistoryIntegrityError('digest-mismatch');
  }
  validateDurableValue(
    { record: parsedRecord, payload: normalizedPayload },
    'historyRecordBytes',
  );
  return freeze({ record: parsedRecord, payload: normalizedPayload });
}

export interface HistoryHeadInput extends Omit<HistoryIdentity, 'streamKind'> {
  readonly streamKind: HistoryStreamKind;
}

export function createGenesisHistoryHead(input: HistoryHeadInput): HistoryHead {
  return parseFrozen(
    historyHeadSchema,
    {
      schema: 'agent-lcars.lifecycle-history-head/v1',
      version: 1,
      domain: HISTORY_DOMAINS.genesis,
      ...identityOf(input),
      count: 0,
      lastSequence: 0,
      headDigest: null,
      lastAppliedRevision: 0,
    },
    'invalid-head',
  );
}
export const createGenesisHistoryCursor = createGenesisHistoryHead;

export interface AppendHistoryInput {
  readonly head: HistoryHead;
  readonly record: HistoryRecord;
}
export interface AppendHistoryResult {
  readonly head: HistoryHead;
  readonly record: HistoryRecord;
}

export function verifyHistoryAppend(
  input: AppendHistoryInput,
): AppendHistoryResult {
  const head = parseFrozen(historyHeadSchema, input.head, 'invalid-head');
  const record = verifyHistoryRecord(input.record);
  if (
    head.lastSequence === Number.MAX_SAFE_INTEGER ||
    head.count === Number.MAX_SAFE_INTEGER
  ) {
    throw new HistoryIntegrityError('sequence-overflow');
  }
  if (
    head.tenantId !== record.tenantId ||
    head.aggregateKind !== record.aggregateKind ||
    head.aggregateId !== record.aggregateId ||
    head.streamKind !== record.streamKind
  )
    throw new HistoryIntegrityError('wrong-identity');
  if (record.sequence !== head.lastSequence + 1) {
    throw new HistoryIntegrityError(
      record.sequence > head.lastSequence + 1
        ? 'sequence-gap'
        : 'wrong-sequence',
    );
  }
  if (record.previousRecordDigest !== head.headDigest)
    throw new HistoryIntegrityError('wrong-predecessor');
  if (record.appliedRevision < head.lastAppliedRevision) {
    throw new HistoryIntegrityError('wrong-sequence');
  }
  const next = parseFrozen(
    historyHeadSchema,
    {
      ...head,
      count: head.count + 1,
      lastSequence: record.sequence,
      headDigest: record.recordDigest,
      lastAppliedRevision: record.appliedRevision,
    },
    'invalid-head',
  );
  return freeze({ head: next, record });
}

export function appendHistoryRecord(input: {
  readonly head: HistoryHead;
  readonly payload: unknown;
  readonly appliedRevision: number;
}): AppendHistoryResult {
  const head = parseFrozen(historyHeadSchema, input.head, 'invalid-head');
  if (
    head.lastSequence === Number.MAX_SAFE_INTEGER ||
    head.count === Number.MAX_SAFE_INTEGER
  ) {
    throw new HistoryIntegrityError('sequence-overflow');
  }
  const record = createHistoryRecord({
    tenantId: head.tenantId,
    aggregateKind: head.aggregateKind,
    aggregateId: head.aggregateId,
    streamKind: head.streamKind,
    sequence: head.lastSequence + 1,
    previousRecordDigest: head.headDigest,
    payload: input.payload,
    appliedRevision: input.appliedRevision,
  });
  return verifyHistoryAppend({ head, record });
}

export function verifyHistoryChain(
  records: readonly unknown[],
  expectedHead?: unknown,
): HistoryHead {
  let head: HistoryHead | undefined;
  if (records.length === 0 && expectedHead !== undefined) {
    const expected = parseFrozen(
      historyHeadSchema,
      expectedHead,
      'invalid-head',
    );
    if (expected.count !== 0)
      throw new HistoryIntegrityError('missing-reference');
    return expected;
  }
  for (const value of records) {
    const record = verifyHistoryRecord(value);
    if (head === undefined) {
      head = createGenesisHistoryHead(record);
    }
    head = verifyHistoryAppend({ head, record }).head;
  }
  if (head === undefined) throw new HistoryIntegrityError('missing-reference');
  if (expectedHead !== undefined) {
    const expected = parseFrozen(
      historyHeadSchema,
      expectedHead,
      'invalid-head',
    );
    if (canonicalDurableJson(expected) !== canonicalDurableJson(head))
      throw new HistoryIntegrityError('digest-mismatch');
  }
  return head;
}

export function historyRecordReference(
  record: HistoryRecord,
): HistoryRecordReference {
  const valid = verifyHistoryRecord(record);
  return freeze({
    schema: 'agent-lcars.lifecycle-history-record-reference/v1',
    version: valid.version,
    tenantId: valid.tenantId,
    aggregateKind: valid.aggregateKind,
    aggregateId: valid.aggregateId,
    streamKind: valid.streamKind,
    sequence: valid.sequence,
    recordDigest: valid.recordDigest,
  });
}

function responseDigest(receipt: {
  readonly operationId?: string;
  readonly replayKey?: string;
  readonly tenantId?: string;
  readonly aggregateKind?: HistoryAggregateKind;
  readonly aggregateId?: string;
  readonly canonicalInputDigest?: string;
  readonly appliedRevision?: number;
  readonly responseSnapshot?: DurableJsonValue;
  readonly responseRecordRefs?: readonly HistoryRecordReference[];
  readonly emittedEffectRefs?: readonly HistoryRecordReference[];
  readonly emittedWorkRefs?: readonly HistoryRecordReference[];
  readonly emittedPresentationRefs?: readonly HistoryRecordReference[];
}): string {
  return digestDomain(HISTORY_DOMAINS.response, {
    operationId: receipt.operationId !== undefined ? receipt.operationId : null,
    replayKey: receipt.replayKey !== undefined ? receipt.replayKey : null,
    tenantId: receipt.tenantId !== undefined ? receipt.tenantId : null,
    aggregateKind:
      receipt.aggregateKind !== undefined ? receipt.aggregateKind : null,
    aggregateId: receipt.aggregateId !== undefined ? receipt.aggregateId : null,
    canonicalInputDigest:
      receipt.canonicalInputDigest !== undefined
        ? receipt.canonicalInputDigest
        : null,
    appliedRevision:
      receipt.appliedRevision !== undefined ? receipt.appliedRevision : null,
    responseSnapshot:
      receipt.responseSnapshot !== undefined ? receipt.responseSnapshot : null,
    responseRecordRefs:
      receipt.responseRecordRefs !== undefined
        ? receipt.responseRecordRefs
        : null,
    emittedEffectRefs:
      receipt.emittedEffectRefs !== undefined
        ? receipt.emittedEffectRefs
        : null,
    emittedWorkRefs:
      receipt.emittedWorkRefs !== undefined ? receipt.emittedWorkRefs : null,
    emittedPresentationRefs:
      receipt.emittedPresentationRefs !== undefined
        ? receipt.emittedPresentationRefs
        : null,
  });
}

export function canonicalReplayInputDigest(input: unknown): string {
  return digestDomain(HISTORY_DOMAINS.input, normalizeDurableValue(input));
}

export function replayResponseDigest(input: {
  readonly operationId: string;
  readonly replayKey: string;
  readonly tenantId: string;
  readonly aggregateKind: HistoryAggregateKind;
  readonly aggregateId: string;
  readonly canonicalInputDigest: string;
  readonly appliedRevision: number;
  readonly responseSnapshot?: DurableJsonValue;
  readonly responseRecordRefs?: readonly HistoryRecordReference[];
  readonly emittedEffectRefs?: readonly HistoryRecordReference[];
  readonly emittedWorkRefs?: readonly HistoryRecordReference[];
  readonly emittedPresentationRefs?: readonly HistoryRecordReference[];
}): string {
  return responseDigest(input);
}

export interface ReplayReceiptInput {
  readonly operationId: string;
  readonly replayKey: string;
  readonly tenantId: string;
  readonly aggregateKind: HistoryAggregateKind;
  readonly aggregateId: string;
  readonly canonicalInputDigest: string;
  readonly appliedRevision: number;
  readonly responseSnapshot?: unknown;
  readonly responseRecordRefs?: readonly HistoryRecordReference[];
  readonly emittedEffectRefs?: readonly HistoryRecordReference[];
  readonly emittedWorkRefs?: readonly HistoryRecordReference[];
  readonly emittedPresentationRefs?: readonly HistoryRecordReference[];
}

function assertReceiptReferenceScope(
  receipt: Pick<
    ReplayReceiptInput,
    'tenantId' | 'aggregateKind' | 'aggregateId'
  >,
  refs: readonly HistoryRecordReference[] | undefined,
): void {
  for (const reference of refs ?? []) {
    if (
      reference.tenantId !== receipt.tenantId ||
      reference.aggregateKind !== receipt.aggregateKind ||
      reference.aggregateId !== receipt.aggregateId
    ) {
      throw new HistoryIntegrityError('wrong-identity');
    }
  }
}

function parseReferenceList(
  refs: readonly unknown[] | undefined,
): HistoryRecordReference[] | undefined {
  if (refs === undefined) return undefined;
  if (!Array.isArray(refs)) throw new HistoryIntegrityError('invalid-receipt');
  return refs.map((ref) =>
    parseFrozen(historyRecordReferenceSchema, ref, 'invalid-receipt'),
  );
}

export function createReplayReceipt(input: ReplayReceiptInput): ReplayReceipt {
  if (
    (input.responseSnapshot === undefined) ===
    (input.responseRecordRefs === undefined)
  ) {
    throw new HistoryIntegrityError('invalid-receipt');
  }
  const responseRecordRefs = parseReferenceList(input.responseRecordRefs);
  const emittedEffectRefs = parseReferenceList(input.emittedEffectRefs);
  const emittedWorkRefs = parseReferenceList(input.emittedWorkRefs);
  const emittedPresentationRefs = parseReferenceList(
    input.emittedPresentationRefs,
  );
  assertReceiptReferenceScope(input, responseRecordRefs);
  assertReceiptReferenceScope(input, emittedEffectRefs);
  assertReceiptReferenceScope(input, emittedWorkRefs);
  assertReceiptReferenceScope(input, emittedPresentationRefs);
  let snapshot: DurableJsonValue | undefined;
  if (input.responseSnapshot !== undefined) {
    try {
      snapshot = normalizeDurableValue(input.responseSnapshot);
    } catch (error) {
      if (error instanceof DurabilityCapacityError) throw error;
      throw new HistoryIntegrityError('invalid-receipt');
    }
  }
  const raw = {
    schema: 'agent-lcars.lifecycle-replay-receipt/v1',
    version: 1,
    operationId: input.operationId,
    replayKey: input.replayKey,
    tenantId: input.tenantId,
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    canonicalInputDigest: input.canonicalInputDigest,
    appliedRevision: input.appliedRevision,
    responseDigest: responseDigest({
      operationId: input.operationId,
      replayKey: input.replayKey,
      tenantId: input.tenantId,
      aggregateKind: input.aggregateKind,
      aggregateId: input.aggregateId,
      canonicalInputDigest: input.canonicalInputDigest,
      appliedRevision: input.appliedRevision,
      responseSnapshot: snapshot,
      responseRecordRefs,
      emittedEffectRefs,
      emittedWorkRefs,
      emittedPresentationRefs,
    }),
    ...(snapshot === undefined ? {} : { responseSnapshot: snapshot }),
    ...(responseRecordRefs === undefined ? {} : { responseRecordRefs }),
    ...(emittedEffectRefs === undefined ? {} : { emittedEffectRefs }),
    ...(emittedWorkRefs === undefined ? {} : { emittedWorkRefs }),
    ...(emittedPresentationRefs === undefined
      ? {}
      : { emittedPresentationRefs }),
  };
  const validated = parseFrozen(replayReceiptSchema, raw, 'invalid-receipt');
  const bounded = validateDurableValue(validated, 'replayReceiptBytes');
  return freeze(bounded as ReplayReceipt);
}

export function verifyReplayReceipt(receipt: unknown): ReplayReceipt {
  const parsed = parseFrozen(replayReceiptSchema, receipt, 'invalid-receipt');
  assertReceiptReferenceScope(parsed, parsed.responseRecordRefs);
  assertReceiptReferenceScope(parsed, parsed.emittedEffectRefs);
  assertReceiptReferenceScope(parsed, parsed.emittedWorkRefs);
  assertReceiptReferenceScope(parsed, parsed.emittedPresentationRefs);
  try {
    if (responseDigest(parsed) !== parsed.responseDigest)
      throw new HistoryIntegrityError('response-mismatch');
  } catch (error) {
    if (error instanceof HistoryIntegrityError) throw error;
    throw new HistoryIntegrityError('invalid-receipt');
  }
  try {
    validateDurableValue(parsed, 'replayReceiptBytes');
  } catch (error) {
    if (error instanceof DurabilityCapacityError) throw error;
    throw new HistoryIntegrityError('invalid-receipt');
  }
  return parsed;
}

export interface HistoryReferenceResolver {
  (reference: HistoryRecordReference): unknown | undefined;
}

export function verifyReplayReceiptReferences(
  receipt: unknown,
  resolve: HistoryReferenceResolver,
): ReplayReceipt {
  const parsed = verifyReplayReceipt(receipt);
  const refs = [
    ...(parsed.responseRecordRefs ?? []),
    ...(parsed.emittedEffectRefs ?? []),
    ...(parsed.emittedWorkRefs ?? []),
    ...(parsed.emittedPresentationRefs ?? []),
  ];
  assertReceiptReferenceScope(parsed, refs);
  for (const reference of refs) {
    const value = resolve(reference);
    if (value === undefined)
      throw new HistoryIntegrityError('missing-reference');
    const record = verifyHistoryRecord(value);
    if (
      canonicalDurableJson(historyRecordReference(record)) !==
      canonicalDurableJson(reference)
    ) {
      throw new HistoryIntegrityError('digest-mismatch');
    }
  }
  return parsed;
}

export interface IdempotencyTombstoneInput {
  readonly tenantId: string;
  readonly aggregateKind: HistoryAggregateKind;
  readonly aggregateId: string;
  readonly replayKey: string;
  readonly canonicalInputDigest: string;
  readonly receiptPointer: string | null;
  readonly disposition: IdempotencyResultDisposition;
}

export function createIdempotencyTombstone(
  input: IdempotencyTombstoneInput,
): IdempotencyTombstone {
  return parseFrozen(
    idempotencyTombstoneSchema,
    {
      schema: 'agent-lcars.lifecycle-idempotency-tombstone/v1',
      version: 1,
      ...input,
    },
    'invalid-tombstone',
  );
}

export function verifyIdempotencyTombstone(
  value: unknown,
): IdempotencyTombstone {
  return parseFrozen(idempotencyTombstoneSchema, value, 'invalid-tombstone');
}

/** Resolve a key forever: a changed digest is never treated as a new request. */
export function assertIdempotencyCompatible(
  tombstone: unknown,
  identity: Pick<
    IdempotencyTombstoneInput,
    'tenantId' | 'aggregateKind' | 'aggregateId'
  > & {
    readonly replayKey: string;
    readonly canonicalInputDigest: string;
  },
): IdempotencyTombstone {
  const parsed = verifyIdempotencyTombstone(tombstone);
  if (
    parsed.tenantId !== identity.tenantId ||
    parsed.aggregateKind !== identity.aggregateKind ||
    parsed.aggregateId !== identity.aggregateId ||
    parsed.replayKey !== identity.replayKey ||
    parsed.canonicalInputDigest !== identity.canonicalInputDigest
  ) {
    throw new HistoryIntegrityError('replay-conflict');
  }
  return parsed;
}
export const verifyIdempotencyReplay = assertIdempotencyCompatible;

export const historyRecordSchemaV1 = historyRecordSchema;
export const historyHeadSchemaV1 = historyHeadSchema;
export const replayReceiptSchemaV1 = replayReceiptSchema;
export const idempotencyTombstoneSchemaV1 = idempotencyTombstoneSchema;
export const immutableHistoryRecordSchema = historyRecordSchema;
export const compactReplayReceiptSchema = replayReceiptSchema;
