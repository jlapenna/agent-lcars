import { createHash } from 'node:crypto';

import {
  DocumentReference,
  GeoPoint,
  Timestamp,
  VectorValue,
} from '@google-cloud/firestore';
import { z } from 'zod';

import {
  type OutboxEntry,
  outboxEntrySchema,
  type Run,
  runSchema,
  type TaskDocument,
  taskDocumentSchema,
  type TaskId,
  taskIdSchema,
} from './model';

/** This route is deliberately a one-shot operator surface.  Its small page
 * and manifest bounds make a complete census repeatable without becoming a
 * general datastore browser. */
export const PERSISTED_MIGRATION_PAGE_MAX = 200;
export const PERSISTED_MIGRATION_MANIFEST_MAX = 100;
/** Firestore permits a 1,500-byte document id. A one-byte kind prefix plus
 * base64url is at most 2,002 characters, including ids full of backslashes
 * or other JSON-escaped characters. */
export const PERSISTED_MIGRATION_CURSOR_MAX_LENGTH = 2_002;
export const PERSISTED_MIGRATION_FINDINGS_MAX = 16;

export const persistedRecordKindSchema = z.enum(['task', 'run', 'outbox']);
export type PersistedRecordKind = z.infer<typeof persistedRecordKindSchema>;

/** The inventory protocol intentionally exposes a closed vocabulary. Never
 * derive a finding code from a stored field name or record value. */
export const persistedRecordFindingCodeSchema = z.enum([
  'not-object',
  'retired-task-document-fields',
  'missing-task',
  'missing-revision',
  'invalid-task',
  'retired-task-fields',
  'missing-consecutiveLost',
  'missing-work',
  'missing-activeRunId',
  'missing-closedAt',
  'invalid-task-document',
  'retired-run-fields',
  'missing-requestSource',
  'missing-params',
  'missing-queue',
  'missing-result',
  'infra-run-events',
  'invalid-run-document',
  'retired-outbox-fields',
  'missing-firstFailedAt',
  'missing-nextAttemptAt',
  'missing-deliveryFailures',
  'invalid-outbox-document',
]);
export type PersistedRecordFindingCode = z.infer<
  typeof persistedRecordFindingCodeSchema
>;

const runIdSchema = z.string().min(1).max(175);
const outboxEntryIdSchema = z.string().min(1).max(184);
const fingerprintSchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/u);

export const persistedRecordSelectorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('task'), task: taskIdSchema }),
  z.strictObject({ kind: z.literal('run'), runId: runIdSchema }),
  z.strictObject({ kind: z.literal('outbox'), entryId: outboxEntryIdSchema }),
]);
export type PersistedRecordSelector = z.infer<
  typeof persistedRecordSelectorSchema
>;

export const persistedMigrationEntrySchema = z.union([
  z.strictObject({
    selector: z.strictObject({ kind: z.literal('task'), task: taskIdSchema }),
    expectedFingerprint: fingerprintSchema,
    replacement: taskDocumentSchema,
  }),
  z.strictObject({
    selector: z.strictObject({ kind: z.literal('run'), runId: runIdSchema }),
    expectedFingerprint: fingerprintSchema,
    replacement: runSchema,
  }),
  z.strictObject({
    selector: z.strictObject({
      kind: z.literal('outbox'),
      entryId: outboxEntryIdSchema,
    }),
    expectedFingerprint: fingerprintSchema,
    replacement: outboxEntrySchema,
  }),
]);
export type PersistedMigrationEntry =
  | {
      selector: { kind: 'task'; task: TaskId };
      expectedFingerprint: string;
      replacement: TaskDocument;
    }
  | {
      selector: { kind: 'run'; runId: string };
      expectedFingerprint: string;
      replacement: Run;
    }
  | {
      selector: { kind: 'outbox'; entryId: string };
      expectedFingerprint: string;
      replacement: OutboxEntry;
    };

export interface PersistedRecordFinding {
  /** A short fixed code, never copied document values. */
  readonly code: PersistedRecordFindingCode;
  /** `compatibility` needs a future migration decision; `optional` records a
   * deliberate current absence without pretending it is malformed. */
  readonly class: 'compatibility' | 'optional' | 'invalid';
}

export interface PersistedRecordInventory {
  readonly selector?: PersistedRecordSelector;
  readonly fingerprint: string;
  /** Total findings before the fixed response cap. */
  readonly findingCount: number;
  /** True when `findings` is a prefix of the complete value-free census. */
  readonly findingsTruncated: boolean;
  readonly findings: readonly PersistedRecordFinding[];
}

