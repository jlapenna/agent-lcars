import { z } from 'zod';

import {
  canonicalDurableJson,
  DurabilityCapacityError,
  DurableJsonValue,
  LIFECYCLE_DURABILITY_LIMITS,
  normalizeDurableValue,
  serializedDurableByteLength,
  validateDurablePage,
} from './durability';
import {
  canonicalReplayInputDigest,
  HistoryIntegrityError,
  sha256Digest,
} from './history';
import {
  attemptIdSchema,
  nonnegativeSafeIntegerSchema,
  opaqueIdSchema,
  positiveSafeIntegerSchema,
  sha256Schema,
  utcDateTimeSchema,
} from './primitives';

export const PAGINATION_COLLECTIONS = [
  'task-presentations',
  'attempt-presentations',
  'presentation-delivery',
  'task-effects',
  'cancellation-work',
  'validation-work',
  'launch-work',
] as const;
export type PaginationCollection = (typeof PAGINATION_COLLECTIONS)[number];
export const paginationCollectionSchema = z.enum(PAGINATION_COLLECTIONS);

const taskSubjectSchema = z.strictObject({
  kind: z.literal('task'),
  repositoryId: positiveSafeIntegerSchema,
  issueNumber: positiveSafeIntegerSchema,
});
const attemptSubjectSchema = z.strictObject({
  kind: z.literal('attempt'),
  attemptId: attemptIdSchema,
});
const tenantSubjectSchema = z.strictObject({ kind: z.literal('tenant') });
export const paginationSubjectSchema = z.discriminatedUnion('kind', [
  taskSubjectSchema,
  attemptSubjectSchema,
  tenantSubjectSchema,
]);
export type PaginationSubject = z.infer<typeof paginationSubjectSchema>;

const tenantFilter = { tenantId: opaqueIdSchema };
const taskFilter = z.strictObject({
  ...tenantFilter,
  collection: z.literal('task-presentations'),
  subject: taskSubjectSchema,
  state: z.enum(['pending', 'obsolete']).optional(),
});
const attemptFilter = z.strictObject({
  ...tenantFilter,
  collection: z.literal('attempt-presentations'),
  subject: z.union([attemptSubjectSchema, taskSubjectSchema]),
});
const deliveryFilter = z.strictObject({
  ...tenantFilter,
  collection: z.literal('presentation-delivery'),
  subject: z.union([
    tenantSubjectSchema,
    taskSubjectSchema,
    attemptSubjectSchema,
  ]),
  source: z.enum(['task', 'attempt']).optional(),
  state: z
    .enum(['pending', 'in-flight', 'converged', 'unknown', 'obsolete'])
    .optional(),
});
const effectFilter = z.strictObject({
  ...tenantFilter,
  collection: z.literal('task-effects'),
  subject: taskSubjectSchema,
  state: z.enum(['pending', 'working', 'complete', 'obsolete']).optional(),
});
const cancellationFilter = z.strictObject({
  ...tenantFilter,
  collection: z.literal('cancellation-work'),
  subject: tenantSubjectSchema,
  state: z.enum(['awaiting-binding', 'pending']).optional(),
});
const validationFilter = z.strictObject({
  ...tenantFilter,
  collection: z.literal('validation-work'),
  subject: tenantSubjectSchema,
  state: z.enum(['pending', 'resolving', 'complete']).optional(),
});
const launchFilter = z.strictObject({
  ...tenantFilter,
  collection: z.literal('launch-work'),
  subject: tenantSubjectSchema,
  state: z.enum([
    'pending',
    'dispatching',
    'accepted',
    'unknown',
    'suppressed',
  ]),
});

export const paginationFilterSchema = z.discriminatedUnion('collection', [
  taskFilter,
  attemptFilter,
  deliveryFilter,
  effectFilter,
  cancellationFilter,
  validationFilter,
  launchFilter,
]);
export type PaginationFilter = z.infer<typeof paginationFilterSchema>;

