import { createHash } from 'node:crypto';

import type {
  EvidenceValidation,
  RuntimeObservationEnvelope,
} from '@agent-lcars/dispatch-contracts';
import {
  hasValidRuntimeObservationPayloadDigest,
  runtimeObservationEnvelopeSchema,
  runtimeObservationPayloadSha256,
  utcDateTimeSchema,
} from '@agent-lcars/dispatch-contracts';

import type { AttemptState } from './attempt-reducer';

const verifiedTerminalObservations = new WeakSet<object>();
const verifiedClaimObservations = new WeakSet<object>();
const verifiedTransitions = new WeakSet<object>();

export class TerminalFinalizerConflict extends Error {
  override name = 'TerminalFinalizerConflict';
}

function frozenClone<T>(value: T): T {
  const freeze = (child: unknown): unknown => {
    if (child !== null && typeof child === 'object') {
      for (const value of Object.values(child)) freeze(value);
      Object.freeze(child);
    }
    return child;
  };
  return freeze(structuredClone(value)) as T;
}

export interface TerminalRunAttestationVerifier {
  /** Returns policy/provider-owned time facts; callers cannot select them. */
  verifyTerminal(input: { envelope: RuntimeObservationEnvelope }): Promise<{
    observedAt: string;
    finalizationDeadline: string;
  }>;
  /** Authenticates the source/transport, never the asserted deliverable. */
  verifyClaim(input: {
    envelope: RuntimeObservationEnvelope;
  }): Promise<{ observedAt: string }>;
}

export interface VerifiedTerminalObservation {
  readonly envelope: RuntimeObservationEnvelope;
  readonly finalizationDeadline: string;
}

export interface VerifiedClaimObservation {
  readonly envelope: RuntimeObservationEnvelope;
}

export type VerifiedFinalizationObservation =
  VerifiedTerminalObservation | VerifiedClaimObservation;

export function isVerifiedTerminalObservation(
  value: unknown,
): value is VerifiedTerminalObservation {
  return (
    value !== null &&
    typeof value === 'object' &&
    verifiedTerminalObservations.has(value)
  );
}

export function isVerifiedClaimObservation(
  value: unknown,
): value is VerifiedClaimObservation {
  return (
    value !== null &&
    typeof value === 'object' &&
    verifiedClaimObservations.has(value)
  );
}

export function isVerifiedFinalizationObservation(
  value: unknown,
): value is VerifiedFinalizationObservation {
  return (
    isVerifiedTerminalObservation(value) || isVerifiedClaimObservation(value)
  );
}

/** Nominal boundary for provider-attested terminal execution facts. */
export class TerminalObservationBoundary {
  constructor(private readonly verifier: TerminalRunAttestationVerifier) {}

  async verify(input: {
    envelope: unknown;
  }): Promise<VerifiedTerminalObservation> {
    const parsed = runtimeObservationEnvelopeSchema.safeParse(input.envelope);
    if (
      !parsed.success ||
      parsed.data.payload.kind !== 'run-terminal' ||
      !(await hasValidRuntimeObservationPayloadDigest(parsed.data))
    ) {
      throw new TerminalFinalizerConflict('Terminal observation is invalid');
    }
    const attestation = await this.verifier.verifyTerminal({
      envelope: frozenClone(parsed.data),
    });
    const observedAt = utcDateTimeSchema.safeParse(attestation.observedAt);
    const deadline = utcDateTimeSchema.safeParse(
      attestation.finalizationDeadline,
    );
    if (
      !observedAt.success ||
      !deadline.success ||
      Date.parse(deadline.data) <= Date.parse(observedAt.data)
    ) {
      throw new TerminalFinalizerConflict('Terminal attestation is invalid');
    }
    const payload = {
      ...parsed.data.payload,
      observedAt: observedAt.data,
    };
    const value = frozenClone({
      envelope: {
        ...parsed.data,
        observedAt: observedAt.data,
        payload,
        payloadSha256: await runtimeObservationPayloadSha256(payload),
      },
      finalizationDeadline: deadline.data,
    });
    verifiedTerminalObservations.add(value);
    return value;
  }
}

