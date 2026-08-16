import type {
  Orchestrator,
  OrchestratorStore,
  OutboxEntry,
  Run,
} from '@agent-lcars/orchestrator';

/**
 * The outbox drain: turns `@agent-lcars/orchestrator` decisions into real
 * GitHub effects. The orchestrator itself never does I/O beyond its own
 * store (see `libs/orchestrator/src/orchestrator.ts`) - it only records
 * that a run should be dispatched or that its outcome should be reported,
 * as a durable outbox entry. This module is the worker that drains that
 * outbox: it launches the worker workflow via `workflow_dispatch` and
 * posts the outcome back to the issue as a comment.
 *
 * Nothing here is durable itself - `store.claimPendingOutbox` /
 * `store.settleOutbox` own that. A failed GitHub call just leaves its entry
 * `pending` for a later `drainOutbox` call to retry.
 */

/** GitHub's REST API accepts a bearer token for both endpoints this module
 * calls. */
const GITHUB_API = 'https://api.github.com';

export interface DispatchDeps {
  store: OrchestratorStore;
  orchestrator: Orchestrator;
  githubToken: string;
  /** Injectable for tests; defaults to the ambient `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface DrainOutboxResult {
  /** runIds whose worker workflow was successfully dispatched. */
  dispatched: string[];
  /** runIds whose outcome comment was successfully posted. */
  reported: string[];
  failed: { entryId: string; error: string }[];
}

/**
 * Claims up to `limit` pending outbox entries and attempts to deliver each.
 * Never throws: every entry is either settled (`done`) or left `pending`
 * with its failure recorded, so a caller can simply invoke this again later
 * to retry.
 */
export async function drainOutbox(
  deps: DispatchDeps,
  limit?: number,
): Promise<DrainOutboxResult> {
  const entries = await deps.store.claimPendingOutbox(limit ?? 10);
  const result: DrainOutboxResult = {
    dispatched: [],
    reported: [],
    failed: [],
  };

  for (const entry of entries) {
    try {
      if (entry.kind === 'dispatch-run') {
        await handleDispatchRun(deps, entry, result);
      } else {
        await handleReportOutcome(deps, entry, result);
      }
    } catch (error) {
      result.failed.push({
        entryId: entry.entryId,
        error: errorMessage(error),
      });
      // Best-effort: the entry may already be settled by the failed
      // handler; leaving it `pending` here just means a later drain
      // retries it, which is always safe.
      await settleQuietly(deps.store, entry.entryId, 'pending');
    }
  }

  return result;
}

/**
 * Launches the run's worker workflow via `workflow_dispatch`. A run whose
 * outbox entry outlived it (already settled elsewhere, or never made it
 * past `pending`) is stale: there is nothing left to dispatch, so the entry
 * is just marked done without ever calling GitHub.
 */
async function handleDispatchRun(
  deps: DispatchDeps,
  entry: OutboxEntry,
  result: DrainOutboxResult,
): Promise<void> {
  const { store, orchestrator, githubToken } = deps;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  const run = await store.readRun(entry.runId);
  if (run === undefined || run.state !== 'pending') {
    await store.settleOutbox(entry.entryId, 'done');
    return;
  }

  const inputs = {
    issue: String(run.task.issue),
    mode: run.params?.mode ?? 'implement',
    reply: run.params?.reply ?? '',
    broker_intent_id: run.runId,
    broker_generation: parseGeneration(run.runId),
    broker_dispatch_token: crypto.randomUUID(),
  };
  const url = `${GITHUB_API}/repos/${run.task.repo}/actions/workflows/${run.pipeline}.yml/dispatches`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: githubHeaders(githubToken),
      body: JSON.stringify({ ref: 'main', inputs }),
    });
  } catch (error) {
    await store.settleOutbox(entry.entryId, 'pending');
    result.failed.push({ entryId: entry.entryId, error: errorMessage(error) });
    return;
  }

  if (response.status !== 204) {
    await store.settleOutbox(entry.entryId, 'pending');
    result.failed.push({
      entryId: entry.entryId,
      error: `workflow_dispatch returned ${response.status}`,
    });
    return;
  }

  await orchestrator.confirmDispatch(run.runId);
  await store.settleOutbox(entry.entryId, 'done');
  result.dispatched.push(run.runId);
}

/** Posts the run's outcome onward as an issue comment. */
async function handleReportOutcome(
  deps: DispatchDeps,
  entry: OutboxEntry,
  result: DrainOutboxResult,
): Promise<void> {
  const { store, githubToken } = deps;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  const run = await store.readRun(entry.runId);
  if (run === undefined) {
    // The report-outcome entry is always applied atomically alongside the
    // run's own settlement (see decide.ts's reportResult/cancelRun/
    // expireLease), so this should not happen. Guard it anyway rather than
    // throw: leave the entry for a later drain in case of a transient
    // read issue.
    await store.settleOutbox(entry.entryId, 'pending');
    result.failed.push({
      entryId: entry.entryId,
      error: `no such run: ${entry.runId}`,
    });
    return;
  }

  const body = outcomeCommentBody(run);
  const url = `${GITHUB_API}/repos/${run.task.repo}/issues/${run.task.issue}/comments`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: githubHeaders(githubToken),
      body: JSON.stringify({ body }),
    });
  } catch (error) {
    await store.settleOutbox(entry.entryId, 'pending');
    result.failed.push({ entryId: entry.entryId, error: errorMessage(error) });
    return;
  }

  if (response.status !== 201) {
    await store.settleOutbox(entry.entryId, 'pending');
    result.failed.push({
      entryId: entry.entryId,
      error: `issue comment returned ${response.status}`,
    });
    return;
  }

  await store.settleOutbox(entry.entryId, 'done');
  result.reported.push(run.runId);
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
}

/** A runId is `{repo}#{issue}/r{generation}` (see `model.ts`'s `requestRun`
 * run-id minting); this pulls the trailing generation back out for the
 * `broker_generation` workflow input. */
function parseGeneration(runId: string): string {
  const match = /\/r(\d+)$/u.exec(runId);
  if (match === null) {
    throw new Error(`cannot parse generation from runId: ${runId}`);
  }
  return match[1];
}

function outcomeCommentBody(run: Run): string {
  switch (run.state) {
    case 'finished': {
      const lines = run.result?.ok
        ? [`✅ Run ${run.runId} finished.`]
        : [`❌ Run ${run.runId} failed.`];
      if (run.result?.ok && run.result.ref !== undefined) {
        lines.push(run.result.ref);
      }
      if (run.result?.summary !== undefined) lines.push(run.result.summary);
      return lines.join('\n');
    }
    case 'canceled':
      return `⏹️ Run ${run.runId} was canceled.`;
    case 'lost':
      return (
        `⚠️ Run ${run.runId} was lost (no report before its lease expired). ` +
        `The task is unlocked; re-request to try again.`
      );
    case 'pending':
    case 'running':
      // A report-outcome entry only ever accompanies a run settling into
      // one of the states above (see decide.ts); this should be
      // unreachable in practice.
      throw new Error(
        `report-outcome for run ${run.runId} in non-terminal state ${run.state}`,
      );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function settleQuietly(
  store: OrchestratorStore,
  entryId: string,
  state: 'pending' | 'done',
): Promise<void> {
  try {
    await store.settleOutbox(entryId, state);
  } catch {
    // Already recorded as a failure by the caller; a settle failure here
    // just means the next drain reclaims it, which is fine.
  }
}
