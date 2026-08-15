import type {
  AttemptPresentationPlan,
  TaskPresentationPlan,
} from '@agent-lcars/dispatch-contracts';

import {
  type AttemptPresentationRecord,
  type PresentationDeliveryRecord,
  type PresentationDeliveryTarget,
  type TaskPresentationRecord,
} from './authority-storage';
import {
  attemptId,
  attemptPlan,
  planDigest,
  type PresentationDeliveryStorageHooks,
  SHA_A,
  SHA_B,
  task,
  taskPlan,
  tenant,
} from './presentation-delivery.spec.support';

type InMemoryPresentationInternals = {
  taskPresentations: Map<string, TaskPresentationRecord>;
  attemptPresentations: Map<string, AttemptPresentationRecord>;
  presentationDeliveries: Map<string, PresentationDeliveryRecord>;
  presentationDeliveryReceipts: Map<string, { snapshot: unknown }>;
};

function deliveryKey(target: PresentationDeliveryTarget): string {
  return target.source === 'task'
    ? JSON.stringify([
        target.tenantId,
        'presentation-delivery',
        'task',
        target.task.repositoryId,
        target.task.issueNumber,
        target.operationId,
      ])
    : JSON.stringify([
        target.tenantId,
        'presentation-delivery',
        'attempt',
        target.task.repositoryId,
        target.task.issueNumber,
        target.attemptId,
        target.operationId,
      ]);
}

export const inMemoryPresentationDeliveryStorageHooks: PresentationDeliveryStorageHooks =
  {
    async seed({ storage, source, operationId, state = 'pending' }) {
      const internals = storage as unknown as InMemoryPresentationInternals;
      const plan =
        source === 'task' ? taskPlan(operationId) : attemptPlan(operationId);
      const target: PresentationDeliveryTarget =
        source === 'task'
          ? { source, tenantId: tenant.tenantId, task, operationId }
          : {
              source,
              tenantId: tenant.tenantId,
              task,
              attemptId,
              operationId,
            };
      if (source === 'task') {
        internals.taskPresentations.set(
          JSON.stringify([
            tenant.tenantId,
            task.repositoryId,
            task.issueNumber,
            'task-presentation',
            operationId,
          ]),
          {
            tenantId: tenant.tenantId,
            plan: plan as TaskPresentationPlan,
            deliveryState: state,
            ...(state === 'obsolete'
              ? { obsoleteAtTaskRevision: 2, obsoleteReason: 'task-resumed' }
              : {}),
          },
        );
      } else {
        internals.attemptPresentations.set(
          JSON.stringify([
            tenant.tenantId,
            attemptId,
            'attempt-presentation',
            operationId,
          ]),
          {
            tenantId: tenant.tenantId,
            plan: plan as AttemptPresentationPlan,
            deliveryState: 'pending',
          },
        );
      }
      internals.presentationDeliveries.set(deliveryKey(target), {
        source,
        tenantId: tenant.tenantId,
        task,
        ...(source === 'attempt' ? { attemptId } : {}),
        operationId,
        planDigest: planDigest(plan),
        state,
      });
      return target;
    },
    async corrupt({ storage, target, kind }) {
      const internals = storage as unknown as InMemoryPresentationInternals;
      if (kind === 'delivery') {
        const record = internals.presentationDeliveries.get(
          deliveryKey(target),
        );
        if (record === undefined) throw new Error('missing delivery record');
        record.receiptSha256 = SHA_A;
        return;
      }
      if (kind === 'receipt') {
        const receipt = internals.presentationDeliveryReceipts.get(
          deliveryKey(target),
        );
        if (receipt === undefined) throw new Error('missing delivery receipt');
        receipt.snapshot = {};
        return;
      }
      if (target.source === 'task') {
        const key = JSON.stringify([
          target.tenantId,
          target.task.repositoryId,
          target.task.issueNumber,
          'task-presentation',
          target.operationId,
        ]);
        const record = internals.taskPresentations.get(key);
        if (record === undefined) throw new Error('missing Task plan');
        record.plan.effectDigest = SHA_B;
      } else {
        const key = JSON.stringify([
          target.tenantId,
          target.attemptId,
          'attempt-presentation',
          target.operationId,
        ]);
        const record = internals.attemptPresentations.get(key);
        if (record === undefined) throw new Error('missing Attempt plan');
        record.plan.outcomeDigest = SHA_B;
      }
    },
  };