export const PAGINATION_ORDER_VERSIONS = Object.freeze({
  'task-presentations': 'task-presentations/v1',
  'attempt-presentations': 'attempt-presentations/v1',
  'presentation-delivery': 'presentation-delivery/v1',
  'task-effects': 'task-effects/v1',
  'cancellation-work': 'cancellation-work/v1',
  'validation-work': 'validation-work/v1',
  'launch-work': 'launch-work/v1',
} as const);
export const paginationOrderVersionSchema = z.enum([
  PAGINATION_ORDER_VERSIONS['task-presentations'],
  PAGINATION_ORDER_VERSIONS['attempt-presentations'],
  PAGINATION_ORDER_VERSIONS['presentation-delivery'],
  PAGINATION_ORDER_VERSIONS['task-effects'],
  PAGINATION_ORDER_VERSIONS['cancellation-work'],
  PAGINATION_ORDER_VERSIONS['validation-work'],
  PAGINATION_ORDER_VERSIONS['launch-work'],
]);

const keySchema = z.string().min(1).max(1024);
const snapshotBoundarySchema = z.strictObject({
  count: nonnegativeSafeIntegerSchema,
  headDigest: sha256Schema,
});
export const paginationSnapshotBoundarySchema = snapshotBoundarySchema;

/** Structural cursor authority is private to this server-side reference. */
const paginationCursorPayloadSchema = z
  .strictObject({
    schema: z.literal('agent-lcars.lifecycle-pagination-cursor/v1'),
    version: z.literal(1),
    tenantId: opaqueIdSchema,
    collection: paginationCollectionSchema,
    filterDigest: sha256Schema,
    orderVersion: paginationOrderVersionSchema,
    subject: paginationSubjectSchema,
    lastKey: keySchema.nullable(),
    lastTieBreaker: keySchema.nullable(),
    expiresAt: utcDateTimeSchema,
    snapshot: snapshotBoundarySchema,
  })
  .superRefine((cursor, ctx) => {
    if ((cursor.lastKey === null) !== (cursor.lastTieBreaker === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['lastKey'],
        message: 'Cursor key and tie-breaker must be present or null together',
      });
    }
  });
type PaginationCursorPayload = z.infer<typeof paginationCursorPayloadSchema>;

const durableJsonValueSchema = z.any().transform((value, ctx) => {
  try {
    return normalizeDurableValue(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Must be canonical durable JSON' });
    return z.NEVER;
  }
});

/** A codec is server-owned: clients receive an opaque string only. */
export interface PaginationCursorCodec {
  mint(payload: unknown): unknown;
  verify(cursor: string): unknown;
}

export const paginationPageSchema = z.strictObject({
  schema: z.literal('agent-lcars.lifecycle-pagination-page/v1'),
  version: z.literal(1),
  tenantId: opaqueIdSchema,
  collection: paginationCollectionSchema,
  snapshot: snapshotBoundarySchema,
  items: z.array(durableJsonValueSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().min(1).max(4096).nullable(),
});
export type PaginationPage<T = DurableJsonValue> = Omit<
  z.infer<typeof paginationPageSchema>,
  'items'
> & { readonly items: readonly T[] };

export class PaginationCursorError extends Error {
  override readonly name = 'PaginationCursorError';
  readonly reason: PaginationCursorReason;

  constructor(reason: PaginationCursorReason) {
    super(`Lifecycle pagination cursor rejected: ${reason}`);
    this.reason = reason;
  }
}
export type PaginationCursorReason =
  | 'malformed'
  | 'expired'
  | 'scope-mismatch'
  | 'snapshot-missing'
  | 'unsupported-version'
  | 'invalid-order';

export class PaginationCapacityError extends Error {
  override readonly name = 'PaginationCapacityError';
  readonly unit: 'items' | 'bytes';
  readonly actual: number;
  readonly maximum: number;

  constructor(unit: 'items' | 'bytes', actual: number, maximum: number) {
    super(`Lifecycle pagination ${unit} capacity exceeded (${actual})`);
    this.unit = unit;
    this.actual = actual;
    this.maximum = maximum;
  }
}

// These are deliberately not configurable by callers. The in-memory
// reference retains only a finite number of complete snapshots, each of
// which is bounded independently of the returned page budget.
const REFERENCE_SNAPSHOT_LIMIT = 32;
const REFERENCE_SNAPSHOT_RECORD_LIMIT = 10_000;
const REFERENCE_SNAPSHOT_BYTE_LIMIT = LIFECYCLE_DURABILITY_LIMITS.pageBytes * 8;

export function paginationFilterDigest(filter: PaginationFilter): string {
  const parsed = paginationFilterSchema.safeParse(filter);
  if (!parsed.success) throw new PaginationCursorError('malformed');
  return canonicalReplayInputDigest(parsed.data);
}

function filterSubject(filter: PaginationFilter): PaginationSubject {
  return filter.subject;
}

function nowDate(now: () => string): Date {
  try {
    const value = now();
    if (typeof value !== 'string') throw new PaginationCursorError('malformed');
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()))
      throw new PaginationCursorError('malformed');
    return date;
  } catch (error) {
    if (error instanceof PaginationCursorError) throw error;
    throw new PaginationCursorError('malformed');
  }
}

