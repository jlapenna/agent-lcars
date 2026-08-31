import type {
  GithubAnchorProjection,
  Run as OrchestratorRun,
} from '@agent-lcars/orchestrator';
import type { WorkSpec } from '@agent-lcars/work';

import {
  type ActionItem,
  actionItemFromGithubAnchorProjection,
} from './action-items';
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
  deriveLogicalWork,
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
      /** The task's `work.spec` snapshot, when one has been derived
       *  (sub-project 5) -- see `AuthoritativeTaskState.spec`. */
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
    console.error(
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
 * single active-state badge. */
function nativeRunAnomalies(
  runs: readonly OrchestratorRun[],
): LogicalWorkAnomaly[] {
  const byPipeline = new Map<string, OrchestratorRun[]>();
  for (const run of runs) {
    if (run.state !== 'pending' && run.state !== 'running') continue;
    const group = byPipeline.get(run.pipeline);
    if (group) group.push(run);
    else byPipeline.set(run.pipeline, [run]);
  }
  return Array.from(byPipeline).flatMap(([pipeline, group]) =>
    group.length > 1
      ? [
          {
            kind: 'duplicate-active-runs',
            detail: `${group.length} ${pipeline} runs are queued or running for the same task at once (${group.map((run) => run.runId).join(', ')}).`,
          },
        ]
      : [],
  );
}

/** A run's own state, coarsened onto `LogicalWorkState`: `pending` means
 * "decided, dispatch not yet confirmed" (dispatching in the old ledger's own
 * vocabulary); `running` is `active`; every terminal state (`finished`,
 * `canceled`, `lost`) means the task is not currently being worked, exactly
 * like the ledger's own `completed`/`dispatch-rejected` states did. */
function stateFromOrchestratorTask(
  state: AuthoritativeTaskState,
): LogicalWorkState {
  const active =
    state.activeRunId === undefined
      ? undefined
      : state.runs.find((run) => run.runId === state.activeRunId);
  if (active) return active.state === 'pending' ? 'dispatching' : 'active';
  const latest = state.runs
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .at(0);
  return latest ? 'completed' : 'unknown';
}
