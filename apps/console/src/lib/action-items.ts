import { agentFleetLogin, maintainerLogin } from './deployment';
import { type DispatchLedger } from './dispatch-ledger';
import {
  getGithubClient,
  getWatchedRepos,
  repoItemKey,
  repoKey,
  type WatchedRepo,
} from './github-client';
import {
  CHECK_WINDOW,
  enrichItems,
  type EnrichmentRequest,
  type ItemEnrichment,
  REVIEW_THREAD_WINDOW,
} from './item-enrichment';
import { supportedAgentLabels } from './watched-repo';

/** Re-exported for the modules that already import it from here. The value
 * itself now comes from `deployment.ts`, which is the single place this
 * instance's identity lives. */
export { agentFleetLogin, maintainerLogin };

export type ActionType =
  | 'needs-human'
  | 'ready-for-agent'
  | 'run-failed'
  | 'review-requested'
  | 'post-deploy-action'
  // A non-draft, already-actionable-by-nobody-else PR that GitHub itself
  // won't merge. Two distinct causes raise this, both requiring
  // !reviewRequested (an outstanding review request already explains why
  // the PR is stuck, and owns its own higher-priority action type):
  //  - mergeableState 'behind': the branch fell behind its base after the
  //    maintainer already approved it - GitHub's own auto-merge won't catch
  //    it up on its own (#216), so this is the maintainer's to unstick with
  //    a single "Rebase onto base branch" click (see ItemOverflowMenu's
  //    canRebase).
  //  - mergeableState 'blocked' with unresolvedReviewThreadCount > 0 (#538):
  //    the retro that filed this (#521) found ten PRs sitting green-checked,
  //    auto-merge-armed, and unmergeable for hours behind 17 unresolved
  //    Codex review threads - `gh pr checks` green and `reviewDecision`
  //    empty gave no hint why. `unresolvedReviewThreadCount` carries the
  //    count so the UI can name the actual blocker instead of just a
  //    generic "can't merge yet."
  | 'merge-blocked'
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
  /** Unresolved review-thread count (#538), set ONLY when it is the
   * operative reason this PR carries 'merge-blocked' - i.e. mergeableState
   * is 'blocked' and the count is nonzero. A PR can carry unresolved
   * threads without this being the blocker (mergeableState 'clean', or
   * blocked for some other reason with zero unresolved threads), and
   * that's deliberately not surfaced here - see `classifyIssue`'s
   * `blockedByThreads`. */
  unresolvedReviewThreadCount?: number;
  /** Set alongside the `silent-error` actionType - the classifier's short
   * explanation of what looks wrong despite GitHub reporting success (see
   * `run-classification.ts`'s `deriveSilentErrorDiagnoses`). */
  silentErrorDiagnosis?: string;
  /** Parsed dispatch-broker ledger for this task, when its comment window
   * was fetched (see `wantsComments`) and carried a well-formed one -
   * `logical-work.ts`'s `deriveLogicalWork` uses this as the authoritative
   * intent/attempt lineage source (agent-lcars#306). */
  ledger?: DispatchLedger;
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

// needs-human and review-requested are tied at the top tier: both mean an
// agent cannot make further progress without Joe, so neither should get
// buried behind run-failed items an agent may still be actively fixing.
const ACTION_PRIORITY: Record<ActionType, number> = {
  'needs-human': 0,
  'review-requested': 0,
  'merge-blocked': 0,
  'ready-for-agent': 1,
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
  'status:ready-for-agent',
  'status:needs-human',
  'status:post-deploy-action',
]);

// The agent's kickoff prompt (see .github/workflows/claude.yml) makes it
// post its exact takeover command in its first ack comment, e.g.
// `~/p/members/tools/claude-agent-session.sh resume <session-id>`. Each new
// run posts a fresh one, so the newest match wins.
const TAKEOVER_COMMAND_RE = /(\S*claude-agent-session\.sh\s+resume\s+[\w-]+)/;

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

