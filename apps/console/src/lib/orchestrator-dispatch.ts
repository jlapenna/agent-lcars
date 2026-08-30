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

import { type AnchorTarget, anchorTarget } from './anchor-target';
import { agentFleetLogin } from './deployment';
import type { DispatchTokenProvider } from './github-app-tokens';

// Re-exported so callers share the same repository-token seam rather than
// reaching past this module into `github-app-tokens.ts` directly.
export type { DispatchTokenProvider };

/**
 * The outbox drain: turns `@agent-lcars/orchestrator` decisions into real
 * GitHub effects. The orchestrator itself never does I/O beyond its own
 * store (see `libs/orchestrator/src/orchestrator.ts`) - it only records
 * that a run should be dispatched or that its outcome should be reported,
 * as a durable outbox entry. This module is the worker that drains that
 * outbox: it makes each run claimable by QueueExecutor and posts the outcome
 * back to an issue as a comment.
 *
 * Nothing here is durable itself - `store.claimPendingOutbox` /
 * `store.settleOutbox` own that. A failed GitHub call just leaves its entry
 * `pending` for a later `drainOutbox` call to retry, with exponential
 * backoff between attempts (`OUTBOX_BACKOFF_BASE_MS`/`_CAP_MS`) until it has
 * been failing for `OUTBOX_RETIRE_AFTER_MS` -- past that it is retired
 * (`failed`) rather than retried forever (#1548, and its own follow-up: a
 * bound keyed on claim *count* rather than failure *time* let normal fleet
 * traffic -- dispatches and completions each trigger a drain, on top of the
 * 30-minute reconcile -- burn through it in minutes during a transient
 * GitHub outage, which is a worse failure than the one being fixed).
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

/**
 * Bounds how long a single outbox entry may keep failing actual delivery
 * attempts, measured from the first one (`OutboxEntry.firstFailedAt`),
 * before it is retired (`failed`) instead of released back to `pending`
 * (#1548 follow-up). Deliberately a *time* budget, not a claim-count one:
 * drains fire on every dispatch and completion in addition to the
 * 30-minute reconcile heartbeat, so a count-based budget (the original
 * version of this fix used `attempts >= 20`) can be exhausted by ordinary
 * fleet traffic within minutes of a transient GitHub outage or a bout of
 * rate-limiting -- turning something that should just clear on its own
 * into a permanently lost dispatch or outcome report, which is worse than
 * the unbounded-retry bug this PR fixes (#1548's own backlog: one entry
 * reached 485 attempts over six days with no bound at all).
 *
 * 72 hours (three days) is comfortably longer than any plausible GitHub
 * outage or rate-limit episode (these clear in minutes to low hours, not
 * days) while still being well short of the six-day backlog #1548
 * produced, so an entry that is *actually* dead -- not just caught in a
 * passing outage -- still gets retired instead of accumulating forever.
 * Paired with `OUTBOX_BACKOFF_CAP_MS` below, an entry failing for the
 * entire window gets on the order of 100-150 real delivery attempts, not
 * thousands.
 */
export const OUTBOX_RETIRE_AFTER_MS = 72 * 60 * 60 * 1000;

/**
 * Backoff between delivery attempts for a failing outbox entry (#1548
 * follow-up), so the fast dispatch/completion drain cadence doesn't
 * hammer an entry that is currently failing -- only the slower, steadier
 * reconcile heartbeat (or a drain that happens to land after backoff has
 * elapsed) gets to retry it. Doubles per consecutive delivery failure
 * (`OutboxEntry.deliveryFailures`) starting at one minute, capped at 30
 * minutes -- deliberately the same as the reconcile interval, so once an
 * entry's backoff has ramped all the way up it settles into being retried
 * roughly once per reconcile pass, no faster, regardless of how much
 * dispatch/completion traffic happens in between.
 */
