import {
  type LeasedOutboxEntry,
  MAX_AUTO_RETRIES,
  type Orchestrator,
  type OrchestratorStore,
  OUTBOX_LEASE_MS,
  type Run,
  type TaskId,
} from '@agent-lcars/orchestrator';

import type { DispatchTokenProvider } from './github-app-tokens';

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
 *
 * Every GitHub call resolves its bearer token per-repo through `tokens`
 * (see `github-app-tokens.ts`) rather than a single ambient token, so a
 * dispatch or outcome comment against a foreign repo can use a token
 * actually scoped there.
 */

/** GitHub's REST API accepts a bearer token for both endpoints this module
 * calls. */
const GITHUB_API = 'https://api.github.com';

export interface DispatchDeps {
  store: OrchestratorStore;
  orchestrator: Orchestrator;
  /** Resolves the bearer token to use for a given repo's GitHub calls. */
  tokens: DispatchTokenProvider;
  /** Injectable for tests; defaults to the ambient `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable GitHub REST root; defaults to the production API. */
  githubApiBaseUrl?: string;
  /** Injectable for deterministic lease tests; defaults to wall-clock UTC. */
  now?: () => string;
}

export interface DrainOutboxResult {
  /** runIds whose worker workflow was successfully dispatched. */
  dispatched: string[];
  /** runIds whose outcome comment was successfully posted. */
  reported: string[];
  failed: { entryId: string; error: string }[];
}

/**
 * Claims up to `limit` available outbox entries and attempts to deliver each.
 * Never throws: every handled entry is either settled (`done`) or explicitly
 * released (`pending`) with its failure recorded. If the process itself dies,
 * the durable lease expires so a later invocation can retry it.
 */
export async function drainOutbox(
  deps: DispatchDeps,
  limit?: number,
): Promise<DrainOutboxResult> {
  const result: DrainOutboxResult = {
    dispatched: [],
    reported: [],
    failed: [],
  };

  // Claim immediately before delivery, not as one upfront batch. Otherwise a
  // slow first GitHub call can consume the leases of later entries before
  // their first attempt, allowing another drain to recover them while this
  // invocation still intends to deliver them.
  for (let claimed = 0; claimed < (limit ?? 10); claimed += 1) {
    const claimedAt = now(deps);
    const [entry] = await deps.store.claimPendingOutbox({
      limit: 1,
      now: claimedAt,
      leaseExpiresAt: new Date(
        Date.parse(claimedAt) + OUTBOX_LEASE_MS,
      ).toISOString(),
    });
    if (entry === undefined) break;

    const failuresBefore = result.failed.length;
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
      await settleQuietly(deps, entry, 'pending');
    }
    // An explicit failure releases the current entry for a future invocation.
    // Stop here so this same drain cannot immediately reclaim it and consume
    // the rest of its limit retrying one persistent failure.
    if (result.failed.length > failuresBefore) break;
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
  entry: LeasedOutboxEntry,
  result: DrainOutboxResult,
): Promise<void> {
  const { store, orchestrator, tokens } = deps;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  const run = await store.readRun(entry.runId);
  if (run === undefined || run.state !== 'pending') {
    await settleClaim(deps, entry, 'done');
    return;
  }

  const inputs = {
    issue: String(run.task.issue),
    mode: run.params?.mode ?? 'implement',
    reply: run.params?.reply ?? '',
    runbook: run.params?.runbook ?? '',
    context: run.params?.context ?? '',
    broker_intent_id: run.runId,
    broker_generation: parseGeneration(run.runId),
    broker_dispatch_token: crypto.randomUUID(),
  };
  const url = `${githubApiBaseUrl(deps)}/repos/${run.task.repo}/actions/workflows/${run.pipeline}.yml/dispatches`;

  let response: Response;
  try {
    const token = await tokens.tokenFor(run.task.repo);
    response = await fetchImpl(url, {
      method: 'POST',
      headers: githubHeaders(token),
      body: JSON.stringify({ ref: 'main', inputs }),
    });
  } catch (error) {
    await settleClaim(deps, entry, 'pending');
    result.failed.push({ entryId: entry.entryId, error: errorMessage(error) });
    return;
  }

  if (response.status !== 204) {
    await settleClaim(deps, entry, 'pending');
    result.failed.push({
      entryId: entry.entryId,
      error: `workflow_dispatch returned ${response.status}`,
    });
    return;
  }

  await orchestrator.confirmDispatch(run.runId);
  await settleClaim(deps, entry, 'done');
  result.dispatched.push(run.runId);
}

/** Posts the run's outcome onward as an issue comment. */
async function handleReportOutcome(
  deps: DispatchDeps,
  entry: LeasedOutboxEntry,
  result: DrainOutboxResult,
): Promise<void> {
  const { store, tokens } = deps;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  const run = await store.readRun(entry.runId);
  if (run === undefined) {
    // The report-outcome entry is always applied atomically alongside the
    // run's own settlement (see decide.ts's reportResult/cancelRun/
    // expireLease), so this should not happen. Guard it anyway rather than
    // throw: leave the entry for a later drain in case of a transient
    // read issue.
    await settleClaim(deps, entry, 'pending');
    result.failed.push({
      entryId: entry.entryId,
      error: `no such run: ${entry.runId}`,
    });
    return;
  }

  const outcome =
    run.state === 'lost'
      ? await describeLostOutcome(store, run)
      : { body: outcomeCommentBody(run), needsHumanLabel: false };
  const url = `${githubApiBaseUrl(deps)}/repos/${run.task.repo}/issues/${run.task.issue}/comments`;

  let response: Response;
  try {
    const token = await tokens.tokenFor(run.task.repo);
    response = await fetchImpl(url, {
      method: 'POST',
      headers: githubHeaders(token),
      body: JSON.stringify({ body: outcome.body }),
    });
  } catch (error) {
    await settleClaim(deps, entry, 'pending');
    result.failed.push({ entryId: entry.entryId, error: errorMessage(error) });
    return;
  }

  if (response.status !== 201) {
    await settleClaim(deps, entry, 'pending');
    result.failed.push({
      entryId: entry.entryId,
      error: `issue comment returned ${response.status}`,
    });
    return;
  }

  if (outcome.needsHumanLabel) {
    await addNeedsHumanLabelBestEffort(
      fetchImpl,
      tokens,
      run.task,
      githubApiBaseUrl(deps),
    );
  }

  await settleClaim(deps, entry, 'done');
  result.reported.push(run.runId);
}

