import {
  PERSISTED_MIGRATION_CURSOR_MAX_LENGTH,
  PERSISTED_MIGRATION_FINDINGS_MAX,
  PERSISTED_MIGRATION_MANIFEST_MAX,
  PERSISTED_MIGRATION_PAGE_MAX,
  persistedMigrationDeleteBlockReasonSchema,
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
const deletionReadinessSchema = z.discriminatedUnion('status', [
  z.strictObject({
    selector: persistedRecordSelectorSchema,
    status: z.literal('ready'),
    reasons: z.array(persistedMigrationDeleteBlockReasonSchema).length(0),
  }),
  z.strictObject({
    selector: persistedRecordSelectorSchema,
    status: z.literal('blocked'),
    reasons: z.array(persistedMigrationDeleteBlockReasonSchema).min(1).max(15),
  }),
]);
const anchorProjectionComparisonSchema = z.strictObject({
  currentQueue: z.number().int().nonnegative(),
  projectedQueue: z.number().int().nonnegative(),
  missingProjectionKeys: z.array(z.string()),
  unexpectedProjectionKeys: z.array(z.string()),
  criticalFieldMismatches: z.array(
    z.strictObject({
      key: z.string(),
      fields: z.array(z.enum(['title', 'url', 'author', 'assigneeLogins'])),
    }),
  ),
  warnings: z.array(z.string()),
  matches: z.boolean(),
});
const anchorProjectionReconcileResultSchema = z.strictObject({
  repositories: z.number().int().nonnegative(),
  anchors: z.number().int().nonnegative(),
  comparison: anchorProjectionComparisonSchema.optional(),
});

/** Temporary, operator-only API contract. It has fixed persisted-record kinds
 * and one bounded projection reconciliation operation; it deliberately does
 * not model a collection name, query expression, or arbitrary document
 * access. A malformed record may carry a bounded opaque address for its one
 * inventoried document; it cannot select a different collection or query.
 * Delete this with the phase-2 compatibility readers after reviewed live
 * conversion. */
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
          're-read transactionally before fixed replacements are written or ' +
          'a value-free delete is accepted. Delete readiness reports only ' +
          'the supplied selector and closed safety reasons.',
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
        deletions: z
          .array(deletionReadinessSchema)
          .max(PERSISTED_MIGRATION_MANIFEST_MAX),
      }),
    ),
  projectionReconcile: base
    .meta(
      openapi({
        method: 'POST',
        path: '/orchestrator-migration/projections/reconcile',
        operationId: 'reconcileGithubAnchorProjections',
        summary:
          'Reconcile the one-shot GitHub anchor projection cutover through Work',
        description:
          'Temporary operator migration endpoint. It reads the bounded GitHub ' +
          'anchor set, writes exact fenced projections, and returns a non-2xx ' +
          'result when the selected stored queue does not match.',
      }),
    )
    .errors({
      CONFLICT: {
        message: 'The projection backfill was incomplete or does not match',
        data: anchorProjectionReconcileResultSchema.optional(),
      },
    })
    .input(z.strictObject({}))
    .output(anchorProjectionReconcileResultSchema),
};
