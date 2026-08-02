import type { Octokit } from '@octokit/rest';

import {
  getGithubClient,
  getWatchedRepos,
  repoItemKey,
  repoKey,
  type WatchedRepo,
} from './github-client';

// Re-exported from github-client.ts, which owns the server-side watched-repo
// boundary; the pure integration shape itself lives in watched-repo.ts.
export type { AgentPipeline } from './github-client';
import type { AgentPipeline } from './github-client';
import { agentIntegration } from './watched-repo';

// Mirrors timeout-minutes in .github/workflows/claude.yml AND
// .github/workflows/opencode.yml (both 90m) so the live-run progress bar
// reflects the real kill budget regardless of which pipeline produced the
// run.
export const RUN_TIMEOUT_MINUTES = 90;

// Mirrors claude.yml's `--max-turns 200` claude_args. opencode.yml has no
// equivalent turn cap (its action takes no max_turns/max_steps input), so
// the turn-budget gauge only ever renders for `pipeline === 'claude'` runs -
// see LiveRunRow in agent-activity-panel.tsx.
export const MAX_TURNS_BUDGET = 200;

/** Resolves which workflow filename a `(repo, pipeline)` pair fetches from.
 * Undefined means this repo does not declare that agent integration. */
function resolveWorkflowFile(
  repo: WatchedRepo,
  pipeline: AgentPipeline,
): string | undefined {
  return agentIntegration(repo, pipeline)?.workflowFile;
}

const RECENT_RUN_LIMIT = 8;

export type AgentRunStatus = 'queued' | 'running' | 'completed';
export type AgentRunConclusion = 'success' | 'failure' | 'cancelled' | 'other';

export interface AgentRun {
  id: number;
  /** Which watched repo this run belongs to - threaded from the
   * `(repo, pipeline)` fetch pair, never re-derived from the run itself. */
  repo: WatchedRepo;
  /**
   * Which workflow this run was fetched from. Derived from the fetch source
   * (which workflow_id produced it), never string-sniffed from the title -
   * titles are free text a human could edit.
   */
  pipeline: AgentPipeline;
  status: AgentRunStatus;
  conclusion?: AgentRunConclusion;
  event: string;
  url: string;
  /**
   * claude.yml's `run-name` sets this to `#<issue/PR number>: <title>`;
   * opencode.yml's mirrors it as `opencode #<number>: <title>`. Either form
   * lets the dashboard join live runs to action items without any
   * runner-side telemetry.
   */
  displayTitle: string;
  /**
   * Parsed from the leading `#<number>:` (optionally preceded by `opencode
   * `) of displayTitle. Undefined for runs that predate the run-name
   * rollout - callers should fall back to a title-string match against
   * `displayTitle` for those.
   */
  issueNumber?: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Queued: seconds spent waiting for a runner. Running: seconds since the
   * run started. Completed: total run duration.
   */
  elapsedSeconds: number;
}

/**
 * Reduced view of `listSelfHostedRunnersForRepo`. #2974 migrated every
 * workflow to autoscaler scale sets: runners are now ephemeral, register
 * with empty label arrays, and legitimately scale to zero when idle. There
 * is nothing meaningful left to show per-runner (the old per-runner
 * name/label badges), so only the fleet-wide aggregate is tracked.
 */
export interface FleetSummary {
  online: number;
  busy: number;
}