export interface PersistedRecordPage {
  readonly kind: PersistedRecordKind;
  /** Each request reads one current Firestore page; it is not a cross-page
   * snapshot. A phase-2 proof must compare two full quiescent passes. */
  readonly consistency: 'page-only';
  readonly records: readonly PersistedRecordInventory[];
  readonly hasMore: boolean;
  /** Opaque, scoped to `kind`, and usable only as the next inventory cursor. */
  readonly nextCursor?: string;
}

/** A caller-controlled cursor is an input error, not an unexpected store
 * failure. The Work route maps this narrow error to its declared 400. */
export class PersistedMigrationCursorError extends Error {
  override readonly name = 'PersistedMigrationCursorError';

  /** Bundled console code can load the shared store and router through
   * different module instances. Keep this narrow guard so a cursor error is
   * still classified as the declared client failure across that boundary. */
  static is(error: unknown): error is PersistedMigrationCursorError {
    return (
      error instanceof PersistedMigrationCursorError ||
      (error instanceof Error && error.name === 'PersistedMigrationCursorError')
    );
  }
}

const cursorKindByte: Record<PersistedRecordKind, number> = {
  task: 0x74,
  run: 0x72,
  outbox: 0x6f,
};

function invalidCursor(message: string): PersistedMigrationCursorError {
  return new PersistedMigrationCursorError(message);
}

/** A migration cursor is eventually used with `collection.doc(id)`, so it
 * must name exactly one direct Firestore document rather than a path or a
 * Firestore-reserved identifier. Keep this validation at the binary cursor
 * boundary so malformed caller input reaches the route's declared 400. */
function isDirectFirestoreDocumentId(documentId: string): boolean {
  return (
    !documentId.includes('/') &&
    documentId !== '.' &&
    documentId !== '..' &&
    !/^__.*__$/u.test(documentId)
  );
}

/** Opaque, kind-bound cursor. Its binary one-byte kind prefix leaves the raw
 * document-id bytes untouched before base64url encoding, so every valid
 * Firestore-sized id can advance this bounded census. */
export function encodePersistedMigrationCursor(
  kind: PersistedRecordKind,
  documentId: string,
): string {
  const documentIdBytes = Buffer.from(documentId, 'utf8');
  if (
    documentIdBytes.length === 0 ||
    documentIdBytes.length > 1_500 ||
    !isDirectFirestoreDocumentId(documentId)
  ) {
    throw invalidCursor('Invalid persisted orchestrator inventory document id');
  }
  const cursor = Buffer.concat([
    Buffer.from([cursorKindByte[kind]]),
    documentIdBytes,
  ]).toString('base64url');
  if (cursor.length > PERSISTED_MIGRATION_CURSOR_MAX_LENGTH) {
    throw invalidCursor('Persisted orchestrator inventory cursor is too large');
  }
  return cursor;
}

export function decodePersistedMigrationCursor(
  cursor: string,
  expectedKind: PersistedRecordKind,
): string {
  if (
    !/^[A-Za-z0-9_-]+$/u.test(cursor) ||
    cursor.length > PERSISTED_MIGRATION_CURSOR_MAX_LENGTH
  ) {
    throw invalidCursor('Invalid persisted orchestrator inventory cursor');
  }
  const cursorBytes = Buffer.from(cursor, 'base64url');
  if (
    cursorBytes.length < 2 ||
    cursorBytes[0] !== cursorKindByte[expectedKind]
  ) {
    throw invalidCursor('Invalid persisted orchestrator inventory cursor');
  }
  const documentId = cursorBytes.subarray(1).toString('utf8');
  if (!isDirectFirestoreDocumentId(documentId)) {
    throw invalidCursor('Invalid persisted orchestrator inventory cursor');
  }
  // Require the exact canonical form emitted above: it rejects malformed UTF-8
  // and non-canonical base64url rather than letting replacement characters
  // become a different anchor id.
  if (encodePersistedMigrationCursor(expectedKind, documentId) !== cursor) {
    throw invalidCursor('Invalid persisted orchestrator inventory cursor');
  }
  return documentId;
}

export interface PersistedMigrationPreview {
  readonly manifestId: string;
  readonly entries: number;
}

export class PersistedMigrationConflict extends Error {
  override readonly name = 'PersistedMigrationConflict';
  constructor(message: string) {
    super(message);
  }

