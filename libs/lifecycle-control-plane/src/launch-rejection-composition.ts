import 'server-only';

import type {
  LifecycleAuthorityStorage,
  TaskAuthorityLease,
  WriteResult,
} from './authority-storage';
import {
  DefinitiveNoRunBoundary,
  type DefinitiveNoRunProofVerifier,
  type LaunchRejectionClock,
} from './launch-rejection-capability';

/** Dependencies of the inactive server-only launch-rejection composition. */
export interface LaunchRejectionCompositionDependencies {
  storage: LifecycleAuthorityStorage;
  verifier: DefinitiveNoRunProofVerifier;
  clock: LaunchRejectionClock;
}

/**
 * No provider client, route, or scheduler is activated here. A future trusted
 * server caller supplies candidate evidence; the boundary mints the only
 * capability the storage transaction accepts.
 */
export class LaunchRejectionComposition {
  private readonly boundary: DefinitiveNoRunBoundary;

  constructor(
    private readonly dependencies: LaunchRejectionCompositionDependencies,
  ) {
    this.boundary = new DefinitiveNoRunBoundary(
      dependencies.verifier,
      dependencies.clock,
    );
  }

  async reject(input: {
    lease: TaskAuthorityLease;
    proof: unknown;
    expectedAttemptRevision: number;
  }): Promise<WriteResult> {
    const rejection = await this.boundary.verify({
      proof: input.proof,
      expectedAttemptRevision: input.expectedAttemptRevision,
    });
    return this.dependencies.storage.rejectVerifiedLaunch({
      lease: input.lease,
      rejection,
    });
  }
}
