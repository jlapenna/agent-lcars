import { type DispatchOutcomeKind } from '@agent-lcars/dispatch-contracts';
import type { Run as OrchestratorRun } from '@agent-lcars/orchestrator';
import { isE2eTesting } from '@agent-lcars/util-server';
import type { WorkSpec } from '@agent-lcars/work';
import { cacheLife, cacheTag } from 'next/cache';

import { type ActionItem, classifyIssue } from './action-items';
import {
  type AuthoritativeTaskState,
  readAuthoritativeTaskStates,
} from './authoritative-task-state';
import { isNotFound } from './backend-actions';
import { GITHUB_DATA_TAG } from './cache-tags';
import {
  DASHBOARD_CACHE_LIFE,
  type Fetched,
  getCachedAgentActivity,
  oldestFetchedAt,
} from './dashboard-data';
import {
  getGithubClient,
  repoItemKey,
  resolveWatchedRepo,
  UnwatchedRepoError,
  type WatchedRepo,
} from './github-client';
import { enrichItems, type ItemEnrichment } from './item-enrichment';
import {
  deriveLogicalWork,
  type ExecutionAttempt,
  type LogicalWork,
  type LogicalWorkAnomaly,
  type LogicalWorkState,
} from './logical-work';
import { taskRefKey } from './watched-repo';

export type TaskDetailResult =
  | {
      status: 'ok';
      work: LogicalWork;
      /** This task's own orchestrator run history, verbatim - order not
       * guaranteed (see `AuthoritativeTaskState.runs`'s own doc comment).
       * Empty for a task with no orchestrator state (pre-cutover history,
       * or a repo the orchestrator never covers); `LogicalWorkCard` renders
       * this natively (#1015) alongside `work.attempts`'s legacy list
       * whenever non-empty, and falls back to the legacy list alone when
       * it's empty. */
      runs: OrchestratorRun[];
      item: ActionItem;
      repo: WatchedRepo;
      anchorState: 'open' | 'closed';
      /** The oldest `fetchedAt` of every cached source this result was
       * built from (see `dashboard-data.ts`'s `oldestFetchedAt`) - the page
       * component's "Updated ..." label reads this instead of the render
       * time, so a cache hit up to `DASHBOARD_CACHE_LIFE` old doesn't
       * misreport itself as "just now". */
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
 * Fetches the exact issue/PR plus its comment-window enrichment, cached
 * under the same `GITHUB_DATA_TAG`/`DASHBOARD_CACHE_LIFE`
 * window as the rest of the dashboard's GitHub reads (see
 * `dashboard-data.ts`'s `getCachedActionItems`/`getCachedAgentActivity`).
 * Scoped to a single task lookup rather than widening the open-items-only
 * `getCachedActionItems` - a closed/merged task this route must still
 * resolve was never on that board to begin with.
 *
 * Without this boundary the page's Refresh button (which busts
 * `GITHUB_DATA_TAG`) had nothing of this page's own to bust: the issue/PR
 * half of the page was always fresh (uncached), but attempts still came from
 * the cached `getCachedAgentActivity()`, so a click could leave the
 * attempts list showing up to `DASHBOARD_CACHE_LIFE`-stale data with no way
 * to force it current.
 *
 * Returns the same `Fetched<T>` shape `getCachedActionItems`/
 * `getCachedAgentActivity` do, timestamped INSIDE the cached function so the
 * timestamp is cached alongside the data it describes (see `Fetched`'s own
 * doc comment) - a cache hit must report the data's real age, not the
 * render time.
 */
async function fetchTaskSource(
  repo: WatchedRepo,
  issueNumber: number,
): Promise<
  Fetched<{ issue: GithubIssueLike; itemEnrichment?: ItemEnrichment }>
> {
  const octokit = getGithubClient();
  const { data: issue } = await octokit.rest.issues.get({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
  });

  const isPr = Boolean(issue.pull_request);
  // Reuses the same batched GraphQL enrichment the dashboard's board uses
  // (item-enrichment.ts) rather than a bespoke comment fetch.
  const enrichment = await enrichItems(repo, [
    {
      number: issueNumber,
      isPr,
      wantsComments: true,
      wantsMergedDeliverables: true,
    },
  ]);

  return {
    data: { issue, itemEnrichment: enrichment.byNumber.get(issueNumber) },
    fetchedAt: new Date().toISOString(),
  };
}

async function getProductionCachedTaskSource(
  repo: WatchedRepo,
  issueNumber: number,
): Promise<
  Fetched<{ issue: GithubIssueLike; itemEnrichment?: ItemEnrichment }>
