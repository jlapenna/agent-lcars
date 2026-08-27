import {
  isWorkAnchor,
  type LeasedOutboxEntry,
  MAX_AUTO_RETRIES,
  type Orchestrator,
  type OrchestratorStore,
  OUTBOX_LEASE_MS,
  type Run,
  type Task,
} from '@agent-lcars/orchestrator';
import { type WorkSpec, workSpecSchema } from '@agent-lcars/work';

import { type AnchorTarget, anchorTarget } from './anchor-target';
import { agentFleetLogin, controlPlaneRepository } from './deployment';
import type { DispatchTokenProvider } from './github-app-tokens';

// Re-exported so `run-binding.ts` (and its tests) can depend on this
// module's own token-provider seam rather than reaching past it into
// `github-app-tokens.ts` directly -- same reasoning as this file importing
// it in the first place: "a token good for this repo", not how it's minted.
export type { DispatchTokenProvider };

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
    // A run that is already `running` (not settled/canceled) got there via
    // this same function's primary path below on some earlier attempt --
    // but a crash between that path's `confirmDispatch` and its own
    // `claimGithubAnchor`/`settleClaim` would otherwise lose the claim
    // projection permanently: this reclaimed entry is the only remaining
    // trigger for it. Re-attempt it here, best-effort (`claimGithubAnchor`
    // never throws), for a GitHub anchor only -- a native run's `target`
    // never carries an `issue` for it to project onto anyway.
    if (
      run?.state === 'running' &&
      run.executor !== 'queue' &&
      !isWorkAnchor(run.task)
    ) {
      await claimGithubAnchor(deps, anchorTarget(run));
    }
    await settleClaim(deps, entry, 'done');
    return;
  }

  if (run.executor === 'queue') {
    await store.enqueueRun({ runId: run.runId, now: now(deps) });
    await orchestrator.confirmDispatch(run.runId);
    await settleClaim(deps, entry, 'done');
    result.dispatched.push(run.runId);
    return;
  }

  const task = (await store.readTask(run.task))?.task;
  let target: AnchorTarget;
  try {
    target = anchorTarget(run, task);
  } catch (error) {
    // A native run whose payload cannot name a repository can never be
    // dispatched: permanent, so settle the entry rather than retry it.
    await settleClaim(deps, entry, 'done');
    result.failed.push({ entryId: entry.entryId, error: errorMessage(error) });
    return;
  }

  let inputs: Record<string, string>;
  if (isWorkAnchor(run.task)) {
    // `run.task` is narrowed to the work anchor here, so `.workId` is the
    // bare ULID the worker workflow expects as `work.id` -- not the
    // anchor object itself.
    let spec: WorkSpec;
    try {
      spec = workSpecSchema.parse(task?.work?.['spec']);
    } catch (error) {
      // A spec that fails the workflow-side contract can never be
      // dispatched: permanent, so settle the entry rather than retry it,
      // exactly as the `anchorTarget` failure above.
      await settleClaim(deps, entry, 'done');
      result.failed.push({
        entryId: entry.entryId,
        error: errorMessage(error),
      });
      return;
    }
    inputs = {
      work: JSON.stringify({ id: run.task.workId, spec }),
      mode: 'implement',
      broker_intent_id: run.runId,
      broker_generation: parseGeneration(run.runId),
      broker_dispatch_token: crypto.randomUUID(),
    };
  } else {
    // A GitHub anchor's `work` (present once Tasks 1-3 have derived one for
    // this task) carries no separate `id` -- the anchor already names the
    // task via `issue`. `spec.parse` failing here (an overlong/malformed
    // stored payload) is the same permanent-failure shape as the native
    // branch above: settle done, do not retry a spec that can never parse.
    //
    // Only emit it for the control-plane repo, though: the webhook admits
    // every repo in `AGENT_LCARS_CONTROL_PLANE_REPOSITORIES`, but today
    // only this repo's own `claude/codex/opencode.yml` declare a `work`
    // `workflow_dispatch` input -- #1544 tracks adding it to the six
    // consumer repos. Sending an undeclared input 422s the whole
    // dispatch, and because `drainOutbox` treats any non-204 as a
    // retryable failure and stops draining on the first one, that single
    // poisoned entry would block every later outbox entry (dispatches
    // *and* outcome comments) forever. Drop `work` for a non-control-plane
    // target until the consumers have caught up.
    let workInput: string | undefined;
    if (task?.work !== undefined && target.repo === controlPlaneRepository()) {
      try {
        workInput = JSON.stringify({
          spec: workSpecSchema.parse(task.work['spec']),
        });
      } catch (error) {
        await settleClaim(deps, entry, 'done');
        result.failed.push({
          entryId: entry.entryId,
          error: errorMessage(error),
        });
        return;
      }
    }
    inputs = {
      issue: String(target.issue),
      ...(workInput === undefined ? {} : { work: workInput }),
      mode: run.params?.mode ?? 'implement',
      reply: run.params?.reply ?? '',
      runbook: run.params?.runbook ?? '',
      context: run.params?.context ?? '',
      broker_intent_id: run.runId,
      broker_generation: parseGeneration(run.runId),
      broker_dispatch_token: crypto.randomUUID(),
    };
  }
  const url = `${githubApiBaseUrl(deps)}/repos/${target.repo}/actions/workflows/${run.pipeline}.yml/dispatches`;

  let response: Response;
  try {
    const token = await tokens.tokenFor(target.repo);
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
  await claimGithubAnchor(deps, target);
  await settleClaim(deps, entry, 'done');
  result.dispatched.push(run.runId);
}

