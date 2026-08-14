import 'server-only';

import type { AttemptState } from './attempt-reducer';
import type {
  CancellationEffectResult,
  CancellationWorkRecord,
  LifecycleAuthorityStorage,
  TaskAuthorityScope,
  TaskEffectRecord,
} from './authority-storage';
import {
  type CancellationEffectClock,
  CancellationTaskEffectCoordinator,
} from './cancellation-effects';
import type { TaskLeaseRunner } from './signal-task-composition';

/** Dependencies owned by the inactive server-side cancellation worker. */
export interface CancellationTaskEffectCompositionDependencies {
  storage: LifecycleAuthorityStorage;
  clock: CancellationEffectClock;
  leases: TaskLeaseRunner;
}

/** Tenant-scoped identity of one durable cancellation effect. */
export interface CancellationTaskEffectInput {
  tenantId: string;
  task: TaskAuthorityScope;
  sourceFactId: string;
  effectKey: string;
}

export interface CancellationAttemptSnapshot {
  attemptId: string;
  revision: number;
  phase: AttemptState['phase'];
  executionEpoch: number;
  futureGrantsDenied: boolean;
  cancellation?: {
    supersededByIntentId?: string;
  };
  outcome?: {
    terminalState: NonNullable<AttemptState['outcome']>['terminalState'];
    execution: NonNullable<AttemptState['outcome']>['execution'];
    result: NonNullable<AttemptState['outcome']>['result'];
    evidenceValidation: NonNullable<
      AttemptState['outcome']
    >['evidenceValidation']['status'];
  };
}

export interface CancellationPresentationSnapshot {
  attemptId: string;
  deliveryState: 'pending';
  terminalState: NonNullable<
    CancellationEffectResult['presentation']
  >['plan']['presentation']['terminalState'];
  execution: NonNullable<
    CancellationEffectResult['presentation']
  >['plan']['presentation']['execution'];
  result: NonNullable<
    CancellationEffectResult['presentation']
  >['plan']['presentation']['result'];
  evidenceValidation: NonNullable<
    CancellationEffectResult['presentation']
  >['plan']['presentation']['evidenceValidation'];
}

export interface CancellationWorkSnapshot {
  attemptId: string;
  executionEpoch: number;
  state: CancellationWorkRecord['state'];
  supersededByIntentId?: string;
}

export type CancellationTaskEffectResult =
  | {
      status: 'deferred';
      deliveryState: TaskEffectRecord['deliveryState'];
    }
  | {
      status: 'completed';
      attempt?: CancellationAttemptSnapshot;
      work?: CancellationWorkSnapshot;
      presentation?: CancellationPresentationSnapshot;
    };

export class CancellationTaskEffectCompositionConflict extends Error {
  override name = 'CancellationTaskEffectCompositionConflict';
}

function sameTask(
  left: TaskAuthorityScope,
  right: TaskAuthorityScope,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.repositoryId === right.repositoryId &&
    left.issueNumber === right.issueNumber
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === [...keys].sort()[index])
  );
}

function validateInput(
  input: unknown,
): asserts input is CancellationTaskEffectInput {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ['tenantId', 'task', 'sourceFactId', 'effectKey'])
  ) {
    throw new CancellationTaskEffectCompositionConflict(
      'Cancellation effect identity is invalid or crosses tenant scope',
    );
  }
  const task = input.task;
  if (
    typeof input.tenantId !== 'string' ||
    input.tenantId.length === 0 ||
    !isRecord(task) ||
    !hasExactKeys(task, ['tenantId', 'repositoryId', 'issueNumber']) ||
    typeof task.tenantId !== 'string' ||
    task.tenantId !== input.tenantId ||
    typeof task.repositoryId !== 'number' ||
    !Number.isSafeInteger(task.repositoryId) ||
    task.repositoryId <= 0 ||
    typeof task.issueNumber !== 'number' ||
    !Number.isSafeInteger(task.issueNumber) ||
    task.issueNumber <= 0 ||
    typeof input.sourceFactId !== 'string' ||
    input.sourceFactId.length === 0 ||
    typeof input.effectKey !== 'string' ||
    input.effectKey.length === 0
  ) {
    throw new CancellationTaskEffectCompositionConflict(
      'Cancellation effect identity is invalid or crosses tenant scope',
    );
  }
}

