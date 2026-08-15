import { z } from 'zod';

import { formatAttemptId, parseAttemptId } from '../marker';
import { centralActivationProvenanceSchema } from './activation';
import { canonicalTaskIdentitySchema, tenantRefSchema } from './identity';
import { policyDecisionSchema } from './policy';
import {
  attemptIdSchema,
  DURABLE_SCALAR_BYTE_LIMITS,
  gitCommitShaSchema,
  nonnegativeSafeIntegerSchema,
  opaqueIdSchema,
  positiveSafeIntegerSchema,
  utcDateTimeSchema,
  utf8ByteLimitedStringSchema,
} from './primitives';

export const localAttemptMarkerSchema = z
  .string()
  .regex(/^g[1-9]\d*:[A-Za-z0-9._:-]+$/u, 'Invalid local marker')
  .refine((value) => {
    const parsed = parseAttemptId(value);
    return parsed !== undefined && Number.isSafeInteger(parsed.generation);
  }, 'Local marker generation must be safe');

const executionSchema = z.strictObject({
  workflowPath: utf8ByteLimitedStringSchema(
    DURABLE_SCALAR_BYTE_LIMITS.workflowPath,
  ).startsWith('.github/workflows/'),
  workflowRef: utf8ByteLimitedStringSchema(
    DURABLE_SCALAR_BYTE_LIMITS.workflowRef,
  ).min(1),
  workflowSha: gitCommitShaSchema,
  mode: z.enum(['implement', 'review', 'reply', 'runbook']),
  executorId: opaqueIdSchema,
  credentialProfileId: opaqueIdSchema,
  renewalDeadline: utcDateTimeSchema,
});

/**
 * Service-produced launch spec. `attemptId` is opaque and globally routable;
 * `localAttemptMarker` remains local correlation only.
 */
export const acceptedAttemptSpecSchema = z
  .strictObject({
    schema: z.literal('agent-lcars.attempt-spec/v1'),
    version: z.literal(1),
    requestId: opaqueIdSchema,
    attemptId: attemptIdSchema,
    tenant: tenantRefSchema,
    task: canonicalTaskIdentitySchema,
    activation: centralActivationProvenanceSchema,
    local: z.strictObject({
      intentId: opaqueIdSchema,
      generation: positiveSafeIntegerSchema,
      attemptMarker: localAttemptMarkerSchema,
      admissionRevision: nonnegativeSafeIntegerSchema,
      idempotencyKey: opaqueIdSchema,
    }),
    execution: executionSchema,
    authorization: policyDecisionSchema,
  })
  .superRefine((value, ctx) => {
    const marker = parseAttemptId(value.local.attemptMarker);
    if (
      marker === undefined ||
      marker.intentId !== value.local.intentId ||
      marker.generation !== value.local.generation ||
      value.local.attemptMarker !==
        formatAttemptId({
          generation: value.local.generation,
          intentId: value.local.intentId,
        })
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['local', 'attemptMarker'],
        message:
          'Local marker must exactly name its local intent and generation',
      });
    }
    if (value.task.tenantId !== value.tenant.tenantId) {
      ctx.addIssue({
        code: 'custom',
        path: ['task', 'tenantId'],
        message: 'Task must belong to the spec tenant',
      });
    }
    if (value.task.repositoryId !== value.tenant.repositoryId) {
      ctx.addIssue({
        code: 'custom',
        path: ['task', 'repositoryId'],
        message: 'Task must belong to the spec repository',
      });
    }
    if (value.authorization.decision !== 'accepted') {
      ctx.addIssue({
        code: 'custom',
        path: ['authorization', 'decision'],
        message: 'An AttemptSpec requires an accepted policy decision',
      });
    }
  });
/** A persisted, service-produced spec; no client-input/draft counterpart exists. */
export type AcceptedAttemptSpec = z.infer<typeof acceptedAttemptSpecSchema>;

/** Exact GitHub run identity. A binding replay must be byte-for-byte equal. */
export const runBindingSchema = z
  .strictObject({
    runId: positiveSafeIntegerSchema,
    runAttempt: positiveSafeIntegerSchema,
    checkRunId: positiveSafeIntegerSchema,
    workflowPath: utf8ByteLimitedStringSchema(
      DURABLE_SCALAR_BYTE_LIMITS.workflowPath,
    ).startsWith('.github/workflows/'),
    workflowRef: utf8ByteLimitedStringSchema(
      DURABLE_SCALAR_BYTE_LIMITS.workflowRef,
    ).min(1),
    workflowSha: gitCommitShaSchema,
    jobWorkflowRef: utf8ByteLimitedStringSchema(
      DURABLE_SCALAR_BYTE_LIMITS.jobWorkflowRef,
    )
      .min(1)
      .optional(),
    jobWorkflowSha: gitCommitShaSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.jobWorkflowRef === undefined) !==
      (value.jobWorkflowSha === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Reusable workflow ref and SHA must be present together',
      });
    }
  });
export type RunBinding = z.infer<typeof runBindingSchema>;
