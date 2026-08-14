import { createHash } from 'node:crypto';

import type {
  AcceptedAttemptSpec,
  AgentResultClaimV1,
  AttemptOutcome,
  EvidenceValidation as ContractEvidenceValidation,
  RunBinding,
  RuntimeObservationEnvelope,
} from '@agent-lcars/dispatch-contracts';
import {
  acceptedAttemptSpecSchema,
  attemptOutcomeSchema,
  canonicalRuntimeObservationPayload,
  evidenceValidationSchema,
  runtimeObservationEnvelopeSchema,
  utcDateTimeSchema,
} from '@agent-lcars/dispatch-contracts';

const SHA256 = /^[a-f0-9]{64}$/u;
const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,200}$/u;

export type AttemptPhase =
  | 'launch-pending'
  | 'launch-accepted'
  | 'launch-response-unknown'
  | 'launch-rejected'
  | 'active'
  | 'result-observed'
  | 'validating'
  | 'cancelling'
  | 'terminal';

export interface AttemptFactReceipt {
  factId: string;
  requestId: string;
  payloadSha256: string;
  canonicalDigest: string;
  observedAt: string;
  kind: RuntimeObservationEnvelope['payload']['kind'];
}

export interface AttemptCommandReceipt {
  eventId: string;
  canonicalDigest: string;
}

export interface ClaimedEvidence {
  factId: string;
  claim: AgentResultClaimV1;
  observedAt: string;
  validation?: EvidenceValidation;
}

export type EvidenceValidation = Exclude<
  ContractEvidenceValidation,
  { status: 'not-applicable' }
>;

export interface FinalizationWindow {
  terminalFactId: string;
  terminalConclusion:
    'success' | 'failure' | 'cancelled' | 'timed_out' | 'skipped';
  openedAt: string;
  closesAt: string;
  evidence: ClaimedEvidence[];
}

export interface PendingTerminalFact {
  factId: string;
  binding: RunBinding;
  conclusion: FinalizationWindow['terminalConclusion'];
  observedAt: string;
  finalizationDeadline: string;
}

export interface AttemptLaunchOperation {
  /** Exactly the global attemptId: one durable outbox operation per attempt. */
  operationId: string;
  executionEpoch: number;
  state: 'recorded' | 'accepted' | 'response-unknown';
}

export interface AttemptState {
  schema: 'agent-lcars.attempt-state/v1';
  version: 1;
  spec: AcceptedAttemptSpec;
  specDigest: string;
  revision: number;
  phase: AttemptPhase;
  launch: AttemptLaunchOperation;
  /** Increments only when a fresh launch has been durably admitted. v1 has one. */
  executionEpoch: number;
  binding?: RunBinding;
  facts: AttemptFactReceipt[];
  commands: AttemptCommandReceipt[];
  pendingTerminal?: PendingTerminalFact;
  pendingClaims: ClaimedEvidence[];
  finalization?: FinalizationWindow;
  cancellation?: {
    eventId: string;
    supersededByIntentId?: string;
  };
  outcome?: AttemptOutcome;
  futureGrantsDenied: boolean;
  updatedAt: string;
}

export type AttemptEvent =
  | { kind: 'launch-accepted'; eventId: string }
  | { kind: 'launch-response-unknown'; eventId: string }
  | { kind: 'launch-rejected'; eventId: string; outcome: AttemptOutcome }
  | {
      kind: 'observation';
      envelope: RuntimeObservationEnvelope;
      /** Required only for an exact terminal run fact; policy supplied. */
      finalizationDeadline?: string;
    }
  | {
      kind: 'start-validation';
      eventId: string;
      at: string;
    }
  | {
      kind: 'validate-claim';
      eventId: string;
      claimFactId: string;
      validation: EvidenceValidation;
    }
  | { kind: 'finalize'; eventId: string; outcome: AttemptOutcome }
  | {
      kind: 'cancel-unlaunched';
      eventId: string;
      outcome: AttemptOutcome;
      supersededByIntentId?: string;
    }
  | { kind: 'request-cancel'; eventId: string; supersededByIntentId?: string }
  | { kind: 'mark-lost'; eventId: string; outcome: AttemptOutcome };

export interface RegisterAttemptInput {
  kind: 'register';
  expectedRevision: 0;
  transitionedAt: string;
  spec: AcceptedAttemptSpec;
  specDigest: string;
}

export interface TransitionAttemptInput {
  kind: 'transition';
  expectedRevision: number;
  transitionedAt: string;
  canonicalDigest: string;
  event: AttemptEvent;
}

export type ReduceAttemptInput = RegisterAttemptInput | TransitionAttemptInput;

