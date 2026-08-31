import 'server-only';

import {
  PersistedMigrationConflict,
  PersistedMigrationCursorError,
  type PersistedMigrationEntry,
} from '@agent-lcars/orchestrator';
import { implement, ORPCError } from '@orpc/server';

import { orchestratorMigrationContract } from './orchestrator-migration-contract';
import type { WorkContext } from './work-mint';

const os = implement(orchestratorMigrationContract).$context<WorkContext>();

/** Dedicated, never-default migration capability. Member automation may hold
 * `work.operator` for normal Work dispatch, but cannot read or replace
 * fleet-wide persisted records unless a maintainer explicitly grants this
 * short-lived scope to its human/operator identity. */
const migrationOperator = os.use(async ({ context, next }) => {
  const { principal } = context;
  if (principal === undefined || !principal.scopes.has('work.migrate')) {
    throw new ORPCError('UNAUTHORIZED', {
      message: 'work.migrate scope required',
    });
  }
  return next({ context: { principal } });
});

export const orchestratorMigrationRouter = os.router({
  inventory: migrationOperator.inventory.handler(async ({ input, context }) => {
    try {
      const page = await context.runtime.store.inventoryPersistedRecords(input);
      // The public contract owns mutable JSON arrays; store types deliberately
      // expose readonly snapshots so callers cannot mutate an inventory page.
      return {
        ...page,
        records: page.records.map((record) => ({
          ...record,
          findings: [...record.findings],
        })),
      };
    } catch (error) {
      if (PersistedMigrationCursorError.is(error)) {
        throw new ORPCError('BAD_REQUEST', {
          message: 'The inventory cursor is malformed or stale',
        });
      }
      throw error;
    }
  }),
  migrate: migrationOperator.migrate.handler(
    async ({ input, context, errors }) => {
      try {
        const entries = input.entries as PersistedMigrationEntry[];
        if (input.mode === 'dry-run') {
          const preview =
            await context.runtime.store.previewPersistedMigration(entries);
          return {
            mode: 'dry-run' as const,
            ...preview,
            deletions: preview.deletions.map((deletion) => ({
              ...deletion,
              reasons: [...deletion.reasons],
            })),
          };
        }
        if (
          input.reviewedManifestId === undefined ||
          input.confirmation !== 'apply-reviewed-manifest'
        ) {
          throw errors.CONFLICT({
            message:
              'apply requires reviewedManifestId and apply-reviewed-manifest confirmation',
          });
        }
        const applied = await context.runtime.store.applyPersistedMigration({
          entries,
          reviewedManifestId: input.reviewedManifestId,
        });
        return {
          mode: 'apply' as const,
          ...applied,
          deletions: applied.deletions.map((deletion) => ({
            ...deletion,
            reasons: [...deletion.reasons],
          })),
        };
      } catch (error) {
        if (PersistedMigrationConflict.is(error)) {
          throw errors.CONFLICT({ message: error.message });
        }
        throw error;
      }
    },
  ),
});
