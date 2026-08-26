import { parseDispatchMarker } from '@agent-lcars/dispatch-contracts';
import {
  isWorkAnchor,
  type Orchestrator,
  type OrchestratorStore,
  type Run,
  taskKey,
  type TerminalRunEntry,
} from '@agent-lcars/orchestrator';

import { anchorTarget } from './anchor-target';
import type { DispatchTokenProvider } from './github-app-tokens';

/**
 * The GitHub boundary for settling runs whose worker workflow is already
 * over (#1361).
 *
 * A run that dies at `startup_failure` -- or is `cancelled` before its first
 * job -- never executes a single step, so the worker never reports
 * completion and `agent-fallback-finalize` never runs either (it is a job in
 * the same workflow, so a validation failure takes it out too). Nothing
 * reports the outcome, the run stays live, and the per-task mutex stays held
 * until the lease expires two hours later. That is the slowest recovery path
 * we have, for the failure mode that is cheapest to detect: the terminal
 * GitHub run is sitting right there.
 *
 * This module reads it. `@agent-lcars/orchestrator` stays pure domain logic
 * over its store and never learns what GitHub is -- it exposes
 * `settleTerminalRuns(entries)`, which takes already-resolved facts. This is
 * where those facts get resolved.
 *
 * Mapping a stored run to its workflow run: GitHub's API does not return a
 * run's dispatch-time inputs on the run object, so `display_title` is the
 * only channel the two share -- which is exactly why the worker workflows
 * embed the `[dispatch:gN:<intentId>]` marker in `run-name:`, and why
 * `@agent-lcars/dispatch-contracts` owns parsing it. The outbox drain passes
 * each run's `runId` verbatim as `broker_intent_id`, so the marker's
 * `intentId` IS the orchestrator runId: no second identifier, and no new
 * persisted field, is needed. It also means this works retroactively, on
 * runs dispatched long before this code existed.
 *
 * The lease remains the backstop: a repo whose runs cannot be listed (API
 * unreachable, token refused, workflow renamed) simply contributes no
 * entries, and its runs settle the old way when their lease expires.
 */

const GITHUB_API = 'https://api.github.com';

/** How many of a workflow's recent `workflow_dispatch` runs to scan per
 *  repo. A live run is by definition recent and the reconciler runs twice an
 *  hour, so one page of 100 is far more history than a live run can hide
 *  behind -- at the cost of one request per repo/workflow pair. */
const RUNS_PAGE_SIZE = 100;

/**
 * The conclusions that mean "this execution is over and nothing will report
 * it". Every one of them is the *executor* failing or being stopped, never
 * an agent saying what it found -- an agent that ran and reported is already
 * settled through the completion callback, so its run is not live here at
 * all.
 *
 * `success` is deliberately absent: a successful run whose callback has not
 * arrived yet is ambiguous (the callback may simply be in flight), so it
 * keeps the lease backstop rather than being force-settled as lost.
 * `action_required`, `neutral`, `skipped` and `stale` are absent for the
 * same reason -- none of them is unambiguously "the work is over".
 */
const TERMINAL_CONCLUSIONS: ReadonlySet<string> = new Set([
  'startup_failure',
  'cancelled',
  'failure',
  'timed_out',
]);

/** Whether a GitHub workflow run's `status`/`conclusion` pair means the run
 *  is over with nothing left to report. Exported for its own unit coverage:
 *  this mapping is the whole judgement this module makes. */
export function isTerminalWorkflowRun(input: {
  status?: string | null;
  conclusion?: string | null;
}): boolean {
  if (input.status !== 'completed') return false;
  return (
    input.conclusion !== null &&
    input.conclusion !== undefined &&
    TERMINAL_CONCLUSIONS.has(input.conclusion)
  );
}

export interface TerminalRunsDeps {
  store: OrchestratorStore;
  orchestrator: Orchestrator;
  tokens: DispatchTokenProvider;
  /** Injectable for tests; defaults to the ambient `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable GitHub REST root; defaults to the production API. */
  githubApiBaseUrl?: string;
}

export interface SettleTerminalRunsResult {
  /** Runs settled by this pass, with the conclusion that proved them over. */
  settled: { runId: string; conclusion: string }[];
  /** Auto-retries started for those runs -- same shape as the sweep's. */
  retried: { lostRunId: string; newRunId: string }[];
  /** Repos whose workflow-run listing failed, or runs whose anchor could
   *  not be resolved to a repo at all. Recorded, never thrown: their runs
   *  keep the lease backstop. */
  failed: { repo: string; pipeline: string; error: string }[];
}