export interface AgentActivity {
  /** Every live (queued or running) workflow attempt, exactly as GitHub
   * reports them - no representative-attempt collapsing (see
   * `collapseLogicalLiveRuns`'s doc comment for why #306 removed that from
   * this path). Two attempts racing the same repo/issue/pipeline both
   * appear here; `logical-work.ts`'s `deriveLogicalWork` is what groups them
   * into one `LogicalWork` card with a visible "N attempts" disclosure -
   * this field itself is the raw, ungrouped truth. Identical to
   * `liveRunAttempts` today; kept as two field names only so existing
   * callers built against either one keep working unchanged (#307 retires
   * the duplicate name once every caller has migrated to the explicit view
   * models). */
  liveRuns: AgentRun[];
  /** Same raw list as `liveRuns` - see that field's doc comment. Optional
   * for callers constructing local fixtures; production fetches always
   * populate it. */
  liveRunAttempts?: AgentRun[];
  recentRuns: AgentRun[];
  /** undefined = runner API unavailable (e.g. token lacks admin:read).
   * Deduped by runner id across every watched repo (see `fleetByRepo` for
   * the un-deduped per-repo view), so this never double-counts an
   * org-level runner group shared across repos. */
  fleet?: FleetSummary;
  /** Per-repo runner counts, keyed by `repoKey()` - each repo's own
   * `listSelfHostedRunnersForRepo` view, NOT deduped against the others (an
   * org-shared runner genuinely shows up in both repos' own API response,
   * so this reflects what each repo actually reports). Only present when
   * more than one repo is watched; a single-repo config has nothing to
   * break out. */
  fleetByRepo?: Record<string, FleetSummary>;
  /** Human-readable notes when a section above degraded instead of crashing. */
  warnings: string[];
}

const DISPLAY_TITLE_NUMBER_RE = /^(?:(?:codex|opencode)\s+)?#(\d+):/;

export function issueNumberFromDisplayTitle(
  displayTitle: string,
): number | undefined {
  const match = displayTitle.match(DISPLAY_TITLE_NUMBER_RE);
  return match ? Number(match[1]) : undefined;
}

/**
 * claude.yml/codex.yml/opencode.yml's `run-name` templates all append
 * `[dispatch:g<generation>:<intentId>]` after the `#<issue>:` join key -
 * the serialized dispatch broker's own reconciliation marker
 * (`.github/actions/dispatch-broker/broker.mjs` and `github-api.mjs` render
 * the identical `[dispatch:g${generation}:${intentId}]` string when binding
 * a run). Parsing it back out lets the console attribute a raw workflow run
 * to the exact ledger generation/intent that dispatched it (see
 * `logical-work.ts`'s `toExecutionAttempt`) instead of only knowing the
 * issue it worked. Undefined for runs that predate the broker rollout, or
 * any run dispatched by hand outside it (a manual `workflow_dispatch` leaves
 * the input blank, which GitHub Actions renders as an empty
 * `[dispatch:g:]`) - both cases fall back to title/issue-number attribution
 * only.
 */
const DISPATCH_MARKER_RE = /\[dispatch:g(\d+):([A-Za-z0-9._:-]+)\]/;

export interface AttemptMarker {
  generation: number;
  intentId: string;
}

export function attemptMarkerFromDisplayTitle(
  displayTitle: string,
): AttemptMarker | undefined {
  const match = displayTitle.match(DISPATCH_MARKER_RE);
  return match
    ? { generation: Number(match[1]), intentId: match[2] }
    : undefined;
}

const PIPELINE_TITLE_PREFIX_RE = /^(?:codex|opencode)\s+/;

/**
 * opencode.yml's run-name repeats the pipeline name ahead of the `#N:` join
 * key (`opencode #42: Fix the thing`). A pipeline badge already renders
 * "opencode" next to the row, so strip the redundant word from the title
 * text itself to avoid saying it twice.
 */
export function displayRunTitle(run: AgentRun): string {
  return run.pipeline !== 'claude'
    ? run.displayTitle.replace(PIPELINE_TITLE_PREFIX_RE, '')
    : run.displayTitle;
}

/**
 * Direct link to the issue/PR a run worked, derived from its parsed
 * `issueNumber`. Always an `/issues/<N>` path - GitHub redirects that route
 * to `/pull/<N>` automatically when N is actually a PR, so one path covers
 * both kinds without the run needing to know which it is. Undefined for
 * runs that predate the run-name rollout (see `issueNumber`'s own doc) -
 * callers should fall back to the run's own title/url in that case.
 */
export function issueUrlForRun(run: AgentRun): string | undefined {
  return run.issueNumber === undefined
    ? undefined
    : `https://github.com/${run.repo.owner}/${run.repo.name}/issues/${run.issueNumber}`;
}

/**
 * A live run queued longer than this almost certainly means the autoscaler
 * isn't supplying it a runner - distinct from "zero runners registered",
 * which is a normal scaled-to-zero idle state on its own.
 */
