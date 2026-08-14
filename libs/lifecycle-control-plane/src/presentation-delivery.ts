import type {
  LifecycleAuthorityStorage,
  PresentationDeliveryRecord,
  PresentationDeliveryTarget,
  TaskAuthorityLease,
} from './authority-storage';
import type { PresentationDeliveryBoundary } from './presentation-delivery-capability';

export {
  type PresentationClock,
  PresentationDeliveryBoundary,
  type PresentationReceiver,
  type VerifiedClaimedPresentationWork,
  type VerifiedPresentationResolution,
} from './presentation-delivery-capability';

/** Inactive composition seam; it performs no provider-specific work itself. */
export class PresentationDeliveryCoordinator {
  constructor(
    private readonly storage: LifecycleAuthorityStorage,
    private readonly boundary: PresentationDeliveryBoundary,
  ) {}

  async deliver(input: {
    lease: TaskAuthorityLease;
    target: PresentationDeliveryTarget;
  }): Promise<PresentationDeliveryRecord> {
    const claim = await this.storage.claimPresentationDelivery(input);
    if (claim.status !== 'claimed' || claim.work === undefined) {
      return claim.record;
    }
    const resolution = await this.boundary.receive(claim.work);
    await this.storage.resolveVerifiedPresentationDelivery({
      lease: input.lease,
      resolution,
    });
    const result = await this.storage.readPresentationDelivery(input.target);
    if (result === undefined) {
      throw new Error('Presentation delivery receipt is missing');
    }
    return result;
  }
}
