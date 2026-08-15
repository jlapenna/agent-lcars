import 'server-only';

import type {
  LifecycleAuthorityStorage,
  TaskAuthorityLease,
  WriteResult,
} from './authority-storage';
import {
  MarkLostBoundary,
  type MarkLostClock,
  markLostLeaseFence,
} from './mark-lost-capability';
import {
  RunStuckObservationBoundary,
  type RunStuckVerifier,
  validateMarkLostEligibility,
} from './mark-lost-eligibility';

/** Dependencies of the inactive server-only mark-lost composition. */
export interface MarkLostCompositionDependencies {
  storage: LifecycleAuthorityStorage;
  verifier: RunStuckVerifier;
  clock: MarkLostClock;
}

/**
 * No provider client, route, or scheduler is activated here. A future trusted
 * server caller supplies the current head, its fact history, and candidate
 * run-stuck evidence; the boundaries mint the only capabilities the storage
 * transaction accepts, and storage still re-checks all of it against its own
 * durable state.
 */
export class MarkLostComposition {
  private readonly observations: RunStuckObservationBoundary;
  private readonly boundary: MarkLostBoundary;

  constructor(private readonly dependencies: MarkLostCompositionDependencies) {
    this.observations = new RunStuckObservationBoundary(dependencies.verifier);
    this.boundary = new MarkLostBoundary(dependencies.clock);
  }

  async terminate(input: {
    lease: TaskAuthorityLease;
    receiptId: string;
    idempotencyKey: string;
    authority: {
      authorityEpoch: number;
      attemptRevision: number;
      launchOperationId: string;
      executionEpoch: number;
    };
    task: unknown;
    head: unknown;
    baselineFactRef: unknown;
    factHistory: readonly unknown[];
    candidates: readonly unknown[];
  }): Promise<WriteResult> {
    const observations = input.candidates.map((candidate) =>
      this.observations.verify({ candidate }),
    );
    const receipt = validateMarkLostEligibility({
      schema: 'agent-lcars.mark-lost-eligibility-request/v1',
      version: 1,
      receiptId: input.receiptId,
      idempotencyKey: input.idempotencyKey,
      // The receipt is pinned to this exact lease incarnation; storage
      // recomputes the same token from the lease it commits under.
      authority: { ...input.authority, fence: markLostLeaseFence(input.lease) },
      task: input.task,
      head: input.head,
      baselineFactRef: input.baselineFactRef,
      factHistory: input.factHistory,
      observations,
    });
    const termination = this.boundary.verify({
      receipt,
      lease: input.lease,
    });
    return this.dependencies.storage.terminateLostAttempt({
      lease: input.lease,
      termination,
    });
  }
}
