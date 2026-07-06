import { getGithubClient, REPO_NAME, REPO_OWNER } from './github-client';

export type ActionType =
  'human-needed' | 'run-failed' | 'review-requested' | 'post-deploy-action';

export type MergeableState =
  'clean' | 'dirty' | 'blocked' | 'unstable' | 'behind' | 'draft' | 'unknown';

export interface SubIssuesSummary {
  total: number;
  completed: number;
}

export interface ActionItem {
  kind: 'issue' | 'pr';
  number: number;
  title: string;
  url: string;
  author?: string;
  updatedAt: string;
  actionTypes: ActionType[];
  labels: string[];
  /** Newest `claude-agent-session.sh resume <id>` command the agent posted. */
  takeoverCommand?: string;
  lastCommentBody?: string;
  lastCommentUrl?: string;
  parentNumber?: number;
  subIssues?: SubIssuesSummary;
  linkedIssueNumbers?: number[];
  draft?: boolean;
  mergeableState?: MergeableState;
  failingChecks?: { name: string; url: string }[];
  /** Some check run on the PR's head is still queued or in progress. */
  ciRunning?: boolean;
}

/**
 * True when all that's left on the item is waiting for the next deploy: the
 * post-deploy verification agent verifies and closes these automatically,
 * so they are not the maintainer's to act on.
 */
export function isDeployWaitOnly(item: ActionItem): boolean {
  return (
    item.actionTypes.length > 0 &&
    item.actionTypes.every((type) => type === 'post-deploy-action')
  );
}

const ACTION_PRIORITY: Record<ActionType, number> = {
  'human-needed': 0,
  'run-failed': 1,
  'review-requested': 2,
  'post-deploy-action': 3,
};

function itemPriority(item: ActionItem): number {
  if (item.actionTypes.length === 0) return Number.MAX_SAFE_INTEGER;
  return Math.min(...item.actionTypes.map((type) => ACTION_PRIORITY[type]));
}

// These already get a dedicated, colored action-type badge (see
// ACTION_LABELS in action-item-card.tsx) - repeating them in the plain
// label list would just be noise.
const LABELS_SHOWN_AS_ACTION_TYPES = new Set([
  'human-needed',
  'post-deploy-action',
]);

interface LastComment {
  body: string;
  url: string;
}

interface CommentScan {
  last?: LastComment;
  takeoverCommand?: string;
}

// The agent's kickoff prompt (see .github/workflows/claude.yml) makes it
// post its exact takeover command in its first ack comment, e.g.
// `~/p/members/tools/claude-agent-session.sh resume <session-id>`. Each new
// run posts a fresh one, so the newest match wins.
const TAKEOVER_COMMAND_RE = /(\S*claude-agent-session\.sh\s+resume\s+[\w-]+)/;

// issues.listComments has no sort/direction parameters (unlike the
// repo-level comment listings) - it ALWAYS returns ascending created order,
// so the newest comments live on the LAST page. Verified live: passing
// sort/direction is silently ignored, which used to make this scan return
// the issue's oldest comment as the "last response" and the takeover command
// of the first (long-dead) session.
const COMMENTS_PER_PAGE = 100;

async function scanComments(
  issueNumber: number,
  commentCount: number,
): Promise<CommentScan> {
  const octokit = getGithubClient();
  const lastPage = Math.max(1, Math.ceil(commentCount / COMMENTS_PER_PAGE));
  let { data: comments } = await octokit.rest.issues.listComments({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    issue_number: issueNumber,
    per_page: COMMENTS_PER_PAGE,
    page: lastPage,
  });
  // The count from the search index can lag deletions; if the computed page
  // is past the end, step back one page rather than reporting no comments.
  if (comments.length === 0 && lastPage > 1) {
    ({ data: comments } = await octokit.rest.issues.listComments({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      issue_number: issueNumber,
      per_page: COMMENTS_PER_PAGE,
      page: lastPage - 1,
    }));
  }
  const last = comments[comments.length - 1];
  let takeoverCommand: string | undefined;
  for (let i = comments.length - 1; i >= 0; i--) {
    const match = comments[i].body?.match(TAKEOVER_COMMAND_RE);
    if (match) {
      takeoverCommand = match[1];
      break;
    }
  }
  return {
    last: last?.body ? { body: last.body, url: last.html_url } : undefined,
    takeoverCommand,
  };
}

