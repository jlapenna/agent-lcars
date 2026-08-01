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
 * Builds the shared ownership/priority view used by both the Command Deck and
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
  const items = rawItems.map((item) => {
    const diagnosis = silentErrorByIssue.get(
      repoItemKey(item.repo, item.number),
    );
    if (!diagnosis) return item;
    return {
      ...item,
      actionTypes: [...item.actionTypes, 'silent-error' as const],
      silentErrorDiagnosis: diagnosis,
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