> {
  'use cache';
  cacheTag(GITHUB_DATA_TAG);
  cacheLife(DASHBOARD_CACHE_LIFE);
  return fetchTaskSource(repo, issueNumber);
}

/** See dashboard-data.ts's E2E cache-bypass rationale. */
function getCachedTaskSource(
  repo: WatchedRepo,
  issueNumber: number,
): Promise<
  Fetched<{ issue: GithubIssueLike; itemEnrichment?: ItemEnrichment }>
> {
  return isE2eTesting()
    ? fetchTaskSource(repo, issueNumber)
    : getProductionCachedTaskSource(repo, issueNumber);
}

/**
 * Loads everything the `/task/<owner>/<repo>/<issue>` canonical detail page
 * needs, by fetching the exact issue/PR directly rather than depending on
 * the cached open-item board (see `getCachedActionItems`). This is
 * deliberate: the whole point of this route (#306/#264) is that it keeps
 * working once a task closes/merges and drops off the board - a route that
 * only ever looked the task up in `getCachedActionItems`'s open-item
 * listing would 404 for exactly the case it exists to fix.
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
  let itemEnrichment: ItemEnrichment | undefined;
  let sourceFetchedAt: string;
  try {
    const source = await getCachedTaskSource(repo, issueNumber);
    issue = source.data.issue;
    itemEnrichment = source.data.itemEnrichment;
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

  const { data: activity, fetchedAt: activityFetchedAt } =
    await getCachedAgentActivity();
  const allAttempts = [...activity.liveRuns, ...activity.recentRuns];

  const key = repoItemKey(repo, issueNumber);
  const authoritative = await readAuthoritativeTaskStates([
    { repository: repo, issueNumber },
  ]);
  const humanNeeded = labels.includes('status:needs-human');
  const mergedDeliverables = new Set(
    (itemEnrichment?.mergedDeliverables ?? []).map(
      (deliverable) => deliverable.number,
    ),
  );
  // `deriveLogicalWork` does the one join it's needed for here - attributing
  // raw GitHub Actions attempts to `taskMeta`/`unavailableTaskKeys` - and
  // yields the `legacy`/`unavailable` attempts-only provenance.
  // `applyOrchestratorTruth` below then overlays the real authoritative
  // truth - the orchestrator's own task+run history - on top of that.
  const { work } = deriveLogicalWork({
    attempts: allAttempts,
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

  const baseTask = work.find((w) => taskRefKey(w.task) === key);
  // Unreachable in practice - `taskMeta` above always seeds exactly this
  // key - but keeps the return type honest instead of a non-null assertion.
  if (!baseTask) return { status: 'not-found' };
  const task = applyOrchestratorTruth(
    baseTask,
    authoritative.states.get(key),
    mergedDeliverables,
    humanNeeded,
  );

  // Reuse the board's one authoritative action classifier instead of
  // recreating a detail-only partial `ActionItem`. This lets the canonical
  // task page expose the same server-backed controls (unpark, retrigger,
  // and pipeline handoff) as the queue without a second set of label rules.
  const { item } = classifyIssue(
    repo,
    { ...issue, updated_at: issue.updated_at ?? sourceFetchedAt },
    itemEnrichment,
  );

  const state = authoritative.states.get(key);
  return {
    status: 'ok',
    work: task,
    runs: state?.runs ?? [],
    item,
    repo,
    anchorState: issue.state === 'closed' ? 'closed' : 'open',
    // Both cached sources this result was built from - the older of the
    // two is the honest staleness figure (see `oldestFetchedAt`'s own doc
    // comment).
    generatedAt: oldestFetchedAt(sourceFetchedAt, activityFetchedAt),
    ...(state?.spec === undefined ? {} : { spec: state.spec }),
  };
}

/**
 * Overlays `@agent-lcars/orchestrator`'s own task+run truth onto the
 * attempts-only `LogicalWork` `deriveLogicalWork` already built from raw
 * GitHub Actions runs (#1183). Absent authoritative state (no orchestrator
 * task document - a repository outside `controlPlaneRepository()`, or a
 * task the fleet has never touched) leaves `work` exactly as `attempts`
 * alone already describe it, matching `deriveLogicalWork`'s own
 * `legacy`/`unavailable` fallback behavior for "no ledger".
 */
