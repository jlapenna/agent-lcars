import { getGithubClient, REPO_NAME, REPO_OWNER } from './github-client';

/** The human this console serves: review requests are matched against this
 * login, and a newest comment by it means the ball is back with the agent. */
export const MAINTAINER_LOGIN = 'jlapenna';

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
  /** Login of the newest comment's author - the possession signal. */
  lastCommentAuthor?: string;
  parentNumber?: number;
  subIssues?: SubIssuesSummary;
  linkedIssueNumbers?: number[];
  draft?: boolean;
  mergeableState?: MergeableState;
  failingChecks?: { name: string; url: string }[];
  /** Some check run on the PR's head is still queued or in progress. */
  ciRunning?: boolean;
}

export interface ActionItemsResult {
  items: ActionItem[];
  /** Human-readable notes when a query or item degraded instead of crashing. */
  warnings: string[];
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

/**
 * True when the maintainer already answered a `human-needed` item: the
 * newest comment is theirs, so the ball is back with the agent even though
 * the label is still set (replies posted directly on GitHub don't clear it
 * the way console replies do). Only `human-needed` is possession-based -
 * a failing CI run or an open review request needs the maintainer no matter
 * who spoke last.
 */
export function isHandedBack(item: ActionItem): boolean {
  return (
    item.actionTypes.includes('human-needed') &&
    item.lastCommentAuthor === MAINTAINER_LOGIN &&
    item.actionTypes.every(
      (type) => type === 'human-needed' || type === 'post-deploy-action',
    )
  );
}

// human-needed and review-requested are tied at the top tier: both mean an
// agent cannot make further progress without Joe, so neither should get
// buried behind run-failed items an agent may still be actively fixing.
const ACTION_PRIORITY: Record<ActionType, number> = {
  'human-needed': 0,
  'review-requested': 0,
  'run-failed': 1,
  'post-deploy-action': 2,
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
  author?: string;
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
    last: last?.body
      ? {
          body: last.body,
          url: last.html_url,
          author: last.user?.login ?? undefined,
        }
      : undefined,
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

interface CheckRunLike {
  name: string;
  html_url?: string | null;
  status: string;
  conclusion: string | null;
}

// GitHub caps a single page at 100; a handful of pages comfortably covers
// any real PR (one check run per workflow job, across a few workflows) -
// this bounds the loop rather than expecting to actually hit it.
const CHECKS_PER_PAGE = 100;
const CHECKS_MAX_PAGES = 5;

async function listAllCheckRuns(
  sha: string,
): Promise<{ checkRuns: CheckRunLike[]; truncated: boolean }> {
  const octokit = getGithubClient();
  const checkRuns: CheckRunLike[] = [];
  let totalCount = 0;
  for (let page = 1; page <= CHECKS_MAX_PAGES; page++) {
    const { data } = await octokit.rest.checks.listForRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: sha,
      per_page: CHECKS_PER_PAGE,
      page,
    });
    totalCount = data.total_count;
    checkRuns.push(...data.check_runs);
    if (
      data.check_runs.length < CHECKS_PER_PAGE ||
      checkRuns.length >= totalCount
    ) {
      break;
    }
  }
  return { checkRuns, truncated: checkRuns.length < totalCount };
}

interface ClassifyResult {
  item: ActionItem;
  warnings: string[];
}

