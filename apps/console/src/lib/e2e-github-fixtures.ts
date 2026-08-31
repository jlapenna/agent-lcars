import type { GithubAnchorProjection } from '@agent-lcars/orchestrator';

import { agentFleetLogin, maintainerLogin } from './deployment';
import type { AgentPipeline } from './watched-repo';

/**
 * Canned GitHub API responses for the e2e suite's *populated* mode, added
 * for #40: every screenshot taken during the LCARS redesign (#32) was of an
 * environment with zero action items and zero runs, so the palette's data
 * colors — terracotta (failed), mustard (timeout), jade (success), magenta
 * (review-requested), and every `ACTION_COLORS` badge — had never actually
 * been rendered against anything.
 *
 * Off by default. A spec opts in by POSTing `{action: 'seed-populated'}` to
 * `/api/e2e/seed`. That route now seeds agent activity from authoritative
 * broker Tasks/Runs and webhook-anchor projections; this GitHub boundary
 * supplies only explicit issue/PR detail and mutation metadata.
 */

// Resolved from deployment config, NOT hardcoded: `tools/e2e/ci.env` sets
// AGENT_LCARS_ADMIN_GITHUB_LOGIN to a dummy value, so a literal 'jlapenna'
// here would no longer match the author/assignee metadata in the durable
// queue fixture.
const MAINTAINER = maintainerLogin();
const FLEET = agentFleetLogin();

/** The single repo the e2e environment watches (`DEFAULT_WATCHED_REPOS`,
 * since `tools/e2e/ci.env` sets no `AGENT_LCARS_WATCHED_REPOS`). */
export const E2E_FIXTURE_REPO = {
  owner: 'supersprinklesracing',
  name: 'sprinkles',
} as const;

/** Stand-in for the real repo's numeric GitHub ID. Numbered well clear of
 * anything real, same as `E2E_ITEM_NUMBERS`. */
export const E2E_FIXTURE_REPOSITORY_ID = 900000000;

/** Numbered well clear of anything real so a fixture leaking into a live
 * console would be obvious rather than plausible. */
export const E2E_ITEM_NUMBERS = {
  humanNeeded: 9001,
  runFailed: 9002,
  reviewRequested: 9003,
  postDeploy: 9004,
  silentError: 9005,
  readyForAgent: 9006,
  humanNeededPostDeploy: 9010,
  /** Carries two live authoritative Runs for the #306 duplicate-attempt
   * anomaly. Off the board on purpose (no board-qualifying label/assignee):
   * the In Flight panel's "attempt history" link is what reaches its
   * `/task/.../9008` detail page, not the board. */
  duplicateDispatch: 9008,
  /** #538: green checks, no requested reviewer, mergeStateStatus BLOCKED
   * with real unresolved review threads - the retro (#521) scenario a
   * `gh pr checks` glance and an empty `reviewDecision` gave no hint about. */
  mergeBlockedThreads: 9011,
} as const;

const HEAD_SHAS = {
  runFailed: 'e2e0000000000000000000000000000000009002',
  reviewRequested: 'e2e0000000000000000000000000000000009003',
  mergeBlockedThreads: 'e2e0000000000000000000000000000000009011',
} as const;

const secondsAgo = (seconds: number) =>
  new Date(Date.now() - seconds * 1000).toISOString();
const minutesAgo = (minutes: number) => secondsAgo(minutes * 60);

const itemUrl = (number: number, kind: 'issues' | 'pull') =>
  `https://github.com/${E2E_FIXTURE_REPO.owner}/${E2E_FIXTURE_REPO.name}/${kind}/${number}`;

interface FixtureItem {
  number: number;
  title: string;
  body: string;
  isPr: boolean;
  labels: string[];
  assignees: string[];
  author: string;
  updatedAt: string;
  comments?: { author: string; body: string }[];
  pr?: {
    draft: boolean;
    mergeableState: string;
    headSha: string;
    requestedReviewers: string[];
    /** `isResolved` for each `reviewThreads(first:N)` node (#538). Omitted
     * (or all-resolved) for every fixture but `mergeBlockedThreads`. */
    reviewThreads?: boolean[];
  };
  checkRuns?: { name: string; status: string; conclusion: string | null }[];
}

