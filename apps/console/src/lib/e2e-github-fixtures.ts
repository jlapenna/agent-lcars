import { agentFleetLogin, maintainerLogin } from './deployment';
import {
  E2E_FIXTURE_BRANCH,
  E2E_FIXTURE_PR_NUMBER,
  E2E_FIXTURE_PR_TITLE,
  E2E_FIXTURE_PR_URL,
} from './e2e-fixtures';
import { type AgentPipeline, DEFAULT_AGENT_INTEGRATIONS } from './watched-repo';

/**
 * Canned GitHub API responses for the e2e suite's *populated* mode, added
 * for #40: every screenshot taken during the LCARS redesign (#32) was of an
 * environment with zero action items and zero runs, so the palette's data
 * colors — terracotta (failed), mustard (timeout), jade (success), magenta
 * (review-requested), and every `ACTION_COLORS` badge — had never actually
 * been rendered against anything.
 *
 * Off by default. `getActionItems()`/`getAgentActivity()` see empty results
 * exactly as they did before this file existed, so the pre-existing specs
 * (which assert the zero state) are untouched; a spec opts in by POSTing
 * `{action: 'seed-populated'}` to `/api/e2e/seed`.
 *
 * The one thing served unconditionally is the branch->PR join
 * `getCliSessions()` needs, which predates this file and which
 * `agent-activity-cli-sessions.spec.ts` depends on - see `openPulls`, which
 * serves it now that the console no longer calls the search API.
 */

// Resolved from deployment config, NOT hardcoded: `tools/e2e/ci.env` sets
// AGENT_LCARS_ADMIN_GITHUB_LOGIN to a dummy value, so a literal 'jlapenna'
// here would no longer match what classifyIssue() compares
// `requested_reviewers` against, nor what the assignee search queries ask
// for -- the fixtures would build items the app then refuses to classify.
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
  /** Carries two live workflow attempts bound to the same dispatch
   * generation/intent marker (see `E2E_RUN_IDS.running` /
   * `duplicateQueued`) - the #306 duplicate-attempt-anomaly scenario. Off
   * the board on purpose (no board-qualifying label/assignee): the In
   * Flight panel's "attempt history" link is what reaches its
   * `/task/.../9008` detail page, not the board. */
  duplicateDispatch: 9008,
  /** #538: green checks, no requested reviewer, mergeStateStatus BLOCKED
   * with real unresolved review threads - the retro (#521) scenario a
   * `gh pr checks` glance and an empty `reviewDecision` gave no hint about. */
  mergeBlockedThreads: 9011,
} as const;

export const E2E_RUN_IDS = {
  running: 70001,
  queuedWaiting: 70002,
  succeeded: 70003,
  failed: 70004,
  timedOut: 70005,
  opencodeSucceeded: 70006,
  /** The `success` run whose joined session doc shows no work at all — the
   * `silent-error` classification is derived from that join, never from the
   * item's own GitHub state, so it needs both halves to render. */
  silentError: 70007,
  duplicateQueued: 70008,
  olderSucceeded: 70009,
  olderFailed: 70010,
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

/** Shared by the two duplicate live-attempt run-name markers in
 * FIXTURE_RUNS - both attempts deliberately carry the SAME
 * generation/intent, since that is exactly the anomaly #306's
 * `deriveLogicalWork` exists to surface (two attempts genuinely bound to
 * one dispatch, not two different generations racing). */
const E2E_DUPLICATE_INTENT_ID = 'e2e-fixture-intent-9008';

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
        // Deliberately carries a takeover command: the card renders one
        // whenever the fleet holds the assignee, and it had never been seen
        // rendered next to a real comment preview. This one keeps the
        // retired sprinkles-era spelling on purpose — action-items.ts's
        // RESUME_COMMAND pattern still matches historical comments, and
        // populated-dashboard.spec.ts asserts on exactly this legacy form.
        // The runFailed fixture below carries the canonical
        // `fleet-claude-agent-session resume <id>` spelling.
        body: 'Parking this — 30 days and 90 days have different storage-cost profiles and I should not pick for you.\n\n`~/p/sprinkles/tools/claude-agent-session.sh resume e2e-fixture-session-id`',
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
        // Canonical takeover spelling (agent-lcars#1328): the fleet-tools
        // `fleet-claude-agent-session resume <id>` command replaced the
        // per-repo claude-agent-session.sh script, so the e2e path must
        // exercise the spelling agents actually post today. The humanNeeded
        // fixture above retains the legacy spelling for back-compat
        // coverage of historical comments.
        body: 'CI is red on the E2E job; re-running.\n\n`fleet-claude-agent-session resume e2e-fixture-pr-session`',
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
    // via item-enrichment.ts and readable via GET /issues/{number}
    // (task-detail.ts), both of which key off FIXTURE_ITEMS directly rather
    // than the filtered board.
    labels: [],
    assignees: [],
    author: MAINTAINER,
    updatedAt: minutesAgo(1),
  },
];