  /** The app bundle can load the store and route through different copies of
   * this library. Keep conflict mapping narrow but resilient across that
   * module boundary, just like {@link PersistedMigrationCursorError}. */
  static is(error: unknown): error is PersistedMigrationConflict {
    return (
      error instanceof PersistedMigrationConflict ||
      (error instanceof Error && error.name === 'PersistedMigrationConflict')
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const missingFindingCodes = {
  task: 'missing-task',
  revision: 'missing-revision',
  consecutiveLost: 'missing-consecutiveLost',
  work: 'missing-work',
  activeRunId: 'missing-activeRunId',
  closedAt: 'missing-closedAt',
  requestSource: 'missing-requestSource',
  params: 'missing-params',
  queue: 'missing-queue',
  result: 'missing-result',
  firstFailedAt: 'missing-firstFailedAt',
  nextAttemptAt: 'missing-nextAttemptAt',
  deliveryFailures: 'missing-deliveryFailures',
} as const;

function missing(
  value: Record<string, unknown>,
  key: keyof typeof missingFindingCodes,
  class_: PersistedRecordFinding['class'],
): PersistedRecordFinding | undefined {
  return Object.hasOwn(value, key)
    ? undefined
    : { code: missingFindingCodes[key], class: class_ };
}

function absent(
  value: Record<string, unknown>,
  key: keyof typeof missingFindingCodes,
  class_: PersistedRecordFinding['class'],
): PersistedRecordFinding[] {
  const finding = missing(value, key, class_);
  return finding === undefined ? [] : [finding];
}

function unknownKeyCount(
  value: Record<string, unknown>,
  allowed: readonly string[],
): number {
  return Object.keys(value).filter((key) => !allowed.includes(key)).length;
}

function retiredFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: PersistedRecordFindingCode,
): PersistedRecordFinding[] {
  return unknownKeyCount(value, allowed) === 0
    ? []
    : [{ code, class: 'compatibility' }];
}

function selectorFrom(
  kind: PersistedRecordKind,
  value: unknown,
): PersistedRecordSelector | undefined {
  if (!isRecord(value)) return undefined;
  if (kind === 'task') {
    const document = value['task'];
    if (!isRecord(document)) return undefined;
    const task = taskIdSchema.safeParse(document['task']);
    return task.success ? { kind, task: task.data } : undefined;
  }
  if (kind === 'run') {
    const runId = runIdSchema.safeParse(value['runId']);
    return runId.success ? { kind, runId: runId.data } : undefined;
  }
  const entryId = outboxEntryIdSchema.safeParse(value['entryId']);
  return entryId.success ? { kind, entryId: entryId.data } : undefined;
}

/** A compact, value-free classification of every currently tolerated
 * persisted shape. This intentionally enumerates optional newer fields too:
 * their absence is reported as `optional`, not mislabelled as corruption.
 * The reviewed manifest decides which values can safely be supplied; this
 * phase never invents them. */
export function inventoryPersistedRecord(
  kind: PersistedRecordKind,
  value: unknown,
): PersistedRecordInventory {
  const selector = selectorFrom(kind, value);
  const findings: PersistedRecordFinding[] = [];
  if (!isRecord(value)) {
    return {
      fingerprint: fingerprint(value),
      findingCount: 1,
      findingsTruncated: false,
      findings: [{ code: 'not-object', class: 'invalid' }],
    };
  }

  if (kind === 'task') {
    findings.push(
      ...retiredFields(
        value,
        ['task', 'revision'],
        'retired-task-document-fields',
      ),
      ...absent(value, 'task', 'invalid'),
      ...absent(value, 'revision', 'invalid'),
    );
    const task = value['task'];
    if (!isRecord(task)) {
      findings.push({ code: 'invalid-task', class: 'invalid' });
    } else {
      findings.push(
        ...retiredFields(
          task,
          [
            'task',
            'activeRunId',
            'runCount',
            'consecutiveLost',
            'work',
            'closedAt',
            'updatedAt',
          ],
          'retired-task-fields',
        ),
        ...absent(task, 'consecutiveLost', 'compatibility'),
        ...absent(task, 'work', 'compatibility'),
        ...absent(task, 'activeRunId', 'optional'),
        ...absent(task, 'closedAt', 'optional'),
      );
    }
    if (!taskDocumentSchema.safeParse(value).success) {
      findings.push({ code: 'invalid-task-document', class: 'invalid' });
    }
  } else if (kind === 'run') {
    findings.push(
      ...retiredFields(
        value,
        [
          'runId',
          'task',
          'state',
          'pipeline',
          'requestId',
          'requestSource',
          'params',
          'queue',
          'leaseExpiresAt',
          'result',
          'events',
          'createdAt',
          'updatedAt',
        ],
        'retired-run-fields',
      ),
      ...absent(value, 'requestSource', 'compatibility'),
      ...absent(value, 'params', 'optional'),
      ...absent(value, 'queue', 'optional'),
      ...absent(value, 'result', 'optional'),
    );
    const events = value['events'];
    if (
      Array.isArray(events) &&
      events.some((event) => isRecord(event) && event['by'] === 'infra')
    ) {
      findings.push({ code: 'infra-run-events', class: 'compatibility' });
    }
    if (!runSchema.strip().safeParse(value).success) {
      findings.push({ code: 'invalid-run-document', class: 'invalid' });
    }
  } else {
    findings.push(
      ...retiredFields(
        value,
        [
          'entryId',
          'kind',
          'task',
          'runId',
          'state',
          'attempts',
          'firstFailedAt',
          'nextAttemptAt',
          'deliveryFailures',
          'createdAt',
          'updatedAt',
          'claimId',
          'leaseExpiresAt',
        ],
        'retired-outbox-fields',
      ),
      ...absent(value, 'firstFailedAt', 'optional'),
      ...absent(value, 'nextAttemptAt', 'optional'),
      ...absent(value, 'deliveryFailures', 'optional'),
    );
    if (!outboxEntrySchema.safeParse(value).success) {
      findings.push({ code: 'invalid-outbox-document', class: 'invalid' });
    }
  }

  return {
    ...(selector === undefined ? {} : { selector }),
    fingerprint: fingerprint(value),
    findingCount: findings.length,
    findingsTruncated: findings.length > PERSISTED_MIGRATION_FINDINGS_MAX,
    findings: findings.slice(0, PERSISTED_MIGRATION_FINDINGS_MAX),
  };
}

/** Canonical, type-tagged Firestore values plus SHA-256 make a reviewed
 * manifest stable across key insertion order without collapsing special
 * numbers or Firestore's Timestamp/GeoPoint/bytes/reference/vector types.
 * Neither inventory nor this digest includes secret data in its response. */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function manifestId(
  entries: readonly PersistedMigrationEntry[],
): string {
  return fingerprint(entries);
}

function stableJson(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `string:${JSON.stringify(value)}`;
  if (typeof value === 'boolean') return `boolean:${value}`;
  if (typeof value === 'bigint') return `bigint:${value}`;
  if (typeof value === 'number') return stableNumber(value);
  if (Buffer.isBuffer(value)) return `bytes:${value.toString('base64url')}`;
  if (value instanceof Uint8Array)
    return `bytes:${Buffer.from(value).toString('base64url')}`;
  if (value instanceof Timestamp)
    return `timestamp:${value.seconds}:${value.nanoseconds}`;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (value instanceof GeoPoint)
    return `geopoint:${stableNumber(value.latitude)}:${stableNumber(value.longitude)}`;
  if (value instanceof DocumentReference) {
    // The Firestore type keeps these runtime identity fields private, but a
    // reference can legally point outside the source document's database.
    const database = value.firestore as unknown as {
      projectId?: unknown;
      databaseId?: unknown;
    };
    return `reference:${JSON.stringify(database.projectId)}:${JSON.stringify(database.databaseId)}:${JSON.stringify(value.path)}`;
  }
  if (value instanceof VectorValue)
    return `vector:[${value.toArray().map(stableNumber).join(',')}]`;
  if (Array.isArray(value)) return `array:[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `object:{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}=${stableJson(value[key])}`)
      .join(',')}}`;
  }
  throw new Error(`Unsupported persisted value type: ${typeof value}`);
}

function stableNumber(value: number): string {
  if (Number.isNaN(value)) return 'number:NaN';
  if (value === Infinity) return 'number:Infinity';
  if (value === -Infinity) return 'number:-Infinity';
  if (Object.is(value, -0)) return 'number:-0';
  return `number:${value}`;
}

export function selectorKey(selector: PersistedRecordSelector): string {
  if (selector.kind === 'task') return `task:${JSON.stringify(selector.task)}`;
  if (selector.kind === 'run') return `run:${selector.runId}`;
  return `outbox:${selector.entryId}`;
}

export function validateManifest(entries: unknown): PersistedMigrationEntry[] {
  const parsed = z
    .array(persistedMigrationEntrySchema)
    .max(PERSISTED_MIGRATION_MANIFEST_MAX)
    .parse(entries) as PersistedMigrationEntry[];
  const seen = new Set<string>();
  for (const entry of parsed) {
    const key = selectorKey(entry.selector);
    if (seen.has(key))
      throw new PersistedMigrationConflict(
        `duplicate manifest selector ${key}`,
      );
    seen.add(key);
    if (entry.selector.kind === 'task') {
      const replacement = entry.replacement as TaskDocument;
      if (
        JSON.stringify(entry.selector.task) !==
        JSON.stringify(replacement.task.task)
      ) {
        throw new PersistedMigrationConflict(
          'task replacement selector does not match document task',
        );
      }
    } else if (entry.selector.kind === 'run') {
      const replacement = entry.replacement as Run;
      if (entry.selector.runId !== replacement.runId) {
        throw new PersistedMigrationConflict(
          'run replacement selector does not match runId',
        );
      }
    } else {
      const replacement = entry.replacement as OutboxEntry;
      if (entry.selector.entryId !== replacement.entryId) {
        throw new PersistedMigrationConflict(
          'outbox replacement selector does not match entryId',
        );
      }
    }
  }
  return parsed;
}

export type PersistedReplacement = TaskDocument | Run | OutboxEntry;