const FIXTURE_ITEMS: FixtureItem[] = [
  {
    number: E2E_ITEM_NUMBERS.humanNeeded,
    title: 'Decide the retention window for archived agent transcripts',
    body: 'The archive TTL was never settled. Needs a call before the watcher ships.',
    isPr: false,
    labels: ['status:needs-human', 'agent:claude'],
    assignees: [MAINTAINER, FLEET],
    author: FLEET,
    updatedAt: minutesAgo(14),
    comments: [
      { author: MAINTAINER, body: 'Filing this so it does not get lost.' },
      {
        author: FLEET,
        body: 'Parking this — 30 days and 90 days have different storage-cost profiles and I should not pick for you.',
      },
    ],
  },
  {
    number: E2E_ITEM_NUMBERS.runFailed,
    title: 'fix(watcher): stop double-counting streamed cache reads',
    body: 'Closes #9001.',
    isPr: true,
    labels: ['agent:claude'],
    assignees: [FLEET],
    author: FLEET,
    updatedAt: minutesAgo(6),
    comments: [
      {
        author: FLEET,
        body: 'CI is red on the E2E job; re-running.',
      },
    ],
    pr: {
      draft: false,
      // `unstable` is the real state for "a required check failed" — the
      // card surfaces it alongside the failing-check list.
      mergeableState: 'unstable',
      headSha: HEAD_SHAS.runFailed,
      requestedReviewers: [],
    },
    checkRuns: [
      { name: 'Verify', status: 'completed', conclusion: 'success' },
      { name: 'E2E', status: 'completed', conclusion: 'failure' },
      { name: 'CodeQL', status: 'in_progress', conclusion: null },
    ],
  },
  {
    number: E2E_ITEM_NUMBERS.reviewRequested,
    title: 'feat(console): tap-icon refresh on the queue header',
    body: 'Closes #9004.',
    isPr: true,
    labels: [],
    assignees: [FLEET],
    author: FLEET,
    updatedAt: minutesAgo(41),
    pr: {
      draft: false,
      // `behind` drives the "Base branch has moved" affordance — another
      // state only ever exercised by unit tests until now.
      mergeableState: 'behind',
      headSha: HEAD_SHAS.reviewRequested,
      requestedReviewers: [MAINTAINER],
    },
    checkRuns: [
      { name: 'Verify', status: 'completed', conclusion: 'success' },
      { name: 'E2E', status: 'completed', conclusion: 'success' },
    ],
  },
  {
    number: E2E_ITEM_NUMBERS.mergeBlockedThreads,
    title: 'fix(console): tighten queue filter debounce',
    body: 'Tightens the inbox search debounce.',
    isPr: true,
    labels: [],
    assignees: [FLEET],
    author: FLEET,
    updatedAt: minutesAgo(50),
    pr: {
      draft: false,
      // #538: green checks below, no requested reviewer, yet GitHub itself
      // reports BLOCKED - the retro's (#521) exact "gh pr checks is green
      // and reviewDecision is empty" shape. Only the unresolved review
      // threads explain it.
      mergeableState: 'blocked',
      headSha: HEAD_SHAS.mergeBlockedThreads,
      requestedReviewers: [],
      reviewThreads: [false, false, false, true],
    },
    checkRuns: [
      { name: 'Verify', status: 'completed', conclusion: 'success' },
      { name: 'E2E', status: 'completed', conclusion: 'success' },
    ],
  },
  {
    number: E2E_ITEM_NUMBERS.postDeploy,
    title: 'Verify the session-cost budget alert after the next deploy',
    body: 'Parked until the alert ships to production.',
    isPr: false,
    labels: ['status:post-deploy-action'],
    assignees: [MAINTAINER],
    author: FLEET,
    updatedAt: minutesAgo(180),
    comments: [
      {
        author: FLEET,
        body: 'Verified in staging; waiting on the production deploy to confirm.',
      },
    ],
  },
  {
    number: E2E_ITEM_NUMBERS.readyForAgent,
    title: 'Add retention metrics to the session archive',
    body: 'Groomed and ready for the maintainer to choose an agent.',
    isPr: false,
    labels: ['status:ready-for-agent', 'app:console'],
    assignees: [],
    author: MAINTAINER,
    updatedAt: minutesAgo(33),
  },
  {
    number: E2E_ITEM_NUMBERS.humanNeededPostDeploy,
    title: 'Confirm the archive TTL took effect in production',
    body: 'Needs a call on the window, then a post-deploy check.',
    isPr: false,
    // Both types on one item deliberately: an item whose *only* type is
    // status:post-deploy-action is `isDeployWaitOnly` and drops to the compact
    // "Waiting on Next Deploy" tier, which renders no action-type badge at
    // all. This is the only way the gray post-deploy action badge ever
    // appears on a full card.
    labels: ['status:needs-human', 'status:post-deploy-action'],
    assignees: [MAINTAINER, FLEET],
    author: FLEET,
    updatedAt: minutesAgo(23),
    comments: [
      {
        author: FLEET,
        body: 'Blocked on the same retention decision as #9001.',
      },
    ],
  },
  {
    number: E2E_ITEM_NUMBERS.silentError,
    title: 'chore(telemetry): prune expired session docs',
    body: 'Routine cleanup.',
    isPr: false,
    labels: ['agent:claude'],
    assignees: [FLEET],
    author: FLEET,
    updatedAt: minutesAgo(52),
  },
  {
    number: E2E_ITEM_NUMBERS.duplicateDispatch,
    title: 'feat(console): repo filter chips',
    body: '',
    isPr: false,
    // No board-qualifying label/assignee on purpose - see this number's own
    // doc comment on E2E_ITEM_NUMBERS. Still enrichable (comments)
    // via an explicit bounded detail read
    // (task-detail.ts), both of which key off FIXTURE_ITEMS directly rather
    // than the filtered board.
    labels: [],
    assignees: [],
    author: MAINTAINER,
    updatedAt: minutesAgo(1),
  },
];

