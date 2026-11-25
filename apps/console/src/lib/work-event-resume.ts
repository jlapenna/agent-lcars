import 'server-only';

import { logger } from '@agent-lcars/logging';
import {
  eventResumeRequestId,
  isLive,
  isRefusal,
  type Orchestrator,
  type OrchestratorStore,
  type WorkAnchor,
} from '@agent-lcars/orchestrator';
import type { SessionDoc } from '@agent-lcars/telemetry';
import { latestRun } from '@agent-lcars/work/derive';

import { resumeParamsFor } from './work-resume-session';

/**
 * Event-resume for dispatched Work (#3570). A run subscribes on behalf of
 * its native Work and ends its turn; the router hands each matching event to
 * {@link queueWorkEventResume}, which records it on the Work durably, and the
 * outbox drain's `event-resume` entry calls {@link admitWorkEventResume} once
 * the Work has no live run. The decisions themselves live in the
 * orchestrator (`queueEventResume`, `admitEventResume`).
 */

export type WorkResumeOutcome =
  | { readonly outcome: 'queued' | 'duplicate' }
  /** The Work can never take this event: unknown, closed, not native, or
   * over its event-resume limit. */
  | { readonly outcome: 'refused'; readonly reason: string };

export interface WorkResumeRequest {
  readonly workId: string;
  readonly deliveryId: string;
  readonly notice: string;
}

export function queueWorkEventResume(
  orchestrator: Pick<Orchestrator, 'queueEventResume'>,
): (request: WorkResumeRequest) => Promise<WorkResumeOutcome> {
  return async ({ workId, deliveryId, notice }) => {
    const outcome = await orchestrator.queueEventResume(
      { workId },
      { deliveryId, notice },
    );
    if (!isRefusal(outcome)) return { outcome: 'queued' };
    if (outcome.reason === 'duplicate-request') return { outcome: 'duplicate' };
    return { outcome: 'refused', reason: outcome.reason };
  };
}

export interface WorkEventResumeDeps {
  readonly store: Pick<OrchestratorStore, 'readTask' | 'listRuns'>;
  readonly orchestrator: Pick<Orchestrator, 'admitEventResume'>;
  /** Session telemetry for the Work's runs, to resume the agent's own
   * conversation; absent, the resume run starts fresh. */
  readonly sessionDocsForRuns?: (
    runIds: readonly string[],
  ) => Promise<SessionDoc[]>;
}

export type AdmitOutcome =
  | 'admitted'
  /** A run holds the Work; its settlement hands the events on. */
  | 'busy'
  /** Nothing is waiting, or a concurrent drain already admitted it. */
  | 'nothing'
  | 'refused';

/** Starts the run that resumes `taskId` for its waiting events, resuming the
 * newest session of its own runs when the pipeline can restore one. */
export async function admitWorkEventResume(
  deps: WorkEventResumeDeps,
  taskId: WorkAnchor,
): Promise<AdmitOutcome> {
  const task = (await deps.store.readTask(taskId))?.task;
  const oldest = task?.eventResumes?.pending[0];
  if (task === undefined || oldest === undefined) return 'nothing';
  const runs = await deps.store.listRuns(taskId);
  if (runs.some((run) => run.runId === task.activeRunId && isLive(run.state)))
    return 'busy';
  const latest = latestRun(runs);
  if (latest === undefined) return 'nothing';
  const runIds = new Set(runs.map((run) => run.runId));
  const params =
    deps.sessionDocsForRuns === undefined
      ? {}
      : resumeParamsFor(
          await deps.sessionDocsForRuns([...runIds]),
          runIds,
          latest.pipeline,
        );
  const outcome = await deps.orchestrator.admitEventResume({
    taskId,
    requestId: eventResumeRequestId(oldest.seq),
    pipeline: latest.pipeline,
    ...(latest.priority === undefined ? {} : { priority: latest.priority }),
    params,
  });
  if (!isRefusal(outcome)) return 'admitted';
  switch (outcome.reason) {
    case 'task-busy':
      return 'busy';
    case 'duplicate-request':
    case 'stale-lease':
    case 'no-pending-event':
      return 'nothing';
    default:
      logger.warn(
        'agent-lcars: event-resume for work %s refused: %s',
        taskId.workId,
        outcome.reason,
      );
      return 'refused';
  }
}
