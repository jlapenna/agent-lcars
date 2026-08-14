import 'server-only';

import type {
  LifecycleAuthorityStorage,
  PresentationDeliveryRecord,
  PresentationDeliveryTarget,
  TaskAuthorityScope,
} from './authority-storage';
import {
  type PresentationClock,
  PresentationDeliveryBoundary,
  PresentationDeliveryCoordinator,
  type PresentationReceiver,
} from './presentation-delivery';
import type { TaskLeaseRunner } from './signal-task-composition';

export interface PresentationDeliveryCompositionDependencies {
  storage: LifecycleAuthorityStorage;
  receiver: PresentationReceiver;
  clock: PresentationClock;
  leases: TaskLeaseRunner;
}

export interface PresentationDeliveryCompositionInput {
  target: PresentationDeliveryTarget;
}

export type SanitizedPresentationDeliveryRecord = Omit<
  PresentationDeliveryRecord,
  'claimedFence'
>;

export class PresentationDeliveryCompositionConflict extends Error {
  override name = 'PresentationDeliveryCompositionConflict';
}

function strictTarget(value: unknown): PresentationDeliveryTarget {
  if (value === null || typeof value !== 'object')
    throw new PresentationDeliveryCompositionConflict(
      'Presentation target is invalid',
    );
  const target = value as Record<string, unknown>;
  const task = target.task;
  const targetKeys = Object.keys(target).sort();
  const allowedTargetKeys =
    target.source === 'attempt'
      ? ['attemptId', 'operationId', 'source', 'task', 'tenantId']
      : ['operationId', 'source', 'task', 'tenantId'];
  if (
    (target.source !== 'task' && target.source !== 'attempt') ||
    typeof target.tenantId !== 'string' ||
    target.tenantId.length === 0 ||
    typeof target.operationId !== 'string' ||
    target.operationId.length === 0 ||
    task === null ||
    typeof task !== 'object' ||
    targetKeys.join('\u0000') !== allowedTargetKeys.sort().join('\u0000')
  ) {
    throw new PresentationDeliveryCompositionConflict(
      'Presentation target is invalid',
    );
  }
  const scope = task as Record<string, unknown>;
  if (
    Object.keys(scope).sort().join('\u0000') !==
    ['issueNumber', 'repositoryId', 'tenantId'].join('\u0000')
  ) {
    throw new PresentationDeliveryCompositionConflict(
      'Presentation task scope is invalid',
    );
  }
  if (
    scope.tenantId !== target.tenantId ||
    !Number.isSafeInteger(scope.repositoryId) ||
    (scope.repositoryId as number) <= 0 ||
    !Number.isSafeInteger(scope.issueNumber) ||
    (scope.issueNumber as number) <= 0
  ) {
    throw new PresentationDeliveryCompositionConflict(
      'Presentation target is invalid or crosses tenant scope',
    );
  }
  if (
    target.source === 'attempt' &&
    (typeof target.attemptId !== 'string' || target.attemptId.length === 0)
  ) {
    throw new PresentationDeliveryCompositionConflict(
      'Attempt target is invalid',
    );
  }
  if (target.source === 'task' && 'attemptId' in target) {
    throw new PresentationDeliveryCompositionConflict('Task target is invalid');
  }
  return structuredClone(value) as PresentationDeliveryTarget;
}

function sameTarget(
  target: PresentationDeliveryTarget,
  record: PresentationDeliveryRecord,
): boolean {
  return (
    target.source === record.source &&
    target.tenantId === record.tenantId &&
    target.operationId === record.operationId &&
    (target.source === 'task'
      ? record.attemptId === undefined
      : target.attemptId === record.attemptId) &&
    target.task.tenantId === record.task.tenantId &&
    target.task.repositoryId === record.task.repositoryId &&
    target.task.issueNumber === record.task.issueNumber
  );
}

export class PresentationDeliveryComposition {
  private readonly coordinator: PresentationDeliveryCoordinator;

  constructor(
    private readonly dependencies: PresentationDeliveryCompositionDependencies,
  ) {
    this.coordinator = new PresentationDeliveryCoordinator(
      dependencies.storage,
      new PresentationDeliveryBoundary(
        dependencies.receiver,
        dependencies.clock,
      ),
    );
  }

  async deliver(
    input: PresentationDeliveryCompositionInput,
  ): Promise<SanitizedPresentationDeliveryRecord> {
    const supplied = strictTarget(input?.target);
    const located =
      await this.dependencies.storage.readPresentationDelivery(supplied);
    if (located === undefined || !sameTarget(supplied, located)) {
      throw new PresentationDeliveryCompositionConflict(
        'Presentation delivery target is unknown or does not match durable identity',
      );
    }
    const canonicalTask: TaskAuthorityScope = {
      tenantId: located.task.tenantId,
      repositoryId: located.task.repositoryId,
      issueNumber: located.task.issueNumber,
    };
    const canonical: PresentationDeliveryTarget =
      located.source === 'task'
        ? {
            source: 'task',
            tenantId: located.tenantId,
            task: canonicalTask,
            operationId: located.operationId,
          }
        : {
            source: 'attempt',
            tenantId: located.tenantId,
            task: canonicalTask,
            attemptId: located.attemptId as string,
            operationId: located.operationId,
          };
    const result = await this.dependencies.leases.run(canonicalTask, (lease) =>
      this.coordinator.deliver({ lease, target: canonical }),
    );
    const { claimedFence: _claimedFence, ...sanitized } = result;
    return structuredClone(sanitized);
  }
}
