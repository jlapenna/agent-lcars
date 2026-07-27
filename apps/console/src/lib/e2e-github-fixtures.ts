import {
  E2E_FIXTURE_BRANCH,
  E2E_FIXTURE_PR_NUMBER,
  E2E_FIXTURE_PR_TITLE,
  E2E_FIXTURE_PR_URL,
} from './e2e-fixtures';

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
 * `agent-activity-cli-sessions.spec.ts` depends on.
 */

/** Whose console this is, per `MAINTAINER_LOGIN` in action-items.ts. */
const MAINTAINER = 'jlapenna';
/** The fleet's assignee, per `AGENT_FLEET_LOGIN` in action-items.ts. */
const FLEET = 'jclaw-bot';

/** The single repo the e2e environment watches (`DEFAULT_WATCHED_REPOS`,
 * since `tools/e2e/ci.env` sets no `AGENT_LCARS_WATCHED_REPOS`). */
export const E2E_FIXTURE_REPO = {
  owner: 'supersprinklesracing',
  name: 'sprinkles',
} as const;

/** Numbered well clear of anything real so a fixture leaking into a live
 * console would be obvious rather than plausible. */
export const E2E_ITEM_NUMBERS = {
  humanNeeded: 9001,
  runFailed: 9002,
  reviewRequested: 9003,
  postDeploy: 9004,
  silentError: 9005,
  humanNeededPostDeploy: 9010,
} as const;

export const E2E_RUN_IDS = {
  running: 70001,
  queuedStalled: 70002,
  succeeded: 70003,
  failed: 70004,
  timedOut: 70005,
  opencodeSucceeded: 70006,
  /** The `success` run whose joined session doc shows no work at all — the
   * `silent-error` classification is derived from that join, never from the
   * item's own GitHub state, so it needs both halves to render. */
  silentError: 70007,
} as const;

const HEAD_SHAS = {
  runFailed: 'e2e0000000000000000000000000000000009002',
  reviewRequested: 'e2e0000000000000000000000000000000009003',
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
  /** Which of `SEARCH_QUERIES`' qualifiers this item answers to. The search
   * endpoint matches on these rather than trying to evaluate GitHub's query
   * language for real. */
  matchesQualifiers: string[];
  comments?: { author: string; body: string }[];
  pr?: {
    draft: boolean;
    mergeableState: string;
    headSha: string;
    requestedReviewers: string[];
  };
  checkRuns?: { name: string; status: string; conclusion: string | null }[];
}