interface FixtureRun {
  id: number;
  workflow: 'claude.yml' | 'opencode.yml';
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
  displayTitle: string;
  createdAt: string;
  startedAt: string;
  updatedAt: string;
}

const FIXTURE_RUNS: FixtureRun[] = [
  {
    id: E2E_RUN_IDS.running,
    workflow: 'claude.yml',
    status: 'in_progress',
    conclusion: null,
    // Board membership is intentionally NOT what makes this render in In
    // Flight (see E2E_ITEM_NUMBERS.duplicateDispatch's own comment) -
    // pointing a live run at, say, the run-failed fixture would hide the
    // very card this fixture set exists to render. Carries a real
    // generation/intent marker (E2E_DUPLICATE_INTENT_ID) so this attempt
    // gets `run-marker` attribution, not just a bare title-number parse.
    displayTitle: `#${E2E_ITEM_NUMBERS.duplicateDispatch}: feat(console): repo filter chips [dispatch:g1:${E2E_DUPLICATE_INTENT_ID}]`,
    createdAt: minutesAgo(13),
    startedAt: minutesAgo(12),
    updatedAt: minutesAgo(1),
  },
  {
    id: E2E_RUN_IDS.queuedWaiting,
    workflow: 'claude.yml',
    status: 'queued',
    conclusion: null,
    displayTitle: '#9009: chore(deps): bump the runner base image',
    createdAt: minutesAgo(2),
    startedAt: minutesAgo(2),
    updatedAt: minutesAgo(2),
  },
  {
    id: E2E_RUN_IDS.duplicateQueued,
    workflow: 'claude.yml',
    status: 'queued',
    conclusion: null,
    // #306: same logical work AND the same generation/intent marker as
    // `running` above - a genuine duplicate dispatch, not a second
    // pipeline racing the item. The GitHub API really does expose both
    // attempts; the console must render both, grouped with a visible
    // duplicate-attempt anomaly, never silently pick one (see
    // agent-activity-panel.tsx's `duplicatePipelineSummary`).
    displayTitle: `#${E2E_ITEM_NUMBERS.duplicateDispatch}: feat(console): repo filter chips [dispatch:g1:${E2E_DUPLICATE_INTENT_ID}]`,
    // Past QUEUE_STALL_THRESHOLD_SECONDS (300), so queue health must still
    // inspect this raw attempt and render the stall alert even though the
    // group's other attempt is already running.
    createdAt: minutesAgo(11),
    startedAt: minutesAgo(11),
    updatedAt: minutesAgo(11),
  },
  {
    id: E2E_RUN_IDS.succeeded,
    workflow: 'claude.yml',
    status: 'completed',
    conclusion: 'success',
    displayTitle: `#${E2E_ITEM_NUMBERS.reviewRequested}: feat(console): tap-icon refresh on the queue header`,
    createdAt: minutesAgo(70),
    startedAt: minutesAgo(69),
    updatedAt: minutesAgo(41),
  },
  {
    id: E2E_RUN_IDS.failed,
    workflow: 'claude.yml',
    status: 'completed',
    conclusion: 'failure',
    displayTitle: `#${E2E_ITEM_NUMBERS.humanNeeded}: Decide the retention window for archived agent transcripts`,
    createdAt: minutesAgo(95),
    startedAt: minutesAgo(94),
    updatedAt: minutesAgo(88),
  },
  {
    id: E2E_RUN_IDS.timedOut,
    workflow: 'claude.yml',
    status: 'completed',
    conclusion: 'cancelled',
    displayTitle: '#9006: feat(autoscaler): drain idle scale sets',
    // Cancelled after ~89 of the 90-minute budget: past
    // LIKELY_TIMEOUT_FRACTION, so the classifier calls this `timeout`
    // (mustard) rather than `cancelled`.
    createdAt: minutesAgo(210),
    startedAt: minutesAgo(209),
    updatedAt: minutesAgo(120),
  },
  {
    id: E2E_RUN_IDS.silentError,
    workflow: 'claude.yml',
    status: 'completed',
    conclusion: 'success',
    displayTitle: `#${E2E_ITEM_NUMBERS.silentError}: chore(telemetry): prune expired session docs`,
    createdAt: minutesAgo(56),
    startedAt: minutesAgo(55),
    updatedAt: minutesAgo(52),
  },
  {
    id: E2E_RUN_IDS.opencodeSucceeded,
    workflow: 'opencode.yml',
    status: 'completed',
    conclusion: 'success',
    displayTitle: 'opencode #9007: docs: refresh the onboarding runbook',
    createdAt: minutesAgo(150),
    startedAt: minutesAgo(149),
    updatedAt: minutesAgo(140),
  },
  // Older completed attempts keep the populated Agents fixture above the
  // phone disclosure threshold. Bridge still deliberately slices its five
  // newest outcomes, while /agents can prove the older-evidence reveal.
  {
    id: E2E_RUN_IDS.olderSucceeded,
    workflow: 'claude.yml',
    status: 'completed',
    conclusion: 'success',
    displayTitle: `#${E2E_ITEM_NUMBERS.reviewRequested}: test(console): preserve the review evidence archive`,
    createdAt: minutesAgo(180),
    startedAt: minutesAgo(179),
    updatedAt: minutesAgo(165),
  },
  {
    id: E2E_RUN_IDS.olderFailed,
    workflow: 'opencode.yml',
    status: 'completed',
    conclusion: 'failure',
    displayTitle: `opencode #${E2E_ITEM_NUMBERS.humanNeeded}: test(console): preserve the failure evidence archive`,
    createdAt: minutesAgo(195),
    startedAt: minutesAgo(194),
    updatedAt: minutesAgo(180),
  },
];