/** Additive, idempotent, best-effort -- projects the two claim effects that
 *  today happen elsewhere for a GitHub anchor: the assignee call is
 *  byte-identical to `.github/actions/claim-issue/claim.sh`'s own mutation
 *  (`POST .../assignees` with `{assignees: [<fleet login>]}`); the eyes
 *  reaction's endpoint/body (`POST .../reactions` with `{content: 'eyes'}`)
 *  matches agent-protocol.md §2, which claim.sh itself does not post -- that
 *  reaction is normally the dispatched agent's own first action, once it
 *  starts reading the anchor's thread. Here it is posted once, on the issue
 *  body only (not per-comment -- the console has not read any comments at
 *  this point), as the single visible acknowledgement a human watching the
 *  issue looks for right when the dispatch is confirmed. A failure here must
 *  not cost the dispatch, which has already succeeded by the time this
 *  runs. See the design spec's "Projections" note.
 *
 *  The two POSTs are independent, deliberately not sharing one `try`: both
 *  are idempotent (a repeated reaction returns the existing one; assigning
 *  an already-assigned login is a no-op), so a network-level failure on the
 *  reactions call must not skip the assignees call. Only the token fetch,
 *  which both calls need, is allowed to skip both. */
async function claimGithubAnchor(
  deps: DispatchDeps,
  target: AnchorTarget,
): Promise<void> {
  if (target.issue === undefined) return;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const apiBaseUrl = githubApiBaseUrl(deps);
  const { repo, issue } = target;

  let token: string;
  try {
    token = await deps.tokens.tokenFor(repo);
  } catch (error) {
    console.error(
      'agent-lcars: claim projection failed for %s#%s:',
      repo,
      issue,
      error,
    );
    return;
  }

  try {
    const response = await fetchImpl(
      `${apiBaseUrl}/repos/${repo}/issues/${issue}/reactions`,
      {
        method: 'POST',
        headers: githubHeaders(token),
        body: JSON.stringify({ content: 'eyes' }),
      },
    );
    if (!response.ok) {
      console.error(
        'agent-lcars: claim projection (reaction) failed for %s#%s: %s %s',
        repo,
        issue,
        response.status,
        await response.text(),
      );
    }
  } catch (error) {
    console.error(
      'agent-lcars: claim projection (reaction) failed for %s#%s:',
      repo,
      issue,
      error,
    );
  }

  try {
    const response = await fetchImpl(
      `${apiBaseUrl}/repos/${repo}/issues/${issue}/assignees`,
      {
        method: 'POST',
        headers: githubHeaders(token),
        body: JSON.stringify({ assignees: [agentFleetLogin()] }),
      },
    );
    if (!response.ok) {
      console.error(
        'agent-lcars: claim projection (assignee) failed for %s#%s: %s %s',
        repo,
        issue,
        response.status,
        await response.text(),
      );
    }
  } catch (error) {
    console.error(
      'agent-lcars: claim projection (assignee) failed for %s#%s:',
      repo,
      issue,
      error,
    );
  }
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

  // `anchorTarget` only needs the task for a native anchor's `spec.target
  // .repo`; `describeLostOutcome` below separately needs the full task doc
  // (any anchor type) for its activeRunId/consecutiveLost read, but only
  // when this run is `lost` -- read once up front so neither path re-reads
  // it (a native anchor never reaches `describeLostOutcome`: it bails at
  // the `target.issue === undefined` check just below).
  const task =
    isWorkAnchor(run.task) || run.state === 'lost'
      ? (await store.readTask(run.task))?.task
      : undefined;
  let target: AnchorTarget;
  try {
    target = anchorTarget(run, task);
  } catch (error) {
    await settleClaim(deps, entry, 'done');
    result.failed.push({ entryId: entry.entryId, error: errorMessage(error) });
    return;
  }
  if (target.issue === undefined) {
    // A native anchor has no GitHub issue to comment on -- the item's
    // outcome is derivable from the run/task documents themselves.
    await settleClaim(deps, entry, 'done');
    return;
  }

  const outcome =
    run.state === 'lost'
      ? await describeLostOutcome(store, run, task)
      : {
          body: outcomeCommentBody(run),
          needsHumanLabel: run.state === 'finished' && run.result?.ok === false,
        };
  const url = `${githubApiBaseUrl(deps)}/repos/${target.repo}/issues/${target.issue}/comments`;

  let response: Response;
  try {
    const token = await tokens.tokenFor(target.repo);
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
      target,
      githubApiBaseUrl(deps),
    );
  }

  await settleClaim(deps, entry, 'done');
  result.reported.push(run.runId);
}