export const QUEUE_STALL_THRESHOLD_SECONDS = 300;

/** The longest-stalled queued live run, if any - used to drive the queue
 * health warning (and its "queued for Xm" message). */
export function findStalledQueuedRun(
  liveRuns: AgentRun[],
): AgentRun | undefined {
  return liveRuns
    .filter(
      (run) =>
        run.status === 'queued' &&
        run.elapsedSeconds > QUEUE_STALL_THRESHOLD_SECONDS,
    )
    .sort((a, b) => b.elapsedSeconds - a.elapsedSeconds)[0];
}

/** One or more live runs clustered onto the same issue/PR - e.g. two
 * pipelines racing the same item, or a stray duplicate dispatch. */
export interface LiveRunGroup {
  /** `repoItemKey(repo, issueNumber)` for a run whose issue number parsed;
   * a synthetic `run-<id>` key for one that didn't (predates the run-name
   * rollout - see `AgentRun.issueNumber`'s own doc), so it still gets a
   * (singleton) group of its own instead of colliding with every other
   * unparsed run under one bucket. */
  key: string;
  issueNumber?: number;
  runs: AgentRun[];
}

/**
 * Clusters live runs by the issue/PR they're working, preserving each
 * group's and each run's first-seen order - the In Flight panel renders
 * runs racing the same item together instead of scattered across the flat
 * list (#239).
 */
export function groupLiveRunsByIssue(liveRuns: AgentRun[]): LiveRunGroup[] {
  const groups = new Map<string, LiveRunGroup>();
  for (const run of liveRuns) {
    const key =
      run.issueNumber === undefined
        ? `run-${run.id}`
        : repoItemKey(run.repo, run.issueNumber);
    const existing = groups.get(key);
    if (existing) {
      existing.runs.push(run);
    } else {
      groups.set(key, { key, issueNumber: run.issueNumber, runs: [run] });
    }
  }
  return Array.from(groups.values());
}

/**
 * GitHub can briefly expose more than one workflow attempt for the same
 * logical piece of work (the same repository, issue and agent pipeline),
 * most visibly as one running attempt beside one queued attempt.
 *
 * This used to be how `getAgentActivity` built its authoritative `liveRuns`:
 * pick one representative attempt per (issue, pipeline) key and silently
 * drop the rest. #306 replaced that - a duplicate dispatch (or a genuine
 * retry-in-flight) is exactly the kind of anomaly an operator needs to see,
 * not a rendering inconvenience to smooth over - so `getAgentActivity` no
 * longer calls this to build `liveRuns`; every raw attempt now survives into
 * both `liveRuns` and `liveRunAttempts` (see that field's own doc comment),
 * and `logical-work.ts`'s `deriveLogicalWork` groups duplicates explicitly
 * instead of collapsing them. This function is kept - still pure, still
 * covered by its own tests below - only for callers that still want a
 * single representative row; production code no longer calls it. #307
 * removes it once both repositories and the production canary prove the
 * v1 ledger/run-marker join (see agent-lcars#301).
 *
 * Prefer an actively running attempt over a queued one, then the newest
 * attempt when statuses tie. Runs whose issue number cannot be parsed stay
 * independent because there is no safe item identity on which to collapse.
 */
export function collapseLogicalLiveRuns(liveRuns: AgentRun[]): AgentRun[] {
  const byLogicalKey = new Map<string, AgentRun>();
  const statusRank: Record<AgentRunStatus, number> = {
    completed: 0,
    queued: 1,
    running: 2,
  };

  for (const run of liveRuns) {
    const key =
      run.issueNumber === undefined
        ? `run-${run.id}`
        : `${repoItemKey(run.repo, run.issueNumber)}:${run.pipeline}`;
    const current = byLogicalKey.get(key);
    if (
      !current ||
      statusRank[run.status] > statusRank[current.status] ||
      (statusRank[run.status] === statusRank[current.status] &&
        run.createdAt > current.createdAt)
    ) {
      byLogicalKey.set(key, run);
    }
  }

  return Array.from(byLogicalKey.values());
}

