import { z } from 'zod';

import { DispatchOutcomeKind, dispatchOutcomeKindSchema } from '../outcomes';
import { localAttemptMarkerSchema, runBindingSchema } from './attempt';
import { persistedFailureClassificationSchema } from './failure';
import { canonicalTaskIdentitySchema, tenantRefSchema } from './identity';
import {
  attemptIdSchema,
  opaqueIdSchema,
  sha256Schema,
  utcDateTimeSchema,
} from './primitives';

/** Legacy ledger references are deliberately loose; the v1 ingress is not. */
const strictDispatchOutcomeReferenceSchema = z.strictObject({
  kind: z.literal('pull-request'),
  number: z.number().int().safe().positive(),
});

/** The worker can only name the exact artifact for later independent fetch. */
export const agentResultClaimSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('pull-request'),
    number: z.number().int().safe().positive(),
    localAttemptMarker: localAttemptMarkerSchema,
  }),
  z.strictObject({
    kind: z.literal('comment'),
    commentId: opaqueIdSchema,
    localAttemptMarker: localAttemptMarkerSchema,
  }),
  z.strictObject({
    kind: z.literal('review'),
    reviewId: opaqueIdSchema,
    pullNumber: z.number().int().safe().positive(),
    localAttemptMarker: localAttemptMarkerSchema,
  }),
  z.strictObject({
    kind: z.literal('structured-no-op'),
    commentId: opaqueIdSchema,
    localAttemptMarker: localAttemptMarkerSchema,
  }),
]);
export type AgentResultClaimV1 = z.infer<typeof agentResultClaimSchema>;

export const runtimeObservationPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('run-bound'), binding: runBindingSchema }),
  z.strictObject({
    kind: z.literal('heartbeat'),
    grantId: opaqueIdSchema,
    at: utcDateTimeSchema,
    phase: z.enum([
      'bootstrap',
      'provider-admission',
      'provider-execution',
      'agent-execution',
    ]),
  }),
  z.strictObject({
    kind: z.literal('run-terminal'),
    binding: runBindingSchema,
    conclusion: z.enum([
      'success',
      'failure',
      'cancelled',
      'timed_out',
      'skipped',
    ]),
    observedAt: utcDateTimeSchema,
  }),
  z.strictObject({
    kind: z.literal('agent-result-claim'),
    claim: agentResultClaimSchema,
  }),
  z.strictObject({
    kind: z.literal('adapter-failure'),
    failure: persistedFailureClassificationSchema,
  }),
]);
export type RuntimeObservationPayload = z.infer<
  typeof runtimeObservationPayloadSchema
>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Unsupported JSON value');
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

/** Stable UTF-8 source text whose SHA-256 binds a runtime observation fact. */
export function canonicalRuntimeObservationPayload(
  payload: RuntimeObservationPayload,
): string {
  return canonicalJson(runtimeObservationPayloadSchema.parse(payload));
}

export async function runtimeObservationPayloadSha256(
  payload: RuntimeObservationPayload,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    canonicalRuntimeObservationPayload(payload),
  );
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export const observationSourceSchema = z.strictObject({
  kind: z.enum([
    'actions-adapter',
    'github-provider',
    'control-plane-reconciler',
  ]),
  sourceId: opaqueIdSchema,
});
export type ObservationSource = z.infer<typeof observationSourceSchema>;

/** At-least-once observations are deduplicated by factId before reduction. */
export const runtimeObservationEnvelopeSchema = z
  .strictObject({
    schema: z.literal('agent-lcars.runtime-observation/v1'),
    version: z.literal(1),
    requestId: opaqueIdSchema,
    factId: opaqueIdSchema,
    attemptId: attemptIdSchema,
    tenant: tenantRefSchema,
    task: canonicalTaskIdentitySchema,
    source: observationSourceSchema,
    observedAt: utcDateTimeSchema,
    /** SHA-256 of the canonical payload bytes; recomputed at ingress. */
    payloadSha256: sha256Schema,
    payload: runtimeObservationPayloadSchema,
  })
  .superRefine((value, ctx) => {
    if (
      value.task.tenantId !== value.tenant.tenantId ||
      value.task.repositoryId !== value.tenant.repositoryId
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['task'],
        message: 'Observation task must belong to its tenant repository',
      });
    }
  });
export type RuntimeObservationEnvelope = z.infer<
  typeof runtimeObservationEnvelopeSchema