/**
 * Describes a `lost` run's outcome comment, which depends on what happened
 * after the loss -- something `outcomeCommentBody` alone can't know, since
 * it only looks at the run itself. Reads the task's current active run (if
 * any) from the store:
 *
 * - it's the deterministic auto-retry (`requestId === 'retry:<lostRunId>'`)
 *   -> name it and report the attempt count;
 * - it's some other live run (an operator's manual request raced the
 *   auto-retry and won, or landed after the budget was already exhausted)
 *   -> name that run instead, matching decide.ts's "refusal is fine"
 *   contract: no auto-retry to report, but the task isn't actually parked;
 * - no active run at all -> the auto-retry budget is exhausted; the task is
 *   genuinely parked, so also flag it for human attention.
 *
 * This is a best-effort read of state as of drain time, not a fact
 * captured durably alongside the lost run itself; in the common case the
 * drain runs moments after the sweep that settled the loss (and any
 * retry), so it reliably reflects that sweep's outcome.
 */
async function describeLostOutcome(
  store: OrchestratorStore,
  run: Run,
): Promise<{ body: string; needsHumanLabel: boolean }> {
  const lostPrefix = `⚠️ Run ${run.runId} ${lostCause(run)}. `;
  const task = await store.readTask(run.task);
  const activeRunId = task?.task.activeRunId;
  const activeRun =
    activeRunId === undefined ? undefined : await store.readRun(activeRunId);

  if (activeRun?.requestId === `retry:${run.runId}`) {
    const attempt = (task?.task.consecutiveLost ?? 0) + 1;
    return {
      body:
        lostPrefix +
        `Retrying automatically as run ${activeRun.runId} ` +
        `(attempt ${attempt} of ${MAX_AUTO_RETRIES + 1}).`,
      needsHumanLabel: false,
    };
  }
  if (activeRun !== undefined) {
    return {
      body: lostPrefix + `Run ${activeRun.runId} is already in progress.`,
      needsHumanLabel: false,
    };
  }
  return {
    body:
      lostPrefix +
      `Auto-retry budget exhausted -- re-request manually (re-add the ` +
      `agent label) when ready.`,
    needsHumanLabel: true,
  };
}

/**
 * Why a `lost` run was lost, in the reader's terms. Both settle paths reach
 * `lost` (see decide.ts's `expireLease` and `settleTerminal`), but for very
 * different reasons, and saying "no report before its lease expired" about a
 * run whose workflow died at `startup_failure` ten minutes in is simply
 * false. The run's own last event already records which path settled it and
 * what the evidence was, so read that rather than assuming.
 */
function lostCause(run: Run): string {
  const last = run.events.at(-1);
  if (last?.by === 'infra') {
    return `was lost (${last.note ?? 'its executor failed'}, no completion report)`;
  }
  return 'was lost (no report before its lease expired)';
}

/** Flags the issue for human attention once the auto-retry budget is
 *  exhausted. Best-effort: a failure here must not fail the outcome-comment
 *  entry, which has already been posted and is about to be settled --
 *  the operator already has the comment telling them what happened;
 *  a missing label is a cosmetic miss, not a functional one. */
async function addNeedsHumanLabelBestEffort(
  fetchImpl: typeof fetch,
  tokens: DispatchTokenProvider,
  task: TaskId,
  apiBaseUrl: string,
): Promise<void> {
  try {
    const token = await tokens.tokenFor(task.repo);
    await fetchImpl(
      `${apiBaseUrl}/repos/${task.repo}/issues/${task.issue}/labels`,
      {
        method: 'POST',
        headers: githubHeaders(token),
        body: JSON.stringify({ labels: ['status:needs-human'] }),
      },
    );
  } catch {
    // Swallowed deliberately -- see the doc comment above.
  }
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
      // `handleReportOutcome` routes `lost` runs to `describeLostOutcome`
      // instead, which needs to consult the store for auto-retry state;
      // this function only covers the synchronous, run-only cases.
      throw new Error(`outcomeCommentBody called for a lost run: ${run.runId}`);
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

function githubApiBaseUrl(
  deps: Pick<DispatchDeps, 'githubApiBaseUrl'>,
): string {
  return (deps.githubApiBaseUrl ?? GITHUB_API).replace(/\/+$/u, '');
}

async function settleQuietly(
  deps: DispatchDeps,
  entry: LeasedOutboxEntry,
  state: 'pending' | 'done',
): Promise<void> {
  try {
    await settleClaim(deps, entry, state);
  } catch {
    // Already recorded as a failure by the caller; a settle failure here
    // just means the next drain reclaims it, which is fine.
  }
}

function now(deps: DispatchDeps): string {
  return deps.now?.() ?? new Date().toISOString();
}

async function settleClaim(
  deps: DispatchDeps,
  entry: LeasedOutboxEntry,
  state: 'pending' | 'done',
): Promise<boolean> {
  return deps.store.settleOutbox({
    entryId: entry.entryId,
    claimId: entry.claimId,
    state,
    now: now(deps),
  });
}
