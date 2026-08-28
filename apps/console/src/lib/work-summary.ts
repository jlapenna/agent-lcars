import 'server-only';

import {
  type OrchestratorStore,
  taskKey,
  type TaskListCursor,
} from '@agent-lcars/orchestrator';
import {
  type ItemState,
  toWorkSummarySafe,
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
 * Projects a bounded page of every anchor carrying a valid `Task.work`
 * payload. This is intentionally a server-side console adapter rather than
 * a new public Work API route: service principals that may create work for
 * one ingress must not gain a fleet-wide read of issue-projection data.
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
  const items = (
    await Promise.all(
      tasks.map(async ({ task }) => {
        const summary = toWorkSummarySafe({
          task,
          runs: await store.listRuns(task.task),
        });
        if (summary === undefined) {
          console.warn(
            'agent-lcars: skipping task with an invalid work payload in work summary projection',
            { task: taskKey(task.task) },
          );
        }
        return summary;
      }),
    )
  ).filter((summary): summary is WorkSummary => summary !== undefined);

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
