import { logger } from '@agent-lcars/logging';
import type {
  GithubAnchorProjection,
  Run as OrchestratorRun,
} from '@agent-lcars/orchestrator';
import type { WorkSpec } from '@agent-lcars/work';

import {
  type ActionItem,
  actionItemFromGithubAnchorProjection,
} from './action-items';
import { duplicateLiveGroups } from './agent-activity';
import {
  type AuthoritativeTaskState,
  readAuthoritativeTaskStates,
} from './authoritative-task-state';
import {
  repoItemKey,
  repoKey,
  resolveWatchedRepo,
  UnwatchedRepoError,
  type WatchedRepo,
} from './github-client';
import {
  coarsenRunStates,
  deriveLogicalWork,
  duplicateRunAnomaly,
  type LogicalWork,
  type LogicalWorkAnomaly,
  type LogicalWorkState,
} from './logical-work';
import { createOrchestratorRuntime } from './orchestrator-runtime';
import { taskRefKey } from './watched-repo';

export type TaskDetailResult =
  | {
      status: 'ok';
      work: LogicalWork;
      /** This task's own authoritative orchestrator Run history, verbatim. */
      runs: OrchestratorRun[];
      item: ActionItem;
      repo: WatchedRepo;
      anchorState: 'open' | 'closed';
      /** Server-owned anchor projection timestamp. */
      generatedAt: string;
      /** The task's immutable Work specification, when this anchor has an
       * authoritative Task record. */
      spec?: WorkSpec;
    }
  | { status: 'not-found' }
  | { status: 'error'; warning: string };

/**
 * Loads everything the `/task/<owner>/<repo>/<issue>` canonical detail page
 * needs from the durable anchor projection plus its Task/Run state. Closed
 * anchors remain addressable in the projection store; no render path queries
 * GitHub or substitutes a live GitHub response when projection data is absent.
 */
export async function getTaskDetail(
  owner: string,
  repoName: string,
  issueNumber: number,
): Promise<TaskDetailResult> {
  let repo: WatchedRepo;
  try {
    repo = resolveWatchedRepo({ owner, name: repoName });
  } catch (error) {
    if (error instanceof UnwatchedRepoError) return { status: 'not-found' };
    throw error;
  }

  const anchor: GithubAnchorProjection['anchor'] = {
    repo: repoKey(repo),
    issue: issueNumber,
  };
  let projection: GithubAnchorProjection | undefined;
  try {
    const { store } = createOrchestratorRuntime();
    projection = await store.readGithubAnchorProjection(anchor);
  } catch (error) {
    logger.error(
      'agent-lcars: failed to load stored task projection (%s#%s):',
      anchor.repo,
      anchor.issue,
      error,
    );
    return {
      status: 'error',
      warning: 'Task detail unavailable (stored projection read failed).',
    };
  }
  if (projection === undefined) return { status: 'not-found' };

  const key = repoItemKey(repo, issueNumber);
  const authoritative = await readAuthoritativeTaskStates([
    { repository: repo, issueNumber },
  ]);
  const humanNeeded = projection.labels.includes('status:needs-human');
  const { work } = deriveLogicalWork({
    runs: [],
    unavailableTaskKeys: authoritative.unavailableTaskKeys,
    taskMeta: new Map([
      [
        key,
        {
          repo,
          issueNumber,
          title: projection.title,
          url: projection.url,
          humanNeeded,
        },
      ],
    ]),
  });

  const baseTask = work.find(
    (w) => 'issueNumber' in w.task && taskRefKey(w.task) === key,
  );
  // Unreachable in practice - `taskMeta` above always seeds exactly this
  // key - but keeps the return type honest instead of a non-null assertion.
  if (!baseTask) return { status: 'not-found' };
  const task = applyOrchestratorTruth(
    baseTask,
    authoritative.states.get(key),
    humanNeeded,
  );

  const item = actionItemFromGithubAnchorProjection(projection, repo);

  const state = authoritative.states.get(key);
  return {
    status: 'ok',
    work: task,
    runs: state?.runs ?? [],
    item,
    repo,
    anchorState: projection.state,
    generatedAt: projection.observedAt,
    ...(state?.spec === undefined ? {} : { spec: state.spec }),
  };
}

/** Overlays the task's durable Run history onto GitHub presentation metadata.
 * A missing task record is intentionally shown as no history, never replaced
 * with a hosted Actions attempt. */
function applyOrchestratorTruth(
  work: LogicalWork,
  state: AuthoritativeTaskState | undefined,
  humanNeeded: boolean,
): LogicalWork {
  if (!state) return work;

  const anomalies = nativeRunAnomalies(state.runs);
  const orchestratorState = stateFromOrchestratorTask(state);
  const nextState: LogicalWorkState =
    work.state === 'unavailable'
      ? 'unavailable'
      : anomalies.length > 0
        ? 'anomaly'
        : humanNeeded
          ? 'human-needed'
          : orchestratorState;

  return {
    ...work,
    state: nextState,
    anomalies,
    provenance: { kind: 'authoritative', revision: state.storageRevision },
  };
}

/** A duplicate live Run is durable broker state, not a hosted-workflow
 * compatibility signal. Surface it on task detail just as the activity view
 * does, so operators never lose an unsafe concurrent execution behind a
 * single active-state badge. The `OrchestratorRun` adapter over
 * `duplicateLiveGroups` (`agent-activity.ts`): live means
 * `pending|running` - this run type's own vocabulary for "not yet terminal",
 * distinct from `AgentRun`'s `queued|running` - pipeline is
 * `OrchestratorRun.pipeline`. */
function nativeRunAnomalies(
  runs: readonly OrchestratorRun[],
): LogicalWorkAnomaly[] {
  const duplicated = duplicateLiveGroups(runs, {
    isLive: (run) => run.state === 'pending' || run.state === 'running',
    pipeline: (run) => run.pipeline,
  });
  return Array.from(duplicated).map(([pipeline, group]) =>
    duplicateRunAnomaly(
      pipeline,
      group.map((run) => run.runId),
    ),
  );
}

/** The run history's own states, coarsened onto `LogicalWorkState` by the
 * same rule the Agents page uses (`coarsenRunStates`): `pending` is
 * "decided, dispatch not yet confirmed", so dispatching; `running` is
 * active; every terminal state (`finished`, `canceled`, `lost`) means the
 * task is not currently being worked. Read off the runs themselves, never
 * off `Task.activeRunId` - the two must agree in a consistent store, but
 * when they do not, the run states are what the Agents page shows, and
 * this page must not say "completed" about a run that page calls live. */
function stateFromOrchestratorTask(
  state: AuthoritativeTaskState,
): LogicalWorkState {
  return coarsenRunStates({
    running: state.runs.some((run) => run.state === 'running'),
    queued: state.runs.some((run) => run.state === 'pending'),
    any: state.runs.length > 0,
  });
}