export const OUTBOX_BACKOFF_BASE_MS = 60_000;
export const OUTBOX_BACKOFF_CAP_MS = 30 * 60_000;

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
 * (`failed`, once it has been failing for `OUTBOX_RETIRE_AFTER_MS`), or
 * explicitly released (`pending`, with backoff -- see
 * `OUTBOX_BACKOFF_BASE_MS`/`_CAP_MS`) with its failure recorded and logged.
 * If the process itself dies, the durable lease expires so a later
 * invocation can retry it.
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
 * Makes the run claimable by QueueExecutor. A run whose outbox entry outlived
 * it (already settled elsewhere, or never made it past `pending`) is stale:
 * there is nothing left to enqueue, so the entry is marked done.
 */
async function handleDispatchRun(
  deps: DispatchDeps,
  entry: LeasedOutboxEntry,
  result: DrainOutboxResult,
): Promise<void> {
  const { store, orchestrator } = deps;

  const run = await store.readRun(entry.runId);
  if (run === undefined || run.state !== 'pending') {
    await settleClaim(deps, entry, 'done');
    return;
  }

  await store.enqueueRun({ runId: run.runId, now: now(deps) });
  await orchestrator.confirmDispatch(run.runId);
  if (!isWorkAnchor(run.task)) {
    await claimGithubAnchor(deps, anchorTarget(run));
  }
  await settleClaim(deps, entry, 'done');
  result.dispatched.push(run.runId);
}

