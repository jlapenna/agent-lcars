import { z } from 'zod';

import { activationProvenanceSchema } from './activation';
import { canonicalTaskIdentitySchema, tenantRefSchema } from './identity';
import {
  nonnegativeSafeIntegerSchema,
  opaqueIdSchema,
  sha256Schema,
} from './primitives';

const taskParkPresentationSchema = z
  .strictObject({
    disposition: z.literal('parked'),
    humanAttention: z.literal('required'),
    notice: z.strictObject({ kind: z.literal('task-parked') }),
    intentId: opaqueIdSchema.optional(),
    intentRevision: nonnegativeSafeIntegerSchema.optional(),
    reason: z.enum(['policy-rejected', 'operator-parked']),
  })
  .superRefine((value, ctx) => {
    if (
      (value.intentId === undefined) !==
      (value.intentRevision === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Park intent identity is all-or-none',
      });
    }
  });

/** Immutable, provider-neutral task presentation operation. */
export const taskPresentationPlanSchema = z
  .strictObject({
    schema: z.literal('agent-lcars.task-presentation-plan/v1'),
    version: z.literal(1),
    operationId: opaqueIdSchema,
    tenant: tenantRefSchema,
    task: canonicalTaskIdentitySchema,
    taskRevision: nonnegativeSafeIntegerSchema,
    sourceFactId: opaqueIdSchema,
    taskEffectKey: opaqueIdSchema,
    effectDigest: sha256Schema,
    transitionDigest: sha256Schema,
    activation: activationProvenanceSchema,
    presentation: taskParkPresentationSchema,
  })
  .superRefine((value, ctx) => {
    if (
      value.tenant.tenantId !== value.task.tenantId ||
      value.tenant.repositoryId !== value.task.repositoryId
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['tenant'],
        message: 'Task and tenant must agree',
      });
    }
  });
export type TaskPresentationPlan = z.infer<typeof taskPresentationPlanSchema>;