export type AttemptEffect =
  | {
      kind: 'dispatch-launch';
      effectKey: string;
      attemptId: string;
      operationId: string;
      executionEpoch: number;
    }
  | {
      kind: 'discover-exact-run';
      effectKey: string;
      attemptId: string;
      executionEpoch: number;
    }
  | {
      kind: 'cancel-or-drain';
      effectKey: string;
      attemptId: string;
      executionEpoch: number;
      supersededByIntentId?: string;
    }
  | {
      kind: 'deny-future-grants';
      effectKey: string;
      attemptId: string;
      /** This makes no claim to revoke already-issued tokens. */
      reason: 'cancelling' | 'terminal' | 'lost';
    }
  | {
      kind: 'validate-evidence';
      effectKey: string;
      attemptId: string;
      terminalFactId: string;
      claimFactId: string;
      claim: AgentResultClaimV1;
    };

export type AttemptConflictKind =
  | 'binding-conflict'
  | 'digest-conflict'
  | 'invalid-input'
  | 'invalid-transition'
  | 'revision-conflict'
  | 'spec-conflict';

export type ReduceAttemptResult =
  | { status: 'applied'; state: AttemptState; effects: AttemptEffect[] }
  | { status: 'replay'; state: AttemptState; effects: [] }
  | {
      status: 'conflict';
      state: AttemptState | undefined;
      conflict: AttemptConflictKind;
      message: string;
      effects: [];
    };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

/** Stable source material for a caller-provided transition digest. */
export function canonicalAttemptTransition(event: AttemptEvent): string {
  return JSON.stringify(canonicalValue(event));
}

export function attemptTransitionDigest(event: AttemptEvent): string {
  return createHash('sha256')
    .update(canonicalAttemptTransition(event))
    .digest('hex');
}

/** The accepted spec is immutable; its digest is recomputed at registration. */
export function attemptSpecDigest(spec: AcceptedAttemptSpec): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(spec)))
    .digest('hex');
}

function conflict(
  state: AttemptState | undefined,
  kind: AttemptConflictKind,
  message: string,
): ReduceAttemptResult {
  return { status: 'conflict', state, conflict: kind, message, effects: [] };
}

function isTimestamp(value: string): boolean {
  return utcDateTimeSchema.safeParse(value).success;
}

function sameBinding(left: RunBinding, right: RunBinding): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function bindingMatchesSpec(
  binding: RunBinding,
  spec: AcceptedAttemptSpec,
): boolean {
  return (
    binding.workflowPath === spec.execution.workflowPath &&
    binding.workflowRef === spec.execution.workflowRef &&
    binding.workflowSha === spec.execution.workflowSha
  );
}

function eventIdentity(event: AttemptEvent): string {
  return event.kind === 'observation' ? event.envelope.factId : event.eventId;
}

function eventRequestIdentity(event: AttemptEvent): string | undefined {
  return event.kind === 'observation' ? event.envelope.requestId : undefined;
}

function existingFact(
  state: AttemptState,
  factId: string,
): AttemptFactReceipt | undefined {
  return state.facts.find((fact) => fact.factId === factId);
}

function checkTransitionInput(input: TransitionAttemptInput): boolean {
  const event = input.event;
  const validEvent =
    OPAQUE_ID.test(eventIdentity(event)) &&
    (event.kind !== 'observation' ||
      (runtimeObservationEnvelopeSchema.safeParse(event.envelope).success &&
        createHash('sha256')
          .update(canonicalRuntimeObservationPayload(event.envelope.payload))
          .digest('hex') === event.envelope.payloadSha256));
  return (
    Number.isSafeInteger(input.expectedRevision) &&
    input.expectedRevision >= 0 &&
    isTimestamp(input.transitionedAt) &&
    SHA256.test(input.canonicalDigest) &&
    input.canonicalDigest === attemptTransitionDigest(event) &&
    validEvent
  );
}

function receipt(
  envelope: RuntimeObservationEnvelope,
  canonicalDigest: string,
): AttemptFactReceipt {
  return {
    factId: envelope.factId,
    requestId: envelope.requestId,
    payloadSha256: envelope.payloadSha256,
    canonicalDigest,
    observedAt: envelope.observedAt,
    kind: envelope.payload.kind,
  };
}

function baseNext(state: AttemptState, at: string): AttemptState {
  return {
    ...state,
    revision: state.revision + 1,
    spec: clone(state.spec),
    launch: clone(state.launch),
    binding: state.binding === undefined ? undefined : clone(state.binding),
    facts: [...state.facts],
    commands: [...state.commands],
    pendingTerminal:
      state.pendingTerminal === undefined
        ? undefined
        : clone(state.pendingTerminal),
    pendingClaims: clone(state.pendingClaims),
    finalization:
      state.finalization === undefined ? undefined : clone(state.finalization),
    cancellation:
      state.cancellation === undefined ? undefined : clone(state.cancellation),
    outcome: state.outcome === undefined ? undefined : clone(state.outcome),
    updatedAt: at,
  };
}