async function classifyIssue(issue: SearchIssue): Promise<ClassifyResult> {
  const octokit = getGithubClient();
  const warnings: string[] = [];
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
  let lastCommentAuthor: string | undefined;
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
      lastCommentAuthor = scan.last?.author;
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
      (reviewer) => reviewer.login === MAINTAINER_LOGIN,
    );
    if (reviewRequested && !pr.draft) {
      actionTypes.push('review-requested');
    }

    // Same defensive pattern as the search queries below: a single GitHub
    // API hiccup for one PR (e.g. a token lacking the "Checks: read"
    // permission) must not crash the whole dashboard for every item.
    try {
      const { checkRuns, truncated } = await listAllCheckRuns(pr.head.sha);
      if (truncated) {
        warnings.push(
          `Check runs truncated for #${issue.number} (over ${CHECKS_MAX_PAGES * CHECKS_PER_PAGE} runs) - some failures may not be shown.`,
        );
      }
      // Only genuine failures count: a `cancelled` conclusion is almost
      // always a superseded or manually-killed run, and badging it "CI run
      // failed" steered the maintainer toward retriggers nobody needed.
      const failed = checkRuns.filter(
        (run) => run.status === 'completed' && run.conclusion === 'failure',
      );
      if (failed.length > 0) {
        actionTypes.push('run-failed');
        failingChecks = failed.map((run) => ({
          name: run.name,
          url: run.html_url ?? issue.html_url,
        }));
      }
      ciRunning = checkRuns.some((run) => run.status !== 'completed');
    } catch (error) {
      console.error(
        `agent-console: failed to list check runs for #${issue.number}:`,
        error,
      );
      warnings.push(`Check runs unavailable for #${issue.number}.`);
    }
  }

  const subIssuesSummary = issue.sub_issues_summary;

  const item: ActionItem = {
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
    lastCommentAuthor,
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
  return { item, warnings };
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
  // human-needed is one of this dashboard's own action types, but not every
  // human-gated item is agent-touched: an ops decision issue (e.g. #2130) can
  // carry human-needed without ever having the claude label or an agent
  // author, and without this query it never enters the dashboard at all.
  'is:open label:human-needed',
  'is:open author:app/claude',
  'is:open review-requested:jlapenna',
];
const SEARCH_QUERIES = BASE_QUERIES.flatMap((query) => [
  `${query} is:issue`,
  `${query} is:pull-request`,
]);

// GitHub's search API hard-caps any single query at 1000 results (per_page
// maxes at 100, so 10 pages is the true ceiling) - paging past that just
// 422s, so this loop stops there and flags the query as truncated instead.
const SEARCH_PER_PAGE = 100;
const SEARCH_MAX_PAGES = 10;

async function searchAll(
  query: string,
): Promise<{ items: SearchIssue[]; truncated: boolean }> {
  const octokit = getGithubClient();
  const items: SearchIssue[] = [];
  let totalCount = 0;
  for (let page = 1; page <= SEARCH_MAX_PAGES; page++) {
    const { data } = await octokit.rest.search.issuesAndPullRequests({
      q: `repo:${REPO_OWNER}/${REPO_NAME} ${query}`,
      per_page: SEARCH_PER_PAGE,
      page,
    });
    totalCount = data.total_count;
    items.push(...(data.items as SearchIssue[]));
    if (data.items.length < SEARCH_PER_PAGE || items.length >= totalCount) {
      break;
    }
  }
  return { items, truncated: items.length < totalCount };
}

export async function getActionItems(): Promise<ActionItemsResult> {
  const warnings: string[] = [];

  // One malformed/rejected query (e.g. a future GitHub search-API contract
  // change, as already happened once - see the SEARCH_QUERIES comment)
  // shouldn't take down the whole dashboard. Log and skip it instead.
  const results = await Promise.allSettled(
    SEARCH_QUERIES.map((query) => searchAll(query)),
  );

  const byNumber = new Map<number, SearchIssue>();
  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') {
      console.error(
        `agent-console: search query failed (${SEARCH_QUERIES[i]}):`,
        result.reason,
      );
      warnings.push(`Search query failed: "${SEARCH_QUERIES[i]}".`);
      continue;
    }
    if (result.value.truncated) {
      warnings.push(
        `Search results truncated (over ${SEARCH_MAX_PAGES * SEARCH_PER_PAGE} matches) for: "${SEARCH_QUERIES[i]}".`,
      );
    }
    for (const issue of result.value.items) {
      byNumber.set(issue.number, issue);
    }
  }

  // Defense in depth: an unexpected error classifying one item (a GitHub API
  // hiccup, a malformed search result, etc.) should drop that one item, not
  // crash the whole dashboard for everyone.
  const issuesToClassify = Array.from(byNumber.values());
  const classified = await Promise.allSettled(
    issuesToClassify.map((issue) => classifyIssue(issue)),
  );
  const items: ActionItem[] = [];
  for (const [i, result] of classified.entries()) {
    if (result.status === 'rejected') {
      console.error(
        'agent-console: failed to classify an item:',
        result.reason,
      );
      warnings.push(`Failed to classify #${issuesToClassify[i].number}.`);
      continue;
    }
    items.push(result.value.item);
    warnings.push(...result.value.warnings);
  }

  items.sort((a, b) => itemPriority(a) - itemPriority(b));
  return { items, warnings };
}