/**
 * Probes every live run's workflow run and settles the ones already over.
 * Never throws: a failed probe leaves its runs alone.
 */
export async function settleTerminalRuns(
  deps: TerminalRunsDeps,
): Promise<SettleTerminalRunsResult> {
  const failed: SettleTerminalRunsResult['failed'] = [];
  const live = await deps.store.listLiveRuns();
  if (live.length === 0) return { settled: [], retried: [], failed };

  const targeted: { run: Run; repo: string }[] = [];
  for (const run of live) {
    try {
      const repo = anchorTarget(
        run,
        isWorkAnchor(run.task)
          ? (await deps.store.readTask(run.task))?.task
          : undefined,
      ).repo;
      targeted.push({ run, repo });
    } catch (error) {
      failed.push({
        repo: taskKey(run.task),
        pipeline: run.pipeline,
        error: errorMessage(error),
      });
    }
  }

  const entries: TerminalRunEntry[] = [];
  for (const [key, runs] of groupByWorkflow(targeted)) {
    const { repo, pipeline } = splitWorkflowKey(key);
    let conclusions: Map<string, string>;
    try {
      conclusions = await terminalConclusions(deps, repo, pipeline);
    } catch (error) {
      failed.push({ repo, pipeline, error: errorMessage(error) });
      continue;
    }
    for (const run of runs) {
      const conclusion = conclusions.get(run.runId);
      if (conclusion !== undefined) {
        entries.push({ runId: run.runId, conclusion });
      }
    }
  }

  const outcome = await deps.orchestrator.settleTerminalRuns(entries);
  return {
    settled: outcome.settled.map((item) => ({
      runId: item.run.runId,
      conclusion: item.conclusion,
    })),
    retried: outcome.retried,
    failed,
  };
}

/** One listing per repo/workflow pair, keyed by the runId each workflow
 *  run's dispatch marker names, holding only the terminal ones. */
async function terminalConclusions(
  deps: TerminalRunsDeps,
  repo: string,
  pipeline: string,
): Promise<Map<string, string>> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const token = await deps.tokens.tokenFor(repo);
  const apiBaseUrl = (deps.githubApiBaseUrl ?? GITHUB_API).replace(/\/+$/u, '');
  const url =
    `${apiBaseUrl}/repos/${repo}/actions/workflows/${pipeline}.yml/runs` +
    `?event=workflow_dispatch&per_page=${RUNS_PAGE_SIZE}`;
  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok) {
    throw new Error(`workflow runs listing returned ${response.status}`);
  }
  const conclusions = new Map<string, string>();
  for (const workflowRun of workflowRuns(await response.json())) {
    if (!isTerminalWorkflowRun(workflowRun)) continue;
    const marker = parseDispatchMarker(
      workflowRun.display_title ?? workflowRun.name,
    );
    if (marker === undefined) continue;
    // First match wins: GitHub returns newest first, and a re-run of the
    // same attempt keeps the same marker.
    if (!conclusions.has(marker.intentId)) {
      conclusions.set(marker.intentId, workflowRun.conclusion ?? 'unknown');
    }
  }
  return conclusions;
}

interface WorkflowRunSummary {
  name?: string | null;
  display_title?: string | null;
  status?: string | null;
  conclusion?: string | null;
}

/** Only the four fields this module reads, pulled off the listing body
 *  defensively -- everything else GitHub sends is ignored. */
function workflowRuns(body: unknown): WorkflowRunSummary[] {
  const runs = (body as { workflow_runs?: unknown } | null)?.workflow_runs;
  return Array.isArray(runs) ? (runs as WorkflowRunSummary[]) : [];
}

/** `repo pipeline` -> the live runs dispatched into that workflow. A space
 *  is a safe separator: neither a `owner/name` repo nor a pipeline id can
 *  contain one. Callers resolve each run's repo (via `anchorTarget`) before
 *  calling this -- `groupByWorkflow` itself never reads an anchor. */
function groupByWorkflow(
  runs: readonly { run: Run; repo: string }[],
): Map<string, Run[]> {
  const grouped = new Map<string, Run[]>();
  for (const { run, repo } of runs) {
    const key = `${repo} ${run.pipeline}`;
    const existing = grouped.get(key);
    if (existing === undefined) grouped.set(key, [run]);
    else existing.push(run);
  }
  return grouped;
}

function splitWorkflowKey(key: string): { repo: string; pipeline: string } {
  const [repo = '', pipeline = ''] = key.split(' ');
  return { repo, pipeline };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