function expiryIso(now: Date, ttlMs: number): string {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new PaginationCursorError('malformed');
  }
  const expiryMs = now.getTime() + ttlMs;
  // ECMAScript Date's finite range is smaller than Number.MAX_SAFE_INTEGER.
  if (!Number.isSafeInteger(expiryMs) || expiryMs > 8_640_000_000_000_000) {
    throw new PaginationCursorError('malformed');
  }
  try {
    return new Date(expiryMs).toISOString();
  } catch {
    throw new PaginationCursorError('malformed');
  }
}

function freezeDetached<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeDetached(child);
    }
    Object.freeze(value);
  }
  return value;
}

function validateCodecPayload(payload: unknown): PaginationCursorPayload {
  if (
    payload !== null &&
    typeof payload === 'object' &&
    'version' in payload &&
    (payload as { version?: unknown }).version !== 1
  ) {
    throw new PaginationCursorError('unsupported-version');
  }
  const parsed = paginationCursorPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new PaginationCursorError('malformed');
  return freezeDetached(
    normalizeDurableValue(parsed.data) as PaginationCursorPayload,
  );
}

function compareKey(
  a: { key: string; tieBreaker: string },
  b: { key: string; tieBreaker: string },
): number {
  return a.key < b.key
    ? -1
    : a.key > b.key
      ? 1
      : a.tieBreaker < b.tieBreaker
        ? -1
        : a.tieBreaker > b.tieBreaker
          ? 1
          : 0;
}

function validatedKey(value: unknown): { key: string; tieBreaker: string } {
  if (
    value === null ||
    typeof value !== 'object' ||
    !keySchema.safeParse((value as { key?: unknown }).key).success ||
    !keySchema.safeParse((value as { tieBreaker?: unknown }).tieBreaker).success
  ) {
    throw new PaginationCursorError('invalid-order');
  }
  return value as { key: string; tieBreaker: string };
}

export interface ReferencePaginationOptions<T> {
  readonly collection: PaginationCollection;
  readonly codec: PaginationCursorCodec;
  readonly records: () => readonly T[];
  readonly keyOf: (record: T) => { key: string; tieBreaker: string };
  readonly matches: (record: T, filter: PaginationFilter) => boolean;
  readonly now: () => string;
  readonly cursorTtlMs?: number;
}

export interface PaginationRequest {
  readonly filter: PaginationFilter;
  readonly limit: number;
  readonly cursor?: string;
}
export interface PaginationPort<T = DurableJsonValue> {
  page(request: PaginationRequest): Promise<PaginationPage<T>>;
}

