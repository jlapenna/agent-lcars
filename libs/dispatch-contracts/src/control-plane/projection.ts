import { z } from 'zod';

import { projectionConvergenceStateSchema } from '../projection';
import { persistedFailureClassificationSchema } from './failure';
import {
  attemptIdSchema,
  nonnegativeSafeIntegerSchema,
  opaqueIdSchema,
  sha256Schema,
  utcDateTimeSchema,
} from './primitives';

const projectionPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('failure-park'),
    failure: persistedFailureClassificationSchema,
  }),
  z.strictObject({
    kind: z.literal('outcome-comment'),
    outcomeDigest: sha256Schema,
  }),
  z.strictObject({
    kind: z.literal('ledger-projection'),
    ledgerRevision: nonnegativeSafeIntegerSchema,
  }),
  z.strictObject({
    kind: z.literal('local-completion-callback'),
    outcomeDigest: sha256Schema,
  }),
]);

/** Effect request, separate from the immutable attempt outcome. */
export const projectionIntentSchema = z
  .strictObject({
    schema: z.literal('agent-lcars.projection-intent/v1'),
    version: z.literal(1),
    operationId: opaqueIdSchema,
    attemptId: attemptIdSchema,
    kind: z.enum([
      'failure-park',
      'outcome-comment',
      'ledger-projection',
      'local-completion-callback',
    ]),
    desiredRevision: nonnegativeSafeIntegerSchema,
    payload: projectionPayloadSchema,
  })
  .refine((value) => value.kind === value.payload.kind, {
    path: ['payload', 'kind'],
    message: 'Projection kind and payload kind must agree',
  });
export type ProjectionIntent = z.infer<typeof projectionIntentSchema>;

/** Projection convergence is an orthogonal operation axis, never attempt state. */
export const projectionOperationStatusSchema = z
  .strictObject({
    operationId: opaqueIdSchema,
    state: projectionConvergenceStateSchema,
    observedAt: utcDateTimeSchema,
    failure: persistedFailureClassificationSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.state === 'diverged' && value.failure === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['failure'],
        message: 'Diverged projection requires a failure',
      });
    }
    if (value.state !== 'diverged' && value.failure !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['failure'],
        message: 'Only diverged projection has a failure',
      });
    }
  });
/** V1 operation status, distinct from legacy ledger ProjectionStatus. */
export const projectionStatusV1Schema = projectionOperationStatusSchema;
export type ProjectionStatusV1 = z.infer<typeof projectionStatusV1Schema>;
export type ProjectionOperationStatus = ProjectionStatusV1;