/**
 * The populated console fixture writes the same durable webhook-shaped
 * anchors the production queue reads. The GitHub HTTP fixture remains only
 * for explicit detail and mutation requests.
 */
export function populatedGithubAnchorProjections(): GithubAnchorProjection[] {
  const observedAt = new Date().toISOString();
  return FIXTURE_ITEMS.map((item) => {
    const comments = item.comments ?? [];
    const lastComment = comments.at(-1);
    const unresolvedReviewThreadIds = (item.pr?.reviewThreads ?? []).flatMap(
      (resolved, index) =>
        resolved ? [] : [`PRRT_e2e_${item.number}_${index}`],
    );
    const checkRuns = (item.checkRuns ?? []).map((check, index) => ({
      id: String(item.number * 1000 + index),
      name: check.name,
      url: `https://github.com/${E2E_FIXTURE_REPO.owner}/${E2E_FIXTURE_REPO.name}/runs/${item.number}-${index}`,
      status: check.status,
      conclusion: check.conclusion,
      updatedAt: item.updatedAt,
    }));
    const linkedIssueNumbers = Array.from(
      item.body.matchAll(
        /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)/giu,
      ),
      (match) => Number(match[1]),
    );
    return {
      anchor: {
        repo: `${E2E_FIXTURE_REPO.owner}/${E2E_FIXTURE_REPO.name}`,
        issue: item.number,
      },
      kind: item.isPr ? ('pr' as const) : ('issue' as const),
      state: 'open' as const,
      title: item.title,
      body: item.body,
      url: itemUrl(item.number, item.isPr ? 'pull' : 'issues'),
      author: item.author,
      labels: item.labels,
      assigneeLogins: item.assignees,
      ...(lastComment === undefined
        ? {}
        : {
            lastComment: {
              id: String(item.number * 100 + comments.length - 1),
              body: lastComment.body,
              url: `${itemUrl(item.number, item.isPr ? 'pull' : 'issues')}#issuecomment-${item.number * 100 + comments.length - 1}`,
              author: lastComment.author,
              createdAt: item.updatedAt,
            },
          }),
      ...(linkedIssueNumbers.length === 0 ? {} : { linkedIssueNumbers }),
      ...(item.isPr
        ? {
            draft: item.pr?.draft ?? false,
            mergeableState: item.pr?.mergeableState as NonNullable<
              GithubAnchorProjection['mergeableState']
            >,
            requestedReviewerLogins: item.pr?.requestedReviewers ?? [],
            checkRuns,
            failingChecks: checkRuns
              .filter(
                (check) =>
                  check.status === 'completed' &&
                  check.conclusion === 'failure',
              )
              .map(({ name, url }) => ({ name, url })),
            ciRunning: checkRuns.some((check) => check.status !== 'completed'),
            unresolvedReviewThreadCount: unresolvedReviewThreadIds.length,
            unresolvedReviewThreadIds,
          }
        : {}),
      sourceUpdatedAt: item.updatedAt,
      observedAt,
    };
  });
}