function applyOrchestratorTruth(
  work: LogicalWork,
  state: AuthoritativeTaskState | undefined,
  mergedDeliverables: ReadonlySet<number>,
  humanNeeded: boolean,
): LogicalWork {
  if (!state) return work;

  const { attempts, anomalies: orchestratorAnomalies } =
    attributeAttemptsToOrchestrator(work.attempts, state, mergedDeliverables);
  const anomalies: LogicalWorkAnomaly[] = [
    ...work.anomalies,
    ...orchestratorAnomalies,
  ];
  const orchestratorState = stateFromOrchestratorTask(state);
  // Mirrors `deriveLogicalWork`'s own precedence (unavailable > anomaly >
  // human-needed > the derived base state) - `work.state` here is exactly
  // that base state's result, so
  // 'unavailable' can only mean the read genuinely failed (in which case
  // `state` above would also be undefined) and 'anomaly'/'human-needed' must
  // still outrank the orchestrator's own reading of "what's active".
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
    attempts,
    anomalies,
    state: nextState,
    provenance: { kind: 'authoritative-v1', revision: state.storageRevision },
  };
}

/** A run's own state, coarsened onto `LogicalWorkState`: `pending` means
 * "decided, dispatch not yet confirmed" (dispatching in the old ledger's own
 * vocabulary); `running` is `active`; every terminal state (`finished`,
 * `canceled`, `lost`) means the task is not currently being worked, exactly
 * like the ledger's own `completed`/`dispatch-rejected` states did - the
 * per-attempt `DispatchOutcomeBadge` remains where success/failure actually
 * renders, not this coarse state. */
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

/** Attributes GitHub Actions attempts to orchestrator runs by the
 * `[dispatch:gN:intentId]` run-name marker - `orchestrator-dispatch.ts`
 * mints its workflow-dispatch inputs under the identical `broker_intent_id`/
 * `broker_generation` names, with `intentId` now literally the
 * orchestrator's own `runId` (`{repo}#{issue}/r{generation}`), so the same
 * marker still corroborates a real run. */
function attributeAttemptsToOrchestrator(
  attempts: ExecutionAttempt[],
  state: AuthoritativeTaskState,
  mergedDeliverables: ReadonlySet<number>,
): { attempts: ExecutionAttempt[]; anomalies: LogicalWorkAnomaly[] } {
  const byRunId = new Map(state.runs.map((run) => [run.runId, run]));
  const anomalies: LogicalWorkAnomaly[] = [];
  const attributed = attempts.map((attempt) => {
    if (attempt.intentId === undefined) return attempt;
    const run = byRunId.get(attempt.intentId);
    if (!run) {
      anomalies.push({
        kind: 'attempt-ledger-mismatch',
        detail: `Run ${attempt.id} carries intent ${attempt.intentId}, which is not in this task's orchestrator run history.`,
      });
      return attempt;
    }
    return {
      ...attempt,
      generation: generationFromRunId(run.runId) ?? attempt.generation,
      attribution: 'orchestrator' as const,
      outcome: outcomeFromRunResult(run, mergedDeliverables) ?? attempt.outcome,
    };
  });
  return { attempts: attributed, anomalies };
}

/** A run's own id is `{repo}#{issue}/r{generation}` (see
 * `libs/orchestrator/src/decide.ts`'s `requestRun`); this pulls the
 * trailing generation number back out for display parity with the marker's
 * own `g<generation>` badge. */
function generationFromRunId(runId: string): number | undefined {
  const match = /\/r(\d+)$/u.exec(runId);
  return match ? Number(match[1]) : undefined;
}

/**
 * Maps a finished run's own `RunResult` (`{ok, summary?, ref?}` - see
 * `libs/orchestrator/src/model.ts`) onto the existing `DispatchOutcomeKind`
 * vocabulary as honestly as the orchestrator's own data allows. The
 * orchestrator deliberately does not preserve the legacy worker's
 * fine-grained failure classification (startup/trajectory/outcome-gate) -
 * only a boolean `ok` - so an unsuccessful run reports no outcome kind at
 * all here rather than guessing one; the raw GitHub Actions conclusion
 * (via `classifyAgentRun`'s own fallback) still drives that attempt's
 * status badge.
 */
function outcomeFromRunResult(
  run: AuthoritativeTaskState['runs'][number],
  mergedDeliverables: ReadonlySet<number>,
): DispatchOutcomeKind | undefined {
  if (run.state !== 'finished' || !run.result?.ok) return undefined;
  const prNumber = pullRequestNumberFromRef(run.result.ref);
  if (prNumber !== undefined && mergedDeliverables.has(prNumber)) {
    return 'merged-deliverable';
  }
  return prNumber !== undefined ? 'pull-request' : 'unknown-success';
}

function pullRequestNumberFromRef(ref: string | undefined): number | undefined {
  if (!ref) return undefined;
  const match = /\/pull\/(\d+)$/u.exec(ref);
  return match ? Number(match[1]) : undefined;
}
