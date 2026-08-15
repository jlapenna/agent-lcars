import { z } from 'zod';

import {
  DURABLE_SCALAR_BYTE_LIMITS,
  opaqueIdSchema,
  positiveSafeIntegerSchema,
  sha256Schema,
  utcDateTimeSchema,
  utf8ByteLimitedStringSchema,
} from './primitives';

const repositorySchema = utf8ByteLimitedStringSchema(
  DURABLE_SCALAR_BYTE_LIMITS.repository,
).regex(/^[^/\s]+\/[^/\s]+$/u);

/** Registered tenant repository identity. The mutable slug is display metadata. */
export const tenantRefSchema = z.strictObject({
  tenantId: opaqueIdSchema,
  repositoryId: positiveSafeIntegerSchema,
  repository: repositorySchema,
  installationId: positiveSafeIntegerSchema,
});
export type TenantRef = z.infer<typeof tenantRefSchema>;

/** The sole task namespace: a GitHub PR is not a second aggregate. */
export const canonicalTaskIdentitySchema = z.strictObject({
  tenantId: opaqueIdSchema,
  repositoryId: positiveSafeIntegerSchema,
  issueNumber: positiveSafeIntegerSchema,
});
export type CanonicalTaskIdentity = z.infer<typeof canonicalTaskIdentitySchema>;

/**
 * Observed GitHub subject/display data. It never participates in the task key;
 * a pull request remains the same repository issue-number aggregate.
 */
export const githubTaskDisplayMetadataSchema = z
  .strictObject({
    task: canonicalTaskIdentitySchema,
    repository: repositorySchema,
    subject: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('issue') }),
      z.strictObject({
        kind: z.literal('pull-request'),
        pullNumber: positiveSafeIntegerSchema,
      }),
    ]),
  })
  .superRefine((value, ctx) => {
    if (
      value.subject.kind === 'pull-request' &&
      value.subject.pullNumber !== value.task.issueNumber
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['subject', 'pullNumber'],
        message: 'A pull request shares its canonical issue number',
      });
    }
  });
export type GitHubTaskDisplayMetadata = z.infer<
  typeof githubTaskDisplayMetadataSchema
>;

const githubWebhookSourceSchema = z.strictObject({
  kind: z.literal('github-webhook'),
  deliveryId: opaqueIdSchema,
  repositoryId: positiveSafeIntegerSchema,
  installationId: positiveSafeIntegerSchema,
  bodySha256: sha256Schema,
  event: z.string().min(1).max(200),
  action: z.string().min(1).max(200),
  actorId: positiveSafeIntegerSchema,
  actorLogin: z.string().min(1).max(100),
  occurredAt: utcDateTimeSchema,
  hmacKeyVersion: opaqueIdSchema,
});

const schedulerSourceSchema = z.strictObject({
  kind: z.literal('schedule-reconcile'),
  schedulerId: opaqueIdSchema,
  scanKey: opaqueIdSchema,
});

const operatorSourceSchema = z.strictObject({
  kind: z.literal('operator-command'),
  operatorId: opaqueIdSchema,
  commandId: opaqueIdSchema,
  command: z.enum(['retry', 'cancel', 'park']),
});

/** Only centrally authenticated ingress identities may introduce a signal. */
export const signalSourceSchema = z.discriminatedUnion('kind', [
  githubWebhookSourceSchema,
  schedulerSourceSchema,
  operatorSourceSchema,
]);
export type SignalSource = z.infer<typeof signalSourceSchema>;

/** The normalized fact the reducer evaluates after authentication. */
export const signalSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('requested-work'),
    mode: z.enum(['implement', 'review', 'reply', 'runbook']),
    requestKey: opaqueIdSchema,
  }),
  z.strictObject({ kind: z.literal('cancel'), commandKey: opaqueIdSchema }),
  z.strictObject({ kind: z.literal('park'), commandKey: opaqueIdSchema }),
  z.strictObject({ kind: z.literal('reconcile'), scanKey: opaqueIdSchema }),
]);
export type ControlPlaneSignal = z.infer<typeof signalSchema>;

/** Normalized ingress fact, not a caller-supplied authorization assertion. */
export const controlPlaneSignalEnvelopeSchema = z
  .strictObject({
    schema: z.literal('agent-lcars.control-plane-signal/v1'),
    version: z.literal(1),
    requestId: opaqueIdSchema,
    factId: opaqueIdSchema,
    tenant: tenantRefSchema,
    task: canonicalTaskIdentitySchema,
    signal: signalSchema,
    receivedAt: utcDateTimeSchema,
    source: signalSourceSchema,
  })
  .superRefine((value, ctx) => {
    if (
      value.task.tenantId !== value.tenant.tenantId ||
      value.task.repositoryId !== value.tenant.repositoryId
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['task'],
        message: 'Task must belong to the envelope tenant repository',
      });
    }
    if (
      value.source.kind === 'github-webhook' &&
      (value.source.repositoryId !== value.tenant.repositoryId ||
        value.source.installationId !== value.tenant.installationId)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'Webhook source must match the registered tenant repository',
      });
    }
    if (
      value.source.kind === 'schedule-reconcile' &&
      (value.signal.kind !== 'reconcile' ||
        value.signal.scanKey !== value.source.scanKey)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['signal'],
        message: 'Scheduler source must carry its exact reconcile scan key',
      });
    }
    if (
      value.signal.kind === 'reconcile' &&
      value.source.kind !== 'schedule-reconcile'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'Reconcile signals require an authenticated scheduler source',
      });
    }
    if (value.source.kind === 'operator-command') {
      const validOperatorSignal =
        (value.source.command === 'retry' &&
          value.signal.kind === 'requested-work' &&
          value.signal.requestKey === value.source.commandId) ||
        (value.source.command === 'cancel' &&
          value.signal.kind === 'cancel' &&
          value.signal.commandKey === value.source.commandId) ||
        (value.source.command === 'park' &&
          value.signal.kind === 'park' &&
          value.signal.commandKey === value.source.commandId);
      if (!validOperatorSignal) {
        ctx.addIssue({
          code: 'custom',
          path: ['signal'],
          message: 'Operator command and normalized signal must agree exactly',
        });
      }
    }
  });
export type ControlPlaneSignalEnvelope = z.infer<
  typeof controlPlaneSignalEnvelopeSchema
>;
