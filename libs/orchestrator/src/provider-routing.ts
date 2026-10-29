import type { CapacityState } from './capacity-model';
import {
  cancelRun,
  decidedRun,
  type Decision,
  isRefusal,
  type Refusal,
  refused,
  requestRun,
  type RequestRunInput,
} from './decide';
import { isLive, isWorkAnchor, providerRoutingSchema, type Run } from './model';

/** A terminal claim is retired by its executor's exit report or the capacity protocol.
 * Preserve the fence only for a live owner or durable capacity/credential
 * debt, not its queue history. A restore receipt
 * (`credentialRestoredClaimFingerprint`) is proof that restore succeeded, not
 * unreleased debt: the lease itself is released by the cleanup operation,
 * which is reserved on every terminal transition and fences here until it
 * finishes. */
export function retainsPhysicalClaim(
  run: Run,
  capacity: CapacityState,
): boolean {
  return (
    run.queue?.state === 'claimed' &&
    (isLive(run.state) ||
      run.credentialOperation !== undefined ||
      capacity.receipts.some((receipt) => receipt.runId === run.runId))
  );
}

/** Label handoff is an explicit request, never an automatic successor of a
 * refusal. The store reads task, queue claim and retained physical owners in
 * the same transaction that cancels and mints. */
export function decideLabelProviderRequest(
  input: RequestRunInput & {
    admittedPipeline: string;
    label: { requestedAt: string; actor: string; allowProviderChange: boolean };
    latestRun?: Run;
    retainedClaims?: readonly Run[];
    capacityReceiptRunIds?: readonly string[];
  },
): Decision | Refusal {
  if (isWorkAnchor(input.taskId)) return refused('not-native');
  const { task, activeRun, latestRun, label, pipeline, now } = input;
  const previous = task?.providerRouting;
  const acceptedGeneration = previous?.acceptedGeneration;
  const effective = input.admittedPipeline;
  const request = providerRoutingSchema.parse({
    requestId: input.requestId,
    requestedAt: label.requestedAt,
    actor: label.actor,
    requestedPipeline: pipeline,
    effectivePipeline: effective,
    status: 'refused',
    ...(acceptedGeneration === undefined ? {} : { acceptedGeneration }),
    ...(latestRun === undefined ? {} : { fromRunId: latestRun.runId }),
  });
  if (task !== undefined && previous?.requestId === input.requestId)
    return { task, outbox: [] };
  // Equal source clocks cannot establish the order of distinct label changes.
  // Fail closed; reapply the intended label after GitHub's clock advances.
  if (
    previous !== undefined &&
    Date.parse(label.requestedAt) <= Date.parse(previous.requestedAt)
  )
    return refused('stale-provider-request', latestRun);
  const requestInput = {
    ...input,
    priority: activeRun?.priority ?? latestRun?.priority ?? input.priority,
  };

  const reject = (reason: string): Decision | Refusal =>
    task === undefined
      ? refused('work-spec-mismatch')
      : {
          task: {
            ...task,
            providerRouting: { ...request, reason },
            updatedAt: now,
          },
          outbox: [],
        };

  // A delayed label cannot retire a newer non-label request or automatic
  // generation. An accepted label successor uses its source clock instead
  // of server admission time, so delivery delay alone does not break handoff.
  if (
    latestRun !== undefined &&
    latestRun.runId !== acceptedGeneration?.runId &&
    Date.parse(label.requestedAt) <= Date.parse(latestRun.createdAt)
  )
    return reject('run-newer-than-label');

  if (
    task !== undefined &&
    pipeline !== effective &&
    !label.allowProviderChange
  )
    return reject('unauthorized-provider-switch');
  if (task !== undefined && latestRun === undefined)
    return reject('physical-ownership-unavailable');
  if (task?.closedAt !== undefined) return reject('task-closed');
  // Missing transactional physical-owner evidence is not absence of ownership.
  if (
    task !== undefined &&
    (input.retainedClaims === undefined ||
      input.capacityReceiptRunIds === undefined)
  )
    return reject('physical-ownership-unavailable');
  if (input.capacityReceiptRunIds?.length || input.retainedClaims?.length)
    return reject(
      isLive(activeRun?.state ?? 'finished')
        ? 'run-already-claimed'
        : 'physical-retirement-required',
    );
  if (
    activeRun?.credentialOperation !== undefined ||
    latestRun?.credentialOperation !== undefined
  )
    return reject('credential-operation-pending');

  let decision: Decision | Refusal;
  // `activeRun` is derived from `task.activeRunId`, so a live active run
  // implies the task exists; the clause only narrows.
  if (
    task !== undefined &&
    activeRun !== undefined &&
    isLive(activeRun.state) &&
    pipeline !== effective
  ) {
    if (activeRun.queue?.state !== 'queued') return reject('task-busy');
    const canceled = cancelRun({
      now,
      task,
      run: activeRun,
      note: `Authorized label provider handoff to ${pipeline}`,
    });
    if (isRefusal(canceled)) return reject(canceled.reason);
    const successor = requestRun({
      ...requestInput,
      task: canceled.task,
      activeRun: undefined,
    });
    if (isRefusal(successor)) return reject(successor.reason);
    decision = {
      ...successor,
      additionalRuns: [decidedRun(canceled)],
      // The label handoff itself is not a worker cancellation outcome.
      outbox: successor.outbox,
    };
  } else {
    decision = requestRun(requestInput);
  }
  if (isRefusal(decision)) return reject(decision.reason);
  const successor = decidedRun(decision);
  return {
    ...decision,
    task: {
      ...decision.task,
      providerRouting: {
        ...request,
        effectivePipeline: successor.pipeline,
        status: 'accepted',
        acceptedGeneration: {
          runId: successor.runId,
          requestedAt: label.requestedAt,
          pipeline: successor.pipeline,
        },
      },
    },
  };
}