/**
 * Describes a `lost` run's outcome comment, which depends on what happened
 * after the loss -- something `outcomeCommentBody` alone can't know, since
 * it only looks at the run itself. Uses the task's current active run (if
 * any), read by the caller alongside its own `anchorTarget` lookup so this
 * never re-reads the same document:
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
  task: Task | undefined,
): Promise<{ body: string; needsHumanLabel: boolean }> {
  const lostPrefix = `⚠️ Run ${run.runId} ${lostCause(run)}. `;
  const activeRunId = task?.activeRunId;
  const activeRun =
    activeRunId === undefined ? undefined : await store.readRun(activeRunId);

  if (activeRun?.requestId === `retry:${run.runId}`) {
    const attempt = (task?.consecutiveLost ?? 0) + 1;
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

/** Flags the issue for human attention: once the auto-retry budget is
 *  exhausted (the `lost` branch), or whenever a run settles `finished` with
 *  `ok: false` (the run itself never called this a retryable loss, so no
 *  auto-retry will follow it -- the task is parked either way). Best-effort:
 *  a failure here must not fail the outcome-comment entry, which has already
 *  been posted and is about to be settled -- the operator already has the
 *  comment telling them what happened; a missing label is a cosmetic miss,
 *  not a functional one. */
async function addNeedsHumanLabelBestEffort(
  fetchImpl: typeof fetch,
  tokens: DispatchTokenProvider,
  target: AnchorTarget,
  apiBaseUrl: string,
): Promise<void> {
  if (target.issue === undefined) {
    // A native anchor has no GitHub issue to label.
    return;
  }
  try {
    const token = await tokens.tokenFor(target.repo);
    await fetchImpl(
      `${apiBaseUrl}/repos/${target.repo}/issues/${target.issue}/labels`,
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
      if (run.result?.ok === false) {
        // Mirrors `describeLostOutcome`'s exhausted-budget clause: the run
        // itself never called this a retryable loss, so (unlike `lost`)
        // no auto-retry will follow it -- the task is parked either way,
        // and only a manual re-request moves it forward.
        lines.push(
          'No auto-retry will follow -- re-request manually (re-add the ' +
            'agent label) when ready.',
        );
      }
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