const FIXTURE_RUNNERS = [
  { id: 1, name: 'e2e-fixture-runner-1', status: 'online', busy: true },
  { id: 2, name: 'e2e-fixture-runner-2', status: 'online', busy: false },
];

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
 * The fixture stand-in for `applyPipelineReassignment`'s own three typed
 * rejections (`apps/dispatch-broker/src/controller-core.ts`) - real
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
 * ledger, the issue itself, and (standing in for the dispatcher this suite
 * never runs for real - see docs/e2e-security-boundary.md) the bound
 * workflow run a successful create+label write would eventually produce.
 *
 * Lives on `globalThis` for the same reason `POPULATED_KEY` does: Next
 * bundles `/api/e2e/github/*` and `/api/e2e/seed` as separate route modules
 * that only share a JS realm, not a module instance, and the seed route
 * needs to reset this between specs (see `resetQuickTaskFixtures`).
 */
const QUICK_TASK_STATE_KEY = '__agentLcarsE2eQuickTaskState';

interface QuickTaskFixtureRun {
  id: number;
  workflow: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
  displayTitle: string;
  createdAt: string;
  startedAt: string;
  updatedAt: string;
}

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
  runs: QuickTaskFixtureRun[];
  /** Annotated tag objects keyed by SHA - `git.createTag` / `git.getTag`. */
  claimTags: Map<string, { message: string; tag: string }>;
  /** Claim ref SHAs keyed by `tags/agent-lcars/quick-task/<id>` -
   * `git.createRef` / `git.getRef` / `git.deleteRef`. */
  claimRefs: Map<string, string>;
  /** Numbered well clear of both the curated `E2E_ITEM_NUMBERS` (9001-9010)
   * and `E2E_RUN_IDS` ranges, and incrementing per created issue/run so a
   * fixture leak or an accidental duplicate create is immediately visible
   * as two different numbers rather than a silently-reused one. */
  nextIssueNumber: number;
  nextRunId: number;
  tagSequence: number;
}