const FIXTURE_ITEMS: FixtureItem[] = [
  {
    number: E2E_ITEM_NUMBERS.humanNeeded,
    title: 'Decide the retention window for archived agent transcripts',
    body: 'The archive TTL was never settled. Needs a call before the watcher ships.',
    isPr: false,
    labels: ['human-needed', 'claude'],
    assignees: [MAINTAINER, FLEET],
    author: FLEET,
    updatedAt: minutesAgo(14),
    matchesQualifiers: [
      `assignee:${FLEET}`,
      `assignee:${MAINTAINER}`,
      'label:claude',
      'label:human-needed',
    ],
    comments: [
      { author: MAINTAINER, body: 'Filing this so it does not get lost.' },
      {
        author: FLEET,
        // Deliberately carries a takeover command: the card renders one
        // whenever the fleet holds the assignee, and it had never been seen
        // rendered next to a real comment preview.
        body: 'Parking this — 30 days and 90 days have different storage-cost profiles and I should not pick for you.\n\n`~/p/sprinkles/tools/claude-agent-session.sh resume e2e-fixture-session-id`',
      },
    ],
  },
  {
    number: E2E_ITEM_NUMBERS.runFailed,
    title: 'fix(watcher): stop double-counting streamed cache reads',
    body: 'Closes #9001.',
    isPr: true,
    labels: ['claude'],
    assignees: [FLEET],
    author: FLEET,
    updatedAt: minutesAgo(6),
    matchesQualifiers: [`assignee:${FLEET}`, 'label:claude'],
    comments: [
      {
        author: FLEET,
        body: 'CI is red on the E2E job; re-running.\n\n`~/p/sprinkles/tools/claude-agent-session.sh resume e2e-fixture-pr-session`',
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
    matchesQualifiers: [`review-requested:${MAINTAINER}`, `assignee:${FLEET}`],
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
    number: E2E_ITEM_NUMBERS.postDeploy,
    title: 'Verify the session-cost budget alert after the next deploy',
    body: 'Parked until the alert ships to production.',
    isPr: false,
    labels: ['post-deploy-action'],
    assignees: [MAINTAINER],
    author: FLEET,
    updatedAt: minutesAgo(180),
    matchesQualifiers: [`assignee:${MAINTAINER}`],
    comments: [
      {
        author: FLEET,
        body: 'Verified in staging; waiting on the production deploy to confirm.',
      },
    ],
  },
  {
    number: E2E_ITEM_NUMBERS.humanNeededPostDeploy,
    title: 'Confirm the archive TTL took effect in production',
    body: 'Needs a call on the window, then a post-deploy check.',
    isPr: false,
    // Both types on one item deliberately: an item whose *only* type is
    // post-deploy-action is `isDeployWaitOnly` and drops to the compact
    // "Waiting on Next Deploy" tier, which renders no action-type badge at
    // all. This is the only way the gray `post-deploy-action` badge ever
    // appears on a full card.
    labels: ['human-needed', 'post-deploy-action'],
    assignees: [MAINTAINER, FLEET],
    author: FLEET,
    updatedAt: minutesAgo(23),
    matchesQualifiers: [
      `assignee:${MAINTAINER}`,
      `assignee:${FLEET}`,
      'label:human-needed',
    ],
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
    labels: ['claude'],
    assignees: [FLEET],
    author: FLEET,
    updatedAt: minutesAgo(52),
    matchesQualifiers: [`assignee:${FLEET}`, 'label:claude'],
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
    // Deliberately NOT one of the board's items: page.tsx drops any item
    // with a live run from the board (it belongs to In Flight instead), so
    // pointing a live run at, say, the run-failed fixture would hide the
    // very card this fixture set exists to render.
    displayTitle: '#9008: feat(console): repo filter chips',
    createdAt: minutesAgo(13),
    startedAt: minutesAgo(12),
    updatedAt: minutesAgo(1),
  },
  {
    id: E2E_RUN_IDS.queuedStalled,
    workflow: 'claude.yml',
    status: 'queued',
    conclusion: null,
    displayTitle: '#9009: chore(deps): bump the runner base image',
    // Past QUEUE_STALL_THRESHOLD_SECONDS (300), so the queue-health alert
    // renders — never seen against real data either.
    createdAt: minutesAgo(9),
    startedAt: minutesAgo(9),
    updatedAt: minutesAgo(9),
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

export function setPopulatedFixtures(enabled: boolean) {
  (globalThis as Record<string, unknown>)[POPULATED_KEY] = enabled;
}

export function populatedFixturesEnabled(): boolean {
  return (globalThis as Record<string, unknown>)[POPULATED_KEY] === true;
}

function searchIssueFor(item: FixtureItem) {
  return {
    number: item.number,
    title: item.title,
    body: item.body,
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

/** `GET /search/issues`. Answers the branch->PR join unconditionally (it
 * predates populated mode); everything else only in populated mode. */
export function searchIssues(q: string) {
  const matchesFixtureBranch =
    q.includes('is:pr') &&
    q.includes('is:open') &&
    q.includes(`head:${E2E_FIXTURE_BRANCH}`);
  if (matchesFixtureBranch) {
    return {
      total_count: 1,
      incomplete_results: false,
      items: [
        {
          number: E2E_FIXTURE_PR_NUMBER,
          title: E2E_FIXTURE_PR_TITLE,
          html_url: E2E_FIXTURE_PR_URL,
          pull_request: {},
        },
      ],
    };
  }

  if (!populatedFixturesEnabled()) {
    return { total_count: 0, incomplete_results: false, items: [] };
  }

  // getActionItems() expands every base query into an `is:issue` and an
  // `is:pull-request` variant, so the kind filter has to be honored or a PR
  // fixture would come back on the issue query and be classified wrong.
  const wantsPr = q.includes('is:pull-request');
  const wantsIssue = q.includes('is:issue');
  const items = FIXTURE_ITEMS.filter(
    (item) =>
      (item.isPr ? wantsPr : wantsIssue) &&
      item.matchesQualifiers.some((qualifier) => q.includes(qualifier)),
  ).map(searchIssueFor);

  return { total_count: items.length, incomplete_results: false, items };
}

/** `GET /repos/{owner}/{repo}/issues/{number}/comments` */
export function issueComments(number: number) {
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
  if (!populatedFixturesEnabled()) {
    return { total_count: 0, workflow_runs: [] };
  }
  const runs = FIXTURE_RUNS.filter(
    (run) =>
      run.workflow === workflowFile &&
      (status === undefined ||
        status === run.conclusion ||
        status === run.status),
  ).map((run) => ({
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