/**
 * Populated mode is a per-server-process toggle rather than a module-level
 * `let`: Next bundles each route handler separately, so `/api/e2e/seed` and
 * `/api/e2e/github/*` cannot rely on sharing one module instance. They do
 * share a JS realm.
 */
const POPULATED_KEY = '__agentLcarsE2ePopulatedFixtures';
const ISSUE_CONTENT_EDITS_KEY = '__agentLcarsE2eIssueContentEdits';

export function setPopulatedFixtures(enabled: boolean) {
  (globalThis as Record<string, unknown>)[POPULATED_KEY] = enabled;
}

export function populatedFixturesEnabled(): boolean {
  return (globalThis as Record<string, unknown>)[POPULATED_KEY] === true;
}

function issueContentEdits(): Map<number, { title: string; body: string }> {
  const bag = globalThis as Record<string, unknown>;
  if (!bag[ISSUE_CONTENT_EDITS_KEY]) {
    bag[ISSUE_CONTENT_EDITS_KEY] = new Map();
  }
  return bag[ISSUE_CONTENT_EDITS_KEY] as Map<
    number,
    { title: string; body: string }
  >;
}

/** Keeps one E2E spec's issue edit from leaking into the next spec sharing
 * the standalone server process. */
export function resetIssueContentEdits(): void {
  (globalThis as Record<string, unknown>)[ISSUE_CONTENT_EDITS_KEY] = new Map();
}

export type ReassignFixtureIssuePipelineResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'not-found'
        | 'no-pipeline'
        | 'already-targeted'
        | 'conflicting-pipeline';
    };

/**
 * The fixture stand-in for the real pipeline-reassignment path's typed
 * rejections (today `reassignPipeline` in `@/lib/backend-actions.ts`; the
 * broker-era `applyPipelineReassignment` these reasons originally mirrored
 * was deleted with `apps/dispatch-broker`) - real
 * controller logic never runs against this fixture
 * (docs/e2e-security-boundary.md). Validates against the issue's current
 * fixture snapshot but, like every other GitHub label write this fixture
 * answers (the atomic label-set PUT below, and clearNeedsHumanLabel's own
 * DELETE), never persists a change of its own - each is a validate-then-echo,
 * so a spec's curated items stay stable for every later assertion in the
 * same test.
 *
 * Takes the resolved `targetLabel`/`pipelineLabels` pair the command itself
 * carries (agent-lcars#811 Codex review), not a bare pipeline name it would
 * have to reconstruct a label from - this fixture only ever sees the
 * fleet-wide default labels in practice, but matching the real command's
 * shape keeps the two from silently drifting.
 */
export function reassignFixtureIssuePipeline(
  number: number,
  targetLabel: string,
  pipelineLabels: string[],
): ReassignFixtureIssuePipelineResult {
  const fixtureIssue = issue(number);
  if (!fixtureIssue) return { ok: false, reason: 'not-found' };
  const currentPipelineLabels = fixtureIssue.labels
    .map((label) => label.name)
    .filter((name) => pipelineLabels.includes(name));
  if (currentPipelineLabels.length === 0) {
    return { ok: false, reason: 'no-pipeline' };
  }
  if (currentPipelineLabels.length > 1) {
    return { ok: false, reason: 'conflicting-pipeline' };
  }
  if (currentPipelineLabels[0] === targetLabel) {
    return { ok: false, reason: 'already-targeted' };
  }
  return { ok: true };
}

