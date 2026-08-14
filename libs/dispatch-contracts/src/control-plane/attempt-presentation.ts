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
  positiveSafeIntegerSchema,
  sha256Schema,
} from './primitives';

const SUCCESS_RESULTS = new Set([
  'no-op',
  'pull-request',
  'merged-deliverable',
  'review',
  'comment',
]);
const FAILURE_RESULTS = new Set([
  'startup-failure',
  'trajectory-failure',
  'outcome-gate-failure',
]);
const deliverableReferenceSchema = z.strictObject({
  kind: z.literal('pull-request'),
  number: positiveSafeIntegerSchema,
});

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
    terminal: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('finalization'),
        commandId: opaqueIdSchema,
        terminalFactId: opaqueIdSchema,
      }),
      z.strictObject({
        kind: z.literal('lifecycle-decision'),
        commandId: opaqueIdSchema,
        decision: z.enum(['launch-rejected', 'cancel-unlaunched', 'mark-lost']),
      }),
    ]),
    outcomeDigest: sha256Schema,
    activation: centralActivationProvenanceSchema,
    presentation: z.strictObject({
      kind: z.literal('attempt-finalized'),
      terminalState: attemptTerminalStateSchema,
      execution: attemptExecutionStateSchema,
      result: z.union([dispatchOutcomeKindSchema, z.literal('none')]),
      reference: deliverableReferenceSchema.optional(),
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
    const presentation = value.presentation;
    const requiresReference =
      presentation.result === 'pull-request' ||
      presentation.result === 'merged-deliverable';
    if (requiresReference !== (presentation.reference !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['presentation', 'reference'],
        message: 'Deliverable reference must match the result kind',
      });
    }
    if (value.terminal.kind === 'lifecycle-decision') {
      const decisionMatches =
        value.terminal.decision === 'launch-rejected'
          ? presentation.terminalState === 'failed' &&
            presentation.execution === 'not_started' &&
            ['none', 'startup-failure'].includes(presentation.result) &&
            presentation.evidenceValidation === 'not-applicable'
          : value.terminal.decision === 'cancel-unlaunched'
            ? ['cancelled', 'superseded'].includes(
                presentation.terminalState,
              ) &&
              presentation.execution === 'not_started' &&
              presentation.result === 'none' &&
              presentation.evidenceValidation === 'not-applicable'
            : presentation.terminalState === 'lost' &&
              ['lost', 'timed_out'].includes(presentation.execution) &&
              presentation.result === 'none' &&
              presentation.evidenceValidation === 'not-applicable';
      if (!decisionMatches) {
        ctx.addIssue({
          code: 'custom',
          path: ['terminal'],
          message: 'Lifecycle decision contradicts the presentation outcome',
        });
      }
    }
    if (presentation.terminalState === 'succeeded') {
      if (
        presentation.execution !== 'exited' ||
        !SUCCESS_RESULTS.has(presentation.result) ||
        presentation.evidenceValidation !== 'validated' ||
        presentation.failure !== undefined
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['presentation'],
          message: 'Succeeded presentation axes are inconsistent',
        });
      }
      return;
    }
    if (presentation.terminalState === 'failed') {
      if (
        !['exited', 'timed_out', 'not_started'].includes(
          presentation.execution,
        ) ||
        (presentation.result !== 'none' &&
          !FAILURE_RESULTS.has(presentation.result)) ||
        presentation.evidenceValidation === 'validated' ||
        presentation.failure === undefined
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['presentation'],
          message: 'Failed presentation axes are inconsistent',
        });
      }
      return;
    }
    if (
      presentation.terminalState === 'cancelled' ||
      presentation.terminalState === 'superseded'
    ) {
      if (
        !['cancelled', 'not_started'].includes(presentation.execution) ||
        presentation.result !== 'none' ||
        presentation.evidenceValidation !== 'not-applicable' ||
        presentation.failure !== undefined
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['presentation'],
          message: 'Cancelled presentation axes are inconsistent',
        });
      }
      return;
    }
    if (
      !['lost', 'timed_out', 'not_started'].includes(presentation.execution) ||
      presentation.result !== 'none' ||
      presentation.evidenceValidation !== 'not-applicable' ||
      presentation.failure !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['presentation'],
        message: 'Lost or expired presentation axes are inconsistent',
      });
    }
  });
export type AttemptPresentationPlan = z.infer<
  typeof attemptPresentationPlanSchema
>;
