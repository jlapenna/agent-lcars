import 'server-only';

import {
  PersistedMigrationConflict,
  type PersistedMigrationEntry,
} from '@agent-lcars/orchestrator';
import { implement, ORPCError } from '@orpc/server';

import { orchestratorMigrationContract } from './orchestrator-migration-contract';
import type { WorkContext } from './work-mint';

const os = implement(orchestratorMigrationContract).$context<WorkContext>();

/** The migration surface uses the same authenticated operator capability as
 * normal Work API mutations. A local process cannot construct this route's
 * store directly; application credentials remain inside the deployed
 * console runtime. */
const operator = os.use(async ({ context, next }) => {
  const { principal } = context;
  if (principal === undefined || !principal.scopes.has('work.operator')) {
    throw new ORPCError('UNAUTHORIZED', {
      message: 'work.operator scope required',
    });
  }
  return next({ context: { principal } });
});

export const orchestratorMigrationRouter = os.router({
  inventory: operator.inventory.handler(async ({ input, context }) => {
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
  }),
  migrate: operator.migrate.handler(async ({ input, context, errors }) => {
    try {
      const entries = input.entries as PersistedMigrationEntry[];
      if (input.mode === 'dry-run') {
        const preview =
          await context.runtime.store.previewPersistedMigration(entries);
        return { mode: 'dry-run' as const, ...preview };
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
      return { mode: 'apply' as const, ...applied };
    } catch (error) {
      if (error instanceof PersistedMigrationConflict) {
        throw errors.CONFLICT({ message: error.message });
      }
      throw error;
    }
  }),
});