/**
 * Stateful Quick Task write-path fixture (agent-lcars#307 part A). Everything
 * `apps/console/src/lib/backend-actions.ts`'s `createQuickTask` actually
 * writes through `AGENT_CONSOLE_GITHUB_API_BASE_URL` - the claim tag/ref
 * ledger and the issue itself. Execution state is seeded through the
 * authoritative Task/Run fixture boundary, never synthesized from a GitHub
 * Actions attempt.
 *
 * Lives on `globalThis` for the same reason `POPULATED_KEY` does: Next
 * bundles `/api/e2e/github/*` and `/api/e2e/seed` as separate route modules
 * that only share a JS realm, not a module instance, and the seed route
 * needs to reset this between specs (see `resetQuickTaskFixtures`).
 */
const QUICK_TASK_STATE_KEY = '__agentLcarsE2eQuickTaskState';

interface QuickTaskFixtureIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  createdAt: string;
  comments: { author: string; body: string }[];
}

interface QuickTaskFixtureState {
  issues: QuickTaskFixtureIssue[];
  /** Annotated tag objects keyed by SHA - `git.createTag` / `git.getTag`. */
  claimTags: Map<string, { message: string; tag: string }>;
  /** Claim ref SHAs keyed by `tags/agent-lcars/quick-task/<id>` -
   * `git.createRef` / `git.getRef` / `git.deleteRef`. */
  claimRefs: Map<string, string>;
  /** Numbered well clear of curated `E2E_ITEM_NUMBERS` (9001-9010). */
  nextIssueNumber: number;
  tagSequence: number;
}

function freshQuickTaskState(): QuickTaskFixtureState {
  return {
    issues: [],
    claimTags: new Map(),
    claimRefs: new Map(),
    nextIssueNumber: 20001,
    tagSequence: 0,
  };
}

function quickTaskState(): QuickTaskFixtureState {
  const bag = globalThis as Record<string, unknown>;
  if (!bag[QUICK_TASK_STATE_KEY]) {
    bag[QUICK_TASK_STATE_KEY] = freshQuickTaskState();
  }
  return bag[QUICK_TASK_STATE_KEY] as QuickTaskFixtureState;
}

/** Called from `/api/e2e/seed`'s `reset` action so a Quick Task issue/claim
 * created by one spec never leaks into a later spec sharing the same
 * single-worker server process (see playwright.config.ts's `workers: 1`). */
export function resetQuickTaskFixtures(): void {
  (globalThis as Record<string, unknown>)[QUICK_TASK_STATE_KEY] =
    freshQuickTaskState();
}

/** Description sentinel a spec can type into the real dialog to make the
 * fixture's issue-create endpoint fail closed with a definitive 4xx. Never
 * a value a real task would use. */
export const E2E_QUICK_TASK_FORCE_4XX_DESCRIPTION = 'E2E_QUICK_TASK_FORCE_4XX';

/** Description sentinel that makes the E2E GitHub route hold one issue
 * creation long enough to prove the client can accept another Quick Task. */
export const E2E_QUICK_TASK_DELAY_DESCRIPTION = 'E2E_QUICK_TASK_DELAY';

export function createQuickTaskClaimTag(
  message: string,
  tag: string,
): { sha: string } {
  const state = quickTaskState();
  state.tagSequence += 1;
  const sha = String(state.tagSequence).padStart(40, 'a');
  state.claimTags.set(sha, { message, tag });
  return { sha };
}

export function getQuickTaskClaimTag(
  sha: string,
): { message: string; tag: string } | undefined {
  return quickTaskState().claimTags.get(sha);
}

/** Returns `false` without mutating state when the ref already exists -
 * mirrors GitHub's real atomic-create semantics (`422 Reference already
 * exists`), which is the whole uniqueness boundary the claim-tag protocol in
 * docs/quick-task-identity.md depends on. */
export function createQuickTaskClaimRef(ref: string, sha: string): boolean {
  const state = quickTaskState();
  if (state.claimRefs.has(ref)) return false;
  state.claimRefs.set(ref, sha);
  return true;
}

export function getQuickTaskClaimRefSha(ref: string): string | undefined {
  return quickTaskState().claimRefs.get(ref);
}

/** Backs `DELETE /git/refs/{ref}` - the release half of the claim protocol
 * (`releaseQuickTaskClaim` in backend-actions.ts), exercised by a definitive
 * 4xx create failure. Returns whether a ref was actually removed so the
 * route can answer 204/404 like the real API. */
