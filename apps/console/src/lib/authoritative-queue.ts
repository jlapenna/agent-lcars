import 'server-only';

import { logger } from '@agent-lcars/logging';
import { latestRun } from '@agent-lcars/work/derive';

import {
  actionItemFromGithubAnchorProjection,
  type ActionItemsResult,
  sortActionItems,
} from './action-items';
import { isSelectedGithubAnchorProjection } from './github-anchor-selector';
import { getWatchedRepos } from './github-client';
import { readHandoffActions } from './handoff-summary-work';
import { createOrchestratorRuntime } from './orchestrator-runtime';

/** Every page is bounded at the datastore boundary.  Do not turn this into a
 * one-shot limited read: queue selection must see an older actionable anchor
 * even when newer unrelated projections fill the first page. */
const OPEN_ANCHOR_PAGE_SIZE = 200;

/**
 * Bridge, Inbox, and Agents use this one server-owned queue projection. The
 * only GitHub-derived values are durable webhook snapshots already accepted
 * by the control plane; this function never constructs an Octokit client.
 */
export async function getAuthoritativeQueueItems(): Promise<ActionItemsResult> {
  const { store } = createOrchestratorRuntime();
  const anchors = [];
  let cursor: Parameters<
    typeof store.listOpenGithubAnchorProjectionPage
  >[0]['cursor'];
  do {
    const page = await store.listOpenGithubAnchorProjectionPage({
      limit: OPEN_ANCHOR_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    anchors.push(...page.projections);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
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
  const items = await Promise.all(
    selected.map(async (item) => {
      if (!item.actionTypes.includes('needs-human')) return item;
      try {
        const run = latestRun(
          await store.listRuns({
            repo: `${item.repo.owner}/${item.repo.name}`,
            issue: item.number,
          }),
        );
        const actions =
          run === undefined ? undefined : await readHandoffActions(store, run);
        return actions ? { ...item, humanNeededActions: actions } : item;
      } catch {
        // Optional reading aids must not hide an otherwise readable decision.
        logger.warn('agent-lcars: human-needed summary read unavailable');
        return item;
      }
    }),
  );
  return {
    items: sortActionItems(items),
  };
}
