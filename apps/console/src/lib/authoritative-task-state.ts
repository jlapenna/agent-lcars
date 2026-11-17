import 'server-only';

import { logger } from '@agent-lcars/logging';
import type { Run, VersionedTask } from '@agent-lcars/orchestrator';
import { taskKey } from '@agent-lcars/orchestrator';
import { workPayloadSchema, type WorkSpec } from '@agent-lcars/work';
import { type ItemView, toItemView } from '@agent-lcars/work/derive';

import { repoKey } from './github-client';
import { createOrchestratorRuntime } from './orchestrator-runtime';
import { type TaskRef, taskRefKey } from './watched-repo';

export const AUTHORITATIVE_TASK_STATE_SCHEMA =
  'agent-lcars.authoritative-task-state/v2' as const;

/**
 * The console's authoritative per-task lifecycle read (#1183): a projection
 * of `@agent-lcars/orchestrator`'s own durable truth (task doc + run
 * history), replacing the pre-#1177 read of the legacy dispatch-controller's
 * Firestore `DispatchLedger`. Unlike that ledger, the orchestrator carries
 * no separate "generation"/"source"/"anomaly" vocabulary - `runs` (oldest
 * first is not guaranteed; see `readAuthoritativeTaskState`) is the whole
 * history, each run's own `events` array its whole lifecycle, and
 * `result` its outcome. Callers that used to read ledger-only concepts
 * (generation, source kind, ledger-recorded anomaly) have nothing to read
 * here - render what actually exists rather than a synthesized stand-in.
 */
export interface AuthoritativeTaskState {
  schema: typeof AUTHORITATIVE_TASK_STATE_SCHEMA;
  task: { repo: string; issue: number };
  /** The orchestrator task document's own compare-and-set revision - the
   * same authoritative-storage-revision concept the pre-#1183 ledger read
   * exposed, just sourced from `@agent-lcars/orchestrator`'s store instead
   * of the legacy dispatch-controller's. */
  storageRevision: number;
  updatedAt: string;
  /** Set iff a run is currently live (see `Task.activeRunId`). */
  activeRunId?: string;
  runs: Run[];
  /** Immutable Work specification used to build every run brief. A missing
   * or malformed payload is durable-data corruption and fails this read;
   * callers surface the authoritative-data warning rather than inventing a
   * GitHub compatibility view. */
  spec: WorkSpec;
  item: ItemView;
}

export interface AuthoritativeTaskStateSet {
  states: Map<string, AuthoritativeTaskState>;
  unavailableTaskKeys: Set<string>;
  warnings: string[];
}

/**
 * Reads one task's orchestrator-authoritative state directly - no
 * repository-id resolution needed (unlike the pre-#1183 Firestore read):
 * `@agent-lcars/orchestrator`'s `TaskId` is just `{repo, issue}` (see
 * `libs/orchestrator/src/model.ts`). A repository that never routes through
 * the orchestrator simply has no task document here, and this returns
 * `undefined` rather than guessing. Every watched repository uses the same
 * repository-qualified TaskId contract.
 */
export async function readAuthoritativeTaskState({
  repository,
  issue,
}: {
  repository: string;
  issue: number;
}): Promise<AuthoritativeTaskState | undefined> {
  const { store } = createOrchestratorRuntime();
  const taskId = { repo: repository, issue };
  const versioned = await store.readTask(taskId);
  if (!versioned) return undefined;
  const runs = await store.listRuns(taskId);
  const payload = workPayloadSchema.safeParse(versioned.task.work);
  if (!payload.success)
    throw new Error('Authoritative task state requires coding Work');
  const spec = payload.data.spec;
  return {
    schema: AUTHORITATIVE_TASK_STATE_SCHEMA,
    task: taskId,
    storageRevision: versioned.revision,
    updatedAt: versioned.task.updatedAt,
    ...(versioned.task.activeRunId === undefined
      ? {}
      : { activeRunId: versioned.task.activeRunId }),
    runs,
    spec,
    item: toItemView({
      workId: `${repository}#${issue}`,
      task: versioned.task,
      runs,
    }),
  };
}

/**
 * The console's single server-side lifecycle adapter. A failed read is
 * recorded explicitly; it is never replaced with the compatibility comment
 * parsed from GitHub.
 */
export async function readAuthoritativeTaskStates(
  tasks: TaskRef[],
): Promise<AuthoritativeTaskStateSet> {
  const uniqueTasks = new Map(tasks.map((task) => [taskRefKey(task), task]));
  const states = new Map<string, AuthoritativeTaskState>();
  const unavailableTaskKeys = new Set<string>();
  const warnings: string[] = [];
  if (uniqueTasks.size === 0) return { states, unavailableTaskKeys, warnings };

  const { store } = createOrchestratorRuntime();
  const taskIds = [...uniqueTasks.values()].map((task) => ({
    repo: repoKey(task.repository),
    issue: task.issueNumber,
  }));
  // Two bounded datastore passes for the whole set instead of one document
  // read and one run query per task: the Agents page asks for every queue
  // item and recent run at once, so the per-task shape was ~2 reads per item
  // on the route's critical path.
  let versioned: Map<string, VersionedTask>;
  let runsByTask: Map<string, Run[]>;
  try {
    [versioned, runsByTask] = await Promise.all([
      store.readTasks(taskIds),
      store.listRunsForTasks(taskIds),
    ]);
  } catch (error) {
    logger.error(
      'agent-lcars: failed to read authoritative task states:',
      error,
    );
    for (const key of uniqueTasks.keys()) unavailableTaskKeys.add(key);
    warnings.push('Authoritative lifecycle state unavailable for this view.');
    return { states, unavailableTaskKeys, warnings };
  }

  for (const [key, task] of uniqueTasks) {
    const taskId = { repo: repoKey(task.repository), issue: task.issueNumber };
    try {
      const current = versioned.get(taskKey(taskId));
      if (current === undefined) continue;
      const payload = workPayloadSchema.safeParse(current.task.work);
      if (!payload.success)
        throw new Error('Authoritative task state requires coding Work');
      const runs = runsByTask.get(taskKey(taskId)) ?? [];
      states.set(key, {
        schema: AUTHORITATIVE_TASK_STATE_SCHEMA,
        task: taskId,
        storageRevision: current.revision,
        updatedAt: current.task.updatedAt,
        ...(current.task.activeRunId === undefined
          ? {}
          : { activeRunId: current.task.activeRunId }),
        runs,
        spec: payload.data.spec,
        item: toItemView({
          workId: `${repoKey(task.repository)}#${task.issueNumber}`,
          task: current.task,
          runs,
        }),
      });
    } catch (error) {
      logger.error(
        'agent-lcars: failed to read authoritative task state (%s):',
        key,
        error,
      );
      unavailableTaskKeys.add(key);
      warnings.push(`Authoritative lifecycle state unavailable for ${key}.`);
    }
  }

  return { states, unavailableTaskKeys, warnings };
}
