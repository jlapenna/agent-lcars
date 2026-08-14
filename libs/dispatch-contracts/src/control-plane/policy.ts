import { z } from 'zod';

import {
  opaqueIdSchema,
  positiveSafeIntegerSchema,
  sha256Schema,
  utcDateTimeSchema,
} from './primitives';

/** Immutable provenance for a centrally evaluated policy decision. */
export const policyRevisionSchema = z.strictObject({
  policyId: opaqueIdSchema,
  policyVersion: z.number().int().safe().positive(),
  contentSha256: sha256Schema,
});
export type PolicyRevision = z.infer<typeof policyRevisionSchema>;

/** Authenticated principal whose action the central policy evaluated. */
export const policyPrincipalSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('github-actor'),
    actorId: positiveSafeIntegerSchema,
    /** Mutable display metadata; never an authorization key. */
    login: z.string().min(1).max(100),
  }),
  z.strictObject({ kind: z.literal('operator'), operatorId: opaqueIdSchema }),
  z.strictObject({ kind: z.literal('system'), systemId: opaqueIdSchema }),
]);
export type PolicyPrincipal = z.infer<typeof policyPrincipalSchema>;

export const policyDecisionSchema = z.discriminatedUnion('decision', [
  z.strictObject({
    schema: z.literal('agent-lcars.policy-decision/v1'),
    version: z.literal(1),
    policy: policyRevisionSchema,
    decision: z.literal('accepted'),
    ruleId: opaqueIdSchema,
    sourceFactId: opaqueIdSchema,
    principal: policyPrincipalSchema,
    evidenceRef: opaqueIdSchema,
    decidedAt: utcDateTimeSchema,
  }),
  z.strictObject({
    schema: z.literal('agent-lcars.policy-decision/v1'),
    version: z.literal(1),
    policy: policyRevisionSchema,
    decision: z.literal('rejected'),
    ruleId: opaqueIdSchema,
    sourceFactId: opaqueIdSchema,
    principal: policyPrincipalSchema,
    evidenceRef: opaqueIdSchema,
    decidedAt: utcDateTimeSchema,
  }),
]);
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;