function denyFutureGrants(
  state: AttemptState,
  effects: AttemptEffect[],
  reason: 'cancelling' | 'terminal' | 'lost',
  effectKey: string,
): void {
  if (!state.futureGrantsDenied) {
    state.futureGrantsDenied = true;
    effects.push({
      kind: 'deny-future-grants',
      effectKey,
      attemptId: state.spec.attemptId,
      reason,
    });
  }
}

function validTerminalOutcome(
  outcome: AttemptOutcome,
  attemptId: string,
): boolean {
  return (
    attemptOutcomeSchema.safeParse(outcome).success &&
    outcome.attemptId === attemptId
  );
}

function sameClaim(
  left: AgentResultClaimV1,
  right: AgentResultClaimV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validLaunchRejectedOutcome(
  outcome: AttemptOutcome,
  state: AttemptState,
  eventId: string,
  finalizedAt: string,
): boolean {
  return (
    validTerminalOutcome(outcome, state.spec.attemptId) &&
    outcome.terminalState === 'failed' &&
    outcome.execution === 'not_started' &&
    ['none', 'startup-failure'].includes(outcome.result) &&
    outcome.reference === undefined &&
    outcome.evidence.kind === 'lifecycle-decision' &&
    outcome.evidence.decisionFactId === eventId &&
    outcome.evidenceValidation.status === 'not-applicable' &&
    outcome.finalizedAt === finalizedAt
  );
}

function validLostOutcome(
  outcome: AttemptOutcome,
  state: AttemptState,
  eventId: string,
  finalizedAt: string,
): boolean {
  return (
    validTerminalOutcome(outcome, state.spec.attemptId) &&
    outcome.terminalState === 'lost' &&
    ['lost', 'timed_out'].includes(outcome.execution) &&
    outcome.result === 'none' &&
    outcome.reference === undefined &&
    outcome.evidence.kind === 'lifecycle-decision' &&
    outcome.evidence.decisionFactId === eventId &&
    outcome.evidenceValidation.status === 'not-applicable' &&
    outcome.finalizedAt === finalizedAt
  );
}

function validUnlaunchedCancellationOutcome(
  outcome: AttemptOutcome,
  state: AttemptState,
  eventId: string,
  supersededByIntentId: string | undefined,
  finalizedAt: string,
): boolean {
  return (
    validTerminalOutcome(outcome, state.spec.attemptId) &&
    outcome.terminalState ===
      (supersededByIntentId === undefined ? 'cancelled' : 'superseded') &&
    outcome.execution === 'not_started' &&
    outcome.result === 'none' &&
    outcome.reference === undefined &&
    outcome.evidence.kind === 'lifecycle-decision' &&
    outcome.evidence.decisionFactId === eventId &&
    outcome.evidenceValidation.status === 'not-applicable' &&
    outcome.finalizedAt === finalizedAt
  );
}

function outcomeMatchesTerminalConclusion(
  outcome: AttemptOutcome,
  conclusion: FinalizationWindow['terminalConclusion'],
): boolean {
  switch (conclusion) {
    case 'success':
      return outcome.execution === 'exited';
    case 'failure':
      return (
        outcome.terminalState === 'failed' && outcome.execution === 'exited'
      );
    case 'cancelled':
      return (
        ['cancelled', 'superseded'].includes(outcome.terminalState) &&
        outcome.execution === 'cancelled'
      );
    case 'timed_out':
      return (
        ['failed', 'expired', 'lost'].includes(outcome.terminalState) &&
        outcome.execution === 'timed_out'
      );
    case 'skipped':
      return (
        outcome.terminalState === 'failed' &&
        outcome.execution === 'not_started'
      );
  }
}

function finalizationFailure(
  reason: 'deliverable_absent' | 'deliverable_unattributable',
) {
  return {
    owningSystem: 'finalizer' as const,
    phase: 'validation' as const,
    reason,
    retryDisposition: 'manual' as const,
    evidenceRef: 'finalization-window',
  };
}

/**
 * The terminal run attestation is immutable. A claim can establish a
 * successful deliverable only for a successful terminal conclusion; it can
 * never turn a failed, timed-out, skipped, or cancelled run into success.
 */
export function deriveFinalizedOutcome(
  state: AttemptState,
  eventId: string,
  finalizedAt: string,
): AttemptOutcome {
  const finalization = state.finalization;
  if (finalization === undefined) {
    throw new Error('Finalization window is absent');
  }

  if (finalization.terminalConclusion === 'cancelled') {
    const cancellation = state.cancellation;
    if (cancellation === undefined && state.binding === undefined) {
      throw new Error('Cancelled terminal fact lacks exact run binding');
    }
    return {
      schema: 'agent-lcars.attempt-outcome/v1',
      version: 1,
      attemptId: state.spec.attemptId,
      terminalState:
        cancellation?.supersededByIntentId === undefined
          ? 'cancelled'
          : 'superseded',
      execution: 'cancelled',
      result: 'none',
      evidence:
        cancellation === undefined
          ? {
              kind: 'terminal-run',
              terminalFactId: finalization.terminalFactId,
              binding: clone(state.binding as RunBinding),
            }
          : {
              kind: 'lifecycle-decision',
              decisionFactId: cancellation.eventId,
            },
      evidenceValidation: { status: 'not-applicable' },
      finalizedAt,
    };
  }

  const validated = finalization.evidence.filter(
    (
      evidence,
    ): evidence is ClaimedEvidence & {
      validation: Extract<EvidenceValidation, { status: 'validated' }>;
    } => evidence.validation?.status === 'validated',
  );
  if (finalization.terminalConclusion === 'success' && validated.length === 1) {
    const evidence = validated[0];
    const claim = evidence.claim;
    const result =
      claim.kind === 'pull-request'
        ? 'pull-request'
        : claim.kind === 'comment'
          ? 'comment'
          : claim.kind === 'review'
            ? 'review'
            : 'no-op';
    return {
      schema: 'agent-lcars.attempt-outcome/v1',
      version: 1,
      attemptId: state.spec.attemptId,
      terminalState: 'succeeded',
      execution: 'exited',
      result,
      ...(claim.kind === 'pull-request'
        ? { reference: { kind: 'pull-request' as const, number: claim.number } }
        : {}),
      evidence: {
        kind: 'validated-claim',
        validationFactId: evidence.validation.validationFactId,
        claim: clone(claim),
      },
      evidenceValidation: clone(evidence.validation),
      finalizedAt,
    };
  }

  const terminal = finalization.terminalConclusion;
  const validation: ContractEvidenceValidation =
    terminal === 'success'
      ? validated.length > 1
        ? {
            status: 'ambiguous',
            validationFactId: eventId,
            candidateCount: validated.length,
            validatedAt: finalizedAt,
          }
        : {
            status: 'absent',
            validationFactId: eventId,
            validatedAt: finalizedAt,
          }
      : { status: 'not-applicable' };
  return {
    schema: 'agent-lcars.attempt-outcome/v1',
    version: 1,
    attemptId: state.spec.attemptId,
    terminalState: 'failed',
    execution:
      terminal === 'skipped'
        ? 'not_started'
        : terminal === 'timed_out'
          ? 'timed_out'
          : 'exited',
    result: 'none',
    failure: finalizationFailure(
      terminal === 'success' && validated.length > 1
        ? 'deliverable_unattributable'
        : 'deliverable_absent',
    ),
    evidence: {
      kind: 'no-deliverable',
      terminalFactId: finalization.terminalFactId,
    },
    evidenceValidation: validation,
    finalizedAt,
  };
}

function validFinalizedOutcome(
  outcome: AttemptOutcome,
  state: AttemptState,
  eventId: string,
  finalizedAt: string,
): boolean {
  const finalization = state.finalization;
  if (
    finalization === undefined ||
    !validTerminalOutcome(outcome, state.spec.attemptId) ||
    outcome.finalizedAt !== finalizedAt ||
    !outcomeMatchesTerminalConclusion(outcome, finalization.terminalConclusion)
  ) {
    return false;
  }

  const validated = finalization.evidence.filter(
    (evidence) => evidence.validation?.status === 'validated',
  );
  if (finalization.terminalConclusion === 'cancelled') {
    return (
      outcome.terminalState ===
        (state.cancellation?.supersededByIntentId === undefined
          ? 'cancelled'
          : 'superseded') &&
      outcome.execution === 'cancelled' &&
      outcome.result === 'none' &&
      (state.cancellation === undefined
        ? outcome.evidence.kind === 'terminal-run' &&
          outcome.evidence.terminalFactId === finalization.terminalFactId &&
          state.binding !== undefined &&
          sameBinding(outcome.evidence.binding, state.binding)
        : outcome.evidence.kind === 'lifecycle-decision' &&
          outcome.evidence.decisionFactId === state.cancellation.eventId) &&
      outcome.evidenceValidation.status === 'not-applicable'
    );
  }
  if (finalization.terminalConclusion !== 'success') {
    return (
      outcome.terminalState === 'failed' &&
      outcome.result === 'none' &&
      outcome.reference === undefined &&
      outcome.evidence.kind === 'no-deliverable' &&
      outcome.evidence.terminalFactId === finalization.terminalFactId &&
      outcome.evidenceValidation.status === 'not-applicable'
    );
  }
  if (validated.length === 1) {
    const evidence = validated[0];
    const validation = evidence.validation;
    return (
      validation?.status === 'validated' &&
      outcome.terminalState === 'succeeded' &&
      outcome.evidence.kind === 'validated-claim' &&
      sameClaim(outcome.evidence.claim, evidence.claim) &&
      outcome.evidence.validationFactId === validation.validationFactId &&
      JSON.stringify(outcome.evidenceValidation) === JSON.stringify(validation)
    );
  }

  if (validated.length > 1) {
    return (
      outcome.terminalState === 'failed' &&
      outcome.reference === undefined &&
      outcome.evidence.kind === 'no-deliverable' &&
      outcome.evidence.terminalFactId === finalization.terminalFactId &&
      outcome.evidenceValidation.status === 'ambiguous' &&
      outcome.evidenceValidation.validationFactId === eventId &&
      outcome.evidenceValidation.candidateCount === validated.length
    );
  }

  if (
    outcome.terminalState !== 'failed' ||
    outcome.reference !== undefined ||
    outcome.evidence.kind !== 'no-deliverable' ||
    outcome.evidence.terminalFactId !== finalization.terminalFactId
  ) {
    return false;
  }

  if (finalization.evidence.length === 0) {
    return (
      outcome.evidenceValidation.status === 'absent' &&
      outcome.evidenceValidation.validationFactId === eventId
    );
  }

  const storedValidation = finalization.evidence.find(
    (evidence) =>
      evidence.validation !== undefined &&
      evidence.validation.validationFactId ===
        (outcome.evidenceValidation.status === 'not-applicable'
          ? undefined
          : outcome.evidenceValidation.validationFactId),
  )?.validation;
  return (
    storedValidation !== undefined &&
    JSON.stringify(storedValidation) ===
      JSON.stringify(outcome.evidenceValidation)
  );
}

/**
 * Pure attempt aggregate reducer. It cannot dispatch, validate GitHub data,
 * mint/revoke credentials, or persist state. The caller atomically persists
 * the returned state and directive before performing any external operation.
 * Cross-aggregate uniqueness for global AttemptId, accepted local intent, and
 * provider run binding belongs to the transactional storage port (#1026).
 */
export function reduceAttempt(
  current: AttemptState | undefined,
  input: ReduceAttemptInput,
): ReduceAttemptResult {
  if (input.kind === 'register') {
    const registrationValid =
      input.expectedRevision === 0 &&
      acceptedAttemptSpecSchema.safeParse(input.spec).success &&
      SHA256.test(input.specDigest) &&
      input.specDigest === attemptSpecDigest(input.spec) &&
      isTimestamp(input.transitionedAt);
    if (!registrationValid) {
      return conflict(current, 'invalid-input', 'Invalid attempt registration');
    }
    if (current !== undefined) {
      if (
        current.spec.attemptId === input.spec.attemptId &&
        current.specDigest === input.specDigest &&
        input.specDigest === attemptSpecDigest(input.spec)
      ) {
        return { status: 'replay', state: current, effects: [] };
      }
      return conflict(
        current,
        'spec-conflict',
        'Attempt identity or spec was reused differently',
      );
    }
    const state: AttemptState = {
      schema: 'agent-lcars.attempt-state/v1',
      version: 1,
      spec: clone(input.spec),
      specDigest: input.specDigest,
      revision: 1,
      phase: 'launch-pending',
      launch: {
        operationId: input.spec.attemptId,
        executionEpoch: 1,
        state: 'recorded',
      },
      executionEpoch: 1,
      facts: [],
      commands: [],
      pendingClaims: [],
      futureGrantsDenied: false,
      updatedAt: input.transitionedAt,
    };
    return {
      status: 'applied',
      state,
      effects: [
        {
          kind: 'dispatch-launch',
          effectKey: `${input.spec.attemptId}:launch:1`,
          attemptId: input.spec.attemptId,
          operationId: input.spec.attemptId,
          executionEpoch: 1,
        },
      ],
    };
  }

  if (current === undefined || !checkTransitionInput(input)) {
    return conflict(
      current,
      'invalid-input',
      'Invalid attempt transition input',
    );
  }
  const identity = eventIdentity(input.event);
  const fact = existingFact(current, identity);
  const command = current.commands.find(
    (receipt) => receipt.eventId === identity,
  );
  const existingEvent = current.facts.find(
    (receipt) => receipt.requestId === eventRequestIdentity(input.event),
  );
  if (command !== undefined) {
    if (command.canonicalDigest !== input.canonicalDigest) {
      return conflict(
        current,
        'digest-conflict',
        'Event identity was reused differently',
      );
    }
    return { status: 'replay', state: current, effects: [] };
  }
  if (fact !== undefined || existingEvent !== undefined) {
    const matched = fact ?? existingEvent;
    if (
      input.event.kind === 'observation' &&
      (matched?.payloadSha256 !== input.event.envelope.payloadSha256 ||
        matched?.canonicalDigest !== input.canonicalDigest)
    ) {
      return conflict(
        current,
        'digest-conflict',
        'Fact identity was reused differently',
      );
    }
    return { status: 'replay', state: current, effects: [] };
  }
  if (input.expectedRevision !== current.revision) {
    return conflict(
      current,
      'revision-conflict',
      'Attempt revision does not match',
    );
  }
  const next = baseNext(current, input.transitionedAt);
  const effects: AttemptEffect[] = [];
  const event = input.event;

  if (event.kind === 'launch-accepted') {
    if (!['launch-pending', 'cancelling'].includes(current.phase)) {
      return conflict(
        current,
        'invalid-transition',
        'Launch acceptance requires launch-pending',
      );
    }
    if (current.phase !== 'cancelling') next.phase = 'launch-accepted';
    next.launch.state = 'accepted';
  } else if (event.kind === 'launch-response-unknown') {
    if (!['launch-pending', 'cancelling'].includes(current.phase)) {
      return conflict(
        current,
        'invalid-transition',
        'Unknown launch response requires launch-pending',
      );
    }
    if (current.phase !== 'cancelling') next.phase = 'launch-response-unknown';
    next.launch.state = 'response-unknown';
    effects.push({
      kind: 'discover-exact-run',
      effectKey: `${event.eventId}:discover-exact-run`,
      attemptId: current.spec.attemptId,
      executionEpoch: current.executionEpoch,
    });
  } else if (event.kind === 'launch-rejected') {
    if (
      !['launch-pending', 'launch-response-unknown'].includes(current.phase)
    ) {
      return conflict(
        current,
        'invalid-transition',
        'Launch rejection requires an unbound launch',
      );
    }
    if (
      current.binding !== undefined ||
      current.pendingTerminal !== undefined
    ) {
      return conflict(
        current,
        'invalid-transition',
        'Observed execution evidence forbids a no-run launch rejection',
      );
    }
    if (
      !validLaunchRejectedOutcome(
        event.outcome,
        current,
        event.eventId,
        input.transitionedAt,
      )
    ) {
      return conflict(
        current,
        'invalid-input',
        'Launch rejection requires a failed not-started outcome bound to this decision',
      );
    }
    next.phase = 'terminal';
    next.outcome = clone(event.outcome);
    denyFutureGrants(next, effects, 'terminal', `${event.eventId}:deny-grants`);
  } else if (event.kind === 'cancel-unlaunched') {
    if (
      current.phase !== 'launch-pending' ||
      current.binding !== undefined ||
      current.pendingTerminal !== undefined ||
      current.facts.some((fact) =>
        ['run-bound', 'run-terminal', 'heartbeat'].includes(fact.kind),
      )
    ) {
      return conflict(
        current,
        'invalid-transition',
        'Unlaunched cancellation requires durable proof that execution never started',
      );
    }
    if (
      !validUnlaunchedCancellationOutcome(
        event.outcome,
        current,
        event.eventId,
        event.supersededByIntentId,
        input.transitionedAt,
      )
    ) {
      return conflict(
        current,
        'invalid-input',
        'Unlaunched cancellation outcome must be bound to this lifecycle decision',
      );
    }
    next.cancellation = {
      eventId: event.eventId,
      ...(event.supersededByIntentId === undefined
        ? {}
        : { supersededByIntentId: event.supersededByIntentId }),
    };
    next.phase = 'terminal';
    next.outcome = clone(event.outcome);
    denyFutureGrants(next, effects, 'terminal', `${event.eventId}:deny-grants`);
  } else if (event.kind === 'request-cancel') {
    if (current.phase === 'terminal') {
      return conflict(
        current,
        'invalid-transition',
        'A terminal attempt cannot be cancelled',
      );
    }
    if (current.cancellation === undefined) {
      if (current.finalization === undefined) next.phase = 'cancelling';
      next.cancellation = {
        eventId: event.eventId,
        ...(event.supersededByIntentId === undefined
          ? {}
          : { supersededByIntentId: event.supersededByIntentId }),
      };
      denyFutureGrants(
        next,
        effects,
        'cancelling',
        `${event.eventId}:deny-grants`,
      );
      effects.push({
        kind: 'cancel-or-drain',
        effectKey: `${event.eventId}:cancel-or-drain`,
        attemptId: next.spec.attemptId,
        executionEpoch: next.executionEpoch,
        ...(event.supersededByIntentId === undefined
          ? {}
          : { supersededByIntentId: event.supersededByIntentId }),
      });
    } else if (
      current.cancellation.supersededByIntentId !== event.supersededByIntentId
    ) {
      return conflict(
        current,
        'invalid-transition',
        'Cancellation reason is already immutable',
      );
    }
  } else if (event.kind === 'mark-lost') {
    if (current.phase === 'terminal') {
      return conflict(current, 'invalid-transition', 'An outcome is immutable');
    }
    if (
      current.pendingTerminal !== undefined ||
      current.finalization !== undefined
    ) {
      return conflict(
        current,
        'invalid-transition',
        'Observed terminal execution evidence must finish through finalization',
      );
    }
    if (
      !validLostOutcome(
        event.outcome,
        current,
        event.eventId,
        input.transitionedAt,
      )
    ) {
      return conflict(
        current,
        'invalid-input',
        'Lost terminalization requires a lost outcome bound to this decision',
      );
    }
    next.phase = 'terminal';
    next.outcome = clone(event.outcome);
    denyFutureGrants(next, effects, 'lost', `${event.eventId}:deny-grants`);
  } else if (event.kind === 'observation') {
    const envelope = event.envelope;
    if (envelope.attemptId !== current.spec.attemptId) {
      return conflict(
        current,
        'invalid-input',
        'Observation belongs to another attempt',
      );
    }
    if (
      envelope.tenant.tenantId !== current.spec.tenant.tenantId ||
      envelope.tenant.repositoryId !== current.spec.tenant.repositoryId ||
      envelope.task.issueNumber !== current.spec.task.issueNumber
    ) {
      return conflict(
        current,
        'invalid-input',
        'Observation tenant/task does not match attempt',
      );
    }
    if (current.phase === 'terminal') {
      return conflict(
        current,
        'invalid-transition',
        'A terminal outcome cannot accept new facts',
      );
    }
    next.facts.push(receipt(envelope, input.canonicalDigest));
    switch (envelope.payload.kind) {
      case 'run-bound': {
        if (!bindingMatchesSpec(envelope.payload.binding, current.spec)) {
          return conflict(
            current,
            'binding-conflict',
            'Binding must match the accepted execution spec',
          );
        }
        if (
          current.binding !== undefined &&
          !sameBinding(current.binding, envelope.payload.binding)
        ) {
          return conflict(
            current,
            'binding-conflict',
            'A different run binding is quarantined',
          );
        }
        next.binding = clone(envelope.payload.binding);
        // An exact bound run is stronger than a missing or lost launch response.
        next.launch = { ...next.launch, state: 'accepted' };
        if (current.pendingTerminal !== undefined) {
          if (
            !sameBinding(
              current.pendingTerminal.binding,
              envelope.payload.binding,
            )
          ) {
            return conflict(
              current,
              'binding-conflict',
              'Pending terminal fact names another run',
            );
          }
          next.phase = 'result-observed';
          next.finalization = {
            terminalFactId: current.pendingTerminal.factId,
            terminalConclusion: current.pendingTerminal.conclusion,
            openedAt: input.transitionedAt,
            closesAt: current.pendingTerminal.finalizationDeadline,
            evidence: clone(
              current.pendingClaims.filter(
                (claim) =>
                  Date.parse(claim.observedAt) <=
                  Date.parse(
                    current.pendingTerminal?.finalizationDeadline ?? '',
                  ),
              ),
            ),
          };
          next.pendingTerminal = undefined;
          next.pendingClaims = [];
        } else if (
          !['result-observed', 'validating', 'cancelling'].includes(
            current.phase,
          )
        ) {
          next.phase = 'active';
        }
        break;
      }
      case 'heartbeat':
      case 'adapter-failure':
        if (
          !['active', 'result-observed', 'validating', 'cancelling'].includes(
            current.phase,
          )
        ) {
          return conflict(
            current,
            'invalid-transition',
            'Runtime facts require a bound or cancelling attempt',
          );
        }
        break;
      case 'run-terminal':
        if (
          event.finalizationDeadline === undefined ||
          !isTimestamp(event.finalizationDeadline)
        ) {
          return conflict(
            current,
            'invalid-input',
            'Terminal facts require an explicit finalization deadline',
          );
        }
        if (
          Date.parse(event.finalizationDeadline) <=
          Math.max(
            Date.parse(input.transitionedAt),
            Date.parse(envelope.observedAt),
            Date.parse(envelope.payload.observedAt),
          )
        ) {
          return conflict(
            current,
            'invalid-input',
            'Finalization deadline must follow window opening',
          );
        }
        if (!bindingMatchesSpec(envelope.payload.binding, current.spec)) {
          return conflict(
            current,
            'binding-conflict',
            'Terminal binding must match the accepted execution spec',
          );
        }
        if (current.binding === undefined) {
          if (current.pendingTerminal !== undefined) {
            return conflict(
              current,
              'invalid-transition',
              'The first terminal execution fact is immutable',
            );
          }
          next.pendingTerminal = {
            factId: envelope.factId,
            binding: clone(envelope.payload.binding),
            conclusion: envelope.payload.conclusion,
            observedAt: envelope.observedAt,
            finalizationDeadline: event.finalizationDeadline,
          };
        } else if (!sameBinding(current.binding, envelope.payload.binding)) {
          return conflict(
            current,
            'binding-conflict',
            'Terminal fact must carry the exact bound run',
          );
        } else if (current.finalization === undefined) {
          next.phase = 'result-observed';
          next.finalization = {
            terminalFactId: envelope.factId,
            terminalConclusion: envelope.payload.conclusion,
            openedAt: input.transitionedAt,
            closesAt: event.finalizationDeadline,
            evidence: clone(
              current.pendingClaims.filter(
                (claim) =>
                  Date.parse(claim.observedAt) <=
                  Date.parse(event.finalizationDeadline as string),
              ),
            ),
          };
          next.pendingClaims = [];
        } else {
          return conflict(
            current,
            'invalid-transition',
            'The first terminal execution fact is immutable',
          );
        }
        break;
      case 'agent-result-claim': {
        if (
          envelope.payload.claim.localAttemptMarker !==
          current.spec.local.attemptMarker
        ) {
          return conflict(
            current,
            'invalid-input',
            'Claim marker belongs to another local attempt',
          );
        }
        if (current.phase === 'validating') {
          return conflict(
            current,
            'invalid-transition',
            'Claims are closed once validation begins',
          );
        }
        const claimDeadline =
          current.finalization?.closesAt ??
          current.pendingTerminal?.finalizationDeadline;
        if (
          claimDeadline !== undefined &&
          Date.parse(envelope.observedAt) > Date.parse(claimDeadline)
        ) {
          return conflict(
            current,
            'invalid-transition',
            'Claims after the finalization deadline are not accepted',
          );
        }
        const claimed: ClaimedEvidence = {
          factId: envelope.factId,
          claim: clone(envelope.payload.claim),
          observedAt: envelope.observedAt,
        };
        if (next.finalization === undefined) next.pendingClaims.push(claimed);
        else next.finalization.evidence.push(claimed);
        break;
      }
    }
  } else if (event.kind === 'start-validation') {
    if (
      current.phase !== 'result-observed' ||
      current.finalization === undefined
    ) {
      return conflict(
        current,
        'invalid-transition',
        'Validation requires an open finalization window',
      );
    }
    if (
      !isTimestamp(event.at) ||
      event.at !== input.transitionedAt ||
      Date.parse(event.at) < Date.parse(current.finalization.closesAt)
    ) {
      return conflict(
        current,
        'invalid-transition',
        'Validation waits for the explicit deadline',
      );
    }
    next.phase = 'validating';
    for (const evidence of current.finalization.evidence) {
      if (evidence.validation !== undefined) continue;
      effects.push({
        kind: 'validate-evidence',
        effectKey: `${event.eventId}:${evidence.factId}:validate-evidence`,
        attemptId: current.spec.attemptId,
        terminalFactId: current.finalization.terminalFactId,
        claimFactId: evidence.factId,
        claim: clone(evidence.claim),
      });
    }
  } else if (event.kind === 'validate-claim') {
    if (current.phase !== 'validating' || current.finalization === undefined) {
      return conflict(
        current,
        'invalid-transition',
        'Claim validation requires a closed evidence window',
      );
    }
    if (
      !evidenceValidationSchema.safeParse(event.validation).success ||
      event.validation.validationFactId !== event.eventId ||
      event.validation.validatedAt !== input.transitionedAt
    ) {
      return conflict(
        current,
        'invalid-input',
        'Claim validation must be a typed fact bound to this event',
      );
    }
    const claim = next.finalization?.evidence.find(
      (evidence) => evidence.factId === event.claimFactId,
    );
    if (claim === undefined || claim.validation !== undefined) {
      return conflict(
        current,
        'invalid-input',
        'Claim validation must target one unvalidated claim',
      );
    }
    claim.validation = clone(event.validation);
  } else if (event.kind === 'finalize') {
    if (current.phase !== 'validating' || current.finalization === undefined) {
      return conflict(
        current,
        'invalid-transition',
        'Finalization requires completed validation',
      );
    }
    if (
      !validFinalizedOutcome(
        event.outcome,
        current,
        event.eventId,
        input.transitionedAt,
      )
    ) {
      return conflict(
        current,
        'invalid-input',
        'Outcome proof does not match the immutable terminal and validation facts',
      );
    }
    if (
      current.finalization.evidence.some(
        (evidence) => evidence.validation === undefined,
      )
    ) {
      return conflict(
        current,
        'invalid-transition',
        'Every observed claim must be independently validated',
      );
    }
    next.outcome = clone(event.outcome);
    next.phase = 'terminal';
    denyFutureGrants(next, effects, 'terminal', `${event.eventId}:deny-grants`);
  }
  if (event.kind !== 'observation') {
    next.commands.push({
      eventId: event.eventId,
      canonicalDigest: input.canonicalDigest,
    });
  }
  return { status: 'applied', state: next, effects };
}
