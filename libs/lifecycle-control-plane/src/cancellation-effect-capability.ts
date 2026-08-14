import { utcDateTimeSchema } from '@agent-lcars/dispatch-contracts';

const verified = new WeakSet<object>();

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

export interface CancellationEffectClock {
  now(): string;
}

/** Nominal handoff minted only from a storage-claimed durable Task effect. */
export interface VerifiedCancellationEffect {
  readonly tenantId: string;
  readonly task: {
    tenantId: string;
    repositoryId: number;
    issueNumber: number;
  };
  readonly sourceFactId: string;
  readonly effectKey: string;
  readonly canonicalDigest: string;
  readonly claimFence: number;
  readonly claimToken: string;
  readonly kind: 'cancel-unlaunched' | 'cancel-or-drain';
  readonly at: string;
}

export function isVerifiedCancellationEffect(
  value: unknown,
): value is VerifiedCancellationEffect {
  return value !== null && typeof value === 'object' && verified.has(value);
}

/** Internal coordinator mint; never exported through the package barrel. */
export function mintVerifiedCancellationEffect(
  input: Omit<VerifiedCancellationEffect, 'at'>,
  clock: CancellationEffectClock,
): VerifiedCancellationEffect {
  const at = utcDateTimeSchema.safeParse(clock.now());
  if (!at.success) throw new Error('Cancellation authority clock is invalid');
  const value = frozenClone({ ...input, at: at.data });
  verified.add(value);
  return value;
}