interface WorkflowRunLike {
  id: number;
  status: string | null;
  conclusion: string | null;
  event: string;
  html_url: string;
  display_title: string;
  created_at: string;
  updated_at: string;
  run_started_at?: string;
}

function toConclusion(raw: string | null): AgentRunConclusion | undefined {
  if (!raw) return undefined;
  if (raw === 'success' || raw === 'failure' || raw === 'cancelled') return raw;
  return 'other';
}

function toAgentRun(
  run: WorkflowRunLike,
  repo: WatchedRepo,
  pipeline: AgentPipeline,
): AgentRun {
  const status: AgentRunStatus =
    run.status === 'completed'
      ? 'completed'
      : run.status === 'in_progress'
        ? 'running'
        : 'queued';
  const startMs = new Date(
    status === 'queued'
      ? run.created_at
      : (run.run_started_at ?? run.created_at),
  ).getTime();
  const endMs =
    status === 'completed' ? new Date(run.updated_at).getTime() : Date.now();
  return {
    id: run.id,
    repo,
    pipeline,
    status,
    conclusion: toConclusion(run.conclusion),
    event: run.event,
    url: run.html_url,
    displayTitle: run.display_title,
    issueNumber: issueNumberFromDisplayTitle(run.display_title),
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    elapsedSeconds: Math.max(0, Math.round((endMs - startMs) / 1000)),
  };
}

// Both claude.yml and opencode.yml still fire on every issue comment, while
// agent-router.yml is the sole label listener. Most comment-triggered runs
// skip at the job-level `if:` and complete in seconds with conclusion
// `skipped`. During a busy comment stretch the
// newest 50+ runs can ALL be skipped no-ops, so "recent real runs" cannot be
// derived from a single recency-ordered page - query per real conclusion
// instead (the API's `status` param also accepts conclusions) and merge.
const RECENT_CONCLUSIONS = ['success', 'failure', 'cancelled'] as const;

async function fetchLiveRuns(
  octokit: Octokit,
  repo: WatchedRepo,
  pipeline: AgentPipeline,
  workflowFile: string,
): Promise<AgentRun[]> {
  const response = await octokit.rest.actions.listWorkflowRuns({
    owner: repo.owner,
    repo: repo.name,
    workflow_id: workflowFile,
    per_page: 30,
  });
  return response.data.workflow_runs
    .filter((run) => run.status !== 'completed')
    .map((run) => toAgentRun(run, repo, pipeline));
}

async function fetchRecentRuns(
  octokit: Octokit,
  repo: WatchedRepo,
  pipeline: AgentPipeline,
  workflowFile: string,
): Promise<AgentRun[]> {
  const responses = await Promise.all(
    RECENT_CONCLUSIONS.map((status) =>
      octokit.rest.actions.listWorkflowRuns({
        owner: repo.owner,
        repo: repo.name,
        workflow_id: workflowFile,
        status,
        per_page: RECENT_RUN_LIMIT,
      }),
    ),
  );
  return responses
    .flatMap((response) => response.data.workflow_runs)
    .map((run) => toAgentRun(run, repo, pipeline));
}

const PIPELINES: AgentPipeline[] = ['claude', 'codex', 'opencode'];

