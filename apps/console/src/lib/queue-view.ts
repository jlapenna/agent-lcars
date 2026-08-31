import type { IssueAgentSessionDoc } from '@agent-lcars/telemetry';

import { type ActionItem, isDeployWaitOnly } from './action-items';
import type { AgentActivity, AgentRun } from './agent-activity';
import { repoItemKey } from './github-client';
import { deriveSilentErrorDiagnoses } from './run-classification';

export interface QueueView {
  items: ActionItem[];
  yourQueue: ActionItem[];
  waitingOnDeploy: ActionItem[];
  rest: ActionItem[];
  liveRunByItemKey: Map<string, AgentRun>;
}

/**
 * Builds the shared ownership/priority view used by both the Bridge and
 * the standalone Decision Inbox. Keeping the joins here makes moving the
 * Inbox a routing concern rather than two subtly different classifications.
 */
export function buildQueueView(
  rawItems: ActionItem[],
  activity: AgentActivity,
  runnerSessionsByRunId: Map<string, IssueAgentSessionDoc>,
): QueueView {
  const silentErrorByIssue = deriveSilentErrorDiagnoses(
    activity.recentRuns,
    runnerSessionsByRunId,
  );
  const newestRunByIssue = new Map<string, AgentRun>();
  for (const run of activity.recentRuns) {
    if (run.issueNumber === undefined) continue;
    const key = repoItemKey(run.repo, run.issueNumber);
    const previous = newestRunByIssue.get(key);
    if (
      previous === undefined ||
      run.updatedAt > previous.updatedAt ||
      (run.updatedAt === previous.updatedAt &&
        run.createdAt > previous.createdAt) ||
      (run.updatedAt === previous.updatedAt &&
        run.createdAt === previous.createdAt &&
        String(run.id) > String(previous.id))
    ) {
      newestRunByIssue.set(key, run);
    }
  }
  const failedRunByIssue = new Set(
    [...newestRunByIssue.entries()]
      .filter(([, run]) => run.conclusion === 'failure')
      .map(([key]) => key),
  );
  const items = rawItems.map((item) => {
    const key = repoItemKey(item.repo, item.number);
    const diagnosis = silentErrorByIssue.get(key);
    const actionTypes = [
      ...item.actionTypes,
      ...(failedRunByIssue.has(key) ? (['run-failed'] as const) : []),
      ...(diagnosis ? (['silent-error'] as const) : []),
    ];
    if (actionTypes.length === item.actionTypes.length) return item;
    return {
      ...item,
      actionTypes,
      ...(diagnosis === undefined ? {} : { silentErrorDiagnosis: diagnosis }),
    };
  });

  const liveRunByItemKey = new Map(
    activity.liveRuns
      .filter((run) => run.issueNumber !== undefined)
      .map((run) => [repoItemKey(run.repo, run.issueNumber as number), run]),
  );
  const idle = items.filter(
    (item) => !liveRunByItemKey.has(repoItemKey(item.repo, item.number)),
  );
  const yourQueue = idle.filter(
    (item) => item.actionTypes.length > 0 && !isDeployWaitOnly(item),
  );
  const waitingOnDeploy = idle.filter(isDeployWaitOnly);
  const rest = idle.filter((item) => item.actionTypes.length === 0);

  return {
    items,
    yourQueue,
    waitingOnDeploy,
    rest,
    liveRunByItemKey,
  };
}
