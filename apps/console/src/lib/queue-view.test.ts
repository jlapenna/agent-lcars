import { describe, expect, it } from 'vitest';

import type { ActionItem } from './action-items';
import type { AgentActivity, AgentRun } from './agent-activity';
import { buildQueueView } from './queue-view';

const repo = { owner: 'example', name: 'console' };

function item(
  number: number,
  actionTypes: ActionItem['actionTypes'],
): ActionItem {
  return {
    kind: 'issue',
    repo,
    number,
    title: `Item ${number}`,
    url: `https://github.com/example/console/issues/${number}`,
    updatedAt: '2026-07-31T00:00:00Z',
    actionTypes,
    labels: [],
    assigneeLogins: [],
  };
}

function liveRun(issueNumber: number): AgentRun {
  return {
    id: issueNumber,
    repo,
    pipeline: 'claude',
    status: 'running',
    event: 'issues',
    url: `https://github.com/example/console/actions/runs/${issueNumber}`,
    displayTitle: `#${issueNumber}: Item ${issueNumber}`,
    issueNumber,
    createdAt: '2026-07-31T00:00:00Z',
    updatedAt: '2026-07-31T00:00:00Z',
    elapsedSeconds: 10,
  };
}

function activity(liveRuns: AgentRun[] = []): AgentActivity {
  return { liveRuns, recentRuns: [], warnings: [] };
}

describe('buildQueueView', () => {
  it('keeps the Inbox and Command Deck ownership buckets mutually exclusive', () => {
    const view = buildQueueView(
      [item(1, ['human-needed']), item(2, ['post-deploy-action']), item(3, [])],
      activity(),
      new Map(),
    );

    expect(view.yourQueue.map(({ number }) => number)).toEqual([1]);
    expect(view.waitingOnDeploy.map(({ number }) => number)).toEqual([2]);
    expect(view.rest.map(({ number }) => number)).toEqual([3]);
  });

  it('removes items with a live agent run from every idle-work surface', () => {
    const view = buildQueueView(
      [item(1, ['human-needed'])],
      activity([liveRun(1)]),
      new Map(),
    );

    expect(view.liveRunByItemKey.size).toBe(1);
    expect(view.yourQueue).toEqual([]);
    expect(view.handedBack).toEqual([]);
    expect(view.waitingOnDeploy).toEqual([]);
    expect(view.rest).toEqual([]);
  });
});