function freshQuickTaskState(): QuickTaskFixtureState {
  return {
    issues: [],
    runs: [],
    claimTags: new Map(),
    claimRefs: new Map(),
    nextIssueNumber: 20001,
    nextRunId: 480001,
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
 * Creates the issue AND immediately synthesizes the marker-carrying workflow
 * run a real deployment's router + dispatcher + worker would eventually
 * produce from that same create+label write. This suite never runs the
 * actual dispatch (see docs/e2e-security-boundary.md) - the point is that
 * everything downstream of this write (the console's own GET/GraphQL
 * polling and `deriveLogicalWork` rendering) still runs for real against a
 * plausible, internally-consistent end state.
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
  const runId = state.nextRunId++;
  const now = new Date().toISOString();

  const intentId = `e2e-quick-task-intent-${number}`;

  // Mirrors claude.yml/codex.yml/opencode.yml's real run-name templates:
  // claude has no pipeline prefix, codex/opencode repeat their own name
  // ahead of the `#N:` join key (see agent-activity.ts's
  // DISPLAY_TITLE_NUMBER_RE / PIPELINE_TITLE_PREFIX_RE, and FIXTURE_RUNS'
  // own opencode entry above).
  const titlePrefix = params.pipeline === 'claude' ? '' : `${params.pipeline} `;
  state.runs.push({
    id: runId,
    workflow: DEFAULT_AGENT_INTEGRATIONS[params.pipeline].workflowFile,
    status: 'in_progress',
    conclusion: null,
    displayTitle: `${titlePrefix}#${number}: ${params.title} [dispatch:g1:${intentId}]`,
    createdAt: now,
    startedAt: now,
    updatedAt: now,
  });

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
 * mechanism under test. Deliberately does NOT merge in the curated
 * `FIXTURE_ITEMS` (unlike `openIssues()`'s `state=open` board listing):
 * none of them ever carry a `quick-task-request` marker, so including them
 * would only add noise, never change which issue a retry resolves to.
 */
export function quickTaskListingIssues() {
  return quickTaskState().issues.map(quickTaskIssueRestShape);
}

function quickTaskGraphqlEntries(): Record<string, unknown> {
  const repository: Record<string, unknown> = {};
  for (const item of quickTaskState().issues) {
    repository[`i${item.number}`] = {
      __typename: 'Issue',
      comments: {
        nodes: item.comments.map((comment, index) => ({
          body: comment.body,
          url: `${itemUrl(item.number, 'issues')}#issuecomment-${item.number}${index}`,
          author: { login: comment.author },
        })),
      },
    };
  }
  return repository;
}

function quickTaskDynamicRuns(workflowFile: string, status?: string) {
  return quickTaskState().runs.filter(
    (run) =>
      run.workflow === workflowFile &&
      (status === undefined ||
        status === run.conclusion ||
        status === run.status),
  );
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

/** The `issues.listForRepo` row shape - which serves issues and PRs alike,
 * with a PR carrying a `pull_request` key. */
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

/** `GET /repos/{owner}/{repo}/issues?state=open` - the board's item universe
 * since #13 replaced the per-qualifier search fan-out. Deliberately returns
 * every fixture item regardless of label/assignee: selecting which of them
 * belong on the board is `isBoardItem`'s job in the app, and a fixture that
 * pre-filtered would hide a regression in exactly that predicate. */
export function openIssues() {
  if (!populatedFixturesEnabled()) return [];
  return FIXTURE_ITEMS.map(issueFor);
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

/**
 * `GET /repos/{owner}/{repo}/pulls?state=open`. Two consumers read this now:
 * `requested_reviewers` answers the board predicate the issue listing can't
 * express, and `head.ref` answers `getCliSessions()`'s branch->PR join.
 *
 * The branch->PR entry is served UNCONDITIONALLY - it predates populated
 * mode and `agent-activity-cli-sessions.spec.ts` depends on it in the zero
 * state. It used to come from the `/search/issues` stub, which this replaced
 * when the console stopped calling the search API at all.
 */
export function openPulls() {
  const branchJoinPr = {
    number: E2E_FIXTURE_PR_NUMBER,
    title: E2E_FIXTURE_PR_TITLE,
    html_url: E2E_FIXTURE_PR_URL,
    head: { ref: E2E_FIXTURE_BRANCH },
    requested_reviewers: [],
  };
  if (!populatedFixturesEnabled()) return [branchJoinPr];
  return [
    branchJoinPr,
    ...FIXTURE_ITEMS.filter((item) => item.isPr).map((item) => ({
      number: item.number,
      title: item.title,
      html_url: itemUrl(item.number, 'pull'),
      // Distinct from the join branch above: these exist to be selected by
      // the review-requested predicate, not to be joined to a session.
      head: { ref: `e2e-fixture-branch-${item.number}` },
      requested_reviewers: (item.pr?.requestedReviewers ?? []).map((login) => ({
        login,
      })),
    })),
  ];
}

/**
 * `POST /graphql` - the batched per-item enrichment query.
 *
 * Replaces what used to be a per-item REST fan-out (issueComments +
 * pullRequest + checkRuns). This deliberately does NOT parse the query: it
 * answers with a node for every fixture item, keyed by the same `i<number>`
 * alias the app builds, and lets the app pick out the ones it asked for.
 * Extra aliases in the response are ignored by the caller, and a fixture
 * that tried to interpret GraphQL for real would be far more fragile than
 * the thing it is standing in for.
 *
 * Enum values are SCREAMING_CASE exactly as the real API returns them, so
 * the lowercasing in `item-enrichment.ts` stays exercised end to end rather
 * than being bypassed by a conveniently pre-lowercased fixture.
 */
export function enrichmentGraphql() {
  // Quick Task-created issues are merged in unconditionally (unlike the
  // FIXTURE_ITEMS loop below): `getTaskDetail`'s comment read must
  // work regardless of whether populated mode is on, the same as `issue()`
  // above.
  const repository: Record<string, unknown> = quickTaskGraphqlEntries();
  if (!populatedFixturesEnabled()) return { repository };

  for (const item of FIXTURE_ITEMS) {
    const comments = {
      nodes: (item.comments ?? []).map((comment, index) => ({
        body: comment.body,
        url: `${itemUrl(item.number, item.isPr ? 'pull' : 'issues')}#issuecomment-${item.number * 100 + index}`,
        author: { login: comment.author },
      })),
    };
    if (!item.isPr) {
      repository[`i${item.number}`] = { __typename: 'Issue', comments };
      continue;
    }
    const runs = item.checkRuns ?? [];
    repository[`i${item.number}`] = {
      __typename: 'PullRequest',
      isDraft: item.pr?.draft ?? false,
      mergeStateStatus: (item.pr?.mergeableState ?? 'unknown').toUpperCase(),
      body: item.body,
      comments,
      reviewRequests: {
        nodes: (item.pr?.requestedReviewers ?? []).map((login) => ({
          requestedReviewer: { login },
        })),
      },
      reviewThreads: {
        totalCount: (item.pr?.reviewThreads ?? []).length,
        nodes: (item.pr?.reviewThreads ?? []).map((isResolved) => ({
          isResolved,
        })),
      },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  totalCount: runs.length,
                  nodes: runs.map((run) => ({
                    name: run.name,
                    status: run.status.toUpperCase(),
                    conclusion: run.conclusion
                      ? run.conclusion.toUpperCase()
                      : null,
                    detailsUrl: 'https://github.com/check',
                  })),
                },
              },
            },
          },
        ],
      },
    };
  }
  return { repository };
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

