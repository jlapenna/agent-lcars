import type { RuntimeObservationEnvelope } from '@agent-lcars/dispatch-contracts';
import {
  hasValidRuntimeObservationPayloadDigest,
  localAttemptMarkerSchema,
  runtimeObservationEnvelopeSchema,
} from '@agent-lcars/dispatch-contracts';

export class RunBindingIngressConflict extends Error {
  override name = 'RunBindingIngressConflict';
}

/** Injected server-only verifier; this module makes no provider calls itself. */
export interface TrustedRunBindingVerifier {
  verifyExactRunBinding(input: {
    envelope: RuntimeObservationEnvelope;
    localAttemptMarker: string;
  }): Promise<void>;
}

const verifiedCapabilities = new WeakSet<object>();

/** Structural lookalikes fail `isVerifiedRunBindingIngress` at the boundary. */
export interface VerifiedRunBindingIngress {
  readonly envelope: RuntimeObservationEnvelope;
  readonly localAttemptMarker: string;
}

export function isVerifiedRunBindingIngress(
  value: unknown,
): value is VerifiedRunBindingIngress {
  return (
    value !== null &&
    typeof value === 'object' &&
    verifiedCapabilities.has(value)
  );
}

function cloneAndFreeze<T>(value: T): T {
  const copy = structuredClone(value);
  const visit = (current: unknown): void => {
    if (
      current !== null &&
      typeof current === 'object' &&
      !Object.isFrozen(current)
    ) {
      for (const child of Object.values(current)) visit(child);
      Object.freeze(current);
    }
  };
  visit(copy);
  return copy;
}

/** Mints the only capability accepted by the run-binding reducer handoff. */
export class RunBindingIngressVerifier {
  constructor(private readonly verifier: TrustedRunBindingVerifier) {}

  async verify(input: {
    envelope: unknown;
    localAttemptMarker: unknown;
  }): Promise<VerifiedRunBindingIngress> {
    const parsedEnvelope = runtimeObservationEnvelopeSchema.safeParse(
      input.envelope,
    );
    const parsedMarker = localAttemptMarkerSchema.safeParse(
      input.localAttemptMarker,
    );
    if (!parsedEnvelope.success || !parsedMarker.success) {
      throw new RunBindingIngressConflict('Run-binding ingress is invalid');
    }
    const envelope = parsedEnvelope.data;
    if (
      envelope.payload.kind !== 'run-bound' ||
      !(await hasValidRuntimeObservationPayloadDigest(envelope))
    ) {
      throw new RunBindingIngressConflict('Run-binding ingress is invalid');
    }
    const capability = cloneAndFreeze({
      envelope,
      localAttemptMarker: parsedMarker.data,
    });
    await this.verifier.verifyExactRunBinding(capability);
    verifiedCapabilities.add(capability);
    return capability;
  }
}
