import { getGithubClient, REPO_NAME, REPO_OWNER } from './github-client';

// Mirrors timeout-minutes in .github/workflows/claude.yml so the live-run
// progress bar reflects the real kill budget.
export const RUN_TIMEOUT_MINUTES = 90;

const AGENT_WORKFLOW_FILE = 'claude.yml';
const AGENT_RUNNER_LABEL = 'claude-workstation';
const RECENT_RUN_LIMIT = 8;

export type AgentRunStatus = 'queued' | 'running' | 'completed';
export type AgentRunConclusion = 'success' | 'failure' | 'cancelled' | 'other';

export interface AgentRun {
  id: number;
  status: AgentRunStatus;
  conclusion?: AgentRunConclusion;
  event: string;
  url: string;
  /**
   * For `issues`/`issue_comment`-triggered runs GitHub sets this to the
   * issue/PR title, which lets the dashboard join live runs to action items
   * without any runner-side telemetry.
   */
  displayTitle: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Queued: seconds spent waiting for a runner. Running: seconds since the
   * run started. Completed: total run duration.
   */
  elapsedSeconds: number;
}

export interface RunnerStatus {
  name: string;
  online: boolean;
  busy: boolean;
}

export interface AgentActivity {
  liveRuns: AgentRun[];
  recentRuns: AgentRun[];
  /** undefined = runner API unavailable (e.g. token lacks admin:read). */
  runners?: RunnerStatus[];
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

function toAgentRun(run: WorkflowRunLike): AgentRun {
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
    status,
    conclusion: toConclusion(run.conclusion),
    event: run.event,
    url: run.html_url,
    displayTitle: run.display_title,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    elapsedSeconds: Math.max(0, Math.round((endMs - startMs) / 1000)),
  };
}

// claude.yml fires on EVERY issue comment and label event; almost all runs
// skip at the job-level `if:` and complete in seconds with conclusion
// `skipped`. During a busy comment stretch the newest 50+ runs can ALL be
// skipped no-ops, so "recent real runs" cannot be derived from a single
// recency-ordered page - query per real conclusion instead (the API's
// `status` param also accepts conclusions) and merge.
const RECENT_CONCLUSIONS = ['success', 'failure', 'cancelled'] as const;

export async function getAgentActivity(): Promise<AgentActivity> {
  const octokit = getGithubClient();

  // Same defensive pattern as getActionItems: any of the three halves
  // failing (API hiccup, missing token permission) degrades that panel
  // section instead of crashing the whole dashboard. Live runs are always
  // the newest rows, so one small unfiltered page covers them.
  const [liveResult, runnersResult, recentResult] = await Promise.allSettled([
    octokit.rest.actions.listWorkflowRuns({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      workflow_id: AGENT_WORKFLOW_FILE,
      per_page: 30,
    }),
    octokit.rest.actions.listSelfHostedRunnersForRepo({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      per_page: 100,
    }),
    Promise.all(
      RECENT_CONCLUSIONS.map((status) =>
        octokit.rest.actions.listWorkflowRuns({
          owner: REPO_OWNER,
          repo: REPO_NAME,
          workflow_id: AGENT_WORKFLOW_FILE,
          status,
          per_page: RECENT_RUN_LIMIT,
        }),
      ),
    ),
  ]);

  let liveRuns: AgentRun[] = [];
  if (liveResult.status === 'fulfilled') {
    liveRuns = liveResult.value.data.workflow_runs
      .map(toAgentRun)
      .filter((run) => run.status !== 'completed');
  } else {
    console.error(
      'agent-console: failed to list live agent runs:',
      liveResult.reason,
    );
  }

  let recentRuns: AgentRun[] = [];
  if (recentResult.status === 'fulfilled') {
    recentRuns = recentResult.value
      .flatMap((response) => response.data.workflow_runs)
      .map(toAgentRun)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, RECENT_RUN_LIMIT);
  } else {
    console.error(
      'agent-console: failed to list recent agent runs:',
      recentResult.reason,
    );
  }

  let runners: RunnerStatus[] | undefined;
  if (runnersResult.status === 'fulfilled') {
    runners = runnersResult.value.data.runners
      .filter((runner) =>
        runner.labels.some((label) => label.name === AGENT_RUNNER_LABEL),
      )
      .map((runner) => ({
        name: runner.name,
        online: runner.status === 'online',
        busy: runner.busy,
      }));
  } else {
    console.error(
      'agent-console: failed to list self-hosted runners:',
      runnersResult.reason,
    );
  }

  return { liveRuns, recentRuns, runners };
}
