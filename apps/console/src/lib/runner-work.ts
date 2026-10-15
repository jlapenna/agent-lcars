import 'server-only';

import { logger } from '@agent-lcars/logging';

import { type AgentRun, agentRunFromOrchestrator } from './agent-activity';
import type { AutoscalerStatusResult, RunnerWork } from './autoscaler-status';
import { createOrchestratorRuntime } from './orchestrator-runtime';

/** A run's task never changes, so a resolved run stays resolved. The bound
 * only keeps a long-lived server from holding every run it ever drew. */
const resolved = new Map<string, RunnerWork>();
const RESOLVED_LIMIT = 256;

/** The Runners row's Job cell for a direct run: `repo #N` opens the task,
 * a Work item opens its page (decision-rows.ts uses the same references). */
export function runnerWorkFor(run: AgentRun): RunnerWork {
  const repo = `${run.repo.owner}/${run.repo.name}`;
  return run.issueNumber !== undefined
    ? {
        label: `${run.repo.name}#${run.issueNumber}`,
        href: `/task/${repo}/${run.issueNumber}`,
        repo,
        pipeline: run.pipeline,
      }
    : {
        label: `${run.repo.name} work`,
        href: `/work/${run.workId}`,
        repo,
        pipeline: run.pipeline,
      };
}

async function readRunnerWork(runId: string): Promise<RunnerWork | undefined> {
  const { store } = createOrchestratorRuntime();
  const run = await store.readRun(runId);
  if (run === undefined) return undefined;
  const task = await store.readTask(run.task);
  if (task === undefined) return undefined;
  const projected = agentRunFromOrchestrator(run, task.task);
  return projected === undefined ? undefined : runnerWorkFor(projected);
}

/** Reads in flight, shared by every stream and page asking for the run. */
const pending = new Map<string, Promise<boolean>>();
/** A run that could not be resolved is not read again for a minute, so a
 * missing run or a Firestore outage does not cost two reads per snapshot
 * per connected client. */
const unresolvedUntil = new Map<string, number>();
const RETRY_UNRESOLVED_MS = 60_000;

function remember(runId: string, work: RunnerWork): void {
  if (resolved.size >= RESOLVED_LIMIT) {
    const oldest = resolved.keys().next().value;
    if (oldest !== undefined) resolved.delete(oldest);
  }
  resolved.set(runId, work);
  unresolvedUntil.delete(runId);
}

function readOnce(runId: string, now: number): Promise<boolean> {
  const inFlight = pending.get(runId);
  if (inFlight !== undefined) return inFlight;
  const read = readRunnerWork(runId)
    .then(
      (work) => {
        if (work !== undefined) remember(runId, work);
        return work !== undefined;
      },
      (error: unknown) => {
        logger.error('agent-lcars: runner work unavailable:', error);
        return false;
      },
    )
    .then((found) => {
      if (!found) {
        if (unresolvedUntil.size >= RESOLVED_LIMIT) unresolvedUntil.clear();
        unresolvedUntil.set(runId, now + RETRY_UNRESOLVED_MS);
      }
      pending.delete(runId);
      return found;
    });
  pending.set(runId, read);
  return read;
}

/** Reads the work item of every direct runner not yet resolved. True when
 * anything resolved, so a live stream knows to emit again. A run that cannot
 * be read leaves its row naming its run id. */
export async function resolveRunnerWork(
  result: AutoscalerStatusResult,
  now = Date.now(),
): Promise<boolean> {
  const runIds = new Set(
    (result.hostInventory?.runners ?? []).flatMap((runner) =>
      runner.runId !== undefined &&
      !resolved.has(runner.runId) &&
      (unresolvedUntil.get(runner.runId) ?? 0) <= now
        ? [runner.runId]
        : [],
    ),
  );
  const found = await Promise.all(
    [...runIds].map((runId) => readOnce(runId, now)),
  );
  return found.some(Boolean);
}

/** Attaches each direct runner's resolved work item. */
export function withRunnerWork(
  result: AutoscalerStatusResult,
): AutoscalerStatusResult {
  const inventory = result.hostInventory;
  if (inventory?.runners === undefined) return result;
  return {
    ...result,
    hostInventory: {
      ...inventory,
      runners: inventory.runners.map((runner) => {
        const work =
          runner.runId === undefined ? undefined : resolved.get(runner.runId);
        return work === undefined ? runner : { ...runner, work };
      }),
    },
  };
}

/** Test seam: forget every resolved run. */
export function resetRunnerWork(): void {
  resolved.clear();
  pending.clear();
  unresolvedUntil.clear();
}
