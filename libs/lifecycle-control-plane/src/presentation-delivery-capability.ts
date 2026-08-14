import {
  type AttemptPresentationPlan,
  attemptPresentationPlanSchema,
  type TaskPresentationPlan,
  taskPresentationPlanSchema,
  utcDateTimeSchema,
} from '@agent-lcars/dispatch-contracts';

const SHA256 = /^[a-f0-9]{64}$/u;
const claimedWorks = new WeakSet<object>();
const resolutions = new WeakSet<object>();

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

interface ClaimedPresentationWorkBase {
  readonly tenantId: string;
  readonly repositoryId: number;
  readonly issueNumber: number;
  readonly operationId: string;
  readonly planDigest: string;
  readonly claimFence: number;
  readonly claimToken: string;
  readonly permission: 'submit';
}

export type VerifiedClaimedPresentationWork =
  | (ClaimedPresentationWorkBase & {
      readonly source: 'task';
      readonly plan: TaskPresentationPlan;
    })
  | (ClaimedPresentationWorkBase & {
      readonly source: 'attempt';
      readonly attemptId: string;
      readonly plan: AttemptPresentationPlan;
    });

export interface VerifiedPresentationResolution {
  readonly work: VerifiedClaimedPresentationWork;
  readonly kind: 'converged' | 'unknown';
  readonly receiptSha256: string;
  readonly resolvedAt: string;
}

export interface PresentationReceiver {
  receive(
    work: VerifiedClaimedPresentationWork,
  ): Promise<{ receiptSha256: string }>;
}

export interface PresentationClock {
  now(): string;
}

export function isVerifiedClaimedPresentationWork(
  value: unknown,
): value is VerifiedClaimedPresentationWork {
  return value !== null && typeof value === 'object' && claimedWorks.has(value);
}

export function isVerifiedPresentationResolution(
  value: unknown,
): value is VerifiedPresentationResolution {
  return value !== null && typeof value === 'object' && resolutions.has(value);
}

/** Storage-only mint. This module is not the public package entrypoint. */
export function mintClaimedPresentationWork(
  input: VerifiedClaimedPresentationWork,
): VerifiedClaimedPresentationWork {
  const planParsed =
    input.source === 'task'
      ? taskPresentationPlanSchema.safeParse(input.plan)
      : attemptPresentationPlanSchema.safeParse(input.plan);
  const attemptMatches =
    input.source === 'task' || input.attemptId === input.plan.attemptId;
  if (
    !planParsed.success ||
    !SHA256.test(input.planDigest) ||
    !Number.isSafeInteger(input.claimFence) ||
    input.claimFence < 1 ||
    input.claimToken.length === 0 ||
    input.permission !== 'submit' ||
    input.plan.operationId !== input.operationId ||
    input.plan.tenant.tenantId !== input.tenantId ||
    input.plan.task.tenantId !== input.tenantId ||
    input.plan.task.repositoryId !== input.repositoryId ||
    input.plan.task.issueNumber !== input.issueNumber ||
    !attemptMatches
  ) {
    throw new Error('Invalid presentation delivery work');
  }
  const value = frozenClone(input);
  claimedWorks.add(value);
  return value;
}

function mintPresentationResolution(
  input: VerifiedPresentationResolution,
): VerifiedPresentationResolution {
  if (
    !isVerifiedClaimedPresentationWork(input.work) ||
    typeof input.receiptSha256 !== 'string' ||
    !SHA256.test(input.receiptSha256) ||
    !utcDateTimeSchema.safeParse(input.resolvedAt).success
  ) {
    throw new Error('Invalid presentation delivery resolution');
  }
  const value = frozenClone(input);
  resolutions.add(value);
  return value;
}

/**
 * Trusted receiver boundary. It never leaks provider errors or responses into
 * durable state: any post-begin ambiguity becomes a closed unknown result.
 */
export class PresentationDeliveryBoundary {
  constructor(
    private readonly receiver: PresentationReceiver,
    private readonly clock: PresentationClock,
  ) {}

  async receive(
    work: VerifiedClaimedPresentationWork,
  ): Promise<VerifiedPresentationResolution> {
    if (!isVerifiedClaimedPresentationWork(work)) {
      throw new Error('Presentation work is not trusted');
    }
    const resolvedAt = this.clock.now();
    if (!utcDateTimeSchema.safeParse(resolvedAt).success) {
      throw new Error('Presentation delivery clock is invalid');
    }
    try {
      const result = await this.receiver.receive(work);
      return mintPresentationResolution({
        work,
        kind: 'converged',
        receiptSha256: result.receiptSha256,
        resolvedAt,
      });
    } catch {
      return mintUnknownPresentationResolution(work, resolvedAt);
    }
  }
}

/** Internal uncertainty result; intentionally not re-exported by the barrel. */
export function mintUnknownPresentationResolution(
  work: VerifiedClaimedPresentationWork,
  resolvedAt: string,
): VerifiedPresentationResolution {
  return mintPresentationResolution({
    work,
    kind: 'unknown',
    receiptSha256: '0'.repeat(64),
    resolvedAt,
  });
}
