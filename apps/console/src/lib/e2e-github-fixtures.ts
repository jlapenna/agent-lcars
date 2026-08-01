import { agentFleetLogin, maintainerLogin } from './deployment';
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
    labels: ['agent:claude'],
    assignees: [FLEET],
    author: FLEET,
    updatedAt: minutesAgo(6),
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
    // Same logical work as `running`: the GitHub API exposes both workflow
    // attempts, while the console should render one active item.
    displayTitle: '#9008: feat(console): repo filter chips',
    // Past QUEUE_STALL_THRESHOLD_SECONDS (300). The logical row chooses the
    // running attempt above, but queue health must still inspect this raw
    // attempt and render the alert.
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

/** The `issues.listForRepo` row shape - which serves issues and PRs alike,
 * with a PR carrying a `pull_request` key. */
function issueFor(item: FixtureItem) {
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

/** `GET /repos/{owner}/{repo}/issues?state=open` - the board's item universe
 * since #13 replaced the per-qualifier search fan-out. Deliberately returns
 * every fixture item regardless of label/assignee: selecting which of them
 * belong on the board is `isBoardItem`'s job in the app, and a fixture that
 * pre-filtered would hide a regression in exactly that predicate. */
export function openIssues() {
  if (!populatedFixturesEnabled()) return [];
  return FIXTURE_ITEMS.map(issueFor);
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
  const repository: Record<string, unknown> = {};
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
