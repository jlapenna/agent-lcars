import 'server-only';

import {
  actionItemFromGithubAnchorProjection,
  type ActionItemsResult,
  sortActionItems,
} from './action-items';
import { isSelectedGithubAnchorProjection } from './github-anchor-selector';
import { getWatchedRepos } from './github-client';
import { createOrchestratorRuntime } from './orchestrator-runtime';

/**
 * Bridge, Inbox, and Agents use this one server-owned queue projection. The
 * only GitHub-derived values are durable webhook snapshots already accepted
 * by the control plane; this function never constructs an Octokit client.
 */
export async function getAuthoritativeQueueItems(): Promise<ActionItemsResult> {
  const { store } = createOrchestratorRuntime();
  const anchors = await store.listOpenGithubAnchorProjections();
  const repositories = new Map(
    getWatchedRepos().map((repository) => [
      `${repository.owner}/${repository.name}`,
      repository,
    ]),
  );
  const selected = anchors.flatMap((anchor) => {
    const repository = repositories.get(anchor.anchor.repo);
    return repository !== undefined &&
      isSelectedGithubAnchorProjection(anchor, repository)
      ? [actionItemFromGithubAnchorProjection(anchor, repository)]
      : [];
  });
  return {
    items: sortActionItems(selected),
  };
}
