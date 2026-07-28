import { agentFleetLogin, maintainerLogin } from './deployment';
import {
  getGithubClient,
  getWatchedRepos,
  repoItemKey,
  repoKey,
  type WatchedRepo,
} from './github-client';

/** Re-exported for the modules that already import it from here. The value
 * itself now comes from `deployment.ts`, which is the single place this
 * instance's identity lives. */
export { agentFleetLogin, maintainerLogin };

export type ActionType =
  | 'human-needed'
  | 'run-failed'
  | 'review-requested'
  | 'post-deploy-action'
  // A finished run's GitHub conclusion said success, but its joined session
  // telemetry shows a session-provable anomaly (an error result - expired
  // token, max-turns exhaustion, a crash - or essentially zero recorded
  // work: zero turns, or zero cost across at most one turn). Deliberately
  // NOT "no PR/commit" - claude.yml's own server-side gates already fail
  // the job before a run can report success with no deliverable evidence in
  // GitHub state (#2497), so re-checking that here would just flood this
  // tier with routine comment-only replies. See run-status-classifier.ts
  // for the exact signature set. Derived by run-classification.ts's
  // deriveSilentErrorDiagnoses, not by classifyIssue below (this is the one
  // ActionType this module never sets itself - see page.tsx, the only place
  // with both the item list and the run/session telemetry needed to compute
  // it).
  | 'silent-error';

export type MergeableState =
  'clean' | 'dirty' | 'blocked' | 'unstable' | 'behind' | 'draft' | 'unknown';

export interface SubIssuesSummary {
  total: number;
  completed: number;
}

