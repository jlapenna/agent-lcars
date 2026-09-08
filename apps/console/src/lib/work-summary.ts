import 'server-only';

import {
  type OrchestratorStore,
  taskKey,
  type TaskListCursor,
} from '@agent-lcars/orchestrator';
import {
  type ItemState,
  toWorkSummary,
  type WorkSummary,
} from '@agent-lcars/work/derive';

/** A bounded raw page from the authoritative all-anchor task feed. */
export interface WorkSummaryPage {
  items: WorkSummary[];
  nextCursor?: TaskListCursor;
}

export interface ListWorkSummariesInput {
  /** Bounded raw-task page size; derived-state filters apply afterwards. */
  limit: number;
  cursor?: TaskListCursor;
  state?: ItemState;
}

function cursorFor(task: Parameters<typeof taskKey>[0], updatedAt: string) {
  return { taskKey: taskKey(task), updatedAt };
}

/**
 * Projects a bounded page of every persisted Task. This is intentionally a
 * server-side console adapter rather than a new public Work API route:
 * service principals that may create work for one ingress must not gain a
 * fleet-wide read of issue-projection data.
 *
 * GitHub-anchored and native entries use identical derived lifecycle state;
 * GitHub is absent from this path. Callers that need PR/check/review details
 * may enrich a returned GitHub anchor separately, but may not replace its
 * work state with that projection.
 */
export async function listWorkSummaries(
  store: OrchestratorStore,
  input: ListWorkSummariesInput,
): Promise<WorkSummaryPage> {
  const tasks = await store.listTasks(input.limit, input.cursor);
  const items = await Promise.all(
    tasks.map(async ({ task }) =>
      toWorkSummary({
        task,
        runs: await store.listRuns(task.task),
      }),
    ),
  );

  const last = tasks[tasks.length - 1];
  return {
    items:
      input.state === undefined
        ? items
        : items.filter((item) => item.state === input.state),
    ...(tasks.length === input.limit && last !== undefined
      ? { nextCursor: cursorFor(last.task.task, last.task.updatedAt) }
      : {}),
  };
}

/**
 * Drops GitHub-anchored items whose issue has since been closed on GitHub
 * (#1860). `deriveItemState`'s `closedAt` field is native-only -- closing a
 * GitHub anchor's issue never touches the orchestrator Task record (see
 * `decide.ts`'s `not-native` refusal) -- so a GitHub-anchored item that
 * parked stays derived as `parked` forever, even once a human closes the
 * issue as complete. This is the enrichment `listWorkSummaries`'s own
 * contract above allows: it narrows which already-derived items a caller
 * shows, it never rewrites `item.state` with the GitHub projection. Native
 * items pass through untouched -- `closedAt` already covers them. A missing
 * or unavailable projection fails open (item kept): a webhook gap is not
 * evidence the issue is actually closed.
 */
export async function excludeClosedGithubAnchors(
  store: OrchestratorStore,
  items: WorkSummary[],
): Promise<WorkSummary[]> {
  const keep = await Promise.all(
    items.map(async (item) => {
      if ('workId' in item.anchor) return true;
      const projection = await store.readGithubAnchorProjection(item.anchor);
      return projection?.state !== 'closed';
    }),
  );
  return items.filter((_, index) => keep[index]);
}