>;

/** Schema parsing is synchronous; ingress additionally calls this digest check. */
export async function hasValidRuntimeObservationPayloadDigest(
  envelope: RuntimeObservationEnvelope,
): Promise<boolean> {
  return (
    envelope.payloadSha256 ===
    (await runtimeObservationPayloadSha256(envelope.payload))
  );
}

export const attemptTerminalStateSchema = z.enum([
  'succeeded',
  'failed',
  'cancelled',
  'superseded',
  'lost',
  'expired',
]);
export type AttemptTerminalState = z.infer<typeof attemptTerminalStateSchema>;

export const attemptExecutionStateSchema = z.enum([
  'exited',
  'timed_out',
  'cancelled',
  'lost',
  'not_started',
]);
export type AttemptExecutionState = z.infer<typeof attemptExecutionStateSchema>;

const validatedClaimEvidenceSchema = z.strictObject({
  kind: z.literal('validated-claim'),
  validationFactId: opaqueIdSchema,
  claim: agentResultClaimSchema,
});
const noDeliverableEvidenceSchema = z.strictObject({
  kind: z.literal('no-deliverable'),
  terminalFactId: opaqueIdSchema,
});
const terminalRunEvidenceSchema = z.strictObject({
  kind: z.literal('terminal-run'),
  terminalFactId: opaqueIdSchema,
  binding: runBindingSchema,
});
const lifecycleEvidenceSchema = z.strictObject({
  kind: z.literal('lifecycle-decision'),
  decisionFactId: opaqueIdSchema,
});

/** A tagged proof shape, deliberately not an extensible evidence collection. */
export const outcomeEvidenceSchema = z.discriminatedUnion('kind', [
  validatedClaimEvidenceSchema,
  noDeliverableEvidenceSchema,
  terminalRunEvidenceSchema,
  lifecycleEvidenceSchema,
]);
export type OutcomeEvidence = z.infer<typeof outcomeEvidenceSchema>;

export const evidenceValidationSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('validated'),
    validationFactId: opaqueIdSchema,
    validatedAt: utcDateTimeSchema,
  }),
  z.strictObject({
    status: z.literal('absent'),
    validationFactId: opaqueIdSchema,
    validatedAt: utcDateTimeSchema,
  }),
  z.strictObject({
    status: z.literal('ambiguous'),
    validationFactId: opaqueIdSchema,
    candidateCount: z.number().int().safe().min(2),
    validatedAt: utcDateTimeSchema,
  }),
  z.strictObject({
    status: z.literal('rejected'),
    validationFactId: opaqueIdSchema,
    reason: z.enum(['marker-mismatch', 'reference-mismatch', 'lookup-failed']),
    validatedAt: utcDateTimeSchema,
  }),
  z.strictObject({ status: z.literal('not-applicable') }),
]);
export type EvidenceValidation = z.infer<typeof evidenceValidationSchema>;

const SUCCESS_RESULTS: ReadonlySet<DispatchOutcomeKind> = new Set([
  'no-op',
  'pull-request',
  'merged-deliverable',
  'review',
  'comment',
]);
const FAILURE_RESULTS: ReadonlySet<DispatchOutcomeKind> = new Set([
  'startup-failure',
  'trajectory-failure',
  'outcome-gate-failure',
]);

/**
 * Immutable finalization truth. Lifecycle terminality, execution, result,
 * reference, and proof are validated as independent axes rather than folded
 * into one misleading status string.
 */
