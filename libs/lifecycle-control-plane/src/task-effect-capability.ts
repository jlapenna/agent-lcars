import type {
  ActivationRecord,
  ControlPlaneSignalEnvelope,
  PolicyDecision,
} from '@agent-lcars/dispatch-contracts';

import {
  type IntentCandidate,
  type ReduceTaskIntentInput,
  taskIntentInputDigest,
} from './task-intent-reducer';

const verifiedTransitions = new WeakSet<object>();
const verifiedCompletions = new WeakSet<object>();
const verifiedObsoletions = new WeakSet<object>();

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

/**
 * Internal authenticated-ingress handoff.  A reducer input is deliberately
 * not a storage command: only a value minted at this boundary can change a
 * Task or create durable effect work.
 */
export interface VerifiedTaskEffectTransition {
  readonly input: ReduceTaskIntentInput;
}

export interface TaskEffectClock {
  now(): string;
}

export function isVerifiedTaskEffectTransition(
  value: unknown,
): value is VerifiedTaskEffectTransition {
  return (
    value !== null &&
    typeof value === 'object' &&
    verifiedTransitions.has(value)
  );
}

/** Not exported from the package barrel; production ingress owns this seam. */
export function mintTaskEffectTransition(
  input: {
    expectedRevision: number;
    envelope: ControlPlaneSignalEnvelope;
    policyDecision: PolicyDecision;
    activation: ActivationRecord;
    candidate?: IntentCandidate;
  },
  clock: TaskEffectClock,
): VerifiedTaskEffectTransition {
  const digestInput = {
    envelope: input.envelope,
    policyDecision: input.policyDecision,
    activation: input.activation,
    ...(input.candidate === undefined ? {} : { candidate: input.candidate }),
  };
  const command: ReduceTaskIntentInput = {
    ...input,
    transitionedAt: clock.now(),
    canonicalDigest: taskIntentInputDigest(digestInput),
  };
  const value = frozenClone({ input: command });
  verifiedTransitions.add(value);
  return value;
}

export interface VerifiedAdmissionEffectCompletion {
  readonly tenantId: string;
  readonly task: {
    tenantId: string;
    repositoryId: number;
    issueNumber: number;
  };
  readonly sourceFactId: string;
  readonly effectKey: string;
  readonly attemptId: string;
  readonly claimToken: string;
}

export function isVerifiedAdmissionEffectCompletion(
  value: unknown,
): value is VerifiedAdmissionEffectCompletion {
  return (
    value !== null &&
    typeof value === 'object' &&
    verifiedCompletions.has(value)
  );
}

export function mintAdmissionEffectCompletion(
  input: VerifiedAdmissionEffectCompletion,
): VerifiedAdmissionEffectCompletion {
  const value = frozenClone(input);
  verifiedCompletions.add(value);
  return value;
}

export interface VerifiedTaskEffectObsoletion {
  readonly tenantId: string;
  readonly task: {
    tenantId: string;
    repositoryId: number;
    issueNumber: number;
  };
  readonly sourceFactId: string;
  readonly effectKey: string;
  readonly claimToken: string;
  readonly reason: 'superseded' | 'activation-no-longer-authoritative';
}

export function isVerifiedTaskEffectObsoletion(
  value: unknown,
): value is VerifiedTaskEffectObsoletion {
  return (
    value !== null &&
    typeof value === 'object' &&
    verifiedObsoletions.has(value)
  );
}

export function mintTaskEffectObsoletion(
  input: VerifiedTaskEffectObsoletion,
): VerifiedTaskEffectObsoletion {
  const value = frozenClone(input);
  verifiedObsoletions.add(value);
  return value;
}