/** Additive, idempotent, best-effort -- projects the two claim effects for
 *  a GitHub anchor that the fleet lane's own claim step used to perform
 *  (`.github/actions/claim-issue`, deleted in #1544/#1557 once every
 *  dispatch became console-owned): the assignee call posts the same shape
 *  GitHub's assignees endpoint expects (`POST .../assignees` with
 *  `{assignees: [<fleet login>]}`); the eyes reaction's endpoint/body
 *  (`POST .../reactions` with `{content: 'eyes'}`) matches agent-
 *  protocol.md §2, which unconditionally tells the dispatched agent to
 *  skip posting the reaction itself -- the console always does it here, at
 *  dispatch-confirm time, before the agent's turn starts. Here it is
 *  posted once, on the issue body only (not per-comment -- the console has
 *  not read any comments at this point), as the single visible
 *  acknowledgement a human watching the issue looks for right when the
 *  dispatch is confirmed. A failure here must not cost the dispatch, which
 *  has already succeeded by the time this runs. See the design spec's
 *  "Projections" note.
 *
 *  The two POSTs are independent, deliberately not sharing one `try`: both
 *  are idempotent (a repeated reaction returns the existing one; assigning
 *  an already-assigned login is a no-op), so a network-level failure on the
 *  reactions call must not skip the assignees call. Only the token fetch,
 *  which both calls need, is allowed to skip both.
 *
 *  The two calls are NOT symmetric in what a 2xx means, though (#1548):
 *  the assignees endpoint filters the requested login against repository
 *  eligibility (collaborator/push access) and silently omits an
 *  ineligible one from the returned `assignees` array rather than
 *  erroring, so a 2xx status alone does not prove the claim landed --
 *  `assigneeWasAttached` checks the body itself. The reactions endpoint
 *  has no equivalent eligibility filter to silently fail: reacting only
 *  requires read access (which the token calling this function already
 *  has, or the whole run would not exist), and its 2xx response is always
 *  the actual reaction record (created, or the caller's pre-existing one)
 *  -- there is no "not applied" reaction to keep out of a listed
 *  collection the way an ineligible assignee is kept out of the assignee
 *  collection. So its `response.ok` check is left as the sufficient
 *  success signal it always was; only the assignee path gained body
 *  verification, and both still report failure with the same
 *  `'...failed for %s#%s: %s %s'` shape. */
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
    const login = agentFleetLogin();
    const response = await fetchImpl(
      `${apiBaseUrl}/repos/${repo}/issues/${issue}/assignees`,
      {
        method: 'POST',
        headers: githubHeaders(token),
        body: JSON.stringify({ assignees: [login] }),
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
    } else if (!(await assigneeWasAttached(response, login))) {
      // GitHub returns 2xx here even when the login lacks push access to
      // the repository (not a collaborator, not assignable) -- it just
      // silently omits it from the response's `assignees` array instead of
      // erroring. `response.ok` alone cannot tell a real claim from a
      // silent no-op; see `assigneeWasAttached`'s doc comment.
      console.error(
        'agent-lcars: claim projection (assignee) silently dropped for ' +
          '%s#%s: %s was not added to the assignees list -- likely not ' +
          'assignable on this repository (missing push access)',
        repo,
        issue,
        login,
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

/** GitHub's `POST .../issues/{n}/assignees` returns 2xx even when the
 *  requested login lacks push access to the repository -- rather than
 *  erroring, it silently drops the login from the returned issue's
 *  `assignees` array. A bare `response.ok` check therefore cannot
 *  distinguish a real claim from a silent no-op; the response body is the
 *  only signal. Confirmed in production: canary run on
 *  jlapenna/sync-padd#89 (2026-08-27) -- the reaction landed, the assignee
 *  never attached, `agent-lcars-bot` had `permission: none` on that repo,
 *  and the 2xx status meant nothing was logged (issue #1548). Returns
 *  `false` (never throws) for a body that isn't the expected shape, so a
 *  malformed or empty response is treated the same as "not confirmed"
 *  rather than crashing this best-effort projection. */
async function assigneeWasAttached(
  response: Response,
  login: string,
): Promise<boolean> {
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return false;
  }
  const assignees =
    typeof body === 'object' && body !== null && 'assignees' in body
      ? (body as { assignees: unknown }).assignees
      : undefined;
  if (!Array.isArray(assignees)) return false;
  return assignees.some(
    (a: unknown) =>
      typeof a === 'object' &&
      a !== null &&
      'login' in a &&
      (a as { login: unknown }).login === login,
  );
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
          needsHumanLabel: run.state === 'finished' && runNeedsHumanLabel(run),
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
    // An older parked/failed outcome can be delayed behind a later run's
    // successful report (for example while its comment delivery retries).
    // Do not reintroduce the stale projection after that later run has
    // already resolved the human need.
    if (!(await hasLaterSuccessfulNonParkRun(store, run))) {
      await addNeedsHumanLabelBestEffort(
        fetchImpl,
        tokens,
        target,
        githubApiBaseUrl(deps),
      );
    }
  } else if (runResolvesNeedsHumanLabel(run)) {
    // The symmetric out-of-order case: an older success can be delivered
    // after a newer park/failure. That newer terminal result still needs the
    // operator signal, so never let this old success clear it.
    if (!(await hasLaterNeedsHumanRun(store, run))) {
      await removeNeedsHumanLabelBestEffort(
        fetchImpl,
        tokens,
        target,
        githubApiBaseUrl(deps),
      );
    }
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

/**
 * Clears a prior park indicator after the same anchor later reaches a
 * successful, non-park terminal outcome. This is deliberately separate from
 * outcome delivery: the outcome comment is the durable operator record, so a
 * transient label API failure must not retry or hide that completed result.
 * GitHub treats an already-removed label as a 404; that is also a successful
 * end state, so all cleanup failures remain best-effort like adding the label.
 */
async function removeNeedsHumanLabelBestEffort(
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
      `${apiBaseUrl}/repos/${target.repo}/issues/${target.issue}/labels/${encodeURIComponent('status:needs-human')}`,
      { method: 'DELETE', headers: githubHeaders(token) },
    );
  } catch {
    // Swallowed deliberately -- the completed outcome is more important than
    // this advisory projection; the next successful run can try again.
  }
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
}

/** `run.result.summary` value the executor sends for a run that parked
 *  with real evidence (agent-protocol.md #4's issue-anchor path: a comment
 *  carrying both the attempt-claim and `agent-result:v1:park` markers).
 *  Shared between `outcomeCommentBody` (which swaps in human-facing
 *  wording instead of echoing this raw token) and `runNeedsHumanLabel`
 *  (which flags the issue despite `ok: true`). */
const PARK_OUTCOME_SUMMARY = 'park';

/** A finished run flags the issue for human attention either the old way
 *  (it failed outright, `ok: false`) or the new one (agent-protocol.md #4:
 *  it succeeded at leaving a real, marker-stamped `park` deliverable, but
 *  that deliverable itself says a human is needed). Both cases still post
 *  their own outcome comment above/alongside this label -- see
 *  `outcomeCommentBody`. */
function runNeedsHumanLabel(run: Run): boolean {
  return (
    run.result?.ok === false || run.result?.summary === PARK_OUTCOME_SUMMARY
  );
}

/**
 * A subsequent successful result resolves the earlier request for human
 * attention unless the result is itself an explicit park. Failed, canceled,
 * and lost runs must leave the signal alone: none proves the human need was
 * resolved.
 */
function runResolvesNeedsHumanLabel(run: Run): boolean {
  return (
    run.state === 'finished' &&
    run.result?.ok === true &&
    run.result.summary !== PARK_OUTCOME_SUMMARY
  );
}

/**
 * Reads the task's durable run history only while considering an add, the
 * rare path where the human-attention projection is changing. Outbox entries
 * are intentionally fair rather than strictly FIFO, so an older report can
 * otherwise land after a newer successful result and recreate a stale label.
 * A read failure remains best-effort: preserving the current park/failure
 * signal is safer than turning the outcome comment into a retry.
 */
async function hasLaterSuccessfulNonParkRun(
  store: OrchestratorStore,
  run: Run,
): Promise<boolean> {
  return hasLaterRunMatching(
    store,
    run,
    runResolvesNeedsHumanLabel,
    'before labeling',
  );
}

/** The converse of `hasLaterSuccessfulNonParkRun`: an old success must not
 * clear a human-needed signal established by a newer terminal run. */
async function hasLaterNeedsHumanRun(
  store: OrchestratorStore,
  run: Run,
): Promise<boolean> {
  return hasLaterRunMatching(
    store,
    run,
    runNeedsHumanLabel,
    'before clearing a label',
  );
}

async function hasLaterRunMatching(
  store: OrchestratorStore,
  run: Run,
  matches: (candidate: Run) => boolean,
  operation: string,
): Promise<boolean> {
  try {
    return (await store.listRuns(run.task)).some(
      (candidate) => isLaterRun(candidate, run) && matches(candidate),
    );
  } catch (error) {
    console.error(
      'agent-lcars: could not check later runs %s for %s:',
      operation,
      run.runId,
      error,
    );
    return false;
  }
}

function isLaterRun(candidate: Run, run: Run): boolean {
  const candidateGeneration = runGeneration(candidate.runId);
  const generation = runGeneration(run.runId);
  return (
    candidateGeneration !== undefined &&
    generation !== undefined &&
    candidateGeneration > generation
  );
}

function runGeneration(runId: string): number | undefined {
  const match = /\/r(\d+)$/u.exec(runId);
  if (match === null) return undefined;
  const generation = Number(match[1]);
  return Number.isSafeInteger(generation) ? generation : undefined;
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
      if (run.result?.summary === PARK_OUTCOME_SUMMARY) {
        // The agent's own comment (carrying both markers) already states
        // the actual blocker in the thread above this one -- don't echo
        // the raw outcome token, point at it instead.
        lines.push(
          "Parked -- see this run's own comment above for the blocker " +
            'and how to resume it.',
        );
      } else if (run.result?.summary !== undefined) {
        lines.push(run.result.summary);
      }
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

/**
 * The one place every per-entry drain failure is logged (#1548: previously
 * none of them were -- six days of a stuck outbox produced no log line
 * anywhere, only a raw Firestore query eventually surfaced it). `outcome`
 * says what happened to the entry as a result, so a reader doesn't have to
 * cross-reference the outbox document itself to know whether this was
 * retried, retired for failing longer than `OUTBOX_RETIRE_AFTER_MS`,
 * retired because its anchor closed, or was never retryable to begin with.
 * `'anchor-closed'` is deliberately distinct from `'retired'` even though
 * both settle the entry `failed` -- one is "GitHub kept rejecting this,"
 * the other is "the anchor resolved before we got to it," and a reader
 * scanning logs should be able to tell which happened without
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
 * Records, logs, and settles a retryable delivery failure (#1548, and its
 * follow-up: see `OUTBOX_RETIRE_AFTER_MS`'s doc comment for why this is
 * gated on elapsed failure time rather than claim count). This only runs
 * for an *actual* delivery attempt that failed -- unlike `attempts` (which
 * the store also bumps on lease recovery, before any delivery is even
 * attempted), `entry.firstFailedAt`/`deliveryFailures` therefore only ever
 * advance here, so a crashed drain that keeps losing its lease without
 * ever reaching GitHub can never by itself push an entry toward
 * retirement or backoff.
 *
 * Below `OUTBOX_RETIRE_AFTER_MS` (measured from the first such failure),
 * the entry is released back to `pending` for a later attempt, with
 * `nextAttemptAt` set so `claimPendingOutbox` skips it until backoff
 * elapses (`OUTBOX_BACKOFF_BASE_MS`/`_CAP_MS`) -- exactly as before this
 * follow-up, except that a fast-firing drain can no longer reclaim it
 * immediately. Once the window is exceeded, it is retired (`failed`)
 * instead, so a genuinely undeliverable entry stops consuming a claim slot
 * forever rather than retrying indefinitely.
 */
async function settleRetryableFailure(
  deps: DispatchDeps,
  entry: LeasedOutboxEntry,
  result: DrainOutboxResult,
  error: unknown,
): Promise<void> {
  const message = errorMessage(error);
  result.failed.push({ entryId: entry.entryId, error: message });

  const nowStr = now(deps);
  // Absent means this entry has never failed an actual delivery attempt
  // before -- treated as failing for the first time right now, never
  // backdated (see `OutboxEntry.firstFailedAt`'s doc comment in model.ts).
  const firstFailedAt = entry.firstFailedAt ?? nowStr;
  const retired =
    Date.parse(nowStr) - Date.parse(firstFailedAt) >= OUTBOX_RETIRE_AFTER_MS;

  if (retired) {
    logOutboxFailure(entry, message, 'retired');
    await settleClaim(deps, entry, 'failed', { now: nowStr, firstFailedAt });
    return;
  }

  const deliveryFailures = (entry.deliveryFailures ?? 0) + 1;
  const backoffMs = Math.min(
    OUTBOX_BACKOFF_CAP_MS,
    OUTBOX_BACKOFF_BASE_MS * 2 ** (deliveryFailures - 1),
  );
  const nextAttemptAt = new Date(Date.parse(nowStr) + backoffMs).toISOString();

  logOutboxFailure(entry, message, 'retrying');
  await settleClaim(deps, entry, 'pending', {
    now: nowStr,
    firstFailedAt,
    nextAttemptAt,
    deliveryFailures,
  });
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
  /** #1548 follow-up: the elapsed-time/backoff bookkeeping to persist
   *  alongside the settle, when the caller is `settleRetryableFailure`.
   *  `now` lets that caller pin the exact instant its own retirement/
   *  backoff math was computed against, rather than this function calling
   *  `now(deps)` a second time and risking a (harmless but confusing)
   *  mismatch against it. */
  failureState?: {
    now?: string;
    firstFailedAt?: string;
    nextAttemptAt?: string;
    deliveryFailures?: number;
  },
): Promise<boolean> {
  return deps.store.settleOutbox({
    entryId: entry.entryId,
    claimId: entry.claimId,
    state,
    now: failureState?.now ?? now(deps),
    firstFailedAt: failureState?.firstFailedAt,
    nextAttemptAt: failureState?.nextAttemptAt,
    deliveryFailures: failureState?.deliveryFailures,
  });
}
