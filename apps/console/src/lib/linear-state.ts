import 'server-only';

import { parseRunGeneration } from '@agent-lcars/dispatch-contracts';
import { issueSourceKey } from '@agent-lcars/dispatch-contracts';
import type { OrchestratorStore } from '@agent-lcars/orchestrator';
import { isWorkAnchor } from '@agent-lcars/orchestrator';
import {
  isSourceManagedWork,
  storedWorkPayloadSchema,
} from '@agent-lcars/work';
import { z } from 'zod';

import { issueReferenceForTask } from './issue-trackers';
import { linearQuery, readLinearIssue } from './linear-client';
import {
  linearConfig,
  linearIssueInRepository,
  linearTeam,
} from './linear-config';

type Event = 'started' | 'parked' | 'failed' | 'canceled' | 'completed';

/** Status publication shares the run's durable dispatch/outcome retry. An old
 * attempt never moves the source backwards, and human closure wins. Successful
 * execution alone does not establish protected delivery. */
export async function publishLinearState(
  store: OrchestratorStore,
  runId: string,
  event: Event,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const run = await store.readRun(runId);
  const task = run && (await store.readTask(run.task))?.task;
  if (
    !run ||
    !task ||
    !isWorkAnchor(task.task) ||
    isSourceManagedWork(task.work)
  )
    return;
  const ref = issueReferenceForTask(task);
  if (ref?.tracker !== 'linear') return;
  const config = linearConfig();
  if (!config || config.organizationId !== ref.organizationId) return;
  if (
    event === 'started'
      ? task.activeRunId !== runId
      : task.runCount !== parseRunGeneration(run.runId)
  )
    return;
  if (
    event === 'completed' &&
    (task.delivery?.runId !== runId ||
      task.delivery.state !== 'complete' ||
      run.delivery?.state !== 'complete' ||
      !run.delivery.mergeCommit)
  )
    return;
  const issue = await readLinearIssue(
    ref.organizationId,
    ref.issueId,
    fetchImpl,
  );
  if (!issue || issue.state === 'closed') return;
  const spec = storedWorkPayloadSchema.parse(task.work).spec;
  if (
    !('target' in spec) ||
    !linearIssueInRepository(config, issue, spec.target.repo)
  )
    return;
  const team = linearTeam(config, issue.teamId ?? '');
  const states = team && 'states' in team ? team.states : undefined;
  if (!states) return;
  const id = states[event];
  if (issue.status?.id === id) return;
  const state = z
    .object({
      workflowState: z
        .object({
          id: z.uuid(),
          type: z.string(),
          team: z.object({ id: z.uuid() }),
        })
        .nullable(),
    })
    .parse(
      await linearQuery(
        `query LcarsWorkflowState($id: String!) { workflowState(id: $id) { id type team { id } } }`,
        { id },
        fetchImpl,
      ),
    );
  if (
    !state.workflowState ||
    state.workflowState.team.id !== issue.teamId ||
    (event === 'completed'
      ? state.workflowState.type !== 'completed'
      : event === 'canceled'
        ? state.workflowState.type !== 'canceled'
        : ['completed', 'canceled', 'duplicate'].includes(
            state.workflowState.type,
          ))
  )
    throw new Error(
      'Linear workflow state does not match its configured team/category',
    );
  // Re-read after configuration lookup: a source close or repository move
  // observed while that request was in flight must fence this write too.
  const current = await readLinearIssue(
    ref.organizationId,
    ref.issueId,
    fetchImpl,
  );
  if (
    !current ||
    current.state === 'closed' ||
    current.teamId !== issue.teamId ||
    current.updatedAt !== issue.updatedAt
  )
    return;
  const latest = (await store.readTask(run.task))?.task;
  if (
    !latest ||
    (event === 'started'
      ? latest.activeRunId !== runId
      : latest.runCount !== parseRunGeneration(run.runId))
  )
    return;
  if (
    latest.issue &&
    (issueSourceKey(latest.issue.reference) !== issueSourceKey(ref) ||
      latest.issue.state === 'closed' ||
      Date.parse(latest.issue.updatedAt) > Date.parse(current.updatedAt))
  )
    return;
  if (latest.closedAt && event !== 'canceled') return;
  const result = z
    .object({
      issueUpdate: z.object({
        success: z.boolean(),
        issue: z.object({ id: z.uuid() }).nullable(),
      }),
    })
    .parse(
      await linearQuery(
        `mutation LcarsWorkflowStateUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id } } }`,
        { id: ref.issueId, input: { stateId: id } },
        fetchImpl,
      ),
    );
  if (
    !result.issueUpdate.success ||
    result.issueUpdate.issue?.id !== ref.issueId
  )
    throw new Error('Linear workflow state update was not confirmed');
}