/** Provider-neutral in-memory keyset paginator used as a contract reference. */
export class ReferencePaginator<
  T extends DurableJsonValue,
> implements PaginationPort<T> {
  private readonly snapshots = new Map<
    string,
    {
      readonly records: readonly T[];
      readonly expiresAtMs: number;
      readonly bytes: number;
    }
  >();

  constructor(private readonly options: ReferencePaginationOptions<T>) {}

  async page(request: PaginationRequest): Promise<PaginationPage<T>> {
    const filter = paginationFilterSchema.safeParse(request.filter);
    if (!filter.success || filter.data.collection !== this.options.collection) {
      throw new PaginationCursorError('scope-mismatch');
    }
    if (!Number.isSafeInteger(request.limit) || request.limit <= 0) {
      throw new PaginationCapacityError(
        'items',
        request.limit,
        LIFECYCLE_DURABILITY_LIMITS.pageItemCount,
      );
    }
    if (request.limit > LIFECYCLE_DURABILITY_LIMITS.pageItemCount) {
      throw new PaginationCapacityError(
        'items',
        request.limit,
        LIFECYCLE_DURABILITY_LIMITS.pageItemCount,
      );
    }
    const now = nowDate(this.options.now);
    this.purgeExpiredSnapshots(now.getTime());
    const filterDigest = paginationFilterDigest(filter.data);
    const subject = filterSubject(filter.data);
    const orderVersion = PAGINATION_ORDER_VERSIONS[this.options.collection];
    const cursorTtlMs = this.options.cursorTtlMs ?? 15 * 60_000;
    let payload: PaginationCursorPayload | undefined;
    let source: readonly T[];
    if (request.cursor === undefined) {
      source = this.snapshot(this.options.records(), filter.data);
      const snapshot = this.boundary(source);
      payload = {
        schema: 'agent-lcars.lifecycle-pagination-cursor/v1',
        version: 1,
        tenantId: filter.data.tenantId,
        collection: this.options.collection,
        filterDigest,
        orderVersion,
        subject,
        lastKey: null,
        lastTieBreaker: null,
        expiresAt: expiryIso(now, cursorTtlMs),
        snapshot,
      };
    } else {
      if (typeof request.cursor !== 'string' || request.cursor.length > 4096) {
        throw new PaginationCursorError('malformed');
      }
      try {
        payload = validateCodecPayload(
          this.options.codec.verify(request.cursor),
        );
      } catch (error) {
        if (error instanceof PaginationCursorError) throw error;
        throw new PaginationCursorError('malformed');
      }
      if (new Date(payload.expiresAt).getTime() <= now.getTime()) {
        throw new PaginationCursorError('expired');
      }
      if (
        payload.tenantId !== filter.data.tenantId ||
        payload.collection !== this.options.collection ||
        payload.filterDigest !== filterDigest ||
        payload.orderVersion !== orderVersion ||
        canonicalDurableJson(payload.subject) !== canonicalDurableJson(subject)
      )
        throw new PaginationCursorError('scope-mismatch');
      const stored = this.snapshots.get(payload.snapshot.headDigest);
      if (stored === undefined || stored.expiresAtMs < now.getTime()) {
        throw new PaginationCursorError('snapshot-missing');
      }
      source = stored.records;
      const storedBoundary = this.boundary(source);
      if (
        storedBoundary.count !== payload.snapshot.count ||
        storedBoundary.headDigest !== payload.snapshot.headDigest
      ) {
        throw new PaginationCursorError('scope-mismatch');
      }
    }
    let offset = 0;
    if (payload.lastKey !== null && payload.lastTieBreaker !== null) {
      let cursorIndex: number;
      try {
        cursorIndex = source.findIndex((record) => {
          const key = validatedKey(this.options.keyOf(record));
          return (
            key.key === payload.lastKey &&
            key.tieBreaker === payload.lastTieBreaker
          );
        });
      } catch (error) {
        if (error instanceof PaginationCursorError) throw error;
        throw new PaginationCursorError('invalid-order');
      }
      if (cursorIndex < 0) throw new PaginationCursorError('scope-mismatch');
      offset = cursorIndex + 1;
    }
    const items = source.slice(offset, offset + request.limit);
    let normalized: readonly T[];
    try {
      normalized = validateDurablePage(items).items as unknown as readonly T[];
    } catch (error) {
      if (error instanceof DurabilityCapacityError) {
        throw new PaginationCapacityError(
          error.unit === 'items' ? 'items' : 'bytes',
          error.actual,
          error.maximum,
        );
      }
      throw error;
    }
    const hasMore = offset + items.length < source.length;
    let nextCursor: string | null = null;
    if (hasMore) {
      try {
        const lastKey = validatedKey(
          this.options.keyOf(items[items.length - 1]),
        );
        const continuation = validateCodecPayload({
          ...payload,
          lastKey: lastKey.key,
          lastTieBreaker: lastKey.tieBreaker,
        });
        this.rememberSnapshot(
          continuation.snapshot,
          source,
          new Date(continuation.expiresAt).getTime(),
          now.getTime(),
        );
        const minted = this.options.codec.mint(continuation);
        if (
          typeof minted !== 'string' ||
          minted.length === 0 ||
          minted.length > 4096
        ) {
          throw new PaginationCursorError('malformed');
        }
        nextCursor = minted;
      } catch (error) {
        if (error instanceof PaginationCursorError) throw error;
        if (error instanceof PaginationCapacityError) throw error;
        throw new PaginationCursorError('malformed');
      }
    }
    const page = {
      schema: 'agent-lcars.lifecycle-pagination-page/v1' as const,
      version: 1 as const,
      tenantId: filter.data.tenantId,
      collection: this.options.collection,
      snapshot: payload.snapshot,
      items: normalized,
      hasMore,
      nextCursor,
    };
    const bytes = serializedDurableByteLength(page);
    if (bytes > LIFECYCLE_DURABILITY_LIMITS.pageBytes) {
      throw new PaginationCapacityError(
        'bytes',
        bytes,
        LIFECYCLE_DURABILITY_LIMITS.pageBytes,
      );
    }
    const parsedPage = paginationPageSchema.safeParse(page);
    if (!parsedPage.success) throw new PaginationCursorError('malformed');
    return freezeDetached(
      normalizeDurableValue(parsedPage.data) as unknown as PaginationPage<T>,
    );
  }

  private snapshot(
    records: readonly T[],
    filter: PaginationFilter,
  ): readonly T[] {
    let selected: T[];
    try {
      selected = records
        .filter((record) => this.options.matches(record, filter))
        .map((record) => normalizeDurableValue(record) as T);
      const seen = new Map<string, Set<string>>();
      for (const record of selected) {
        const key = validatedKey(this.options.keyOf(record));
        const tieBreakers = seen.get(key.key) ?? new Set<string>();
        if (tieBreakers.has(key.tieBreaker)) {
          throw new PaginationCursorError('invalid-order');
        }
        tieBreakers.add(key.tieBreaker);
        seen.set(key.key, tieBreakers);
      }
      selected.sort((a, b) =>
        compareKey(
          validatedKey(this.options.keyOf(a)),
          validatedKey(this.options.keyOf(b)),
        ),
      );
    } catch (error) {
      if (error instanceof PaginationCursorError) throw error;
      throw new PaginationCursorError('malformed');
    }
    return freezeDetached(selected);
  }

  private rememberSnapshot(
    boundary: { readonly count: number; readonly headDigest: string },
    records: readonly T[],
    expiresAtMs: number,
    nowMs: number,
  ): void {
    this.purgeExpiredSnapshots(nowMs);
    if (records.length > REFERENCE_SNAPSHOT_RECORD_LIMIT) {
      throw new PaginationCapacityError(
        'items',
        records.length,
        REFERENCE_SNAPSHOT_RECORD_LIMIT,
      );
    }
    const bytes = serializedDurableByteLength(records);
    if (bytes > REFERENCE_SNAPSHOT_BYTE_LIMIT) {
      throw new PaginationCapacityError(
        'bytes',
        bytes,
        REFERENCE_SNAPSHOT_BYTE_LIMIT,
      );
    }
    const existing = this.snapshots.get(boundary.headDigest);
    if (
      existing === undefined &&
      this.snapshots.size >= REFERENCE_SNAPSHOT_LIMIT
    ) {
      throw new PaginationCapacityError(
        'items',
        this.snapshots.size + 1,
        REFERENCE_SNAPSHOT_LIMIT,
      );
    }
    this.snapshots.set(boundary.headDigest, {
      records,
      expiresAtMs: Math.max(existing?.expiresAtMs ?? 0, expiresAtMs),
      bytes,
    });
  }

  private purgeExpiredSnapshots(nowMs: number): void {
    for (const [digest, snapshot] of this.snapshots) {
      if (snapshot.expiresAtMs <= nowMs) this.snapshots.delete(digest);
    }
  }

  private boundary(records: readonly T[]): {
    count: number;
    headDigest: string;
  } {
    return {
      count: records.length,
      headDigest: sha256Digest(canonicalDurableJson(records)),
    };
  }
}