export function deleteQuickTaskClaimRef(ref: string): boolean {
  return quickTaskState().claimRefs.delete(ref);
}

/**
 * Creates the GitHub issue projection for a Quick Task. Its execution state
 * is independently supplied by the authoritative Task/Run fixture seam.
 */
export function recordQuickTaskIssue(params: {
  title: string;
  body: string;
  labels: string[];
  pipeline: AgentPipeline;
}): {
  number: number;
  html_url: string;
  title: string;
  body: string;
  labels: { name: string }[];
} {
  const state = quickTaskState();
  const number = state.nextIssueNumber++;
  const now = new Date().toISOString();

  state.issues.push({
    number,
    title: params.title,
    body: params.body,
    labels: params.labels,
    createdAt: now,
    comments: [],
  });

  return {
    number,
    html_url: itemUrl(number, 'issues'),
    title: params.title,
    body: params.body,
    labels: params.labels.map((name) => ({ name })),
  };
}

function quickTaskIssueRestShape(item: QuickTaskFixtureIssue) {
  return {
    number: item.number,
    title: item.title,
    body: item.body,
    html_url: itemUrl(item.number, 'issues'),
    user: { login: MAINTAINER },
    state: 'open',
    updated_at: item.createdAt,
    labels: item.labels.map((name) => ({ name })),
    assignees: [],
    comments: item.comments.length,
  };
}

export function quickTaskIssue(number: number) {
  const found = quickTaskState().issues.find(
    (candidate) => candidate.number === number,
  );
  return found ? quickTaskIssueRestShape(found) : undefined;
}

/**
 * `GET /repos/{o}/{r}/issues?state=all` - what
 * `backend-actions.ts`'s `findExistingQuickTask` scans for the request-ID
 * marker before ever attempting a create, which is the entire idempotency
 * mechanism under test. It deliberately does not merge the curated queue
 * anchors: none carry a `quick-task-request` marker, so they could only add
 * noise and must not act as a fixture queue fallback.
 */
export function quickTaskListingIssues() {
  return quickTaskState().issues.map(quickTaskIssueRestShape);
}

function quickTaskIssueComments(number: number) {
  const item = quickTaskState().issues.find(
    (candidate) => candidate.number === number,
  );
  if (!item) return undefined;
  return item.comments.map((comment, index) => ({
    id: number * 1000 + index,
    user: { login: comment.author },
    body: comment.body,
    html_url: `${itemUrl(number, 'issues')}#issuecomment-${number}${index}`,
    created_at: item.createdAt,
  }));
}

/** Exact issue-detail response shape, with a PR carrying `pull_request`. */
function issueFor(item: FixtureItem) {
  const edited = issueContentEdits().get(item.number);
  return {
    number: item.number,
    title: edited?.title ?? item.title,
    body: edited?.body ?? item.body,
    html_url: itemUrl(item.number, item.isPr ? 'pull' : 'issues'),
    user: { login: item.author },
    updated_at: item.updatedAt,
    labels: item.labels.map((name) => ({ name })),
    assignees: item.assignees.map((login) => ({ login })),
    comments: item.comments?.length ?? 0,
    ...(item.isPr
      ? { pull_request: { url: itemUrl(item.number, 'pull') } }
      : {}),
  };
}

/** Stateful target for PATCH /issues/{number}. Supports both the curated
 * populated-dashboard issues and issues filed through Quick Task. */
export function updateFixtureIssueContent(
  number: number,
  content: { title: string; body: string },
) {
  const quickTask = quickTaskState().issues.find(
    (candidate) => candidate.number === number,
  );
  if (quickTask) {
    quickTask.title = content.title;
    quickTask.body = content.body;
    return quickTaskIssueRestShape(quickTask);
  }

  const item = FIXTURE_ITEMS.find(
    (candidate) => candidate.number === number && !candidate.isPr,
  );
  if (!item) return undefined;
  issueContentEdits().set(number, content);
  return issueFor(item);
}

/** Individual issue read used by rendered mutation flows such as retrigger
 * and atomic pipeline reassignment, and by the canonical `/task/<owner>/
 * <repo>/<issue>` detail page (task-detail.ts) - which is why a Quick
 * Task-created issue is checked first and unconditionally: that page must
 * resolve a freshly filed task regardless of whether populated mode is on. */
