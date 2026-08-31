import type { Run as OrchestratorRun } from '@agent-lcars/orchestrator';
import { isE2eTesting } from '@agent-lcars/util-server';
import type { WorkSpec } from '@agent-lcars/work';
import { cacheLife, cacheTag } from 'next/cache';

import {
  type ActionItem,
  actionItemFromGithubAnchorProjection,
} from './action-items';
import {
  type AuthoritativeTaskState,
  readAuthoritativeTaskStates,
} from './authoritative-task-state';
import { isNotFound } from './backend-actions';
import { GITHUB_DETAIL_TAG } from './cache-tags';
import { DASHBOARD_CACHE_LIFE, type Fetched } from './dashboard-data';
import {
  getGithubClient,
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
      /** GitHub issue/PR metadata cache timestamp. Execution history is read
       * separately from the authoritative control plane. */
      generatedAt: string;
      /** The task's `work.spec` snapshot, when one has been derived
       *  (sub-project 5) -- see `AuthoritativeTaskState.spec`. */
      spec?: WorkSpec;
    }
  | { status: 'not-found' }
  | { status: 'error'; warning: string };

interface GithubIssueLike {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  state: string;
  updated_at?: string;
  user?: { login?: string } | null;
  assignees?: ({ login?: string } | null)[] | null;
  pull_request?: unknown;
  labels: (string | { name?: string })[];
}

/**
 * Fetches the exact issue/PR as a deliberately bounded, exact-anchor lookup.
 * It is separate from the
 * authoritative queue cache: a closed/merged task this route must still
 * resolve was never in that open-anchor feed to begin with.
 *
 * Returns the same `Fetched<T>` shape as the projection readers, timestamped
 * INSIDE the cached function so the
 * timestamp is cached alongside the data it describes (see `Fetched`'s own
 * doc comment) - a cache hit must report the data's real age, not the
 * render time.
 */
async function fetchTaskSource(
  repo: WatchedRepo,
  issueNumber: number,
): Promise<Fetched<{ issue: GithubIssueLike }>> {
  const octokit = getGithubClient();
  const { data: issue } = await octokit.rest.issues.get({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
  });

  return {
    data: { issue },
    fetchedAt: new Date().toISOString(),
  };
}

async function getProductionCachedTaskSource(
  repo: WatchedRepo,
  issueNumber: number,
): Promise<Fetched<{ issue: GithubIssueLike }>> {
  'use cache';
  cacheTag(GITHUB_DETAIL_TAG);
  cacheLife(DASHBOARD_CACHE_LIFE);
  return fetchTaskSource(repo, issueNumber);
}

/** See dashboard-data.ts's E2E cache-bypass rationale. */
function getCachedTaskSource(
  repo: WatchedRepo,
  issueNumber: number,
): Promise<Fetched<{ issue: GithubIssueLike }>> {
  return isE2eTesting()
    ? fetchTaskSource(repo, issueNumber)
    : getProductionCachedTaskSource(repo, issueNumber);
}

/**
 * Loads everything the `/task/<owner>/<repo>/<issue>` canonical detail page
 * needs, by fetching the exact issue/PR directly rather than depending on
 * the cached open-anchor queue. This is
 * deliberate: the whole point of this route (#306/#264) is that it keeps
 * working once a task closes/merges and drops off the board - a route that
 * only ever looked at the queue's open anchors would 404 for exactly the
 * case it exists to fix.
 *
 * Attempts still come from the cached `getCachedAgentActivity()` (live runs
 * plus the newest 8 recent runs across every watched repo/pipeline) rather
 * than a fresh per-task Actions API fetch - GitHub's API has no way to list
 * "runs for issue N" directly (see agent-activity.ts's own top comment), and
 * this page must not add its own uncapped per-item Actions fan-out. A task
 * whose most recent attempt aged out of that global top-8 window shows an
 * intent history with no attempts rather than a full one - the same known
 * limitation the dashboard's "Recently finished" disclosure already has.
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

  let issue: GithubIssueLike;
  let sourceFetchedAt: string;
  try {
    const source = await getCachedTaskSource(repo, issueNumber);
    issue = source.data.issue;
    sourceFetchedAt = source.fetchedAt;
  } catch (error) {
    if (isNotFound(error)) return { status: 'not-found' };
    console.error(
      'agent-lcars: failed to load task detail (%s#%s):',
      `${repo.owner}/${repo.name}`,
      issueNumber,
      error,
    );
    return {
      status: 'error',
      warning: 'Task detail unavailable (GitHub API request failed).',
    };
  }

  const labels = issue.labels.map((label) =>
    typeof label === 'string' ? label : (label.name ?? ''),
  );

  const key = repoItemKey(repo, issueNumber);
  const authoritative = await readAuthoritativeTaskStates([
    { repository: repo, issueNumber },
  ]);
  const humanNeeded = labels.includes('status:needs-human');
  // GitHub is the issue/PR presentation boundary. Lifecycle comes only from
  // the task state read below; do not resurrect an Actions-attempt fallback.
  const { work } = deriveLogicalWork({
    runs: [],
    unavailableTaskKeys: authoritative.unavailableTaskKeys,
    taskMeta: new Map([
      [
        key,
        {
          repo,
          issueNumber,
          title: issue.title,
          url: issue.html_url,
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

  const item = actionItemFromGithubAnchorProjection({
    anchor: { repo: repoKey(repo), issue: issueNumber },
    kind: issue.pull_request === undefined ? 'issue' : 'pr',
    state: issue.state === 'closed' ? 'closed' : 'open',
    title: issue.title,
    body: issue.body ?? '',
    url: issue.html_url,
    ...(issue.user?.login === undefined ? {} : { author: issue.user.login }),
    labels: issue.labels
      .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
      .filter((label) => label.length > 0),
    assigneeLogins: (issue.assignees ?? []).flatMap((assignee) =>
      assignee?.login === undefined ? [] : [assignee.login],
    ),
    sourceUpdatedAt: issue.updated_at ?? sourceFetchedAt,
    observedAt: sourceFetchedAt,
  });

  const state = authoritative.states.get(key);
  return {
    status: 'ok',
    work: task,
    runs: state?.runs ?? [],
    item,
    repo,
    anchorState: issue.state === 'closed' ? 'closed' : 'open',
    generatedAt: sourceFetchedAt,
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
