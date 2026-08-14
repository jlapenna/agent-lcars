import { z } from 'zod';

import { dispatchOutcomeKindSchema } from '../outcomes';
import { centralActivationProvenanceSchema } from './activation';
import { persistedFailureClassificationSchema } from './failure';
import { canonicalTaskIdentitySchema, tenantRefSchema } from './identity';
import {
  attemptExecutionStateSchema,
  attemptTerminalStateSchema,
} from './observation';
import {
  attemptIdSchema,
  nonnegativeSafeIntegerSchema,
  opaqueIdSchema,
  sha256Schema,
} from './primitives';

/** Closed, provider-neutral summary of immutable finalizer truth. */
export const attemptPresentationPlanSchema = z
  .strictObject({
    schema: z.literal('agent-lcars.attempt-presentation-plan/v1'),
    version: z.literal(1),
    operationId: opaqueIdSchema,
    tenant: tenantRefSchema,
    task: canonicalTaskIdentitySchema,
    attemptId: attemptIdSchema,
    attemptRevision: nonnegativeSafeIntegerSchema,
    finalizationCommandId: opaqueIdSchema,
    terminalFactId: opaqueIdSchema,
    outcomeDigest: sha256Schema,
    activation: centralActivationProvenanceSchema,
    presentation: z.strictObject({
      kind: z.literal('attempt-finalized'),
      terminalState: attemptTerminalStateSchema,
      execution: attemptExecutionStateSchema,
      result: z.union([dispatchOutcomeKindSchema, z.literal('none')]),
      evidenceValidation: z.enum([
        'validated',
        'absent',
        'ambiguous',
        'rejected',
        'not-applicable',
      ]),
      failure: persistedFailureClassificationSchema
        .omit({ evidenceRef: true })
        .optional(),
    }),
  })
  .superRefine((value, ctx) => {
    if (
      value.tenant.tenantId !== value.task.tenantId ||
      value.tenant.repositoryId !== value.task.repositoryId
    )
      ctx.addIssue({ code: 'custom', message: 'Tenant/task mismatch' });
    if (
      (value.presentation.terminalState === 'failed') !==
      (value.presentation.failure !== undefined)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Failure summary must match failed terminal state',
      });
  });
export type AttemptPresentationPlan = z.infer<
  typeof attemptPresentationPlanSchema
>;
