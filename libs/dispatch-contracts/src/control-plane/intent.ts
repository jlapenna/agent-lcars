import { z } from 'zod';

import { activationProvenanceSchema } from './activation';
import { canonicalTaskIdentitySchema } from './identity';
import { policyDecisionSchema } from './policy';
import {
  nonnegativeSafeIntegerSchema,
  opaqueIdSchema,
  utcDateTimeSchema,
} from './primitives';

export const intentStatusSchema = z.enum([
  'admitted',
  'desired',
  'superseded',
  'parked',
  'cancelled',
  'completed',
]);
export type IntentStatus = z.infer<typeof intentStatusSchema>;

/** Immutable intent revision; new work never reopens or changes an old one. */
export const intentRevisionSchema = z
  .strictObject({
    schema: z.literal('agent-lcars.intent/v1'),
    version: z.literal(1),
    task: canonicalTaskIdentitySchema,
    intentId: opaqueIdSchema,
    revision: nonnegativeSafeIntegerSchema,
    status: intentStatusSchema,
    sourceFactId: opaqueIdSchema,
    policyDecision: policyDecisionSchema,
    activation: activationProvenanceSchema,
    createdAt: utcDateTimeSchema,
  })
  .superRefine((value, ctx) => {
    if (value.sourceFactId !== value.policyDecision.sourceFactId) {
      ctx.addIssue({
        code: 'custom',
        path: ['policyDecision', 'sourceFactId'],
        message:
          'Intent and policy decision must reference the same source fact',
      });
    }
    if (
      (value.status === 'admitted' || value.status === 'desired') &&
      value.policyDecision.decision !== 'accepted'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['policyDecision', 'decision'],
        message: 'Admitted and desired intents require accepted policy',
      });
    }
  });
export type IntentRevision = z.infer<typeof intentRevisionSchema>;

/** The task's one desired relation, kept separate from historical intents. */
export const desiredIntentRelationSchema = z.strictObject({
  task: canonicalTaskIdentitySchema,
  intentId: opaqueIdSchema,
  intentRevision: nonnegativeSafeIntegerSchema,
  selectedAt: utcDateTimeSchema,
  supersedesIntentId: opaqueIdSchema.optional(),
});
export type DesiredIntentRelation = z.infer<typeof desiredIntentRelationSchema>;