interface SearchIssue {
  number: number;
  title: string;
  html_url: string;
  body?: string | null;
  updated_at: string;
  user?: { login?: string } | null;
  labels: (string | { name?: string })[];
  pull_request?: unknown;
  parent_issue_url?: string | null;
  sub_issues_summary?: { total: number; completed: number };
  comments?: number;
}

// GitHub's own closing-keyword syntax: "closes #123", "fixes #123", etc.
// Cross-repo references (owner/repo#123) are out of scope - triage only
// needs same-repo hierarchy.
const CLOSING_KEYWORD_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)/gi;

function extractLinkedIssueNumbers(
  body: string | null | undefined,
  selfNumber: number,
): number[] | undefined {
  if (!body) return undefined;
  const numbers = new Set<number>();
  for (const match of body.matchAll(CLOSING_KEYWORD_RE)) {
    const n = Number(match[1]);
    if (n !== selfNumber) numbers.add(n);
  }
  return numbers.size > 0 ? Array.from(numbers) : undefined;
}

function extractParentNumber(
  parentIssueUrl: string | null | undefined,
): number | undefined {
  const match = parentIssueUrl?.match(/\/issues\/(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

async function classifyIssue(issue: SearchIssue): Promise<ActionItem> {
  const octokit = getGithubClient();
  const isPr = Boolean(issue.pull_request);
  const labels = issue.labels.map((label) =>
    typeof label === 'string' ? label : (label.name ?? ''),
  );
  const isPostDeploy = labels.includes('post-deploy-action');
  const isHumanNeeded = labels.includes('human-needed');

  const actionTypes: ActionType[] = [];
  if (isHumanNeeded) {
    actionTypes.push('human-needed');
  }
  if (isPostDeploy) {
    actionTypes.push('post-deploy-action');
  }

  let lastCommentBody: string | undefined;
  let lastCommentUrl: string | undefined;
  let takeoverCommand: string | undefined;
  // Comment fetches cost one API call per item, so stay scoped: actionable
  // items (for the comment preview) plus claude-labeled issues (where the
  // agent's ack comment carries the session takeover command; PRs never
  // do - the agent only posts it on the issue it picked up).
  const wantsTakeover = !isPr && labels.includes('claude');
  if (isHumanNeeded || isPostDeploy || wantsTakeover) {
    const scan = await scanComments(issue.number, issue.comments ?? 0);
    if (isHumanNeeded || isPostDeploy) {
      lastCommentBody = scan.last?.body;
      lastCommentUrl = scan.last?.url;
    }
    takeoverCommand = wantsTakeover ? scan.takeoverCommand : undefined;
  }

  let draft: boolean | undefined;
  let mergeableState: MergeableState | undefined;
  let failingChecks: { name: string; url: string }[] | undefined;
  let ciRunning: boolean | undefined;
  let linkedIssueNumbers = extractLinkedIssueNumbers(issue.body, issue.number);

  if (isPr) {
    const { data: pr } = await octokit.rest.pulls.get({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      pull_number: issue.number,
    });
    draft = pr.draft;
    mergeableState = (pr.mergeable_state as MergeableState) || 'unknown';
    // The PR body returned here is authoritative (search results can lag);
    // prefer it when present.
    linkedIssueNumbers =
      extractLinkedIssueNumbers(pr.body, issue.number) ?? linkedIssueNumbers;

    // A review request on a draft isn't actionable yet - the agent asks for
    // review at PR creation, but a draft is by definition still being
    // iterated on. It surfaces once the PR is marked ready.
    const reviewRequested = pr.requested_reviewers?.some(
      (reviewer) => reviewer.login === 'jlapenna',
    );
    if (reviewRequested && !pr.draft) {
      actionTypes.push('review-requested');
    }

    // Same defensive pattern as the search queries below: a single GitHub
    // API hiccup for one PR (e.g. a token lacking the "Checks: read"
    // permission) must not crash the whole dashboard for every item.
    try {
      const { data: checkRuns } = await octokit.rest.checks.listForRef({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        ref: pr.head.sha,
        per_page: 20,
      });
      // Only genuine failures count: a `cancelled` conclusion is almost
      // always a superseded or manually-killed run, and badging it "CI run
      // failed" steered the maintainer toward retriggers nobody needed.
      const failed = checkRuns.check_runs.filter(
        (run) => run.status === 'completed' && run.conclusion === 'failure',
      );
      if (failed.length > 0) {
        actionTypes.push('run-failed');
        failingChecks = failed.map((run) => ({
          name: run.name,
          url: run.html_url ?? issue.html_url,
        }));
      }
      ciRunning = checkRuns.check_runs.some(
        (run) => run.status !== 'completed',
      );
    } catch (error) {
      console.error(
        `agent-console: failed to list check runs for #${issue.number}:`,
        error,
      );
    }
  }

  const subIssuesSummary = issue.sub_issues_summary;

  return {
    kind: isPr ? 'pr' : 'issue',
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    author: issue.user?.login ?? undefined,
    updatedAt: issue.updated_at,
    actionTypes,
    labels: labels.filter((label) => !LABELS_SHOWN_AS_ACTION_TYPES.has(label)),
    takeoverCommand,
    lastCommentBody,
    lastCommentUrl,
    parentNumber: extractParentNumber(issue.parent_issue_url),
    subIssues:
      subIssuesSummary && subIssuesSummary.total > 0
        ? {
            total: subIssuesSummary.total,
            completed: subIssuesSummary.completed,
          }
        : undefined,
    linkedIssueNumbers,
    draft,
    mergeableState,
    failingChecks,
    ciRunning,
  };
}

// The search/issues API's `OR` only applies to free-text terms, not
// qualifiers (`label:`/`author:`/`review-requested:`) - `q:
// "label:claude OR author:app/claude"` 422s. Run one query per qualifier
// and dedupe by issue number instead.
//
// GitHub's search API also now rejects any query that doesn't explicitly
// say `is:issue` or `is:pull-request` ("Query must include 'is:issue' or
// 'is:pull-request'", 422) - there's no single qualifier meaning "both", so
// each base query below is expanded into both variants.
const BASE_QUERIES = [
  'is:open label:claude',
  'is:open author:app/claude',
  'is:open review-requested:jlapenna',
];
const SEARCH_QUERIES = BASE_QUERIES.flatMap((query) => [
  `${query} is:issue`,
  `${query} is:pull-request`,
]);

export async function getActionItems(): Promise<ActionItem[]> {
  const octokit = getGithubClient();

  // One malformed/rejected query (e.g. a future GitHub search-API contract
  // change, as already happened once - see the SEARCH_QUERIES comment)
  // shouldn't take down the whole dashboard. Log and skip it instead.
  const results = await Promise.allSettled(
    SEARCH_QUERIES.map((query) =>
      octokit.rest.search.issuesAndPullRequests({
        q: `repo:${REPO_OWNER}/${REPO_NAME} ${query}`,
        per_page: 50,
      }),
    ),
  );

  const byNumber = new Map<number, SearchIssue>();
  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') {
      console.error(
        `agent-console: search query failed (${SEARCH_QUERIES[i]}):`,
        result.reason,
      );
      continue;
    }
    for (const issue of result.value.data.items) {
      byNumber.set(issue.number, issue as SearchIssue);
    }
  }

  // Defense in depth: an unexpected error classifying one item (a GitHub API
  // hiccup, a malformed search result, etc.) should drop that one item, not
  // crash the whole dashboard for everyone.
  const classified = await Promise.allSettled(
    Array.from(byNumber.values()).map((issue) => classifyIssue(issue)),
  );
  const items: ActionItem[] = [];
  for (const result of classified) {
    if (result.status === 'rejected') {
      console.error(
        'agent-console: failed to classify an item:',
        result.reason,
      );
      continue;
    }
    items.push(result.value);
  }

  return items.sort((a, b) => itemPriority(a) - itemPriority(b));
}
