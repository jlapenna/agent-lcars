import { z } from 'zod';

import { runIntrospectionSchema } from './contract';

/** Versioned client/gateway handoff. The external gateway is Homelab-owned;
 * these schemas do not declare a Work API route or a deployed service. */
export const INVESTIGATION_REQUEST_MAX_BYTES = 32 * 1024;
export const INVESTIGATION_RESPONSE_MAX_BYTES = 64 * 1024;
export const INVESTIGATION_ERROR_MAX_BYTES = 2 * 1024;
export const INVESTIGATION_TRANSPORT_MS = 65_000;

const bytes = (minimum: number, maximum: number) =>
  z
    .string()
    .min(minimum)
    .max(maximum)
    .refine(
      (value) => new TextEncoder().encode(value).length <= maximum,
      'UTF-8 byte limit exceeded',
    );
const identity = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .regex(/^[A-Za-z0-9._:-]+$/u);
const confidence = z.number().min(0).max(1);
const audit = z.strictObject({
  journal: z.enum(['retained', 'failed', 'unknown']),
  loki: z.enum(['accepted', 'failed', 'not-enabled', 'unknown']),
});

export const investigationRequestSchema = z.strictObject({
  version: z.literal(1),
  runId: runIntrospectionSchema.shape.runId,
  requestId: identity(128),
  question: bytes(1, 4096),
  issueUrl: bytes(1, 2048).nullable(),
  context: bytes(0, 16384),
});

export const investigationResultSchema = z.strictObject({
  version: z.literal(1),
  requestId: investigationRequestSchema.shape.requestId,
  runId: investigationRequestSchema.shape.runId,
  investigationId: z.uuid(),
  findings: z
    .array(
      z.strictObject({
        finding: bytes(1, 2048),
        confidence,
        evidence: z
          .array(
            z.strictObject({
              id: identity(64),
              // The current typed probe producer emits UTC as +00:00; Console
              // timestamps use Z. Preserve the standard ISO offset spelling on the wire.
              ts: z.iso.datetime({ offset: true }),
              // Portable wire identities only. Membership in the current host/probe
              // catalog and linkage to this native turn belong to the gateway.
              host: identity(128),
              probe: identity(128),
              exit: z.number().int(),
              truncated: z.boolean(),
              audit_delivery: audit,
              excerpt: bytes(0, 1024),
            }),
          )
          .min(1)
          .max(4),
      }),
    )
    .max(8),
  confidence,
  could_not_answer: z
    .array(
      bytes(1, 512).refine((value) =>
        /^(no-probe-exists|needs-mutation|needs-human):/u.test(value),
      ),
    )
    .max(8),
  audit_delivery: audit.extend({ journal: z.literal('retained') }),
});

export const investigationErrorSchema = z.strictObject({
  version: z.literal(1),
  requestId: investigationRequestSchema.shape.requestId.nullable(),
  error: z.strictObject({
    code: z.enum([
      'invalid-request',
      'request-too-large',
      'unauthorized',
      'worker-fenced',
      'request-id-conflict',
      'quota-exhausted',
      'request-in-progress',
      'invalid-investigator-result',
      'authorization-unavailable',
      'investigator-unavailable',
      'audit-unavailable',
      'deadline-exceeded',
    ]),
    message: bytes(0, 512),
    retryable: z.boolean(),
  }),
});
