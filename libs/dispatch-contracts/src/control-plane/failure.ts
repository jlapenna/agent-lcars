import { z } from 'zod';

import {
  FAILURE_PHASES,
  FAILURE_REASONS,
  OWNING_SYSTEMS,
  RETRY_DISPOSITIONS,
} from '../failure';
import { opaqueIdSchema } from './primitives';

/**
 * Durable v1 failure data. It reuses the established failure vocabulary but
 * deliberately replaces legacy free-text evidence/detail with a non-secret
 * record reference. Human-readable diagnostics belong in redacted logs, not
 * in authority records that are copied into observations and projections.
 */
export const persistedFailureClassificationSchema = z.strictObject({
  owningSystem: z.enum(OWNING_SYSTEMS),
  phase: z.enum(FAILURE_PHASES),
  reason: z.enum(FAILURE_REASONS),
  retryDisposition: z.enum(RETRY_DISPOSITIONS),
  retryBudget: z.number().int().safe().nonnegative().optional(),
  evidenceRef: opaqueIdSchema.optional(),
});
export type PersistedFailureClassification = z.infer<
  typeof persistedFailureClassificationSchema
>;
