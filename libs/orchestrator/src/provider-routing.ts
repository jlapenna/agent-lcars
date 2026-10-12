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

/** Label handoff is an explicit request, never an automatic successor of a
 * refusal. The store reads task, queue claim and retained physical owners in
 * the same transaction that cancels and mints. */
export function decideLabelProviderRequest(
  input: RequestRunInput & {
    label: { requestedAt: string; actor: string };
    latestRun?: Run;
    retainedClaims?: readonly Run[];
  },
): Decision | Refusal {
  if (isWorkAnchor(input.taskId)) return refused('not-native');
  const { task, activeRun, latestRun, label, pipeline, now } = input;
  const previous = task?.providerRouting;
  const effective = activeRun?.pipeline ?? latestRun?.pipeline ?? pipeline;
  const request = providerRoutingSchema.parse({
    requestId: input.requestId,
    requestedAt: label.requestedAt,
    actor: label.actor,
    requestedPipeline: pipeline,
    effectivePipeline: effective,
    status: 'refused',
    ...(latestRun === undefined ? {} : { fromRunId: latestRun.runId }),
  });
  if (task !== undefined && previous?.requestId === input.requestId)
    return { task, outbox: [] };
  // Equal source clocks cannot establish the order of distinct label changes.
  // Fail closed; reapply the intended label after GitHub's clock advances.
  if (
    previous !== undefined &&
    (Date.parse(label.requestedAt) < Date.parse(previous.requestedAt) ||
      (Date.parse(label.requestedAt) === Date.parse(previous.requestedAt) &&
        (pipeline !== effective || pipeline !== previous.requestedPipeline)))
  )
    return refused('stale-provider-request', latestRun);
  if (
    task !== undefined &&
    previous === undefined &&
    latestRun !== undefined &&
    Date.parse(label.requestedAt) <= Date.parse(latestRun.createdAt)
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

  if (task !== undefined && latestRun === undefined)
    return reject('physical-ownership-unavailable');
  if (task?.closedAt !== undefined) return reject('task-closed');
  // Missing transactional physical-owner evidence is not absence of ownership.
  if (task !== undefined && input.retainedClaims === undefined)
    return reject('physical-ownership-unavailable');
  if (input.retainedClaims?.length)
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
  if (
    activeRun !== undefined &&
    isLive(activeRun.state) &&
    activeRun.pipeline !== pipeline
  ) {
    if (task === undefined) return refused('unknown-task');
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
        successorRunId: successor.runId,
      },
    },
  };
}
