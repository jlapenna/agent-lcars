import { z } from 'zod';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Repository-owned agent catalog health on the maintenance reply
 * (docs/repository-agents.md). It carries repository names and timestamps
 * only: no agent names, definitions, errors or messages. */
export const repositoryAgentObservationSchema = z.strictObject({
  version: z.literal(1),
  observedAt: z.iso.datetime(),
  /** Cataloged agents by admission state: enabled; vetoed (valid, operator
   * disabled); invalid (definition error); unavailable (the source refresh
   * failed); removed (no longer in the repository). */
  agents: z.strictObject({
    enabled: count,
    vetoed: count,
    invalid: count,
    unavailable: count,
    removed: count,
  }),
  /** Every refreshed repository's last attempt, last successful read and
   * last failed read. Absent means never. */
  sources: z.array(
    z.strictObject({
      repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
      attemptedAt: z.iso.datetime().optional(),
      succeededAt: z.iso.datetime().optional(),
      failedAt: z.iso.datetime().optional(),
    }),
  ),
});
export type RepositoryAgentObservation = z.infer<
  typeof repositoryAgentObservationSchema
>;
