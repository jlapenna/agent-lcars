import { parseTerminalQuickTaskBody } from '@agent-lcars/dispatch-contracts';
import { cacheLife, cacheTag } from 'next/cache';

import type { ActionItem } from './action-items';
import { readAuthoritativeTaskStates } from './authoritative-task-state';
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
import { deriveLogicalWork, type LogicalWork } from './logical-work';
import { taskRefKey } from './watched-repo';

export type TaskDetailResult =
  | {
      status: 'ok';
      work: LogicalWork;
      item: ActionItem;
      repo: WatchedRepo;
      anchorState: 'open' | 'closed';
      /** The oldest `fetchedAt` of every cached source this result was
       * built from (see `dashboard-data.ts`'s `oldestFetchedAt`) - the page
       * component's "Updated ..." label reads this instead of the render
       * time, so a cache hit up to `DASHBOARD_CACHE_LIFE` old doesn't
       * misreport itself as "just now". */
      generatedAt: string;
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
 * Fetches the exact issue/PR plus its comment-window enrichment (ledger
 * included), cached under the same `GITHUB_DATA_TAG`/`DASHBOARD_CACHE_LIFE`
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
async function getCachedTaskSource(
  repo: WatchedRepo,
  issueNumber: number,
): Promise<
  Fetched<{ issue: GithubIssueLike; itemEnrichment?: ItemEnrichment }>
> {
  'use cache';
  cacheTag(GITHUB_DATA_TAG);
  cacheLife(DASHBOARD_CACHE_LIFE);

  const octokit = getGithubClient();
  const { data: issue } = await octokit.rest.issues.get({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
  });

  const isPr = Boolean(issue.pull_request);
  // Reuses the same batched GraphQL enrichment the dashboard's board uses
  // (item-enrichment.ts) rather than a bespoke comment fetch, so ledger
  // parsing stays the one code path (see toEnrichment's `ledger` field).
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
  const authoritativeState = authoritative.states.get(key);
  const { work } = deriveLogicalWork({
    attempts: allAttempts,
    ledgers: authoritativeState
      ? new Map([[key, authoritativeState.controllerState]])
      : new Map(),
    authoritativeRevisions: authoritativeState
      ? new Map([[key, authoritativeState.storageRevision]])
      : new Map(),
    unavailableTaskKeys: authoritative.unavailableTaskKeys,
    taskMeta: new Map([
      [
        key,
        {
          repo,
          issueNumber,
          title: issue.title,
          url: issue.html_url,
          humanNeeded: labels.includes('status:needs-human'),
        },
      ],
    ]),
    mergedDeliverables: new Map([
      [
        key,
        new Set(
          (itemEnrichment?.mergedDeliverables ?? []).map(
            (deliverable) => deliverable.number,
          ),
        ),
      ],
    ]),
  });

  const task = work.find((w) => taskRefKey(w.task) === key);
  // Unreachable in practice - `taskMeta` above always seeds exactly this
  // key - but keeps the return type honest instead of a non-null assertion.
  if (!task) return { status: 'not-found' };

  return {
    status: 'ok',
    work: task,
    item: {
      kind: issue.pull_request ? 'pr' : 'issue',
      repo,
      number: issue.number,
      title: issue.title,
      body:
        parseTerminalQuickTaskBody(issue.body)?.description ?? issue.body ?? '',
      url: issue.html_url,
      author: issue.user?.login ?? undefined,
      updatedAt: issue.updated_at ?? sourceFetchedAt,
      actionTypes: [],
      labels: labels.filter((label) => label.length > 0),
      assigneeLogins: (issue.assignees ?? [])
        .map((assignee) => assignee?.login ?? '')
        .filter((login) => login.length > 0),
    },
    repo,
    anchorState: issue.state === 'closed' ? 'closed' : 'open',
    // Both cached sources this result was built from - the older of the
    // two is the honest staleness figure (see `oldestFetchedAt`'s own doc
    // comment).
    generatedAt: oldestFetchedAt(sourceFetchedAt, activityFetchedAt),
  };
}
