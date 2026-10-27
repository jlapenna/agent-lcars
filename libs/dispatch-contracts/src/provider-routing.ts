import { z } from 'zod';

/** Latest source-ordered label request; Work and historical Run facts stay immutable.
 * Refusal is final for this delivery, never permission to start after settlement. */
export const providerRoutingSchema = z.strictObject({
  requestId: z.string().min(1).max(1_024),
  requestedAt: z.iso.datetime({ offset: false }),
  actor: z.string().min(1).max(128),
  requestedPipeline: z.string().min(1).max(128),
  effectivePipeline: z.string().min(1).max(128),
  status: z.enum(['accepted', 'refused']),
  reason: z.string().min(1).max(128).optional(),
  fromRunId: z.string().min(1).max(1_024).optional(),
  /** Last accepted label generation, retained across later refusals. */
  acceptedGeneration: z
    .strictObject({
      runId: z.string().min(1).max(1_024),
      requestedAt: z.iso.datetime({ offset: false }),
      pipeline: z.string().min(1).max(128),
    })
    .optional(),
  /** Historical only: records written before `acceptedGeneration` existed
   * carry it. Nothing reads or writes it any more. */
  successorRunId: z.string().min(1).max(1_024).optional(),
});
