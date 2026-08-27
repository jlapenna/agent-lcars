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
import { agentFleetLogin } from './deployment';
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
 * `pending` for a later `drainOutbox` call to retry, up to
 * `MAX_OUTBOX_DELIVERY_ATTEMPTS` attempts -- past that it is retired
 * (`failed`) rather than retried forever (#1548).
 *
 * Every GitHub call resolves its bearer token per-repo through `tokens`
 * (see `github-app-tokens.ts`) rather than a single ambient token, so a
 * dispatch or outcome comment against a foreign repo can use a token
 * actually scoped there.
 *
 * A `report-outcome` entry old enough to be considered stale
 * (`OUTBOX_STALE_REPORT_AGE_MS`) is additionally checked against its
 * anchor issue/PR before delivery: if the anchor has since closed, the
 * entry is retired instead of delivered. This is a maintainer decision
 * about outward-facing delivery (#1548's backlog release should not spam
 * resolved issues with days-old outcome reports), not a technical
 * constraint -- see `isAnchorOpen`/`handleReportOutcome` below.
 */

/** GitHub's REST API accepts a bearer token for both endpoints this module
 * calls. */
const GITHUB_API = 'https://api.github.com';

/** Bounds how many times a single outbox entry can be released back to
 *  `pending` before it is retired (`failed`) instead. GitHub outages, token
 *  hiccups, and secondary rate limits normally clear within a handful of
 *  drain cycles (the fleet's reconcile heartbeat alone runs every 30
 *  minutes, on top of whichever webhook/completion traffic triggers a drain
 *  in between); twenty attempts gives that kind of transient failure ample
 *  room while still guaranteeing a genuinely undeliverable entry stops
 *  consuming a claim slot forever (#1548 -- one entry reached 485 attempts
 *  over six days with no bound at all). */
export const MAX_OUTBOX_DELIVERY_ATTEMPTS = 20;

/** Bounds when a `report-outcome` entry is old enough to pay for an extra
 *  GitHub lookup (`isAnchorOpen`) before delivery, checking whether its
 *  anchor issue/PR is still open. A run's outcome normally lands within
 *  minutes of completion -- the very next drain cycle after `decide.ts`
 *  writes the entry -- so an entry below this age is virtually never a
 *  stale backlog item, and charging every single delivery an extra API
 *  call just to cover that near-impossible case would be pure overhead.
 *  24 hours is deliberately generous headroom above "minutes": comfortably
 *  clear of a transient drain pause, a burst of claim contention, or a
 *  brief GitHub outage, while still catching entries anywhere near the
 *  multi-day backlog #1548 actually produced (up to six days old) long
 *  before they would otherwise reach delivery. */
export const OUTBOX_STALE_REPORT_AGE_MS = 24 * 60 * 60 * 1000;

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
 * Never throws: every handled entry is either settled (`done`), retired
 * (`failed`, once it exhausts `MAX_OUTBOX_DELIVERY_ATTEMPTS`), or explicitly
 * released (`pending`) with its failure recorded and logged. If the process
 * itself dies, the durable lease expires so a later invocation can retry it.
 *
 * #1548: earlier versions stopped the whole drain on the first failure, on
 * the theory that continuing would just let this same invocation immediately
 * reclaim the entry it had just failed and burn its whole `limit` budget
 * retrying it. That protection came at the cost of blocking every *other*
 * pending entry too -- for six days, fleet-wide, since the claim query has
 * no ordering and kept handing drains the same unlucky entries first. The
 * fix keeps the original protection (`failedThisDrain` excludes an entry
 * this invocation already failed from being reclaimed within the same
 * call) without the collateral damage: the loop now keeps going, so every
 * *other* pending entry still gets its fair attempt this invocation.
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
  const failedThisDrain = new Set<string>();

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
      excludeEntryIds: failedThisDrain,
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
      await settleRetryableFailureQuietly(deps, entry, result, error);
    }
    // Excluded from this invocation's remaining claims only -- not stopped
    // entirely -- so forward progress continues on every other pending
    // entry. A later, separate `drainOutbox` call is free to reclaim it.
    if (result.failed.length > failuresBefore) {
      failedThisDrain.add(entry.entryId);
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
    recordPermanentFailure(entry, result, error);
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
      recordPermanentFailure(entry, result, error);
      return;
    }
    inputs = {
      work: JSON.stringify({
        id: run.task.workId,
        spec,
        // Sub-project 6: `resumeSessionId`/`resumeTranscriptGcsUri` are
        // written together onto `run.params` by work-router.ts's
        // `redispatch` handler (Task 2), which already resolved the
        // session's transcript at redispatch time -- no further lookup
        // needed here. Checking both rather than just `resumeSessionId`
        // keeps a half-written params record (which should never happen,
        // but this is cheap insurance) from producing a `resume` with no
        // transcript to fetch.
        ...(run.params?.['resumeSessionId'] !== undefined &&
        run.params?.['resumeTranscriptGcsUri'] !== undefined
          ? {
              resume: {
                sessionId: run.params['resumeSessionId'],
                transcriptGcsUri: run.params['resumeTranscriptGcsUri'],
              },
            }
          : {}),
      }),
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
    // Wave 1 of #1544 landed a `work` `workflow_dispatch` input on every
    // consumer repo's `claude/codex/opencode.yml` (six repos, all merged),
    // forwarded to the agent-lane shim alongside a
    // `control-plane-projections` flag derived from whether `work` was
    // sent -- so this no longer needs to gate `work` down to the single
    // control-plane repo itself. `target.repo` reaching this point is
    // already admitted: the webhook that created this GitHub-anchored task
    // only ever does so for a repo in `AGENT_LCARS_CONTROL_PLANE_REPOSITORIES`
    // (see `orchestrator-ingest.ts`'s `checkRepository`), and every
    // admitted repo now declares the input. Emit it whenever the task has
    // one.
    //
    // If an admitted repo's workflow hasn't actually caught up yet (a real
    // possibility mid-onboarding -- see the 422-retry block below), the
    // dispatch below 422s. That no longer risks poisoning the outbox the
    // way it once did: `drainOutbox`'s per-entry fairness means one
    // persistently-failing entry no longer blocks any other, and a
    // dispatch that keeps failing is bounded by `OUTBOX_RETIRE_AFTER_MS`
    // (with backoff between attempts) rather than retried forever.
    let workInput: string | undefined;
    if (task?.work !== undefined) {
      try {
        workInput = JSON.stringify({
          spec: workSpecSchema.parse(task.work['spec']),
        });
      } catch (error) {
        await settleClaim(deps, entry, 'done');
        recordPermanentFailure(entry, result, error);
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
    await settleRetryableFailure(deps, entry, result, error);
    return;
  }

  // #1544 wave 2 review (PRRT_kwDOTemFxc6c7KaP): `docs/onboarding-repo.md`
  // admits a repo to `AGENT_LCARS_CONTROL_PLANE_REPOSITORIES` (step 1)
  // before that repo's own workflow callers declare the `work` input
  // (step 4). A webhook landing in that window mints a GitHub-anchored
  // task with `work`, and GitHub 422s this dispatch because the
  // not-yet-updated workflow doesn't declare it. Rather than re-add a
  // repo allow-list here (which just recreates this failure for every
  // *future* onboarding, forever), degrade: drop `work` and retry once so
  // the run proceeds on the legacy issue-anchored path instead of poisoning
  // the outbox entry. Only applies when there is a legacy path to fall
  // back to (`target.issue !== undefined`, i.e. not a native work-anchor
  // run, whose only content *is* `work`) and only for the specific 422
  // shape GitHub uses for an undeclared input -- any other 422 reason
  // fails exactly as before.
  //
  // #1548 interaction: the initial 422 that triggers this retry is never
  // itself recorded via `settleRetryableFailure` -- only the outcome
  // below (`response`, reassigned to the retry's result when a retry
  // happens) is. So a retry that lands 204 leaves no failure/backoff state
  // on the entry at all, and a retry that fails (network error above, or a
  // non-204 status falling through to the check below) is recorded
  // exactly once, against its own outcome -- never twice for what is, from
  // the outbox's perspective, a single delivery attempt.
  if (
    response.status === 422 &&
    inputs['work'] !== undefined &&
    target.issue !== undefined
  ) {
    const unexpected = await unexpectedDispatchInputs(response);
    if (unexpected?.includes('work')) {
      console.error(
        'agent-lcars: dispatch to %s#%s named unexpected input(s) [%s] ' +
          '(422) -- retrying once without `work` on the legacy ' +
          'issue-anchored path',
        target.repo,
        target.issue,
        unexpected.join(', '),
      );
      const { work: _work, ...retryInputs } = inputs;
      try {
        const token = await tokens.tokenFor(target.repo);
        response = await fetchImpl(url, {
          method: 'POST',
          headers: githubHeaders(token),
          body: JSON.stringify({ ref: 'main', inputs: retryInputs }),
        });
      } catch (error) {
        await settleRetryableFailure(deps, entry, result, error);
        return;
      }
    }
  }

  if (response.status !== 204) {
    await settleRetryableFailure(
      deps,
      entry,
      result,
      `workflow_dispatch returned ${response.status}`,
    );
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
    await settleRetryableFailure(
      deps,
      entry,
      result,
      `no such run: ${entry.runId}`,
    );
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
    recordPermanentFailure(entry, result, error);
    return;
  }
  if (target.issue === undefined) {
    // A native anchor has no GitHub issue to comment on -- the item's
    // outcome is derivable from the run/task documents themselves.
    await settleClaim(deps, entry, 'done');
    return;
  }

  // #1548's fix (fairness + the attempt cap above) means deploying it
  // releases a backlog of report-outcome entries up to six days old across
  // several repos. Delivering all of them regardless would post outcome
  // comments onto issues/PRs a human has since closed -- noise on
  // something already resolved. Maintainer decision: only pay for the
  // anchor lookup once an entry is old enough that it could plausibly be
  // part of that backlog (see `OUTBOX_STALE_REPORT_AGE_MS`), and only
  // retire it if the anchor is confirmed closed.
  if (isStaleReport(entry, deps)) {
    const anchorOpen = await isAnchorOpen(deps, target);
    if (anchorOpen === false) {
      await settleClaim(deps, entry, 'failed');
      const message = `anchor ${target.repo}#${target.issue} is closed; retiring stale outcome report`;
      result.failed.push({ entryId: entry.entryId, error: message });
      logOutboxFailure(entry, message, 'anchor-closed');
      return;
    }
    // `anchorOpen === true` (still open) or `undefined` (the lookup
    // itself failed -- see `isAnchorOpen`'s doc comment) both fall through
    // to normal delivery below.
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
    await settleRetryableFailure(deps, entry, result, error);
    return;
  }

  if (response.status !== 201) {
    await settleRetryableFailure(
      deps,
      entry,
      result,
      `issue comment returned ${response.status}`,
    );
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

/** Whether a `report-outcome` entry is old enough to warrant the extra
 *  `isAnchorOpen` lookup before delivery -- see
 *  `OUTBOX_STALE_REPORT_AGE_MS`'s doc comment for why 24 hours. */
function isStaleReport(entry: LeasedOutboxEntry, deps: DispatchDeps): boolean {
  return (
    Date.parse(now(deps)) - Date.parse(entry.createdAt) >=
    OUTBOX_STALE_REPORT_AGE_MS
  );
}

/**
 * Whether a stale `report-outcome` entry's anchor issue or PR is still
 * open -- `undefined` if that could not be determined. GitHub serves pull
 * requests through the same issues endpoint (a PR *is* an issue for this
 * purpose, including its `state`), so one lookup covers both anchor kinds
 * without a separate PR-aware client.
 *
 * Never throws. A network failure or a response this call can't interpret
 * must not delete the entry (this is advisory, not the delivery attempt
 * itself) and must not abort the drain -- so this defers rather than
 * retries: it reports "unknown" back to `handleReportOutcome`, which falls
 * through to attempting normal delivery exactly as it would for a
 * confirmed-open anchor, rather than releasing the entry back to `pending`
 * without ever trying to deliver it. A transient failure here is
 * indistinguishable from a transient failure on the delivery call itself
 * immediately below it, which already tolerates retrying -- there is no
 * reason to treat the lookup more conservatively than the delivery it is
 * gating.
 */
async function isAnchorOpen(
  deps: DispatchDeps,
  target: AnchorTarget,
): Promise<boolean | undefined> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  try {
    const token = await deps.tokens.tokenFor(target.repo);
    const response = await fetchImpl(
      `${githubApiBaseUrl(deps)}/repos/${target.repo}/issues/${target.issue}`,
      { method: 'GET', headers: githubHeaders(token) },
    );
    if (!response.ok) {
      console.error(
        'agent-lcars: anchor lookup failed for %s#%s: %s',
        target.repo,
        target.issue,
        response.status,
      );
      return undefined;
    }
    const body = (await response.json()) as { state?: unknown };
    return body.state !== 'closed';
  } catch (error) {
    console.error(
      'agent-lcars: anchor lookup failed for %s#%s:',
      target.repo,
      target.issue,
      error,
    );
    return undefined;
  }
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

/** GitHub's `workflow_dispatch` 422 for an input the target workflow
 *  doesn't declare names the offending input(s) in its `message` field as
 *  `Unexpected inputs provided: ["name", ...]` -- confirmed against
 *  independent third-party reports of the live API response (not just its
 *  docs): backstage/backstage#20023 (`message` reproduced verbatim as
 *  `Unexpected inputs provided: ["instanceName", "projectId", ...]`) and
 *  benc-uk/workflow-dispatch#80 (`Unexpected inputs provided: ["action",
 *  "arg", "customer"] - https://docs.github.com/rest/actions/workflows#
 *  create-a-workflow-dispatch-event`). Returns the named inputs, or
 *  `undefined` if the body isn't that shape -- a 422 for any other reason
 *  (bad ref, disallowed value, etc.) must not be mistaken for this one. */
async function unexpectedDispatchInputs(
  response: Response,
): Promise<string[] | undefined> {
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return undefined;
  }
  const message =
    typeof body === 'object' && body !== null && 'message' in body
      ? (body as { message: unknown }).message
      : undefined;
  if (typeof message !== 'string') return undefined;

  const match = /^Unexpected inputs provided: (\[.*\])/u.exec(message);
  if (match === null) return undefined;

  try {
    const names: unknown = JSON.parse(match[1]);
    if (Array.isArray(names) && names.every((n) => typeof n === 'string')) {
      return names as string[];
    }
  } catch {
    // Matched the prefix but the bracketed list didn't parse as JSON --
    // treat as not-this-shape rather than throwing out of a failure path.
  }
  return undefined;
}

function githubApiBaseUrl(
  deps: Pick<DispatchDeps, 'githubApiBaseUrl'>,
): string {
  return (deps.githubApiBaseUrl ?? GITHUB_API).replace(/\/+$/u, '');
}

/**
 * The one place every per-entry drain failure is logged (#1548: previously
 * none of them were -- six days of a stuck outbox produced no log line
 * anywhere, only a raw Firestore query eventually surfaced it). `outcome`
 * says what happened to the entry as a result, so a reader doesn't have to
 * cross-reference the outbox document itself to know whether this was
 * retried, retired for exhausting its attempt budget, retired because its
 * anchor closed, or was never retryable to begin with. `'anchor-closed'` is
 * deliberately distinct from `'retired'` (the `MAX_OUTBOX_DELIVERY_ATTEMPTS`
 * case) even though both settle the entry `failed` -- one is "GitHub kept
 * rejecting this," the other is "the anchor resolved before we got to it,"
 * and a reader scanning logs should be able to tell which happened without
 * cross-referencing the entry's attempt count.
 */
function logOutboxFailure(
  entry: LeasedOutboxEntry,
  error: string,
  outcome: 'retrying' | 'retired' | 'permanent' | 'anchor-closed',
): void {
  console.error(
    'agent-lcars: outbox drain failed for %s (kind %s, attempt %d, %s): %s',
    entry.entryId,
    entry.kind,
    entry.attempts,
    outcome,
    error,
  );
}

/** Records and logs a failure that can never succeed on retry (an
 *  unparseable payload, an anchor that can't be resolved) -- the caller has
 *  already settled the entry `done` rather than releasing it, exactly as a
 *  successful delivery would, so there's nothing left for a later drain to
 *  do. Logging it as `permanent` distinguishes that from an entry that
 *  actually delivered. */
function recordPermanentFailure(
  entry: LeasedOutboxEntry,
  result: DrainOutboxResult,
  error: unknown,
): void {
  const message = errorMessage(error);
  result.failed.push({ entryId: entry.entryId, error: message });
  logOutboxFailure(entry, message, 'permanent');
}

/**
 * Records, logs, and settles a retryable delivery failure (#1548). Below
 * `MAX_OUTBOX_DELIVERY_ATTEMPTS`, the entry is released back to `pending`
 * for a later attempt, exactly as before; once it reaches that bound it is
 * retired (`failed`) instead, so a genuinely undeliverable entry stops
 * consuming a claim slot forever rather than retrying indefinitely.
 */
async function settleRetryableFailure(
  deps: DispatchDeps,
  entry: LeasedOutboxEntry,
  result: DrainOutboxResult,
  error: unknown,
): Promise<void> {
  const message = errorMessage(error);
  result.failed.push({ entryId: entry.entryId, error: message });
  const retired = entry.attempts >= MAX_OUTBOX_DELIVERY_ATTEMPTS;
  logOutboxFailure(entry, message, retired ? 'retired' : 'retrying');
  await settleClaim(deps, entry, retired ? 'failed' : 'pending');
}

/** Same as {@link settleRetryableFailure}, but never throws: for the
 *  top-level per-entry catch in `drainOutbox`, where the entry may already
 *  be settled by the failed handler and a settle failure here just means
 *  the next drain reclaims it, which is always safe. */
async function settleRetryableFailureQuietly(
  deps: DispatchDeps,
  entry: LeasedOutboxEntry,
  result: DrainOutboxResult,
  error: unknown,
): Promise<void> {
  try {
    await settleRetryableFailure(deps, entry, result, error);
  } catch {
    // Already recorded as a failure above; a settle failure here just
    // means the next drain reclaims it, which is fine.
  }
}

function now(deps: DispatchDeps): string {
  return deps.now?.() ?? new Date().toISOString();
}

async function settleClaim(
  deps: DispatchDeps,
  entry: LeasedOutboxEntry,
  state: 'pending' | 'done' | 'failed',
): Promise<boolean> {
  return deps.store.settleOutbox({
    entryId: entry.entryId,
    claimId: entry.claimId,
    state,
    now: now(deps),
  });
}
