import type {
  CancellationEffectResult,
  LifecycleAuthorityStorage,
  TaskAuthorityLease,
  TaskAuthorityScope,
} from './authority-storage';
import {
  type CancellationEffectClock,
  mintVerifiedCancellationEffect,
} from './cancellation-effect-capability';

/** Trusted clock injected by the inactive cancellation coordinator. */
export type { CancellationEffectClock } from './cancellation-effect-capability';

/** Inactive coordinator: records cancellation truth/work, never delivers it. */
export class CancellationTaskEffectCoordinator {
  constructor(
    private readonly storage: LifecycleAuthorityStorage,
    private readonly clock: CancellationEffectClock,
  ) {}

  async reconcile(input: {
    lease: TaskAuthorityLease;
    tenantId: string;
    task: TaskAuthorityScope;
    sourceFactId: string;
    effectKey: string;
  }): Promise<CancellationEffectResult> {
    const effect = await this.storage.readTaskEffect(input);
    if (effect === undefined) throw new Error('Task effect is unknown');
    if (
      effect.payload.kind !== 'cancel-unlaunched' &&
      effect.payload.kind !== 'cancel-or-drain'
    )
      return { effect };
    const claim = await this.storage.claimTaskEffect(input);
    if (claim.status === 'terminal') {
      const receipt = await this.storage.readCancellationReceipt(input);
      if (receipt !== undefined) return receipt;
      return { effect: claim.effect };
    }
    if (
      claim.effect.deliveryState !== 'working' ||
      claim.effect.claimToken === undefined
    )
      return { effect: claim.effect };
    const payload = claim.effect.payload;
    if (
      payload.kind !== 'cancel-unlaunched' &&
      payload.kind !== 'cancel-or-drain'
    ) {
      return { effect: claim.effect };
    }
    const result = await this.storage.applyVerifiedCancellationEffect({
      lease: input.lease,
      cancellation: mintVerifiedCancellationEffect(
        {
          tenantId: input.tenantId,
          task: input.task,
          sourceFactId: input.sourceFactId,
          effectKey: input.effectKey,
          canonicalDigest: claim.effect.canonicalDigest,
          claimFence: input.lease.fence,
          claimToken: claim.effect.claimToken as string,
          kind: payload.kind,
        },
        this.clock,
      ),
    });
    return result;
  }
}
