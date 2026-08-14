import 'server-only';

import type {
  LaunchOutboxRecord,
  LifecycleAuthorityStorage,
  TaskAuthorityScope,
  WriteResult,
} from './authority-storage';
import {
  type LaunchResolutionClock,
  LaunchResolutionCoordinator,
} from './launch-resolution';
import type { LaunchResponseBoundary } from './launch-resolution-capability';
import type { TaskLeaseRunner } from './signal-task-composition';

/** Dependencies owned by the inactive server-side launch-outbox worker. */
export interface LaunchOutboxCompositionDependencies {
  storage: LifecycleAuthorityStorage;
  /** The provider-neutral boundary; it is never exposed to callers. */
  responses: LaunchResponseBoundary;
  leases: TaskLeaseRunner;
  clock: LaunchResolutionClock;
}

export interface LaunchOutboxCompositionInput {
  tenantId: string;
  task: TaskAuthorityScope;
  attemptId: string;
}

/** Public durable receipt; storage claim fences/tokens are never returned. */
export type LaunchOutboxReceipt = Omit<
  LaunchOutboxRecord,
  'claimedFence' | 'claimToken'
>;

/**
 * Durable result of one outbox reconciliation.  A claimed work item is
 * resolved before the result is returned; replay and terminal claims return
 * the existing durable record without crossing the response boundary.
 */
export type LaunchOutboxReconcileResult =
  | {
      status: 'resolved';
      launch: LaunchOutboxReceipt;
      write: WriteResult;
    }
  | {
      status: 'replay' | 'terminal';
      launch: LaunchOutboxReceipt;
    };

export class LaunchOutboxCompositionConflict extends Error {
  override name = 'LaunchOutboxCompositionConflict';
}

function validateInput(input: LaunchOutboxCompositionInput): void {
  if (
    typeof input.tenantId !== 'string' ||
    input.tenantId.length === 0 ||
    input.tenantId !== input.task.tenantId ||
    !Number.isSafeInteger(input.task.repositoryId) ||
    input.task.repositoryId <= 0 ||
    !Number.isSafeInteger(input.task.issueNumber) ||
    input.task.issueNumber <= 0 ||
    !/^[A-Za-z0-9_-]{22,64}$/u.test(input.attemptId)
  ) {
    throw new LaunchOutboxCompositionConflict(
      'Launch identity is invalid or crosses tenant scope',
    );
  }
}

function receipt(record: LaunchOutboxRecord): LaunchOutboxReceipt {
  return {
    operationId: record.operationId,
    attemptId: record.attemptId,
    tenantId: record.tenantId,
    repositoryId: record.repositoryId,
    issueNumber: record.issueNumber,
    executionEpoch: record.executionEpoch,
    state: record.state,
  };
}

/**
 * Inactive server-owned worker for one durable launch outbox operation.
 *
 * Callers provide only tenant-scoped identity. The injected lease runner owns
 * acquisition and release, while storage owns the launch capability and the
 * coordinator owns the dispatch/reconcile response decision. This class has
 * no provider client and never accepts a caller-supplied lease or capability.
 */
export class LaunchOutboxComposition {
  private readonly resolution: LaunchResolutionCoordinator;

  constructor(
    private readonly dependencies: LaunchOutboxCompositionDependencies,
  ) {
    this.resolution = new LaunchResolutionCoordinator(
      dependencies.storage,
      dependencies.responses,
      dependencies.clock,
    );
  }

  async reconcile(
    input: LaunchOutboxCompositionInput,
  ): Promise<LaunchOutboxReconcileResult> {
    validateInput(input);
    const attempt = await this.dependencies.storage.readAttempt({
      tenantId: input.tenantId,
      attemptId: input.attemptId,
    });
    if (
      attempt === undefined ||
      attempt.spec.task.tenantId !== input.task.tenantId ||
      attempt.spec.task.repositoryId !== input.task.repositoryId ||
      attempt.spec.task.issueNumber !== input.task.issueNumber
    ) {
      throw new LaunchOutboxCompositionConflict(
        'Launch Attempt does not match the supplied task identity',
      );
    }
    return this.dependencies.leases.run(input.task, async (lease) => {
      const claim = await this.dependencies.storage.claimLaunchWork({
        lease,
        tenantId: input.tenantId,
        attemptId: input.attemptId,
      });
      if (claim.status !== 'claimed') {
        const launch = await this.dependencies.storage.readLaunch({
          tenantId: input.tenantId,
          attemptId: input.attemptId,
        });
        if (launch === undefined) {
          throw new LaunchOutboxCompositionConflict(
            'Launch claim did not have a durable outbox record',
          );
        }
        return { status: claim.status, launch: receipt(launch) };
      }
      if (claim.work === undefined) {
        throw new LaunchOutboxCompositionConflict(
          'Claimed launch work is missing its capability',
        );
      }

      const write = await this.resolution.resolve({
        lease,
        work: claim.work,
      });
      const launch = await this.dependencies.storage.readLaunch({
        tenantId: input.tenantId,
        attemptId: input.attemptId,
      });
      if (launch === undefined) {
        throw new LaunchOutboxCompositionConflict(
          'Resolved launch is missing its durable outbox record',
        );
      }
      return { status: 'resolved', launch: receipt(launch), write };
    });
  }
}