function publicResult(
  result: CancellationEffectResult,
): CancellationTaskEffectResult {
  const { effect, attempt, work, presentation } = result;
  if (
    effect.payload.kind !== 'cancel-unlaunched' &&
    effect.payload.kind !== 'cancel-or-drain'
  ) {
    return { status: 'deferred', deliveryState: effect.deliveryState };
  }
  if (effect.deliveryState !== 'complete') {
    return { status: 'deferred', deliveryState: effect.deliveryState };
  }
  const safeAttempt =
    attempt === undefined
      ? undefined
      : ({
          attemptId: attempt.spec.attemptId,
          revision: attempt.revision,
          phase: attempt.phase,
          executionEpoch: attempt.executionEpoch,
          futureGrantsDenied: attempt.futureGrantsDenied,
          ...(attempt.cancellation === undefined
            ? {}
            : {
                cancellation: {
                  ...(attempt.cancellation.supersededByIntentId === undefined
                    ? {}
                    : {
                        supersededByIntentId:
                          attempt.cancellation.supersededByIntentId,
                      }),
                },
              }),
          ...(attempt.outcome === undefined
            ? {}
            : {
                outcome: {
                  terminalState: attempt.outcome.terminalState,
                  execution: attempt.outcome.execution,
                  result: attempt.outcome.result,
                  evidenceValidation: attempt.outcome.evidenceValidation.status,
                },
              }),
        } satisfies CancellationAttemptSnapshot);
  const safePresentation =
    presentation === undefined
      ? undefined
      : ({
          attemptId: presentation.plan.attemptId,
          deliveryState: presentation.deliveryState,
          terminalState: presentation.plan.presentation.terminalState,
          execution: presentation.plan.presentation.execution,
          result: presentation.plan.presentation.result,
          evidenceValidation: presentation.plan.presentation.evidenceValidation,
        } satisfies CancellationPresentationSnapshot);
  const safeWork =
    work === undefined
      ? undefined
      : ({
          attemptId: work.attemptId,
          executionEpoch: work.executionEpoch,
          state: work.state,
          ...(work.supersededByIntentId === undefined
            ? {}
            : { supersededByIntentId: work.supersededByIntentId }),
        } satisfies CancellationWorkSnapshot);
  return {
    status: 'completed',
    ...(safeAttempt === undefined ? {} : { attempt: safeAttempt }),
    ...(safeWork === undefined ? {} : { work: safeWork }),
    ...(safePresentation === undefined
      ? {}
      : { presentation: safePresentation }),
  };
}

/**
 * Server-owned cancellation effect worker. The caller supplies only durable
 * tenant-scoped identity; storage and the lease runner own all capabilities.
 * Provider cancellation is deliberately outside this boundary.
 */
export class CancellationTaskEffectComposition {
  private readonly coordinator: CancellationTaskEffectCoordinator;

  constructor(
    private readonly dependencies: CancellationTaskEffectCompositionDependencies,
  ) {
    this.coordinator = new CancellationTaskEffectCoordinator(
      dependencies.storage,
      dependencies.clock,
    );
  }

  async reconcile(
    input: CancellationTaskEffectInput,
  ): Promise<CancellationTaskEffectResult> {
    validateInput(input);
    const effect = await this.dependencies.storage.readTaskEffect(input);
    if (
      effect === undefined ||
      effect.tenantId !== input.tenantId ||
      !sameTask(effect.task, input.task) ||
      effect.sourceFactId !== input.sourceFactId ||
      effect.effectKey !== input.effectKey
    ) {
      throw new CancellationTaskEffectCompositionConflict(
        'Cancellation effect is unknown or its durable identity conflicts',
      );
    }

    const durableInput: CancellationTaskEffectInput = {
      tenantId: effect.tenantId,
      task: {
        tenantId: effect.task.tenantId,
        repositoryId: effect.task.repositoryId,
        issueNumber: effect.task.issueNumber,
      },
      sourceFactId: effect.sourceFactId,
      effectKey: effect.effectKey,
    };
    return this.dependencies.leases.run(durableInput.task, async (lease) => {
      const result = await this.coordinator.reconcile({
        lease,
        ...durableInput,
      });
      return publicResult(result);
    });
  }
}
