import 'server-only';

import type {
  LifecycleAuthorityStorage,
  TaskAuthorityLease,
  TaskAuthorityScope,
} from './authority-storage';
import type {
  AdmissionPlanResolver,
  TaskAttemptAdmissionCoordinator,
} from './task-attempt-admission';
import { TaskAttemptAdmissionCoordinator as AdmissionCoordinator } from './task-attempt-admission';
import type {
  AdmissionTaskEffectCoordinator,
  TaskEffectReconcileResult,
} from './task-effects';
import { AdmissionTaskEffectCoordinator as EffectCoordinator } from './task-effects';

export interface TaskEffectLeaseRunner {
  run<T>(
    scope: TaskAuthorityScope,
    operation: (lease: TaskAuthorityLease) => Promise<T>,
  ): Promise<T>;
}

export interface TaskAdmissionEffectCompositionDependencies {
  storage: LifecycleAuthorityStorage;
  plans: AdmissionPlanResolver;
  leases: TaskEffectLeaseRunner;
}

export interface TaskAdmissionEffectInput {
  tenantId: string;
  task: TaskAuthorityScope;
  sourceFactId: string;
  effectKey: string;
}

export class TaskAdmissionEffectCompositionConflict extends Error {
  override name = 'TaskAdmissionEffectCompositionConflict';
}

/**
 * Inactive server-owned worker for durable admit-attempt effects. It owns the
 * task lease and stops after the atomic Attempt/launch-outbox admission.
 */
export class TaskAdmissionEffectComposition {
  private readonly effects: AdmissionTaskEffectCoordinator;

  constructor(
    private readonly dependencies: TaskAdmissionEffectCompositionDependencies,
  ) {
    const admission: TaskAttemptAdmissionCoordinator = new AdmissionCoordinator(
      dependencies.storage,
      dependencies.plans,
    );
    this.effects = new EffectCoordinator(dependencies.storage, admission);
  }

  async reconcile(
    input: TaskAdmissionEffectInput,
  ): Promise<TaskEffectReconcileResult> {
    if (
      input.tenantId.length === 0 ||
      input.tenantId !== input.task.tenantId ||
      input.sourceFactId.length === 0 ||
      input.effectKey.length === 0
    ) {
      throw new TaskAdmissionEffectCompositionConflict(
        'Task effect identity is invalid or crosses tenant scope',
      );
    }
    return this.dependencies.leases.run(input.task, (lease) =>
      this.effects.reconcile({ ...input, lease }),
    );
  }
}
