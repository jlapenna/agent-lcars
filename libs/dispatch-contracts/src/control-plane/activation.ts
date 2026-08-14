import { z } from 'zod';

import { tenantRefSchema } from './identity';
import {
  opaqueIdSchema,
  positiveSafeIntegerSchema,
  utcDateTimeSchema,
} from './primitives';

/**
 * Activation is a single record, not an authority history. Shadow mode has no
 * effect capability; central-authoritative mode names exactly one authority epoch.
 * Enforcing uniqueness of that epoch across durable records is a storage
 * invariant, intentionally outside a per-record schema.
 */
const activationBase = {
  schema: z.literal('agent-lcars.control-plane-activation/v1'),
  version: z.literal(1),
  tenant: tenantRefSchema,
  taskClassId: opaqueIdSchema,
  activationId: opaqueIdSchema,
  authorityEpoch: positiveSafeIntegerSchema,
  effectiveBoundary: positiveSafeIntegerSchema,
  recordedAt: utcDateTimeSchema,
};

export const activationRecordSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    ...activationBase,
    mode: z.literal('shadow'),
    effectMode: z.literal('none'),
  }),
  z.strictObject({
    ...activationBase,
    mode: z.literal('central-authoritative'),
    effectMode: z.literal('enabled'),
  }),
  z.strictObject({
    ...activationBase,
    mode: z.literal('retired'),
    effectMode: z.literal('none'),
  }),
]);
export type ActivationRecord = z.infer<typeof activationRecordSchema>;

/** Immutable authority pin copied onto intents accepted during an epoch. */
export const activationProvenanceSchema = z.strictObject({
  activationId: opaqueIdSchema,
  taskClassId: opaqueIdSchema,
  authorityEpoch: positiveSafeIntegerSchema,
  mode: z.enum(['shadow', 'central-authoritative']),
});
export type ActivationProvenance = z.infer<typeof activationProvenanceSchema>;

/** Only a central-authoritative epoch may produce an executable attempt. */
export const centralActivationProvenanceSchema = z.strictObject({
  activationId: opaqueIdSchema,
  taskClassId: opaqueIdSchema,
  authorityEpoch: positiveSafeIntegerSchema,
  mode: z.literal('central-authoritative'),
});
export type CentralActivationProvenance = z.infer<
  typeof centralActivationProvenanceSchema
>;
