import {
  decidedRun,
  type Decision,
  finalDeliveryOutbox,
  isRefusal,
  type Refusal,
  refused,
  requestRun,
} from './decide';
import { type DeliveryBinding, type Run, type Task } from './model';

/** Exact server observation; partial GitHub/projection data has no authority. */
export type DeliveryObservation =
  | { kind: 'waiting'; head: string }
  | { kind: 'protected-merge'; head: string; mergeCommit: string }
  | { kind: 'revision'; head: string; newHead: string }
  | { kind: 'correction'; head: string; reason: string }
  | {
      kind: 'runtime-evidence';
      head: string;
      mergeCommit: string;
      principal: string;
      ref: string;
    };

export function advanceDelivery(input: {
  now: string;
  task: Task;
  run: Run;
  observation: DeliveryObservation;
  /** Re-resolved original intake grant, never the monitoring caller's grant. */
  correctionAuthorized: boolean;
}): Decision | Refusal {
  const { now, task, run, observation } = input;
  if (task.closedAt !== undefined) return refused('task-closed');
  const binding = task.delivery;
  if (
    binding === undefined ||
    binding.runId !== run.runId ||
    run.delivery?.head !== binding.head ||
    binding.head !== observation.head ||
    task.activeRunId !== undefined ||
    run.state !== 'finished' ||
    !run.result?.ok
  )
    return refused('stale-lease');
  if (observation.kind === 'runtime-evidence') {
    if (
      !input.correctionAuthorized ||
      binding.state !== 'runtime-required' ||
      observation.mergeCommit !== binding.mergeCommit
    )
      return refused('not-claimant');
    const delivery: DeliveryBinding = {
      ...binding,
      state: 'complete',
      observedAt: now,
      runtimeEvidence: {
        principal: observation.principal,
        ref: observation.ref,
        observedAt: now,
      },
    };
    return {
      task: { ...task, delivery, updatedAt: now },
      run: { ...run, delivery, updatedAt: now },
      outbox: finalDeliveryOutbox(task, run, delivery, now),
    };
  }
  if (observation.kind === 'revision' && binding.state === 'waiting') {
    const delivery = { ...binding, head: observation.newHead, observedAt: now };
    return {
      task: { ...task, delivery, updatedAt: now },
      run: { ...run, delivery, updatedAt: now },
      outbox: [],
    };
  }
  if (binding.state !== 'waiting' || observation.kind === 'waiting')
    return { task, run, outbox: [] };
  if (observation.kind === 'protected-merge') {
    const delivery: DeliveryBinding = {
      ...binding,
      state: binding.runtimeGate === 'none' ? 'complete' : 'runtime-required',
      mergeCommit: observation.mergeCommit,
      observedAt: now,
    };
    return {
      task: { ...task, delivery, updatedAt: now },
      run: { ...run, delivery, updatedAt: now },
      outbox: finalDeliveryOutbox(task, run, delivery, now),
    };
  }
  if (observation.kind !== 'correction') return { task, run, outbox: [] };
  if (!input.correctionAuthorized) return refused('not-claimant');
  if (binding.correctionRunId !== undefined) return refused('run-not-live');
  // Credential debt and physical retirement remain on the original Run. The
  // existing queue/capacity owner refuses successor activation until resolved.
  const { delivery: _delivery, ...withoutDelivery } = task;
  const successor = requestRun({
    now,
    taskId: task.task,
    task: withoutDelivery,
    activeRun: undefined,
    requestId: `delivery:${run.runId}`,
    requestSource: 'delivery-correction',
    pipeline: run.pipeline,
    priority: run.priority,
    ...(run.providerFallback === undefined
      ? {}
      : { providerFallback: run.providerFallback }),
    params: {
      ...run.params,
      mode: 'implement',
      context:
        `Correct delivery https://github.com/${binding.repo}/pull/${binding.number} at ${binding.head}. ${observation.reason}`.slice(
          0,
          16_384,
        ),
      deliveryPredecessor: run.runId,
    },
  });
  if (isRefusal(successor)) return successor;
  const correction = decidedRun(successor);
  return {
    ...successor,
    task: {
      ...successor.task,
      delivery: { ...binding, correctionRunId: correction.runId },
    },
    run,
    additionalRuns: [correction],
  };
}