export interface ActionItem {
  kind: 'issue' | 'pr';
  /** Which watched repo this item belongs to - issue/PR numbers only
   * disambiguate within one repo, so any join keyed on `number` alone must
   * key on `repoItemKey(item.repo, item.number)` instead once more than one
   * repo is configured. */
  repo: WatchedRepo;
  number: number;
  title: string;
  url: string;
  author?: string;
  updatedAt: string;
  actionTypes: ActionType[];
  labels: string[];
  /** GitHub logins assigned to this item (#2783 ownership spine) - e.g.
   * `jclaw-bot` means the agent fleet has claimed it. Used by the /agents
   * page's stale-claim detection (see claimed-idle.ts); no console surface
   * needed it before that. */
  assigneeLogins: string[];
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
  /** Set alongside the `silent-error` actionType - the classifier's short
   * explanation of what looks wrong despite GitHub reporting success (see
   * `run-classification.ts`'s `deriveSilentErrorDiagnoses`). */
  silentErrorDiagnosis?: string;
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
    item.lastCommentAuthor === maintainerLogin() &&
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
  'silent-error': 1,
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
  repo: WatchedRepo,
  issueNumber: number,
  commentCount: number,
): Promise<CommentScan> {
  const octokit = getGithubClient();
  const lastPage = Math.max(1, Math.ceil(commentCount / COMMENTS_PER_PAGE));
  let { data: comments } = await octokit.rest.issues.listComments({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
    per_page: COMMENTS_PER_PAGE,
    page: lastPage,
  });
  // The count from the search index can lag deletions; if the computed page
  // is past the end, step back one page rather than reporting no comments.
  if (comments.length === 0 && lastPage > 1) {
    ({ data: comments } = await octokit.rest.issues.listComments({
      owner: repo.owner,
      repo: repo.name,
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

/** One item as returned by `issues.listForRepo`, which serves both issues
 * and PRs (a PR is an issue carrying a `pull_request` key). Verified against
 * the live API: this response carries `labels`, `assignees`, `comments`,
 * `sub_issues_summary` and - on sub-issues - `parent_issue_url`, so it is a
 * complete replacement for the search-result shape this used to be. */
interface RepoIssue {
  number: number;
  title: string;
  html_url: string;
  body?: string | null;
  updated_at: string;
  user?: { login?: string } | null;
  labels: (string | { name?: string })[];
  assignees?: ({ login?: string } | null)[] | null;
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
  repo: WatchedRepo,
  sha: string,
): Promise<{ checkRuns: CheckRunLike[]; truncated: boolean }> {
  const octokit = getGithubClient();
  const checkRuns: CheckRunLike[] = [];
  let totalCount = 0;
  for (let page = 1; page <= CHECKS_MAX_PAGES; page++) {
    const { data } = await octokit.rest.checks.listForRef({
      owner: repo.owner,
      repo: repo.name,
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

async function classifyIssue(
  repo: WatchedRepo,
  issue: RepoIssue,
): Promise<ClassifyResult> {
  const octokit = getGithubClient();
  const warnings: string[] = [];
  const isPr = Boolean(issue.pull_request);
  const labels = issue.labels.map((label) =>
    typeof label === 'string' ? label : (label.name ?? ''),
  );
  const isPostDeploy = labels.includes('post-deploy-action');
  const assigneeLogins = (issue.assignees ?? []).map(
    (assignee) => assignee?.login ?? '',
  );
  // Label only, deliberately (#2802 decided: keep the label). An
  // assignee-pair fallback was tried as migration groundwork, but assignees
  // are additive-only — un-parking removes the label, never the assignees —
  // so the pair kept items in Your Queue forever after they were answered,
  // and claude.yml's deliverable check + pr-heal's park-check key on the
  // label anyway (#3023).
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
  // items (for the comment preview) plus anything the agent fleet has
  // claimed via the assignee field (#2783) - issues AND PRs alike, since
  // every session now announces its takeover command where it works:
  // claude.yml runs on their anchor issue/PR, interactive sessions per
  // pr.md Step 0 and the SKILL.md claim guardrail.
  const wantsTakeover = assigneeLogins.includes(agentFleetLogin());
  if (isHumanNeeded || isPostDeploy || wantsTakeover) {
    const scan = await scanComments(repo, issue.number, issue.comments ?? 0);
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
      owner: repo.owner,
      repo: repo.name,
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
      (reviewer) => reviewer.login === maintainerLogin(),
    );
    if (reviewRequested && !pr.draft) {
      actionTypes.push('review-requested');
    }

    // Same defensive pattern as the search queries below: a single GitHub
    // API hiccup for one PR (e.g. a token lacking the "Checks: read"
    // permission) must not crash the whole dashboard for every item.
    try {
      const { checkRuns, truncated } = await listAllCheckRuns(
        repo,
        pr.head.sha,
      );
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
      // %s, not a template literal: issue.number ultimately traces back to
      // a Server Action call, which isn't runtime-type-checked at the HTTP
      // boundary (CodeQL js/tainted-format-string).
      console.error(
        'agent-lcars: failed to list check runs for #%s:',
        issue.number,
        error,
      );
      warnings.push(`Check runs unavailable for #${issue.number}.`);
    }
  }

  const subIssuesSummary = issue.sub_issues_summary;

  const item: ActionItem = {
    kind: isPr ? 'pr' : 'issue',
    repo,
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    author: issue.user?.login ?? undefined,
    updatedAt: issue.updated_at,
    actionTypes,
    labels: labels.filter((label) => !LABELS_SHOWN_AS_ACTION_TYPES.has(label)),
    assigneeLogins: assigneeLogins.filter((login) => login.length > 0),
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

// This used to run one `search.issuesAndPullRequests` call per (repo,
// qualifier) pair - 7 base queries x 2 (`is:issue`/`is:pull-request`) = 14
// search requests per repo. The search API has its own budget of 30
// requests per MINUTE (entirely separate from, and ~166x tighter per-minute
// than, the 5,000/hr core budget), so a single two-repo dashboard load spent
// 28 of the 30 available that minute and a second refresh inside the same
// minute 429'd. See #13.
//
// Every one of those qualifiers is a predicate over open items, and both
// list endpoints below are on the roomy core budget. So: fetch the repo's
// open items once, fetch its open PRs once, and evaluate the predicates in
// memory. Search pressure drops to zero, the `is:issue`/`is:pull-request`
// doubling disappears (one list covers both), and the 1000-result search
// ceiling stops applying.

/** Labels that put an item on the board on their own.
 *
 * `claude`/`opencode`/`codex` are belt and suspenders: a labeled issue whose
 * run never started (runner outage, queue loss) is dispatched-but-unclaimed,
 * because the claim step only runs once a runner picks the job up. Without
 * these exactly the items most in need of attention would be invisible.
 *
 * `human-needed` is one of this dashboard's own action types, but not every
 * human-gated item is agent-touched: an ops decision issue (e.g. #2130) can
 * carry it without ever having a pipeline label or an agent author (or, if
 * labeled by hand, an assignee), and without this it never enters the
 * dashboard at all. */
const BOARD_LABELS = ['claude', 'opencode', 'codex', 'human-needed'];

/**
 * The open-item predicate, replacing the old per-qualifier search queries
 * one for one.
 *
 * Assignee checks are the ownership spine (#2783): `jclaw-bot` assigned
 * means the agent fleet has claimed the item - this covers what used to
 * need an `author:app/claude` query AND still missed things (@claude PR
 * threads, runbook anchors, and interactive-session claims never carry the
 * claude label, but all get the fleet assignee now). `jlapenna` assigned
 * means the ball is in the maintainer's court: human-needed endings and
 * failed-run reports assign him automatically, and anything he owns
 * personally belongs on his console too.
 *
 * `reviewRequestedLogins` comes from the PR listing (issues.listForRepo
 * can't express `review-requested:`). Drafts are deliberately NOT filtered
 * here - the old `review-requested:` query didn't filter them either, and
 * classifyIssue is what declines to raise the actionType on a draft.
 */
function isBoardItem(
  issue: RepoIssue,
  reviewRequestedLogins: string[] | undefined,
): boolean {
  const assignees = (issue.assignees ?? []).map((a) => a?.login ?? '');
  if (
    assignees.includes(agentFleetLogin()) ||
    assignees.includes(maintainerLogin())
  ) {
    return true;
  }
  const labels = issue.labels.map((label) =>
    typeof label === 'string' ? label : (label.name ?? ''),
  );
  if (labels.some((label) => BOARD_LABELS.includes(label))) return true;
  return reviewRequestedLogins?.includes(maintainerLogin()) ?? false;
}

// A page cap rather than an expected limit: the watched repos carry tens of
// open items, not thousands. Unlike the search API there is no 1000-result
// ceiling here, so this only exists so a pathological repo can't page
// forever - it degrades to a truncation warning the same way the search
// path used to.
const ITEMS_PER_PAGE = 100;
const ITEMS_MAX_PAGES = 10;

/** Every open issue AND pull request in the repo - `issues.listForRepo`
 * serves both, with PRs carrying a `pull_request` key. */
async function listOpenItems(
  repo: WatchedRepo,
): Promise<{ items: RepoIssue[]; truncated: boolean }> {
  const octokit = getGithubClient();
  const items: RepoIssue[] = [];
  for (let page = 1; page <= ITEMS_MAX_PAGES; page++) {
    const { data } = await octokit.rest.issues.listForRepo({
      owner: repo.owner,
      repo: repo.name,
      state: 'open',
      // Deterministic, triage-useful ordering within a priority tier (the
      // final sort below is by action priority only, and is stable).
      sort: 'updated',
      direction: 'desc',
      per_page: ITEMS_PER_PAGE,
      page,
    });
    items.push(...(data as RepoIssue[]));
    if (data.length < ITEMS_PER_PAGE) return { items, truncated: false };
  }
  return { items, truncated: true };
}

/** Requested-reviewer logins per open PR number - the one predicate
 * `issues.listForRepo` can't express. `pulls.list` populates
 * `requested_reviewers` (verified against the live API), so this costs one
 * listing rather than a `pulls.get` per open PR. */
async function listReviewRequests(
  repo: WatchedRepo,
): Promise<Map<number, string[]>> {
  const octokit = getGithubClient();
  const byNumber = new Map<number, string[]>();
  for (let page = 1; page <= ITEMS_MAX_PAGES; page++) {
    const { data } = await octokit.rest.pulls.list({
      owner: repo.owner,
      repo: repo.name,
      state: 'open',
      per_page: ITEMS_PER_PAGE,
      page,
    });
    for (const pr of data) {
      byNumber.set(
        pr.number,
        (pr.requested_reviewers ?? []).map((reviewer) => reviewer?.login ?? ''),
      );
    }
    if (data.length < ITEMS_PER_PAGE) break;
  }
  return byNumber;
}

export async function getActionItems(): Promise<ActionItemsResult> {
  const warnings: string[] = [];

  // Two calls per repo, both on the core budget. Each repo's pair settles
  // independently: one repo's outage (or a token missing one permission)
  // degrades that repo to a warning instead of blanking the dashboard,
  // matching the per-query degradation the search fan-out used to give.
  const perRepo = await Promise.all(
    getWatchedRepos().map(async (repo) => {
      const [itemsResult, reviewsResult] = await Promise.allSettled([
        listOpenItems(repo),
        listReviewRequests(repo),
      ]);

      if (itemsResult.status === 'rejected') {
        console.error(
          'agent-lcars: failed to list open items (%s):',
          repoKey(repo),
          itemsResult.reason,
        );
        return {
          repo,
          issues: [] as RepoIssue[],
          warnings: [
            `Open items unavailable for ${repoKey(repo)} (GitHub API request failed).`,
          ],
        };
      }

      const repoWarnings: string[] = [];
      if (itemsResult.value.truncated) {
        repoWarnings.push(
          `Open items truncated for ${repoKey(repo)} (over ${ITEMS_MAX_PAGES * ITEMS_PER_PAGE} open) - some items may not be shown.`,
        );
      }

      // A failed PR listing costs only the review-requested predicate;
      // everything selected by label or assignee still lands.
      let reviewRequests: Map<number, string[]> | undefined;
      if (reviewsResult.status === 'fulfilled') {
        reviewRequests = reviewsResult.value;
      } else {
        console.error(
          'agent-lcars: failed to list open pull requests (%s):',
          repoKey(repo),
          reviewsResult.reason,
        );
        repoWarnings.push(
          `Review requests unavailable for ${repoKey(repo)} - review-requested PRs may be missing.`,
        );
      }

      return {
        repo,
        issues: itemsResult.value.items.filter((issue) =>
          isBoardItem(issue, reviewRequests?.get(issue.number)),
        ),
        warnings: repoWarnings,
      };
    }),
  );

  // Keyed by repoItemKey, NOT bare issue.number - issue/PR numbers only
  // disambiguate within one repo, so two different repos' #42 must survive
  // as two distinct entries here.
  const byKey = new Map<string, RepoIssue & { repo: WatchedRepo }>();
  for (const { repo, issues, warnings: repoWarnings } of perRepo) {
    warnings.push(...repoWarnings);
    for (const issue of issues) {
      byKey.set(repoItemKey(repo, issue.number), { ...issue, repo });
    }
  }

  // Defense in depth: an unexpected error classifying one item (a GitHub API
  // hiccup, a malformed listing entry, etc.) should drop that one item, not
  // crash the whole dashboard for everyone.
  const issuesToClassify = Array.from(byKey.values());
  const classified = await Promise.allSettled(
    issuesToClassify.map((issue) => classifyIssue(issue.repo, issue)),
  );
  const items: ActionItem[] = [];
  for (const [i, result] of classified.entries()) {
    const issue = issuesToClassify[i];
    if (result.status === 'rejected') {
      console.error('agent-lcars: failed to classify an item:', result.reason);
      warnings.push(
        `Failed to classify ${repoItemKey(issue.repo, issue.number)}.`,
      );
      continue;
    }
    items.push(result.value.item);
    warnings.push(...result.value.warnings);
  }

  items.sort((a, b) => itemPriority(a) - itemPriority(b));
  return { items, warnings };
}