const currentPointerCommon = {
  schema: z.literal('agent-lcars.lifecycle-current-pointer/v1'),
  version: z.literal(1),
  tenantId: opaqueIdSchema,
  revision: nonnegativeSafeIntegerSchema,
  pointerDigest: sha256Schema,
};
const currentTaskPointerSchema = z.strictObject({
  ...currentPointerCommon,
  kind: z.literal('task'),
  subject: taskSubjectSchema,
  taskKey: opaqueIdSchema,
});
const currentAttemptPointerSchema = z.strictObject({
  ...currentPointerCommon,
  kind: z.literal('attempt'),
  subject: attemptSubjectSchema,
  attemptKey: opaqueIdSchema,
});
const currentTaskPresentationPointerSchema = z.strictObject({
  ...currentPointerCommon,
  kind: z.literal('task-presentation'),
  subject: taskSubjectSchema,
  operationId: opaqueIdSchema,
});
const currentAttemptPresentationPointerSchema = z.strictObject({
  ...currentPointerCommon,
  kind: z.literal('attempt-presentation'),
  subject: attemptSubjectSchema,
  operationId: opaqueIdSchema,
});
const currentDeliveryPointerSchema = z.discriminatedUnion('source', [
  z.strictObject({
    ...currentPointerCommon,
    kind: z.literal('delivery'),
    source: z.literal('task'),
    subject: taskSubjectSchema,
    operationId: opaqueIdSchema,
  }),
  z.strictObject({
    ...currentPointerCommon,
    kind: z.literal('delivery'),
    source: z.literal('attempt'),
    subject: taskSubjectSchema,
    attemptId: attemptIdSchema,
    operationId: opaqueIdSchema,
  }),
]);
const currentTaskEffectPointerSchema = z.strictObject({
  ...currentPointerCommon,
  kind: z.literal('task-effect'),
  subject: taskSubjectSchema,
  sourceFactId: opaqueIdSchema,
  effectKey: opaqueIdSchema,
});
const currentCancellationPointerSchema = z.strictObject({
  ...currentPointerCommon,
  kind: z.literal('cancellation-work'),
  subject: attemptSubjectSchema,
  eventId: opaqueIdSchema,
});
const currentValidationPointerSchema = z.strictObject({
  ...currentPointerCommon,
  kind: z.literal('validation-work'),
  subject: attemptSubjectSchema,
  terminalFactId: opaqueIdSchema,
  claimFactId: opaqueIdSchema,
});
const currentLaunchPointerSchema = z.strictObject({
  ...currentPointerCommon,
  kind: z.literal('launch-work'),
  subject: attemptSubjectSchema,
  operationId: opaqueIdSchema,
});
export const currentPointerSchema = z.discriminatedUnion('kind', [
  currentTaskPointerSchema,
  currentAttemptPointerSchema,
  currentTaskPresentationPointerSchema,
  currentAttemptPresentationPointerSchema,
  currentDeliveryPointerSchema,
  currentTaskEffectPointerSchema,
  currentCancellationPointerSchema,
  currentValidationPointerSchema,
  currentLaunchPointerSchema,
]);
export type CurrentPointer = z.infer<typeof currentPointerSchema>;
export type CurrentPointerKind = CurrentPointer['kind'];
export const currentPointerKindSchema = z.enum([
  'task',
  'attempt',
  'task-presentation',
  'attempt-presentation',
  'delivery',
  'task-effect',
  'cancellation-work',
  'validation-work',
  'launch-work',
]);
type CurrentPointerLookupVariant<T> = T extends CurrentPointer
  ? Omit<T, 'schema' | 'version' | 'revision' | 'pointerDigest'>
  : never;