export const attemptOutcomeSchema = z
  .strictObject({
    schema: z.literal('agent-lcars.attempt-outcome/v1'),
    version: z.literal(1),
    attemptId: attemptIdSchema,
    terminalState: attemptTerminalStateSchema,
    execution: attemptExecutionStateSchema,
    result: z.union([dispatchOutcomeKindSchema, z.literal('none')]),
    reference: strictDispatchOutcomeReferenceSchema.optional(),
    failure: persistedFailureClassificationSchema.optional(),
    evidence: outcomeEvidenceSchema,
    evidenceValidation: evidenceValidationSchema,
    finalizedAt: utcDateTimeSchema,
  })
  .superRefine((value, ctx) => {
    const error = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: 'custom', message, path });
    const hasReference = value.reference !== undefined;
    const permitsReference =
      value.result === 'pull-request' || value.result === 'merged-deliverable';

    if (hasReference !== permitsReference) {
      error('A PR reference is required exactly for a PR deliverable result', [
        'reference',
      ]);
    }
    if (value.terminalState === 'succeeded') {
      if (
        value.execution !== 'exited' ||
        !SUCCESS_RESULTS.has(value.result as DispatchOutcomeKind)
      ) {
        error('Succeeded outcomes require an exited successful result', [
          'terminalState',
        ]);
      }
      if (
        value.evidence.kind !== 'validated-claim' ||
        value.evidenceValidation.status !== 'validated'
      ) {
        error('Succeeded outcomes require a validated exact claim', [
          'evidence',
        ]);
      }
      if (value.failure !== undefined) {
        error('Succeeded outcomes cannot carry a failure classification', [
          'failure',
        ]);
      }
      if (value.evidence.kind === 'validated-claim') {
        const claimResultMatches =
          ((value.result === 'pull-request' ||
            value.result === 'merged-deliverable') &&
            value.evidence.claim.kind === 'pull-request') ||
          (value.result === 'comment' &&
            value.evidence.claim.kind === 'comment') ||
          (value.result === 'review' &&
            value.evidence.claim.kind === 'review') ||
          (value.result === 'no-op' &&
            value.evidence.claim.kind === 'structured-no-op');
        if (!claimResultMatches) {
          error('Validated claim kind must match the delivered result', [
            'evidence',
            'claim',
            'kind',
          ]);
        }
        if (
          value.evidenceValidation.status === 'validated' &&
          value.evidence.validationFactId !==
            value.evidenceValidation.validationFactId
        ) {
          error('Evidence and validation must name the same fact', [
            'evidenceValidation',
            'validationFactId',
          ]);
        }
        if (
          value.evidence.claim.kind === 'pull-request' &&
          value.reference?.number !== value.evidence.claim.number
        ) {
          error('PR reference must match the validated claim', [
            'reference',
            'number',
          ]);
        }
      }
    }
    if (value.terminalState === 'failed') {
      if (!['exited', 'timed_out', 'not_started'].includes(value.execution)) {
        error('Failed outcomes require failed execution evidence', [
          'execution',
        ]);
      }
      if (
        value.result !== 'none' &&
        !FAILURE_RESULTS.has(value.result as DispatchOutcomeKind)
      ) {
        error('Failed outcomes cannot claim a successful result', ['result']);
      }
      if (value.failure === undefined)
        error('Failed outcomes require a failure classification', ['failure']);
      if (value.evidence.kind === 'validated-claim') {
        error('Failed outcomes cannot carry validated claim evidence', [
          'evidence',
        ]);
      }
      if (value.evidenceValidation.status === 'validated') {
        error('Failed outcomes cannot validate a deliverable', [
          'evidenceValidation',
        ]);
      }
    }
    if (['cancelled', 'superseded'].includes(value.terminalState)) {
      if (
        !['cancelled', 'not_started'].includes(value.execution) ||
        value.result !== 'none'
      ) {
        error('Cancelled or superseded outcomes have no deliverable result', [
          'result',
        ]);
      }
      if (
        value.evidence.kind !== 'lifecycle-decision' &&
        value.evidence.kind !== 'terminal-run'
      ) {
        error(
          'Cancelled or superseded outcomes require lifecycle or terminal proof',
          ['evidence'],
        );
      }
      if (value.failure !== undefined) {
        error('Cancelled or superseded outcomes do not carry failures', [
          'failure',
        ]);
      }
      if (value.evidenceValidation.status !== 'not-applicable') {
        error(
          'Cancelled or superseded outcomes do not validate a deliverable',
          ['evidenceValidation'],
        );
      }
    }
    if (['lost', 'expired'].includes(value.terminalState)) {
      if (
        !['lost', 'timed_out', 'not_started'].includes(value.execution) ||
        value.result !== 'none'
      ) {
        error('Lost or expired outcomes have no deliverable result', [
          'result',
        ]);
      }
      if (
        value.evidence.kind !== 'terminal-run' &&
        value.evidence.kind !== 'lifecycle-decision'
      ) {
        error('Lost or expired outcomes require terminal or lifecycle proof', [
          'evidence',
        ]);
      }
      if (value.evidenceValidation.status !== 'not-applicable') {
        error('Lost or expired outcomes do not validate a deliverable', [
          'evidenceValidation',
        ]);
      }
    }
  });
export type AttemptOutcome = z.infer<typeof attemptOutcomeSchema>;