/** Authenticates claim transport without treating the claim as evidence. */
export class ClaimObservationBoundary {
  constructor(private readonly verifier: TerminalRunAttestationVerifier) {}

  async parse(input: { envelope: unknown }): Promise<VerifiedClaimObservation> {
    const parsed = runtimeObservationEnvelopeSchema.safeParse(input.envelope);
    if (
      !parsed.success ||
      parsed.data.payload.kind !== 'agent-result-claim' ||
      !(await hasValidRuntimeObservationPayloadDigest(parsed.data))
    ) {
      throw new TerminalFinalizerConflict('Claim observation is invalid');
    }
    const attestation = await this.verifier.verifyClaim({
      envelope: frozenClone(parsed.data),
    });
    const observedAt = utcDateTimeSchema.safeParse(attestation.observedAt);
    if (!observedAt.success) {
      throw new TerminalFinalizerConflict('Claim attestation is invalid');
    }
    const value = frozenClone({
      envelope: { ...parsed.data, observedAt: observedAt.data },
    });
    verifiedClaimObservations.add(value);
    return value;
  }
}

export type FinalizationVerdict =
  | { readonly status: 'validated' }
  | {
      readonly status: 'rejected';
      readonly reason: 'marker-mismatch' | 'reference-mismatch';
    };

/** Opaque commands accepted by the finalization storage transaction. */
export type VerifiedFinalizationTransition =
  | {
      readonly kind: 'observation';
      readonly tenantId: string;
      readonly attemptId: string;
      readonly at: string;
      readonly observation: VerifiedFinalizationObservation;
    }
  | {
      readonly kind: 'start-validation';
      readonly tenantId: string;
      readonly attemptId: string;
      readonly at: string;
    }
  | {
      readonly kind: 'validate-claim';
      readonly tenantId: string;
      readonly attemptId: string;
      readonly claimFactId: string;
      readonly validationFactId: string;
      readonly at: string;
      readonly verdict: FinalizationVerdict;
    }
  | {
      readonly kind: 'finalize';
      readonly tenantId: string;
      readonly attemptId: string;
      readonly eventId: string;
      readonly at: string;
    };

export function isVerifiedFinalizationTransition(
  value: unknown,
): value is VerifiedFinalizationTransition {
  return (
    value !== null &&
    typeof value === 'object' &&
    verifiedTransitions.has(value)
  );
}

export function finalizationCommandId(...parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

/** Internal coordinator seam; not re-exported by the public package barrel. */
export function mintFinalizationTransition(
  input: VerifiedFinalizationTransition,
): VerifiedFinalizationTransition {
  if (
    !utcDateTimeSchema.safeParse(input.at).success ||
    (input.kind === 'observation' &&
      !isVerifiedFinalizationObservation(input.observation))
  ) {
    throw new TerminalFinalizerConflict('Finalization transition is invalid');
  }
  const value = frozenClone(input);
  verifiedTransitions.add(value);
  return value;
}

export function validationForVerdict(input: {
  verdict: FinalizationVerdict;
  validationFactId: string;
  validatedAt: string;
}): Extract<EvidenceValidation, { status: 'validated' | 'rejected' }> {
  return input.verdict.status === 'validated'
    ? {
        status: 'validated',
        validationFactId: input.validationFactId,
        validatedAt: input.validatedAt,
      }
    : {
        status: 'rejected',
        reason: input.verdict.reason,
        validationFactId: input.validationFactId,
        validatedAt: input.validatedAt,
      };
}

export function attemptHasCommand(
  state: AttemptState,
  eventId: string,
): boolean {
  return state.commands.some((command) => command.eventId === eventId);
}