interface ClassifyResult {
  item: ActionItem;
  warnings: string[];
}

/** Pure over its inputs now: every GitHub read this used to make per item
 * is answered up front by one batched query per repo (see
 * `item-enrichment.ts`). Undefined enrichment means that item's details
 * didn't come back - it still classifies from the listing alone rather than
 * dropping off the board. */
function classifyIssue(
  repo: WatchedRepo,
  issue: RepoIssue,
  enrichment: ItemEnrichment | undefined,
): ClassifyResult {
  const warnings: string[] = [];
  const isPr = Boolean(issue.pull_request);
  const labels = issue.labels.map((label) =>
    typeof label === 'string' ? label : (label.name ?? ''),
  );
  const isPostDeploy = labels.includes('status:post-deploy-action');
  const isReadyForAgent = labels.includes('status:ready-for-agent');
  const assigneeLogins = (issue.assignees ?? []).map(
    (assignee) => assignee?.login ?? '',
  );
  // Label only, deliberately (#2802 decided: keep the label). An
  // assignee-pair fallback was tried as migration groundwork, but assignees
  // are additive-only — un-parking removes the label, never the assignees —
  // so the pair kept items in Your Queue forever after they were answered,
  // and claude.yml's deliverable check + pr-heal's park-check key on the
  // label anyway (#3023).
  const isHumanNeeded = labels.includes('status:needs-human');

  const actionTypes: ActionType[] = [];
  if (isReadyForAgent) {
    actionTypes.push('ready-for-agent');
  }
  if (isHumanNeeded) {
    actionTypes.push('needs-human');
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
    const comments = enrichment?.comments ?? [];
    const last = comments[comments.length - 1];
    if (isHumanNeeded || isPostDeploy) {
      lastCommentBody = last?.body;
      lastCommentUrl = last?.url;
      lastCommentAuthor = last?.author;
    }
    // Newest match wins: each run posts a fresh takeover command, and the
    // window is oldest-first, so scan backwards.
    if (wantsTakeover) {
      for (let i = comments.length - 1; i >= 0; i--) {
        const match = comments[i].body.match(TAKEOVER_COMMAND_RE);
        if (match) {
          takeoverCommand = match[1];
          break;
        }
      }
    }
  }

  let draft: boolean | undefined;
  let mergeableState: MergeableState | undefined;
  let failingChecks: { name: string; url: string }[] | undefined;
  let ciRunning: boolean | undefined;
  let unresolvedReviewThreadCount: number | undefined;
  let linkedIssueNumbers = extractLinkedIssueNumbers(issue.body, issue.number);

  if (isPr) {
    const pr = enrichment?.pr;
    draft = pr?.draft;
    mergeableState = (pr?.mergeableState as MergeableState) || 'unknown';
    // The PR body from the item query is authoritative; the listing's copy
    // can lag.
    linkedIssueNumbers =
      extractLinkedIssueNumbers(pr?.body, issue.number) ?? linkedIssueNumbers;

    // A review request on a draft isn't actionable yet - the agent asks for
    // review at PR creation, but a draft is by definition still being
    // iterated on. It surfaces once the PR is marked ready.
    const reviewRequested =
      pr?.requestedReviewerLogins.includes(maintainerLogin());
    if (reviewRequested && !pr?.draft) {
      actionTypes.push('review-requested');
    }

    // Already approved (so 'review-requested' cleared), but the branch fell
    // behind its base afterward - GitHub's own auto-merge waits forever for
    // someone to catch it up rather than doing so itself (#216). Skipped
    // when review-requested already fired: that case's own primary action
    // (approve-rebase) already covers catching the branch up.
    const behindBase = mergeableState === 'behind';
    // GitHub reports mergeStateStatus BLOCKED for several unrelated causes
    // (a missing required reviewer, a required check, unresolved review
    // threads...); only attribute it to threads - and only then surface
    // the count - when there actually are unresolved ones (#538). A
    // 'blocked' PR with zero here is blocked by something else this
    // classifier doesn't (yet) name.
    const blockedByThreads =
      mergeableState === 'blocked' &&
      (pr?.unresolvedReviewThreadCount ?? 0) > 0;
    if (!reviewRequested && !pr?.draft && (behindBase || blockedByThreads)) {
      actionTypes.push('merge-blocked');
      if (blockedByThreads) {
        unresolvedReviewThreadCount = pr?.unresolvedReviewThreadCount;
      }
    }

    if (pr?.checksTruncated) {
      warnings.push(
        `Check runs truncated for #${issue.number} (over ${CHECK_WINDOW} runs) - some failures may not be shown.`,
      );
    }
    // Gated on mergeableState alone, not blockedByThreads: truncation is
    // exactly what can make the unresolved count land at 0 (the real
    // unresolved thread sits past page one) and blockedByThreads false when
    // the PR is genuinely blocked by threads - nesting this warning inside
    // that condition would suppress the one signal that explains why the
    // count can't be trusted (Codex review on #538/#575).
    if (mergeableState === 'blocked' && pr?.reviewThreadsTruncated) {
      warnings.push(
        `Review threads truncated for #${issue.number} (over ${REVIEW_THREAD_WINDOW}) - the unresolved count may be an undercount.`,
      );
    }
    // Only genuine failures count: a `cancelled` conclusion is almost
    // always a superseded or manually-killed run, and badging it "CI run
    // failed" steered the maintainer toward retriggers nobody needed.
    const checkRuns = pr?.checkRuns ?? [];
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
    unresolvedReviewThreadCount,
    ledger: enrichment?.ledger,
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

/** Workflow-independent labels that put an item on the board on their own.
 *
 * Each repository's agent selector labels are added dynamically from its
 * declared integrations below. A labeled issue whose run never started
 * (runner outage, queue loss) is dispatched-but-unclaimed, because the claim
 * step only runs once a runner picks the job up. Without these exactly the
 * items most in need of attention would be invisible.
 *
 * `status:ready-for-agent` and `status:needs-human` are dashboard action
 * types in their own right. Neither necessarily has a pipeline label or an
 * agent/maintainer assignee yet, so both must select an item independently or
 * exactly the handoff work they represent would remain invisible. */
const BOARD_LABELS = ['status:needs-human', 'status:ready-for-agent'];

/** REST-shaped logins (docs/bot-identity-formats.md) of every pipeline that
 * opens PRs under its own identity - kept in sync with the
 * `AGENT_BOT_LOGINS` repo variable `agent-automerge.yml` reads. Belt and
 * suspenders, same reasoning as `BOARD_LABELS`: the assignee-based ownership
 * spine (#2783) is the primary signal, but it depends on `jclaw-bot`
 * actually holding assignable (triage+) repo access, and an agent-authored
 * PR must not go invisible the moment that assignment silently no-ops or
 * every other signal (a label, a still-open review request) has cleared
 * (#216). */
const AGENT_AUTHOR_LOGINS = ['claude[bot]', 'agent-lcars[bot]'];

/**
 * The open-item predicate, replacing the old per-qualifier search queries
 * one for one.
 *
 * Assignee checks are the ownership spine (#2783): `jclaw-bot` assigned
 * means the agent fleet has claimed the item - this covers what used to
 * need an `author:app/claude` query AND still missed things (@claude PR
 * threads, runbook anchors, and interactive-session claims never carry the
 * claude label, but all get the fleet assignee now). `jlapenna` assigned
 * means the ball is in the maintainer's court: needs-human endings and
 * failed-run reports assign him automatically, and anything he owns
 * personally belongs on his console too.
 *
 * `reviewRequestedLogins` comes from the PR listing (issues.listForRepo
 * can't express `review-requested:`). Drafts are deliberately NOT filtered
 * here - the old `review-requested:` query didn't filter them either, and
 * classifyIssue is what declines to raise the actionType on a draft.
 */
function isBoardItem(
  repo: WatchedRepo,
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
  const repoBoardLabels = [...BOARD_LABELS, ...supportedAgentLabels(repo)];
  if (labels.some((label) => repoBoardLabels.includes(label))) return true;
  if (AGENT_AUTHOR_LOGINS.includes(issue.user?.login ?? '')) return true;
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
        issues: itemsResult.value.items.filter((issue) => {
          // A malformed listing entry (a null `labels`, an unexpected
          // shape) must drop that one item, not throw out of the filter and
          // blank the whole repo's board.
          try {
            return isBoardItem(repo, issue, reviewRequests?.get(issue.number));
          } catch (error) {
            console.error(
              'agent-lcars: skipping a malformed item from %s:',
              repoKey(repo),
              error,
            );
            repoWarnings.push(
              `Skipped a malformed item from ${repoKey(repo)}.`,
            );
            return false;
          }
        }),
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

  const issuesToClassify = Array.from(byKey.values());

  // One batched enrichment query per repo, replacing what used to be a
  // per-item REST fan-out (a listComments for every parked/claimed item,
  // plus a pulls.get and up to five checks.listForRef per PR). Grouped by
  // repo because the query is repo-scoped.
  const byRepo = new Map<
    string,
    {
      repo: WatchedRepo;
      requests: EnrichmentRequest[];
      // Depends only on `repo`, not the individual issue - computed once
      // per repo-grouped batch instead of once per issue.
      agentLabels: string[];
    }
  >();
  for (const issue of issuesToClassify) {
    const key = repoKey(issue.repo);
    let group = byRepo.get(key);
    if (!group) {
      group = {
        repo: issue.repo,
        requests: [],
        agentLabels: supportedAgentLabels(issue.repo),
      };
      byRepo.set(key, group);
    }
    const labels = issue.labels.map((label) =>
      typeof label === 'string' ? label : (label.name ?? ''),
    );
    const assignees = (issue.assignees ?? []).map((a) => a?.login ?? '');
    // The first three conditions mirror classifyIssue's own condition for
    // reading comments at all (last-comment preview / takeover command).
    // The fourth is new for #306: any item carrying an agent pipeline label
    // is a candidate for a pinned dispatch-broker ledger comment, and
    // `toEnrichment` (item-enrichment.ts) only ever gets a chance to parse
    // one out of a comment window this app actually fetched.
    group.requests.push({
      number: issue.number,
      isPr: Boolean(issue.pull_request),
      wantsComments:
        labels.includes('status:needs-human') ||
        labels.includes('status:post-deploy-action') ||
        assignees.includes(agentFleetLogin()) ||
        group.agentLabels.some((label) => labels.includes(label)),
    });
  }

  const enrichedPerRepo = await Promise.all(
    Array.from(byRepo.values()).map(async ({ repo, requests }) => ({
      repo,
      result: await enrichItems(repo, requests),
    })),
  );
  const enrichment = new Map<string, ItemEnrichment>();
  for (const { repo, result } of enrichedPerRepo) {
    warnings.push(...result.warnings);
    for (const [number, value] of result.byNumber) {
      enrichment.set(repoItemKey(repo, number), value);
    }
  }

  // Defense in depth: an unexpected error classifying one item (a malformed
  // listing entry, an unexpected shape) should drop that one item, not
  // crash the whole dashboard for everyone.
  const items: ActionItem[] = [];
  for (const issue of issuesToClassify) {
    try {
      const result = classifyIssue(
        issue.repo,
        issue,
        enrichment.get(repoItemKey(issue.repo, issue.number)),
      );
      items.push(result.item);
      warnings.push(...result.warnings);
    } catch (error) {
      console.error('agent-lcars: failed to classify an item:', error);
      warnings.push(
        `Failed to classify ${repoItemKey(issue.repo, issue.number)}.`,
      );
    }
  }

  items.sort((a, b) => itemPriority(a) - itemPriority(b));
  return { items, warnings };
}