export type CurrentPointerLookup = CurrentPointerLookupVariant<CurrentPointer>;
type CurrentPointerCreateInputVariant<T> = T extends CurrentPointer
  ? Omit<T, 'schema' | 'version' | 'pointerDigest'>
  : never;
export type CurrentPointerCreateInput =
  CurrentPointerCreateInputVariant<CurrentPointer>;
type CurrentPointerUnsignedVariant<T> = T extends CurrentPointer
  ? Omit<T, 'pointerDigest'>
  : never;
export type CurrentPointerUnsigned =
  CurrentPointerUnsignedVariant<CurrentPointer>;
export interface CurrentPointerReader<T = DurableJsonValue> {
  readCurrent(input: CurrentPointerLookup): Promise<T | undefined>;
}
export type CurrentPointerReadPort<T = DurableJsonValue> =
  CurrentPointerReader<T>;

export function deriveCurrentPointerDigest(
  pointer: CurrentPointerUnsigned,
): string {
  return sha256Digest(
    `agent-lcars.lifecycle-current-pointer/digest/v1\u0000${canonicalDurableJson(pointer)}`,
  );
}

type CurrentPointerForCreateInput<T extends CurrentPointerCreateInput> =
  T extends { readonly source: infer Source }
    ? Extract<CurrentPointer, { kind: T['kind']; source: Source }>
    : Extract<CurrentPointer, { kind: T['kind'] }>;