/** `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` */
export function checkRuns(ref: string) {
  const item = FIXTURE_ITEMS.find((candidate) => candidate.pr?.headSha === ref);
  const runs = (item?.checkRuns ?? []).map((run, index) => ({
    id: index + 1,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    html_url: `${itemUrl(item?.number ?? 0, 'pull')}/checks`,
  }));
  return { total_count: runs.length, check_runs: runs };
}

/** `GET /repos/{owner}/{repo}/actions/workflows/{file}/runs`. `status` is
 * how `fetchRecentRuns` asks for one conclusion at a time. */
export function workflowRuns(workflowFile: string, status?: string) {
  // Quick Task's bound run is merged in unconditionally, same as issue()/
  // enrichmentGraphql() above: the console's live/recent run fetch
  // (agent-activity.ts) must see it whether or not populated mode is on.
  const populated = populatedFixturesEnabled()
    ? FIXTURE_RUNS.filter(
        (run) =>
          run.workflow === workflowFile &&
          (status === undefined ||
            status === run.conclusion ||
            status === run.status),
      )
    : [];
  const runs = [
    ...populated,
    ...quickTaskDynamicRuns(workflowFile, status),
  ].map((run) => ({
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    event: 'issues',
    html_url: `https://github.com/${E2E_FIXTURE_REPO.owner}/${E2E_FIXTURE_REPO.name}/actions/runs/${run.id}`,
    display_title: run.displayTitle,
    created_at: run.createdAt,
    run_started_at: run.startedAt,
    updated_at: run.updatedAt,
  }));
  return { total_count: runs.length, workflow_runs: runs };
}

/** `GET /repos/{owner}/{repo}/actions/runners` */
export function selfHostedRunners() {
  if (!populatedFixturesEnabled()) {
    return { total_count: 0, runners: [] };
  }
  return { total_count: FIXTURE_RUNNERS.length, runners: FIXTURE_RUNNERS };
}
