import {
  PERSISTED_MIGRATION_CURSOR_MAX_LENGTH,
  PERSISTED_MIGRATION_FINDINGS_MAX,
  PERSISTED_MIGRATION_MANIFEST_MAX,
  PERSISTED_MIGRATION_PAGE_MAX,
  persistedMigrationEntrySchema,
  persistedRecordFindingCodeSchema,
  persistedRecordKindSchema,
  persistedRecordSelectorSchema,
} from '@agent-lcars/orchestrator';
import { oc } from '@orpc/contract';
import { openapi } from '@orpc/openapi';
import { z } from 'zod';

const bearer = { security: [{ bearerAuth: [] }] };
const base = oc.meta(
  openapi({ tags: ['orchestrator migration'], spec: bearer }),
);

const findingSchema = z.strictObject({
  code: persistedRecordFindingCodeSchema,
  class: z.enum(['compatibility', 'optional', 'invalid']),
});
const inventoryRecordSchema = z.strictObject({
  selector: persistedRecordSelectorSchema.optional(),
  fingerprint: z.string().length(64),
  findingCount: z.number().int().nonnegative(),
  findingsTruncated: z.boolean(),
  findings: z.array(findingSchema).max(PERSISTED_MIGRATION_FINDINGS_MAX),
});

/** Temporary, operator-only API contract. It has fixed orchestrator record
 * kinds and bounded payloads; it deliberately does not model a collection
 * name, a query expression, or arbitrary document access. Delete this with
 * the phase-2 compatibility readers after a reviewed live conversion. */
export const orchestratorMigrationContract = {
  inventory: base
    .meta(
      openapi({
        method: 'GET',
        path: '/orchestrator-migration/{kind}',
        operationId: 'inventoryPersistedOrchestratorRecords',
        summary: 'Inventory one bounded page of persisted orchestrator records',
      }),
    )
    .errors({
      BAD_REQUEST: { message: 'The inventory cursor is malformed or stale' },
    })
    .input(
      z.strictObject({
        kind: persistedRecordKindSchema,
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(PERSISTED_MIGRATION_PAGE_MAX)
          .default(PERSISTED_MIGRATION_PAGE_MAX),
        cursor: z
          .string()
          .regex(/^[A-Za-z0-9_-]+$/u)
          .max(PERSISTED_MIGRATION_CURSOR_MAX_LENGTH)
          .optional(),
      }),
    )
    .output(
      z.strictObject({
        kind: persistedRecordKindSchema,
        consistency: z.literal('page-only'),
        records: z.array(inventoryRecordSchema),
        hasMore: z.boolean(),
        nextCursor: z
          .string()
          .max(PERSISTED_MIGRATION_CURSOR_MAX_LENGTH)
          .optional(),
      }),
    ),
  migrate: base
    .meta(
      openapi({
        method: 'POST',
        path: '/orchestrator-migration',
        operationId: 'migratePersistedOrchestratorRecords',
        summary:
          'Preview or apply a reviewed bounded persisted-record manifest',
        description:
          'Dry-run is the default. Apply requires the digest returned by a ' +
          'previous preview and the exact confirmation string; records are ' +
          're-read transactionally before the fixed replacements are written.',
      }),
    )
    .errors({
      CONFLICT: { message: 'The reviewed manifest is stale or invalid' },
    })
    .input(
      z.strictObject({
        mode: z.enum(['dry-run', 'apply']).default('dry-run'),
        entries: z
          .array(persistedMigrationEntrySchema)
          .min(1)
          .max(PERSISTED_MIGRATION_MANIFEST_MAX),
        reviewedManifestId: z.string().length(64).optional(),
        confirmation: z.literal('apply-reviewed-manifest').optional(),
      }),
    )
    .output(
      z.strictObject({
        mode: z.enum(['dry-run', 'apply']),
        manifestId: z.string().length(64),
        entries: z.number().int().positive(),
      }),
    ),
};
