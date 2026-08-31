import { AGENT_BOT_LOGINS } from '@agent-lcars/dispatch-contracts';
import type { GithubAnchorProjection } from '@agent-lcars/orchestrator';

import { agentFleetLogin, maintainerLogin } from './deployment';
import type { WatchedRepo } from './github-client';
import { supportedAgentLabels } from './watched-repo';

const BOARD_LABELS = ['status:needs-human', 'status:ready-for-agent'];

/**
 * The durable equivalent of the current GitHub queue predicate. It is pure
 * so backfill validation and the later console cutover share the exact
 * selection contract: the projection feed contains every open anchor, while
 * the queue remains the actionable fleet/maintainer subset.
 */
export function isSelectedGithubAnchorProjection(
  projection: GithubAnchorProjection,
): boolean {
  const [owner, name] = projection.anchor.repo.split('/');
  const repo: WatchedRepo = { owner: owner as string, name: name as string };
  if (
    projection.assigneeLogins.includes(agentFleetLogin()) ||
    projection.assigneeLogins.includes(maintainerLogin())
  ) {
    return true;
  }
  const boardLabels = [...BOARD_LABELS, ...supportedAgentLabels(repo)];
  if (projection.labels.some((label) => boardLabels.includes(label))) {
    return true;
  }
  if (
    projection.author !== undefined &&
    AGENT_BOT_LOGINS.includes(projection.author)
  ) {
    return true;
  }
  return (
    projection.requestedReviewerLogins?.includes(maintainerLogin()) ?? false
  );
}