export function issue(number: number) {
  const quickTask = quickTaskIssue(number);
  if (quickTask) return quickTask;
  if (!populatedFixturesEnabled()) return undefined;
  const item = FIXTURE_ITEMS.find((candidate) => candidate.number === number);
  return item ? issueFor(item) : undefined;
}

/** `GET /repos/{owner}/{repo}/issues/{number}/comments` */
export function issueComments(number: number) {
  const quickTask = quickTaskIssueComments(number);
  if (quickTask) return quickTask;
  const item = FIXTURE_ITEMS.find((candidate) => candidate.number === number);
  return (item?.comments ?? []).map((comment, index) => ({
    id: number * 100 + index,
    user: { login: comment.author },
    body: comment.body,
    html_url: `${itemUrl(number, item?.isPr ? 'pull' : 'issues')}#issuecomment-${number * 100 + index}`,
    created_at: minutesAgo(60 - index * 5),
  }));
}

/** Exact GraphQL-anchor detail used only by the control-plane refresh seam.
 * It deliberately has no list/query discovery surface: callers name each
 * already-known anchor and receive the same bounded detail GitHub returns. */
export function githubAnchorGraphqlDetail(number: number) {
  const quickTask = quickTaskState().issues.find(
    (candidate) => candidate.number === number,
  );
  if (quickTask) {
    return {
      body: quickTask.body,
      comments: {
        nodes: quickTask.comments.map((comment) => ({
          body: comment.body,
          url: `${itemUrl(number, 'issues')}#issuecomment-${number}`,
          createdAt: quickTask.createdAt,
          updatedAt: quickTask.createdAt,
          author: { login: comment.author },
        })),
      },
    };
  }

  if (!populatedFixturesEnabled()) return undefined;
  const item = FIXTURE_ITEMS.find((candidate) => candidate.number === number);
  if (!item) return undefined;
  const edited = issueContentEdits().get(number);
  const comments = item.comments ?? [];
  const detail = {
    body: edited?.body ?? item.body,
    comments: {
      nodes: comments.map((comment, index) => ({
        body: comment.body,
        url: `${itemUrl(number, item.isPr ? 'pull' : 'issues')}#issuecomment-${number * 100 + index}`,
        createdAt: item.updatedAt,
        updatedAt: item.updatedAt,
        author: { login: comment.author },
      })),
    },
  };
  if (!item.pr) return detail;

  const reviewThreads = item.pr.reviewThreads ?? [];
  const checks = item.checkRuns ?? [];
  return {
    ...detail,
    isDraft: item.pr.draft,
    mergeStateStatus: item.pr.mergeableState,
    reviewRequests: {
      nodes: item.pr.requestedReviewers.map((login) => ({
        requestedReviewer: { login },
      })),
    },
    reviewThreads: {
      totalCount: reviewThreads.length,
      nodes: reviewThreads.map((isResolved, index) => ({
        id: `PRRT_e2e_${number}_${index}`,
        isResolved,
      })),
    },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                totalCount: checks.length,
                nodes: checks.map((check, index) => ({
                  name: check.name,
                  status: check.status,
                  conclusion: check.conclusion,
                  detailsUrl: `https://github.com/${E2E_FIXTURE_REPO.owner}/${E2E_FIXTURE_REPO.name}/runs/${number}-${index}`,
                })),
              },
            },
          },
        },
      ],
    },
  };
}

/** `GET /repos/{owner}/{repo}/pulls/{number}` */
export function pullRequest(number: number) {
  const item = FIXTURE_ITEMS.find((candidate) => candidate.number === number);
  if (!item?.pr) return undefined;
  return {
    number,
    title: item.title,
    body: item.body,
    html_url: itemUrl(number, 'pull'),
    draft: item.pr.draft,
    mergeable_state: item.pr.mergeableState,
    head: { sha: item.pr.headSha },
    requested_reviewers: item.pr.requestedReviewers.map((login) => ({ login })),
  };
}

/** `GET /repos/{owner}/{repo}/actions/runners` */
export function selfHostedRunners() {
  return { total_count: 0, runners: [] };
}