export async function getAgentActivity(): Promise<AgentActivity> {
  const octokit = getGithubClient();
  const repos = getWatchedRepos();

  // One (repo, pipeline) pair per fetch, skipping pairs a repo has opted out
  // of (see resolveWorkflowFile) - naive N-repo x M-pipeline fan-out,
  // deliberately unthrottled for now (see #13, filed alongside this change).
  const pairs = repos.flatMap((repo) =>
    PIPELINES.flatMap((pipeline) => {
      const workflowFile = resolveWorkflowFile(repo, pipeline);
      return workflowFile ? [{ repo, pipeline, workflowFile }] : [];
    }),
  );

  // Same defensive pattern as getActionItems: any half failing (API hiccup,
  // missing token permission) degrades that section instead of crashing the
  // whole dashboard. Live runs are always the newest rows, so one small
  // unfiltered page per pair covers them. The runner fleet listing is
  // fetched per repo - deduped by runner id before summing (below), since
  // an org-level runner group shared across watched repos would otherwise
  // be double-counted once for each repo that can see it.
  const [liveResults, recentResults, runnerResults] = await Promise.all([
    Promise.allSettled(
      pairs.map(({ repo, pipeline, workflowFile }) =>
        fetchLiveRuns(octokit, repo, pipeline, workflowFile),
      ),
    ),
    Promise.allSettled(
      pairs.map(({ repo, pipeline, workflowFile }) =>
        fetchRecentRuns(octokit, repo, pipeline, workflowFile),
      ),
    ),
    Promise.allSettled(
      repos.map((repo) =>
        octokit.rest.actions
          .listSelfHostedRunnersForRepo({
            owner: repo.owner,
            repo: repo.name,
            per_page: 100,
          })
          .then((response) => ({ repo, response })),
      ),
    ),
  ]);

  const warnings: string[] = [];

  let liveRuns: AgentRun[] = [];
  for (const [i, result] of liveResults.entries()) {
    if (result.status === 'fulfilled') {
      liveRuns = liveRuns.concat(result.value);
    } else {
      console.error(
        'agent-lcars: failed to list live agent runs (%s/%s):',
        repoKey(pairs[i].repo),
        pairs[i].pipeline,
        result.reason,
      );
      warnings.push(
        `Live agent runs unavailable for ${repoKey(pairs[i].repo)} (GitHub API request failed).`,
      );
    }
  }
  // No representative-attempt collapse here (#306) - every raw attempt
  // survives into both fields the console reads (see AgentActivity's own
  // doc comments). Duplicate/anomalous attempts are grouped explicitly by
  // `logical-work.ts`'s `deriveLogicalWork`, never dropped by this fetch.
  const liveRunAttempts = liveRuns;

  let recentRuns: AgentRun[] = [];
  for (const [i, result] of recentResults.entries()) {
    if (result.status === 'fulfilled') {
      recentRuns = recentRuns.concat(result.value);
    } else {
      console.error(
        'agent-lcars: failed to list recent agent runs (%s/%s):',
        repoKey(pairs[i].repo),
        pairs[i].pipeline,
        result.reason,
      );
      warnings.push(
        `Recent agent runs unavailable for ${repoKey(pairs[i].repo)} (GitHub API request failed).`,
      );
    }
  }
  recentRuns = recentRuns
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, RECENT_RUN_LIMIT);

  let fleet: FleetSummary | undefined;
  let fleetByRepo: Record<string, FleetSummary> | undefined;
  // Keyed by runner id (not summed inline): an org-level runner group
  // registers identically against every repo it's shared with, so listing
  // it per watched repo would otherwise count the same runner once per
  // repo that can see it.
  const runnersById = new Map<number, { status: string; busy: boolean }>();
  let anyFleetResult = false;
  const perRepoFleet: Record<string, FleetSummary> = {};
  for (const [i, result] of runnerResults.entries()) {
    if (result.status === 'fulfilled') {
      anyFleetResult = true;
      const repoTotal = { online: 0, busy: 0 };
      for (const runner of result.value.response.data.runners) {
        runnersById.set(runner.id, {
          status: runner.status,
          busy: runner.busy,
        });
        if (runner.status === 'online') {
          repoTotal.online += 1;
          if (runner.busy) repoTotal.busy += 1;
        }
      }
      perRepoFleet[repoKey(repos[i])] = repoTotal;
    } else {
      console.error(
        'agent-lcars: failed to list self-hosted runners (%s):',
        repoKey(repos[i]),
        result.reason,
      );
      warnings.push(
        `Runner fleet status unavailable for ${repoKey(repos[i])} (GitHub API request failed).`,
      );
    }
  }
  if (anyFleetResult) {
    fleet = { online: 0, busy: 0 };
    for (const runner of runnersById.values()) {
      if (runner.status === 'online') {
        fleet.online += 1;
        if (runner.busy) fleet.busy += 1;
      }
    }
    if (repos.length > 1) {
      fleetByRepo = perRepoFleet;
    }
  }

  return {
    liveRuns,
    liveRunAttempts,
    recentRuns,
    fleet,
    fleetByRepo,
    warnings: Array.from(new Set(warnings)),
  };
}
