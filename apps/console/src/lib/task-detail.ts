import { getCachedAgentActivity } from './dashboard-data';
import {
  getGithubClient,
  repoItemKey,
  resolveWatchedRepo,
  UnwatchedRepoError,
  type WatchedRepo,
} from './github-client';
import { enrichItems } from './item-enrichment';
import { deriveLogicalWork, type LogicalWork } from './logical-work';
import { taskRefKey } from './watched-repo';

export type TaskDetailResult =
  | {
      status: 'ok';
      work: LogicalWork;
      repo: WatchedRepo;
      anchorState: 'open' | 'closed';
    }
  | { status: 'not-found' }
  | { status: 'error'; warning: string };

interface GithubIssueLike {
  number: number;
  title: string;
  html_url: string;
  state: string;
  pull_request?: unknown;
  labels: (string | { name?: string })[];
}

function hasStatus(error: unknown, status: number): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status?: unknown }).status === status
  );
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

  const octokit = getGithubClient();
  let issue: GithubIssueLike;
  try {
    const response = await octokit.rest.issues.get({
      owner: repo.owner,
      repo: repo.name,
      issue_number: issueNumber,
    });
    issue = response.data;
  } catch (error) {
    if (hasStatus(error, 404)) return { status: 'not-found' };
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

  const isPr = Boolean(issue.pull_request);
  const labels = issue.labels.map((label) =>
    typeof label === 'string' ? label : (label.name ?? ''),
  );

  // Reuses the same batched GraphQL enrichment the dashboard's board uses
  // (item-enrichment.ts) rather than a bespoke comment fetch, so ledger
  // parsing stays the one code path (see toEnrichment's `ledger` field).
  const enrichment = await enrichItems(repo, [
    { number: issueNumber, isPr, wantsComments: true },
  ]);
  const itemEnrichment = enrichment.byNumber.get(issueNumber);

  const { data: activity } = await getCachedAgentActivity();
  const attempts = activity.liveRunAttempts ?? activity.liveRuns;
  const allAttempts = [...attempts, ...activity.recentRuns];

  const key = repoItemKey(repo, issueNumber);
  const { work } = deriveLogicalWork({
    attempts: allAttempts,
    ledgers: itemEnrichment?.ledger
      ? new Map([[key, itemEnrichment.ledger]])
      : new Map(),
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
  });

  const task = work.find((w) => taskRefKey(w.task) === key);
  // Unreachable in practice - `taskMeta` above always seeds exactly this
  // key - but keeps the return type honest instead of a non-null assertion.
  if (!task) return { status: 'not-found' };

  return {
    status: 'ok',
    work: task,
    repo,
    anchorState: issue.state === 'closed' ? 'closed' : 'open',
  };
}
