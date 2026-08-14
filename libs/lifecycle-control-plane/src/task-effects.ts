import type {
  ActivationRecord,
  ControlPlaneSignalEnvelope,
  PolicyDecision,
} from '@agent-lcars/dispatch-contracts';

import type {
  AdmissionResult,
  LifecycleAuthorityStorage,
  TaskAuthorityLease,
  TaskAuthorityScope,
  TaskEffectRecord,
  TaskEffectTransitionResult,
} from './authority-storage';
import { TaskAttemptAdmissionCoordinator } from './task-attempt-admission';
import {
  mintAdmissionEffectCompletion,
  mintTaskEffectObsoletion,
  mintTaskEffectTransition,
  type TaskEffectClock,
} from './task-effect-capability';
import type { TaskIntentEffect } from './task-intent-reducer';
import type { IntentCandidate } from './task-intent-reducer';

/**
 * Server-only ingress composition: it owns the trusted time and canonical
 * digest before handing a nominal reducer command to storage.  Authentication
 * and policy evaluation are upstream; this coordinator never performs effects.
 */
export class TaskEffectTransitionCoordinator {
  constructor(
    private readonly storage: LifecycleAuthorityStorage,
    private readonly clock: TaskEffectClock,
  ) {}

  async apply(input: {
    lease: TaskAuthorityLease;
    expectedRevision: number;
    envelope: ControlPlaneSignalEnvelope;
    policyDecision: PolicyDecision;
    activation: ActivationRecord;
    candidate?: IntentCandidate;
  }): Promise<TaskEffectTransitionResult> {
    return this.storage.applyTaskEffectTransition({
      lease: input.lease,
      transition: mintTaskEffectTransition(input, this.clock),
    });
  }
}

export type TaskEffectReconcileResult =
  | { status: 'deferred'; effect: TaskEffectRecord }
  | {
      status: 'completed';
      effect: TaskEffectRecord;
      admission: AdmissionResult;
    };

/**
 * Inactive worker seam.  It has no provider client: only the reducer's
 * admit-attempt work is consumed, and its durable admission receipt is
 * written before the effect is completed.
 */
export class AdmissionTaskEffectCoordinator {
  constructor(
    private readonly storage: LifecycleAuthorityStorage,
    private readonly admissions: TaskAttemptAdmissionCoordinator,
  ) {}

  async reconcile(input: {
    lease: TaskAuthorityLease;
    tenantId: string;
    task: TaskAuthorityScope;
    sourceFactId: string;
    effectKey: string;
  }): Promise<TaskEffectReconcileResult> {
    const effect = await this.storage.readTaskEffect(input);
    if (effect === undefined) throw new Error('Task effect is unknown');
    if (
      effect.deliveryState === 'obsolete' ||
      effect.deliveryState === 'complete'
    ) {
      return { status: 'deferred', effect };
    }
    if (effect.payload.kind !== 'admit-attempt') {
      return { status: 'deferred', effect };
    }
    const claim = await this.storage.claimTaskEffect(input);
    const claimed = claim.effect;
    // A later fence may have completed it while this worker was scheduling.
    if (
      claimed.deliveryState === 'complete' ||
      claimed.deliveryState === 'obsolete'
    ) {
      return { status: 'deferred', effect: claimed };
    }
    const admissionEffect = claimed.payload;
    if (admissionEffect.kind !== 'admit-attempt') {
      return { status: 'deferred', effect: claimed };
    }
    if (claim.status === 'replay') {
      const receipt = await this.storage.readAttemptAdmission({
        lease: input.lease,
        tenantId: input.tenantId,
        task: input.task,
        intentId: admissionEffect.intentId,
        intentRevision: admissionEffect.intentRevision,
      });
      if (receipt?.attempt === undefined) {
        return { status: 'deferred', effect: claimed };
      }
      const completed = await this.storage.completeTaskEffect({
        lease: input.lease,
        completion: mintAdmissionEffectCompletion({
          ...input,
          attemptId: receipt.attempt.spec.attemptId,
          claimToken: claimed.claimToken as string,
        }),
      });
      return { status: 'completed', effect: completed, admission: receipt };
    }
    const task = await this.storage.readTask(input.task);
    const currentIntent =
      task?.attempt.kind === 'unlaunched'
        ? task.attempt.intentId === admissionEffect.intentId &&
          task.desired?.intentId === admissionEffect.intentId &&
          task.desired.intentRevision === admissionEffect.intentRevision
        : task?.attempt.kind === 'launched'
          ? task.attempt.intentId === admissionEffect.intentId &&
            task.attempt.intentRevision === admissionEffect.intentRevision
          : false;
    if (!currentIntent) {
      const obsolete = await this.storage.obsoleteTaskEffect({
        lease: input.lease,
        obsoletion: mintTaskEffectObsoletion({
          ...input,
          claimToken: claimed.claimToken as string,
          reason: 'superseded',
        }),
      });
      return { status: 'deferred', effect: obsolete };
    }
    if (
      task?.attempt.kind === 'unlaunched' &&
      !(await this.storage.mayWriteEffects({
        scope: {
          ...input.task,
          taskClassId: admissionEffect.activation.taskClassId,
        },
        activation: admissionEffect.activation,
        boundary: task.revision,
      }))
    ) {
      const obsolete = await this.storage.obsoleteTaskEffect({
        lease: input.lease,
        obsoletion: mintTaskEffectObsoletion({
          ...input,
          claimToken: claimed.claimToken as string,
          reason: 'activation-no-longer-authoritative',
        }),
      });
      return { status: 'deferred', effect: obsolete };
    }
    const admission = await this.admissions.admit({
      lease: input.lease,
      tenantId: input.tenantId,
      task: input.task,
      intentId: admissionEffect.intentId,
      intentRevision: admissionEffect.intentRevision,
    });
    if (admission.attempt === undefined) {
      throw new Error('Admission receipt did not contain an Attempt');
    }
    const completed = await this.storage.completeTaskEffect({
      lease: input.lease,
      completion: mintAdmissionEffectCompletion({
        ...input,
        attemptId: admission.attempt.spec.attemptId,
        claimToken: claimed.claimToken as string,
      }),
    });
    return { status: 'completed', effect: completed, admission };
  }
}

export function isAdmissionEffect(
  effect: TaskIntentEffect,
): effect is Extract<TaskIntentEffect, { kind: 'admit-attempt' }> {
  return effect.kind === 'admit-attempt';
}
