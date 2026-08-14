import type {
  AcceptedAttemptSpec,
  ActivationProvenance,
  CanonicalTaskIdentity,
  TenantRef,
} from '@agent-lcars/dispatch-contracts';

const verifiedAdmissions = new WeakSet<object>();

/**
 * Opaque coordinator-to-storage handoff. It is not a client request and is
 * deliberately not exported from the package barrel.
 */
export interface VerifiedAttemptAdmission {
  readonly tenant: TenantRef;
  readonly task: CanonicalTaskIdentity;
  readonly expectedTaskRevision: number;
  readonly intentId: string;
  readonly intentRevision: number;
  readonly activation: ActivationProvenance;
  readonly execution: AcceptedAttemptSpec['execution'];
}

export function isVerifiedAttemptAdmission(
  value: unknown,
): value is VerifiedAttemptAdmission {
  return (
    value !== null && typeof value === 'object' && verifiedAdmissions.has(value)
  );
}

function frozenClone<T>(value: T): T {
  const freeze = (child: unknown): unknown => {
    if (child !== null && typeof child === 'object') {
      for (const nested of Object.values(child)) freeze(nested);
      Object.freeze(child);
    }
    return child;
  };
  return freeze(structuredClone(value)) as T;
}

/** Internal server coordinator seam; never exported through index.ts. */
export function mintAttemptAdmission(input: {
  tenant: TenantRef;
  task: CanonicalTaskIdentity;
  expectedTaskRevision: number;
  intentId: string;
  intentRevision: number;
  activation: ActivationProvenance;
  execution: AcceptedAttemptSpec['execution'];
}): VerifiedAttemptAdmission {
  const value = frozenClone(input);
  verifiedAdmissions.add(value);
  return value;
}
