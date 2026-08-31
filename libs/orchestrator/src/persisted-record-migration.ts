import { createHash } from 'node:crypto';

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

export const persistedRecordKindSchema = z.enum(['task', 'run', 'outbox']);
export type PersistedRecordKind = z.infer<typeof persistedRecordKindSchema>;

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
  readonly code: string;
  /** `compatibility` needs a future migration decision; `optional` records a
   * deliberate current absence without pretending it is malformed. */
  readonly class: 'compatibility' | 'optional' | 'invalid';
}

export interface PersistedRecordInventory {
  readonly selector?: PersistedRecordSelector;
  /** Encoded datastore id is shown only for an invalid legacy document that
   * has no safe domain selector. It is never accepted by apply. */
  readonly opaqueDocumentId?: string;
  readonly fingerprint: string;
  readonly findings: readonly PersistedRecordFinding[];
}

export interface PersistedRecordPage {
  readonly kind: PersistedRecordKind;
  readonly records: readonly PersistedRecordInventory[];
  readonly hasMore: boolean;
  /** Opaque, scoped to `kind`, and usable only as the next inventory cursor. */
  readonly nextCursor?: string;
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function missing(
  value: Record<string, unknown>,
  key: string,
  class_: PersistedRecordFinding['class'],
): PersistedRecordFinding | undefined {
  return Object.hasOwn(value, key)
    ? undefined
    : { code: `missing-${key}`, class: class_ };
}

function absent(
  value: Record<string, unknown>,
  key: string,
  class_: PersistedRecordFinding['class'],
): PersistedRecordFinding[] {
  const finding = missing(value, key, class_);
  return finding === undefined ? [] : [finding];
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): PersistedRecordFinding[] {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .sort()
    .map((key) => ({
      code: `retired-top-level-${key}`,
      class: 'compatibility',
    }));
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
      findings: [{ code: 'not-object', class: 'invalid' }],
    };
  }

  if (kind === 'task') {
    findings.push(
      ...unknownKeys(value, ['task', 'revision']),
      ...absent(value, 'task', 'invalid'),
      ...absent(value, 'revision', 'invalid'),
    );
    const task = value['task'];
    if (!isRecord(task)) {
      findings.push({ code: 'invalid-task', class: 'invalid' });
    } else {
      findings.push(
        ...unknownKeys(task, [
          'task',
          'activeRunId',
          'runCount',
          'consecutiveLost',
          'work',
          'closedAt',
          'updatedAt',
        ]),
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
      ...unknownKeys(value, [
        'runId',
        'task',
        'state',
        'pipeline',
        'requestId',
        'params',
        'queue',
        'leaseExpiresAt',
        'result',
        'events',
        'createdAt',
        'updatedAt',
      ]),
      ...absent(value, 'params', 'optional'),
      ...absent(value, 'queue', 'optional'),
      ...absent(value, 'result', 'optional'),
    );
    const events = value['events'];
    if (Array.isArray(events)) {
      events.forEach((event, index) => {
        if (isRecord(event) && event['by'] === 'infra') {
          findings.push({
            code: `infra-event-${index}`,
            class: 'compatibility',
          });
        }
      });
    }
    if (!runSchema.strip().safeParse(value).success) {
      findings.push({ code: 'invalid-run-document', class: 'invalid' });
    }
  } else {
    findings.push(
      ...unknownKeys(value, [
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
      ]),
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
    findings,
  };
}

/** Canonical JSON and SHA-256 make a reviewed manifest stable across key
 * insertion order. Neither inventory nor this digest includes secret data in
 * its response; the operator supplies a bounded reviewed replacement. */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function manifestId(
  entries: readonly PersistedMigrationEntry[],
): string {
  return fingerprint(entries);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
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