export function createCurrentPointer<T extends CurrentPointerCreateInput>(
  pointer: T,
): CurrentPointerForCreateInput<T> {
  const unsigned = {
    schema: 'agent-lcars.lifecycle-current-pointer/v1' as const,
    version: 1 as const,
    ...pointer,
  } as CurrentPointerUnsigned;
  return validateCurrentPointer({
    ...unsigned,
    pointerDigest: deriveCurrentPointerDigest(unsigned),
  }) as CurrentPointerForCreateInput<T>;
}

export function validateCurrentPointer(value: unknown): CurrentPointer {
  const parsed = currentPointerSchema.safeParse(value);
  if (!parsed.success) throw new HistoryIntegrityError('invalid-head');
  const normalized = normalizeDurableValue(parsed.data) as CurrentPointer;
  const unsigned = { ...normalized } as CurrentPointerUnsigned;
  delete (unsigned as { pointerDigest?: unknown }).pointerDigest;
  if (deriveCurrentPointerDigest(unsigned) !== normalized.pointerDigest) {
    throw new HistoryIntegrityError('digest-mismatch');
  }
  return freezeDetached(normalized);
}
export const verifyCurrentPointer = validateCurrentPointer;

export const boundedReferencePaginator = ReferencePaginator;
export const pageSchema = paginationPageSchema;
