import type {
  LifecycleAuthorityStorage,
  TaskAuthorityLease,
  WriteResult,
} from './authority-storage';
import {
  isVerifiedClaimedLaunchWork,
  type LaunchResolutionClock,
  LaunchResponseBoundary,
  mintUnknownLaunchReconciliation,
  type VerifiedClaimedLaunchWork,
} from './launch-resolution-capability';

export {
  type LaunchResolutionClock,
  LaunchResponseBoundary,
  type TrustedLaunchResponseVerifier,
  type VerifiedClaimedLaunchWork,
  type VerifiedLaunchResolution,
} from './launch-resolution-capability';

/** Inactive composition seam; it has no provider client of its own. */
export class LaunchResolutionCoordinator {
  constructor(
    private readonly storage: LifecycleAuthorityStorage,
    private readonly responses: LaunchResponseBoundary,
    private readonly clock: LaunchResolutionClock,
  ) {}

  async resolve(input: {
    lease: TaskAuthorityLease;
    work: VerifiedClaimedLaunchWork;
  }): Promise<WriteResult> {
    if (!isVerifiedClaimedLaunchWork(input.work)) {
      throw new Error('Launch work was not minted by storage');
    }
    if (input.work.permission === 'reconcile-unknown') {
      return this.storage.resolveVerifiedLaunch({
        lease: input.lease,
        resolution: mintUnknownLaunchReconciliation({
          work: input.work,
          resolvedAt: this.clock.now(),
        }),
      });
    }
    const resolution = await this.responses.resolve(input.work);
    return this.storage.resolveVerifiedLaunch({
      lease: input.lease,
      resolution,
    });
  }
}
