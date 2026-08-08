import type {
  LedgerGeneration,
  LedgerRunAttempt,
  LedgerTaskRef,
} from '@agent-lcars/dispatch-contracts';
import type { DispatchLedger } from '@agent-lcars/dispatch-contracts';
import {
  AGENT_PIPELINES,
  displayTitleMatchesAttempt,
  parseRouterGroupMarker,
  workerWorkflow,
} from '@agent-lcars/dispatch-contracts';
import type {
  ReconcileIssue,
  ReconcileIssueQuery,
  ReconcileTransport,
} from '@agent-lcars/dispatch-reconcile';
import {
  CLOSED_SWEEP_WINDOW_MS,
  listOpenAgentLabeledIssues as listOpenAgentLabeledIssuesShared,
  listOpenIssuesAssignedTo as listOpenIssuesAssignedToShared,
  listRecentlyClosedAgentLabeledIssues as listRecentlyClosedAgentLabeledIssuesShared,
  listRecentlyClosedIssuesAssignedTo as listRecentlyClosedIssuesAssignedToShared,
} from '@agent-lcars/dispatch-reconcile';

import {
  createLedger,
  LEDGER_MARKER,
  parseLedgerComment,
  renderLedgerComment,
} from './broker';

const API_VERSION = '2026-03-10';

// #545: `findConflictingRouterRun` no longer reads the flaky
// `concurrency_groups` sub-resource at all (see the comment above it), so
// the original reason for this budget -- issue #340's "the listing hasn't
// caught up yet" eventual-consistency lag -- no longer applies to it. A
// retry budget is still worth keeping, for a different reason: a genuine
// conflict (another in-progress agent-router.yml run currently carrying
// this task's router-group marker) can resolve on its own within seconds if
// that run is mid-completion, and retrying gives it the chance instead of
// failing red on the first snapshot. Same shape, same values, new
// justification -- 5 attempts 3s apart remains a reasonable few-second
// window to let an almost-finished conflicting run clear.
const CONCURRENCY_VERIFY_MAX_ATTEMPTS = 5;
const CONCURRENCY_VERIFY_RETRY_DELAY_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class GitHubApiError extends Error {
  status: number | undefined;
  data: unknown;

  constructor(message: string, status?: number, data?: unknown) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.data = data;
  }
}

class LedgerProjectionRepairError extends Error {
  constructor(
    public readonly commentId: number,
    public readonly status: number,
  ) {
    super(
      `Failed to remove extra dispatch-ledger marker comment ${commentId}: HTTP ${status}`,
    );
    this.name = 'LedgerProjectionRepairError';
  }
}

// Thrown by `checkIndirectBrokerConcurrency`, the sole concurrency-
// verification path (#348's third round retired the direct, own-listing
// check; #545 then replaced the indirect path's own flaky per-candidate
// fetch with a reliable marker match on the run listing -- see the comment
// above `findConflictingRouterRun` below for both stories). `retryable`
// marks the one failure mode that can resolve with more time: another
// in-progress run currently carries this task's router-group marker, which
// may finish imminently and drop off the listing on the next attempt. A
// config mismatch between the supplied group and the TaskRef-derived one is
// the only other failure mode, and it is a real anomaly regardless of
// retrying -- it will never resolve itself, so it is never retryable.
// (#545 removed the third failure mode this class used to carry --
// "a candidate run couldn't be inspected at all" -- because
// `findConflictingRouterRun` no longer fetches anything per candidate; see
// below. Simplified here rather than left as a dead, unreachable branch.)
//
// A `retryable: true` error that survives verifyBrokerConcurrency's full
// retry budget has two possible explanations that look identical from
// here: ordinary contention that never resolved, or a `queue: max`
// eviction (#344) where a newer run took this run's slot. `main.mjs`'s
// broker() disambiguates the two via `findSupersedingRouterRun` before
// deciding whether to fail red or exit gracefully; when it finds
// corroborating evidence of eviction, this run's own control evidence for
// its triggering event is accepted as lost (never recorded in the ledger)
// rather than retried further — the newer, superseding run already carries
// the issue's dispatch state forward correctly, so nothing is lost except
// this one event's audit trail entry.
class BrokerConcurrencyMismatchError extends Error {
  retryable: boolean;

  constructor(
    message: string,
    { retryable = false }: { retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'BrokerConcurrencyMismatchError';
    this.retryable = retryable;
  }
}

// --- GitHub REST shapes this file reads/writes. One set covering every
// endpoint this file calls -- issue/comment/timeline/run listings and the
// dispatch/response envelopes -- each function below reads only the fields
// it actually needs, exactly as the untyped original did. ---

/** The minimal shape `request()` below actually reads off a fetch response
 *  -- narrower than the real DOM/undici `Response` so a test's minimal mock
 *  (`{ status, headers, text }`) is exactly what this function depends on,
 *  not everything `fetch` happens to also return. The real global `fetch`
 *  satisfies this structurally, since `Response` is a strict superset. */
interface FetchLikeResponse {
  status: number;
  headers: Headers;
  text: () => Promise<string>;
}

type FetchImpl = (url: string, init: RequestInit) => Promise<FetchLikeResponse>;

interface RequestOptions {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
}

interface RawResponse {
  status: number;
  data: unknown;
  headers: Headers;
}

/** `createGitHubApi()`'s return shape. `requestOk` is generic because its
 *  return shape is entirely endpoint-dependent; each call site names the
 *  shape it expects, exactly as main.mjs's own copy of this interface
 *  does. */
interface GitHubApi {
  request: (path: string, options?: RequestOptions) => Promise<RawResponse>;
  requestOk: <T = unknown>(
    path: string,
    options?: RequestOptions,
  ) => Promise<T>;
}

interface CreateGitHubApiOptions {
  token: string;
  fetchImpl?: FetchImpl;
  baseUrl?: string;
}

/** The narrowest TaskRef slice `repositoryPath` and its callers that never
 *  touch `repositoryId`/`issue` (`dispatchRouterEvent`,
 *  `listOpenAgentLabeledIssues`, `listOpenIssuesAssignedTo`,
 *  `validateDispatchResponse`) actually need -- dispatch-reconcile.yml's
 *  scan job calls several of these with a bare `{ repository }`, not a full
 *  canonical TaskRef. */
type RepositoryRef = Pick<LedgerTaskRef, 'repository'>;

interface GitHubUserRef {
  login?: string;
  type?: string;
}

interface GitHubLabelRef {
  name: string;
}

interface GitHubIssueComment {
  id: number;
  body: string;
  created_at: string;
  author_association?: string;
  user?: GitHubUserRef;
  pin?: boolean;
}

interface GitHubIssueDetail {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  user?: GitHubUserRef;
  labels?: (string | GitHubLabelRef)[];
  assignees?: GitHubUserRef[];
  pull_request?: unknown;
  created_at: string;
  updated_at: string;
  merged?: boolean;
  merged_at?: string | null;
}

/** A GitHub Actions workflow run, as returned by both the single-run GET
 *  and the runs-list endpoints this file reads. */
interface WorkflowRun {
  id: number;
  url: string;
  html_url: string;
  status: string;
  conclusion: string | null;
  updated_at: string;
  display_title?: string;
  repository?: { id: number };
  event?: string;
  path?: string;
}

interface WorkflowRunsListResponse {
  workflow_runs?: WorkflowRun[];
}

interface RunJobsResponse {
  jobs?: { name?: string; status?: string }[];
}

interface ConcurrencyGroupsResponse {
  concurrency_groups?: { group_name?: unknown }[];
}

/** `loadLedger()`/`saveLedger()`'s return shape -- the ledger paired with
 *  the GitHub comment carrying it. */
interface LoadedLedger {
  ledger: DispatchLedger;
  comment: GitHubIssueComment;
  created: boolean;
  existingComments?: GitHubIssueComment[];
}

function createGitHubApi({
  token,
  fetchImpl = fetch,
  baseUrl = 'https://api.github.com',
}: CreateGitHubApiOptions): GitHubApi {
  async function request(
    path: string,
    { method = 'GET', body, timeoutMs = 30_000 }: RequestOptions = {},
  ): Promise<RawResponse> {
    let response: FetchLikeResponse;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': API_VERSION,
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new GitHubApiError(
        // Genuinely untrusted here -- whatever fetchImpl rejected with, of
        // any shape. Every real fetch failure is Error-shaped; same
        // assumption the untyped original made without checking.
        `GitHub request transport failure: ${(error as Error).message}`,
        undefined,
      );
    }
    const text = await response.text();
    let data: unknown;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { malformedBody: text.slice(0, 500) };
      }
    }
    return { status: response.status, data, headers: response.headers };
  }

  async function requestOk<T = unknown>(
    path: string,
    options?: RequestOptions,
  ): Promise<T> {
    const response = await request(path, options);
    if (response.status < 200 || response.status >= 300) {
      throw new GitHubApiError(
        `GitHub request failed with HTTP ${response.status}`,
        response.status,
        response.data,
      );
    }
    // Every caller names the shape it expects via T; GitHub's actual
    // response body is never validated against it here, same trust
    // boundary the untyped original had (the caller is on the hook for
    // reading only fields it can tolerate being wrong).
    return response.data as T;
  }

  return { request, requestOk };
}

function splitRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo, extra] = repository.split('/');
  if (!owner || !repo || extra) throw new Error('Invalid repository identity');
  return { owner, repo };
}

function repositoryPath(task: RepositoryRef): string {
  const { owner, repo } = splitRepository(task.repository);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function brokerConcurrencyGroup(task: LedgerTaskRef): string {
  if (
    !Number.isSafeInteger(task?.repositoryId) ||
    task.repositoryId <= 0 ||
    !Number.isSafeInteger(task?.issue) ||
    task.issue <= 0
  ) {
    throw new Error('Cannot derive broker concurrency group from TaskRef');
  }
  return `agent-lcars-dispatch-v1-${task.repositoryId}-${task.issue}`;
}

// Used by checkIndirectBrokerConcurrency (the sole concurrency-verification
// path, #348): a config mismatch between a run's own supplied group and its
// TaskRef-derived expected group is never explained by listing lag — it
// means the two disagree right now and will keep disagreeing on every
// retry. This used to also guard validateBrokerConcurrencyResponse, the
// direct/own-listing check's equivalent entry point, before #348's third
// round retired that path entirely (see the comment above
// findConflictingRouterRun below).
function assertSuppliedGroupMatches(
  suppliedGroup: string,
  expected: string,
): void {
  if (suppliedGroup !== expected) {
    throw new BrokerConcurrencyMismatchError(
      'Broker concurrency output does not match its TaskRef',
    );
  }
}

// Used by findSupersedingRouterRun: which entries of a
// `.../concurrency_groups` listing response (if any) name the expected
// group, matched case-insensitively. Returns the full matching array (not
// just a boolean); the caller only ever cares whether it is non-empty.
// #545 removed the other caller (findConflictingRouterRun no longer fetches
// this endpoint at all -- see the comment above it).
function groupMembershipHolds(
  response: ConcurrencyGroupsResponse | undefined,
  expected: string,
): { group_name?: unknown }[] {
  return (response?.concurrency_groups ?? []).filter(
    (group) =>
      typeof group?.group_name === 'string' &&
      group.group_name.toLowerCase() === expected.toLowerCase(),
  );
}

// URL builder for findSupersedingRouterRun below, which fetches OTHER
// completed/in-progress runs' own concurrency-group listings while looking
// for positive corroboration of a `queue: max` eviction (#344) -- never
// THIS run's own listing. #545 removed the only other call site
// (findConflictingRouterRun's per-candidate inspection): see the comment
// above that function for why the conflict check no longer needs this
// endpoint at all. findSupersedingRouterRun still legitimately needs it --
// it is not looking for "no conflict", it is looking for one specific
// newer run that can positively confirm eviction, and per its own
// fail-closed contract a miss here is "still unexplained", never treated
// as disproof (see the comment above it).
function concurrencyGroupsPath(root: string, runId: number): string {
  return `${root}/actions/runs/${runId}/concurrency_groups?per_page=100`;
}

// Empirically confirmed on issue #348 (round 1): GitHub's own
// `/actions/runs/{id}/concurrency_groups` listing never reports membership
// for workflow_dispatch-triggered runs -- 5/5 sampled dispatch runs (some
// hours old, ruling out ordinary listing lag) returned zero matches, while
// every sampled issues-event run returned exactly one. Neither the run
// object (`GET /actions/runs/{id}`) nor the jobs API carries any
// concurrency field for any event type either, so there is no direct
// source of truth for a dispatch run's own group membership to fall back
// to. A direct, own-listing check is therefore unusable for these runs --
// it would always see zero matches and fail every single time, which is
// exactly #348's bug (a 100% failure rate for every workflow_dispatch-
// triggered broker run).
//
// #348 reopened (round 2), 2026-08-04: the same is true of pull_request-
// triggered runs -- every pull_request-triggered `agent-router.yml` run had
// failed this same check with a 100% failure rate since the broker's
// introduction, and a failing run's own listing was re-probed and still
// empty hours later, ruling out ordinary lag. PR #349's original fix had
// assumed "event-triggered runs (issues, issue_comment, pull_request)" all
// shared issues' reliable self-listing; PR #522 routed pull_request onto
// the same indirect path as workflow_dispatch instead, on the assumption
// (not yet a sampled fact) that issues/issue_comment were still reliable.
//
// #348 reopened again (round 3), 2026-08-04: production disproved that
// assumption within hours of #522 merging. A broader sample (36
// issue_comment-triggered runs, including solo/uncontested ones re-probed
// and still empty 13+ hours later) put issue_comment's failure rate at
// ~47%; the same pass found `issues` wasn't clean either, at ~17% of 90
// sampled runs, including a solo, uncontested run. Every trigger type
// sampled -- workflow_dispatch, pull_request, issues, issue_comment -- had
// now shown this same self-listing failure, just at different rates. Round
// 3 retired the "reliable event type" allowlist entirely: an indirect
// check -- confirm no OTHER in-progress `agent-router.yml` run's OWN
// listing reports holding this run's expected group -- became the
// unconditional default for every trigger. The broker job's own
// `concurrency: { group, cancel-in-progress: false, queue: max }` block
// already guarantees GitHub itself never runs two broker jobs for the same
// group at once; that indirect check confirmed the guarantee was actually
// holding for THIS run, just observed from the other side (the absence of
// a conflicting holder, rather than this run's own presence).
//
// That indirect check still inherited a structural gap of its own (#545):
// it could not detect two simultaneous runs racing for the same group when
// NEITHER one's own listing ever materialized -- which, per the round 3
// sampling above, was no longer confined to workflow_dispatch/pull_request.
// Three rounds of patches (#349, #522, #550) narrowed the affected trigger
// set but never closed this blind spot, because every version still
// depended on a run correctly reporting membership in ITS OWN
// `concurrency_groups` listing -- the one sub-resource this whole
// investigation kept finding unreliable, at rates from ~17% to 100%
// depending on trigger, and never fully explained by ordinary lag (every
// round's failing runs were re-probed hours later and still empty).
//
// #545's redesign, below: stop depending on that sub-resource for the
// conflict check altogether. The candidate-discovery LISTING itself
// (`GET .../workflows/agent-router.yml/runs?status=in_progress`) was never
// the unreliable part -- every round above trusted it completely to find
// candidates; only the follow-up per-candidate `concurrency_groups` fetch
// was ever flaky. That listing response also returns `display_title`
// inline for every run, with no separate fetch required -- exactly the
// field the worker side already builds its own reliable join key from (see
// `findRunsForGeneration` below and `formatDispatchMarker` in
// dispatch-contracts). `agent-router.yml`'s `run-name:` now embeds a
// second, analogous marker via `formatRouterGroupMarker`
// (`libs/dispatch-contracts/src/marker.js`), encoding this task's
// `repositoryId` and `issue` -- the same two inputs `brokerConcurrencyGroup`
// below derives its own group name from. Unlike the retired
// `concurrency_groups` check, GitHub Actions sets this marker
// unconditionally by evaluating `run-name:` at trigger time, identically
// for all four trigger types -- there is no "self-reporting" step for any
// run to skip or race, and so no per-trigger reliability to sample at all.
//
// This closes #545's specific gap: two simultaneous runs racing for the
// same group are now BOTH visible to each other's single listing query --
// each run's `display_title` (hence its marker) is present on that query
// the instant it exists as an in-progress run, not contingent on either run
// separately succeeding at reporting its own group membership. What
// remains is only the ordinary race inherent to any listing-based check:
// if run A queries before run B has transitioned into `in_progress` (still
// `queued`) or after B has already completed, A's single snapshot can miss
// it -- the same kind of timing window `verifyBrokerConcurrency`'s retry
// loop below already exists to cover, and categorically smaller than a
// blind spot that used to persist no matter how many times or how long a
// caller retried.
// The marker alone is NOT sufficient, and assuming it was would trade one
// bug for another. `run-name:` is evaluated at the *workflow* level, so a
// second run carries this task's marker from the instant it starts -- while
// it is still only in its `normalize` job. But `normalize` takes no
// concurrency group at all; only the `broker` job takes the per-task group
// (see agent-router.yml, whose comment records why normalize's old
// repository-wide queue was removed). Treating any
// same-task run as a holder would therefore manufacture conflicts during
// ordinary event bursts and, once the retry budget expired, drop or delay
// legitimate intent, completion, and control evidence.
//
// So the marker narrows the candidates and the *jobs* listing decides. That
// is the "live job/run list" this redesign is named for: `/actions/runs/{id}/
// jobs` is an ordinary, reliable listing -- unlike the `concurrency_groups`
// sub-resource it replaces -- and it reports job status directly, which is
// the level the group actually lives at.
//
// Only `in_progress` counts. A candidate's `broker` job sitting in `queued`
// is waiting behind the group, very likely behind *this* run, and is not a
// conflict.
const ROUTER_BROKER_JOB_NAME = 'broker';

async function findConflictingRouterRun(
  api: GitHubApi,
  task: LedgerTaskRef,
  runId: number,
): Promise<WorkflowRun | undefined> {
  const root = repositoryPath(task);
  const data = await api.requestOk<WorkflowRunsListResponse>(
    `${root}/actions/workflows/agent-router.yml/runs?status=in_progress&per_page=100`,
  );
  const candidates = (data.workflow_runs ?? []).filter((run) => {
    if (!Number.isSafeInteger(run?.id) || run.id === runId) return false;
    const marker = parseRouterGroupMarker(run.display_title);
    return (
      marker !== undefined &&
      marker.repositoryId === task.repositoryId &&
      marker.issue === task.issue
    );
  });
  for (const candidate of candidates) {
    // Fails closed: a jobs-listing error propagates rather than being read
    // as "no conflict", same as the runs listing above.
    const jobs = await api.requestOk<RunJobsResponse>(
      `${root}/actions/runs/${candidate.id}/jobs?per_page=100`,
    );
    const holdsGroup = (jobs.jobs ?? []).some(
      (job) =>
        job?.name === ROUTER_BROKER_JOB_NAME && job.status === 'in_progress',
    );
    if (holdsGroup) return candidate;
  }
  return undefined;
}

async function checkIndirectBrokerConcurrency(
  api: GitHubApi,
  task: LedgerTaskRef,
  runId: number,
  suppliedGroup: string,
): Promise<{ group_name: string; group_members: unknown[] }> {
  const expected = brokerConcurrencyGroup(task);
  // Same config-mismatch defense as the direct path: never explained by
  // eventual consistency, so never retryable.
  assertSuppliedGroupMatches(suppliedGroup, expected);
  const conflicting = await findConflictingRouterRun(api, task, runId);
  if (conflicting) {
    // Retryable: the conflicting run may simply be mid-flight (about to
    // complete) or -- indistinguishably from here -- this run itself may
    // be the one that got queue-evicted (#344/#345), in which case
    // main.mjs's wasSupersededEviction disambiguates once retries are
    // exhausted.
    throw new BrokerConcurrencyMismatchError(
      `Another in-progress agent-router.yml run (${conflicting.id}) ` +
        `carries this task's router-group marker for broker concurrency ` +
        `group ${expected}`,
      { retryable: true },
    );
  }
  return { group_name: expected, group_members: [] };
}

interface VerifyBrokerConcurrencyOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  eventName?: string;
}

// #348's third round (2026-08-04) removed the previous allowlist of
// "reliable" trigger types (see the comment above `findConflictingRouterRun`
// for why): every event name now verifies indirectly, unconditionally, with
// no branch on `eventName` at all. #545 then changed WHAT the indirect check
// reads (a router-group marker on the reliable run listing, not the flaky
// `concurrency_groups` sub-resource) without changing this either/or: there
// is still only one verification path. `eventName` is kept as an optional
// parameter purely for the diagnostic `::notice::` log line below -- it does
// not select between verification paths.
async function verifyBrokerConcurrency(
  api: GitHubApi,
  task: LedgerTaskRef,
  runId: number,
  suppliedGroup: string,
  {
    maxAttempts = CONCURRENCY_VERIFY_MAX_ATTEMPTS,
    retryDelayMs = CONCURRENCY_VERIFY_RETRY_DELAY_MS,
    sleepImpl = sleep,
    eventName,
  }: VerifyBrokerConcurrencyOptions = {},
): Promise<{ group_name: string; group_members: unknown[] }> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await checkIndirectBrokerConcurrency(
        api,
        task,
        runId,
        suppliedGroup,
      );
      console.log(
        '::notice::' +
          `Broker run ${runId}${eventName ? ` (event: ${eventName})` : ''} ` +
          `verified concurrency group ${suppliedGroup} indirectly, via its ` +
          'router-group marker on the run listing (#545). No other ' +
          'in-progress agent-router.yml run currently carries it.',
      );
      return result;
    } catch (error) {
      // Genuinely untrusted here -- whatever checkIndirectBrokerConcurrency
      // threw. Every real caller only ever throws a
      // BrokerConcurrencyMismatchError or a GitHubApiError, but this reads
      // the same duck-typed fields the untyped original did rather than
      // narrowing to one class, so a differently-shaped error (a test
      // double, say) is handled identically to before.
      const candidate = error as { retryable?: boolean; message?: string };
      const canRetry = candidate.retryable === true && attempt < maxAttempts;
      if (!canRetry) {
        if (attempt > 1) {
          candidate.message = `${candidate.message} (after ${attempt} attempts)`;
        }
        throw error;
      }
      await sleepImpl(retryDelayMs);
    }
  }
  // Unreachable: the loop always returns or throws on its final attempt.
  throw new BrokerConcurrencyMismatchError(
    'Broker run does not report the expected concurrency group',
  );
}

// When `queue: max` evicts an older run from a concurrency group's
// tracking table, the run still executes to completion but its own
// `.../concurrency_groups` listing never comes to include the group
// (issue #344). From inside the evicted run alone, that is
// indistinguishable from ordinary listing lag (#340) -- both present as
// "zero matches" once verifyBrokerConcurrency exhausts its retries.
// Disambiguate by looking for positive, independent corroboration: a
// strictly newer router run for the same issue that itself demonstrably
// holds the expected group. Absence of such a run proves nothing either
// way, so callers must treat "not found" as "still unexplained", not as
// "not evicted".
const SUPERSEDING_RUN_CANDIDATE_LIMIT = 5;

async function findSupersedingRouterRun(
  api: GitHubApi,
  task: LedgerTaskRef,
  runId: number,
): Promise<WorkflowRun | undefined> {
  const expected = brokerConcurrencyGroup(task);
  const root = repositoryPath(task);
  const data = await api.requestOk<WorkflowRunsListResponse>(
    `${root}/actions/workflows/agent-router.yml/runs?per_page=100`,
  );
  const marker = `route #${task.issue}:`;
  const candidates = (data.workflow_runs ?? [])
    .filter(
      (run) =>
        Number.isSafeInteger(run?.id) &&
        run.id > runId &&
        typeof run.display_title === 'string' &&
        run.display_title.startsWith(marker),
    )
    .sort((left, right) => right.id - left.id)
    .slice(0, SUPERSEDING_RUN_CANDIDATE_LIMIT);
  // Independent per-candidate lookups with no ordering dependency between
  // them -- fetch them all concurrently rather than one at a time.
  const inspections = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const response = await api.requestOk<ConcurrencyGroupsResponse>(
          concurrencyGroupsPath(root, candidate.id),
        );
        // An unrelated fetch failure for one candidate doesn't disprove
        // eviction; treat it as "keep looking" rather than failing the
        // whole check.
        return groupMembershipHolds(response, expected).length > 0
          ? candidate
          : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return inspections.find(Boolean);
}

async function listAll<T>(api: GitHubApi, path: string): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const data = await api.requestOk(
      `${path}${separator}per_page=100&page=${page}`,
    );
    if (!Array.isArray(data))
      throw new Error('GitHub pagination response is not an array');
    all.push(...data);
    if (data.length < 100) return all;
  }
  throw new Error('GitHub pagination exceeded safety bound');
}

// Shared by main.mjs's dispatchReconcileScan and run-dispatch-canary/
// run.mjs's sweepStaleCanaries: both fire one independent GitHub write (or
// small sequence of writes) per discovered candidate, and both discovery
// lanes can legitimately return a large backlog (a scheduled reconcile scan
// over every agent-labeled/fleet-assigned issue; a canary janitor sweep over
// every stale marked issue). Firing all of them at once via a bare
// Promise.all(Settled) would burst one request per candidate simultaneously
// and risk tripping GitHub's secondary rate limits -- the resulting
// rejections would just become per-candidate failures, silently skipping
// otherwise-healthy candidates for the rest of that pass. This bounds how
// many `worker` calls are in flight at once (a small fixed-size pool that
// refills as each slot frees up) while still attempting every item and
// keeping each item's success/failure fully independent, mirroring
// Promise.allSettled's per-item `{status, value}` / `{status, reason}`
// result shape (in the same order as `items`) so callers built around that
// shape don't need to change.
interface ConcurrencyFulfilled<R> {
  status: 'fulfilled';
  value: R;
}

interface ConcurrencyRejected {
  status: 'rejected';
  reason: unknown;
}

type ConcurrencyOutcome<R> = ConcurrencyFulfilled<R> | ConcurrencyRejected;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<ConcurrencyOutcome<R>[]> {
  const results: ConcurrencyOutcome<R>[] = new Array(items.length);
  let cursor = 0;
  async function runNext(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = {
          status: 'fulfilled',
          value: await worker(items[index], index),
        };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) {
    workers.push(runNext());
  }
  await Promise.all(workers);
  return results;
}

function createReconcileTransport(api: GitHubApi): ReconcileTransport {
  return {
    listIssues: async (query: ReconcileIssueQuery) => {
      const root = repositoryPath({ repository: query.repository });
      const parameters = new URLSearchParams({
        state: query.state,
        per_page: String(query.perPage),
        page: String(query.page),
      });
      if (query.label) parameters.set('labels', query.label);
      if (query.assignee) parameters.set('assignee', query.assignee);
      if (query.since) parameters.set('since', query.since);
      return api.requestOk<ReconcileIssue[]>(
        `${root}/issues?${parameters.toString()}`,
      );
    },
    dispatchReconcile: (repository, issue) =>
      dispatchRouterEvent(
        api,
        { repository },
        {
          kind: 'reconcile',
          issue: String(issue),
        },
      ),
  };
}

async function listOpenAgentLabeledIssues(
  api: GitHubApi,
  task: RepositoryRef,
): Promise<ReconcileIssue[]> {
  return listOpenAgentLabeledIssuesShared(
    createReconcileTransport(api),
    task.repository,
  );
}

// Bounded closed-issue sweep: converges a ledger's `control.closed` copy
// for an issue/PR GitHub already closed but whose live `closed` event
// never reached agent-router.yml. Both ways an anchor closes in this repo
// go through GITHUB_TOKEN -- an automerge-linked PR auto-closing its
// `Fixes #N` issue, and agent-automerge.yml's own explicit `gh issue close`
// backstop sweep -- and GitHub's documented recursion guard drops any
// workflow trigger an event caused by GITHUB_TOKEN would otherwise fire.
// `listOpenAgentLabeledIssues` above can never find these: they are no
// longer open. This is the discovery half of the fix; the write side
// (reconcileControlState) lives in main.mjs, next to the exact
// applyAnchorControl call a genuine live close event already uses.
//
// Bounded by `since` (the REST issues-list endpoint's own "updated at or
// after" filter) rather than the whole repository's closed-issue history,
// which an unbounded closed-state sweep would otherwise walk forever --
// exactly the cost blowup the comment above warns a naive version of this
// would risk. Only an issue whose own state changed inside the window can
// plausibly have drifted: dispatch-reconcile.yml runs every 30 minutes, so
// 24 hours gives roughly 48 scheduled passes a chance at any single closed
// issue before it ages out of the window -- generous headroom for a missed
// run or a transient GitHub outage, while still being a small, fixed
// multiple of "one day" rather than "forever". An issue that somehow
// drifts for longer than that is not silently lost: reconcileControlState
// converges on live state unconditionally whenever it's known, independent
// of how the candidate was discovered, so a maintainer can always force one
// through by hand with a manual `workflow_dispatch` (`kind: reconcile`,
// that issue number).
async function listRecentlyClosedAgentLabeledIssues(
  api: GitHubApi,
  task: RepositoryRef,
  now: Date | string = new Date(),
): Promise<ReconcileIssue[]> {
  return listRecentlyClosedAgentLabeledIssuesShared(
    createReconcileTransport(api),
    task.repository,
    now,
  );
}

// Label-independent discovery lane (#363 review, P2): removing an issue's
// last `agent:*` label while its worker is still active is recorded only as
// `control-evidence` (normalize.mjs's `unlabeled` handling) -- the
// generation itself stays active. If that worker's later completion
// callback is then also lost, `listOpenAgentLabeledIssues` alone never sees
// this issue again (it carries no agent:* label anymore), and no scheduled
// pass would ever re-observe it.
//
// Reuses an existing, already-deployed signal rather than inventing a new
// index/watermark mechanism: `claim-issue` (invoked by every worker
// workflow at dispatch time) assigns `vars.AGENT_FLEET_LOGIN` (`jclaw-bot`)
// to the anchor issue/PR, additively and idempotently, and nothing in this
// codebase ever removes that assignment. It is therefore a durable,
// label-independent "an agent has dispatched work here" marker that
// survives exactly the failure this discovers -- at the cost of also
// matching issues whose ledger is long since terminal (the assignment is
// never cleared on completion either). That over-inclusion is harmless: a
// reconcile pass over an issue with no active/pending generation is a fast
// no-op (see reconcileLedger), just spending a little extra scan/dispatch
// budget rather than missing evidence.
async function listOpenIssuesAssignedTo(
  api: GitHubApi,
  task: RepositoryRef,
  login: string,
): Promise<ReconcileIssue[]> {
  return listOpenIssuesAssignedToShared(
    createReconcileTransport(api),
    task.repository,
    login,
  );
}

// Closed counterpart to listOpenIssuesAssignedTo, for the exact same reason
// listRecentlyClosedAgentLabeledIssues exists beside listOpenAgentLabeledIssues
// (#715 review of #645/#663): the fleet-assignee lane is what keeps an
// unlabeled-but-still-active ledger discoverable at all once its last
// agent:*/review:* label is removed -- see listOpenIssuesAssignedTo's own
// header -- and that guarantee cannot lapse the instant the anchor closes.
// An anchor whose last agent:*/review:* label was already removed before
// GITHUB_TOKEN closed it drops off BOTH the labeled closed sweep (it
// carries no label to match) and the labeled/assignee OPEN lanes (it is no
// longer open); without this function nothing would ever put it back in
// front of a reconcile pass again, and its control.closed would stay stale
// forever -- the exact permanent-staleness hole #645 already closed for the
// labeled case, reopened for the unlabeled one. Bounded identically to
// listRecentlyClosedAgentLabeledIssues: `since` no older than
// CLOSED_SWEEP_WINDOW_MS behind `now`.
async function listRecentlyClosedIssuesAssignedTo(
  api: GitHubApi,
  task: RepositoryRef,
  login: string,
  now: Date | string = new Date(),
): Promise<ReconcileIssue[]> {
  return listRecentlyClosedIssuesAssignedToShared(
    createReconcileTransport(api),
    task.repository,
    login,
    now,
  );
}

interface LoadLedgerOptions {
  createIfMissing?: boolean;
}

export interface LedgerProjectionIdentity {
  login: string;
  type: 'Bot' | 'User';
}

async function loadLedger(
  api: GitHubApi,
  task: LedgerTaskRef,
  workflowIdentity = 'github-actions[bot]',
  { createIfMissing = true }: LoadLedgerOptions = {},
): Promise<LoadedLedger | undefined> {
  const root = repositoryPath(task);
  const comments = await listAll<GitHubIssueComment>(
    api,
    `${root}/issues/${task.issue}/comments`,
  );
  const candidates = comments.filter((comment) =>
    comment.body?.includes(LEDGER_MARKER),
  );
  if (candidates.length > 1) {
    throw new Error('Duplicate dispatch ledger comments');
  }
  if (candidates.length === 1) {
    const comment = candidates[0];
    if (
      comment.user?.login !== workflowIdentity ||
      comment.user?.type !== 'Bot'
    ) {
      throw new Error('Dispatch ledger author is not the workflow identity');
    }
    return {
      comment,
      ledger: parseLedgerComment(comment.body, task),
      created: false,
    };
  }

  if (!createIfMissing) return undefined;

  const ledger = createLedger(task);
  const comment = await api.requestOk<GitHubIssueComment>(
    `${root}/issues/${task.issue}/comments`,
    {
      method: 'POST',
      body: { body: renderLedgerComment(ledger) },
    },
  );
  if (!Number.isSafeInteger(comment?.id)) {
    throw new Error('GitHub did not return the created ledger comment ID');
  }
  return { comment, ledger, created: true, existingComments: comments };
}

/**
 * Locate or create the human-facing ledger comment without parsing it as
 * controller state. Authority mode calls this only after Firestore has been
 * read and leased, so a controlled worker can neither corrupt nor duplicate
 * comments to block the controller from reaching its real state.
 */
async function loadLedgerProjection(
  api: GitHubApi,
  task: LedgerTaskRef,
  ledger: DispatchLedger,
  controllerIdentities: readonly LedgerProjectionIdentity[] = [
    { login: 'github-actions[bot]', type: 'Bot' },
  ],
): Promise<LoadedLedger> {
  const root = repositoryPath(task);
  const comments = await listAll<GitHubIssueComment>(
    api,
    `${root}/issues/${task.issue}/comments`,
  );
  const markerCandidates = comments.filter((comment) =>
    comment.body?.includes(LEDGER_MARKER),
  );
  const ownedCandidates = markerCandidates
    .filter(
      (comment) =>
        comment.body?.includes(LEDGER_MARKER) &&
        controllerIdentities.some(
          (identity) =>
            comment.user?.login === identity.login &&
            comment.user?.type === identity.type,
        ),
    )
    .sort((left, right) => left.id - right.id);
  let comment = ownedCandidates[0];
  let created = false;
  if (!comment) {
    comment = await api.requestOk<GitHubIssueComment>(
      `${root}/issues/${task.issue}/comments`,
      {
        method: 'POST',
        body: { body: renderLedgerComment(ledger) },
      },
    );
    if (!Number.isSafeInteger(comment?.id)) {
      throw new Error('GitHub did not return the created ledger comment ID');
    }
    created = true;
  }

  // Worker preflight remains a strict compatibility reader until that
  // capability moves into the hosted controller. Repair every extra marker
  // while this authority holder owns the task lease, regardless of author:
  // controlled workers comment through the App bot rather than the workflow
  // bot, and strict preflight rejects duplicate markers before author checks.
  for (const duplicate of markerCandidates.filter(
    (candidate) => candidate.id !== comment.id,
  )) {
    const response = await api.request(
      `${root}/issues/comments/${duplicate.id}`,
      { method: 'DELETE' },
    );
    if (
      response.status !== 404 &&
      (response.status < 200 || response.status >= 300)
    ) {
      throw new LedgerProjectionRepairError(duplicate.id, response.status);
    }
    console.log(
      `::notice::Removed extra dispatch-ledger marker comment ${duplicate.id}.`,
    );
  }
  return {
    comment,
    ledger,
    created,
    ...(created && { existingComments: comments }),
  };
}

export type AuthorityInitializationEvidence =
  'compatibility-projection' | 'pre-cutover' | 'post-cutover';

/**
 * Classify the evidence available when an authority record is missing.
 *
 * Marker absence is not evidence: a controlled worker can edit or delete
 * comments. The trusted cutover epoch and GitHub's immutable issue/PR
 * `created_at` are the non-forgeable boundary. Tasks created before that
 * boundary must already have been shadow-backfilled, so missing state fails
 * closed even if every compatibility marker has been removed. Tasks created
 * at or after the boundary are genuinely post-authority and may be seeded.
 */
async function classifyAuthorityTaskInitialization(
  api: GitHubApi,
  task: LedgerTaskRef,
  authorityEpoch: string,
  controllerIdentities: readonly LedgerProjectionIdentity[] = [
    { login: 'github-actions[bot]', type: 'Bot' },
  ],
): Promise<AuthorityInitializationEvidence> {
  const comments = await listAll<GitHubIssueComment>(
    api,
    `${repositoryPath(task)}/issues/${task.issue}/comments`,
  );
  // Projection presence is tracking evidence only when the canonical
  // controller identity authored it. Other App/bot credentials are
  // available to controlled worker jobs and cannot prove authority history.
  const hasProjection = comments.some(
    (comment) =>
      comment.body?.includes(LEDGER_MARKER) &&
      controllerIdentities.some(
        (identity) =>
          comment.user?.login === identity.login &&
          comment.user?.type === identity.type,
      ),
  );
  if (hasProjection) return 'compatibility-projection';

  const epoch = Date.parse(authorityEpoch);
  if (!Number.isFinite(epoch)) {
    throw new Error(
      `DISPATCH_AUTHORITY_EPOCH must be a valid timestamp, got ${JSON.stringify(authorityEpoch)}`,
    );
  }
  const issue = await api.requestOk<GitHubIssueDetail>(
    `${repositoryPath(task)}/issues/${task.issue}`,
  );
  const createdAt = Date.parse(issue.created_at);
  if (!Number.isFinite(createdAt)) {
    throw new Error(
      `GitHub returned an invalid created_at for ${task.repository}#${task.issue}`,
    );
  }
  return createdAt >= epoch ? 'post-cutover' : 'pre-cutover';
}

async function saveLedger(
  api: GitHubApi,
  loaded: LoadedLedger,
): Promise<LoadedLedger> {
  const root = repositoryPath(loaded.ledger.task);
  const comment = await api.requestOk<GitHubIssueComment>(
    `${root}/issues/comments/${loaded.comment.id}`,
    {
      method: 'PATCH',
      body: { body: renderLedgerComment(loaded.ledger) },
    },
  );
  loaded.comment = comment;
  return loaded;
}

interface PinResult {
  pinned: boolean;
  reason?: string;
}

async function pinLedgerWhenUnoccupied(
  api: GitHubApi,
  loaded: LoadedLedger,
  isPullRequest: boolean,
): Promise<PinResult> {
  if (!loaded.created || isPullRequest)
    return { pinned: false, reason: 'ineligible' };
  // `existingComments` is only ever unset when `created` is false -- see
  // loadLedger's own construction, which always pairs the two -- and the
  // guard above already proved `created` is true.
  const { existingComments } = loaded;
  if (!existingComments) {
    throw new Error(
      'LoadedLedger.existingComments missing despite created=true',
    );
  }
  if (existingComments.some((comment) => comment.pin)) {
    return { pinned: false, reason: 'occupied' };
  }
  const root = repositoryPath(loaded.ledger.task);
  try {
    await api.requestOk(`${root}/issues/comments/${loaded.comment.id}/pin`, {
      method: 'PUT',
    });
    return { pinned: true };
  } catch (error) {
    return {
      pinned: false,
      // Every requestOk failure throws a GitHubApiError (see request()
      // above); this mirrors the untyped original's own optional-chained
      // `error.status` read for anything else.
      reason: `best-effort-failed:${error instanceof GitHubApiError ? (error.status ?? 'transport') : 'transport'}`,
    };
  }
}

// workerConfigurations/agentWorkerPipelines/workerWorkflow used to be
// github-api.mjs's own hand-copied worker registry. They now come straight
// from the shared libs/dispatch-contracts/src/pipelines.js definitions
// (AGENT_PIPELINES/workerWorkflow, imported above), re-exported under their
// original names so existing importers (main.mjs, workflow-contract.test.mjs,
// github-api.test.mjs) don't churn.
const agentWorkerPipelines = AGENT_PIPELINES;

/** What GitHub's own workflow-dispatch response body must decode to;
 *  validated field by field below before any field is trusted. */
interface DispatchResponseData {
  workflow_run_id?: unknown;
  run_url?: unknown;
  html_url?: unknown;
}

function validateDispatchResponse(
  response: { status: number; data: unknown },
  task: RepositoryRef,
): { runId: number; runUrl: string; htmlUrl: string } {
  if (response.status !== 200) {
    throw new GitHubApiError(
      `Workflow dispatch returned HTTP ${response.status}`,
      response.status,
      response.data,
    );
  }
  // Genuinely untrusted -- GitHub's POST .../dispatches response body,
  // checked field by field below before any field is trusted.
  const data = response.data as DispatchResponseData | null | undefined;
  const runId = data?.workflow_run_id;
  const runUrl = data?.run_url;
  const htmlUrl = data?.html_url;
  const { owner, repo } = splitRepository(task.repository);
  const expectedRunUrl = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}`;
  const expectedHtmlUrl = `https://github.com/${owner}/${repo}/actions/runs/${runId}`;
  if (
    !Number.isSafeInteger(runId) ||
    // isSafeInteger's signature accepts `unknown` but does not narrow it --
    // same posture as ledger-core.ts's assertTaskRef, which casts for the
    // same reason immediately after an identical guard.
    (runId as number) <= 0 ||
    typeof runUrl !== 'string' ||
    runUrl !== expectedRunUrl ||
    typeof htmlUrl !== 'string' ||
    htmlUrl !== expectedHtmlUrl
  ) {
    throw new GitHubApiError(
      'Workflow dispatch returned malformed run details',
      200,
      response.data,
    );
  }
  return { runId: runId as number, runUrl, htmlUrl };
}

// Shared by main.mjs's completionCallback/dispatchReconcileScan and
// run-dispatch-canary/run.mjs's dispatchRouterCanary: every caller posts
// the same workflow_dispatch shape at this repo's own agent-router.yml
// (ref: 'main', a caller-supplied `inputs` object naming the `kind`) and
// then validates the same response contract via validateDispatchResponse.
// Only the `inputs` payload differs per caller.
async function dispatchRouterEvent(
  api: GitHubApi,
  task: RepositoryRef,
  inputs: Record<string, string>,
): Promise<{ runId: number; runUrl: string; htmlUrl: string }> {
  const response = await api.request(
    `${repositoryPath(task)}/actions/workflows/agent-router.yml/dispatches`,
    {
      method: 'POST',
      body: { ref: 'main', inputs },
    },
  );
  return validateDispatchResponse(response, task);
}

/** `beginDispatch` (modules/scheduler.mjs) always sets `attempt` together
 *  with the `dispatching` state a generation is in by the time
 *  dispatchAccepted (main.mjs) calls this -- this makes that invariant
 *  explicit rather than dereferencing undefined and blaming the caller. */
function attemptOf(generation: LedgerGeneration): LedgerRunAttempt {
  const { attempt } = generation;
  if (!attempt) {
    throw new Error(`Generation ${generation.generation} has no attempt`);
  }
  return attempt;
}

async function dispatchWorker(
  api: GitHubApi,
  generation: LedgerGeneration,
  task: LedgerTaskRef,
): Promise<{
  runId: number;
  runUrl: string;
  htmlUrl: string;
  workflow: string;
}> {
  const workflow = workerWorkflow(generation.pipeline);
  const root = repositoryPath(task);
  const response = await api.request(
    `${root}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
    {
      method: 'POST',
      body: {
        ref: 'main',
        inputs: {
          issue: String(task.issue),
          mode: generation.mode,
          reply: generation.reply ?? '',
          runbook: generation.runbook ?? '',
          context: generation.context ?? '',
          broker_intent_id: generation.intentId,
          broker_generation: String(generation.generation),
          // `beginDispatch` (modules/scheduler.mjs) always sets `attempt`
          // together with the `dispatching` state a generation is in by
          // the time dispatchAccepted (main.mjs) calls this -- same
          // assumption the untyped original made without checking.
          broker_dispatch_token: attemptOf(generation).token,
        },
      },
    },
  );
  return { ...validateDispatchResponse(response, task), workflow };
}

async function getWorkflowRun(
  api: GitHubApi,
  task: LedgerTaskRef,
  runId: number,
): Promise<WorkflowRun> {
  return api.requestOk<WorkflowRun>(
    `${repositoryPath(task)}/actions/runs/${runId}`,
  );
}

// Runs list responses are sorted newest-first, and a single `per_page=100`
// page only ever sees the 100 most recent runs of that workflow. A
// generation dispatched a while ago (exactly the scenario #305's reconciler
// exists to repair) can have accumulated 100+ more recent workflow_dispatch
// runs for the same pipeline since -- an unscoped, unpaginated call then
// falsely reports "no matching run" for a dispatch that genuinely still
// exists, and the reconciler's bounded-retry escalation (trackMissingRun)
// would eventually park a perfectly healthy dispatch (#363 review, P2).
//
// Two independent, compounding mitigations, both pure narrowing -- neither
// can ever cause a true match to be excluded:
//   1. Scope the query to `created` at or after this generation's own
//      dispatch time (with a small clock-skew buffer): a run for this
//      generation can never have been created earlier, so this only
//      shrinks the candidate set, and in the overwhelmingly common case
//      collapses it to a single page. Cheaper than deep pagination, so
//      applied first.
//   2. Still paginate a bounded number of pages within that scoped window
//      as defense in depth against pathological traffic even inside the
//      scoped range -- accumulating matches across every scanned page
//      (never stopping at the first match) so a genuine duplicate-attempt
//      run landing on a later page is still detected, not silently missed.
const FIND_RUNS_FOR_GENERATION_MAX_PAGES = 5;
const FIND_RUNS_FOR_GENERATION_CREATED_BUFFER_MS = 5 * 60 * 1000;

function createdAtOrAfterFilter(generation: LedgerGeneration): string {
  const dispatchedAt =
    generation.attempt?.dispatchStartedAt ?? generation.occurredAt;
  const parsed = Date.parse(dispatchedAt);
  if (Number.isNaN(parsed)) return '';
  const scoped = new Date(
    parsed - FIND_RUNS_FOR_GENERATION_CREATED_BUFFER_MS,
  ).toISOString();
  // GitHub's documented range-qualifier syntax for the `created` list
  // parameter (not the newer 2026-03-10-only surface used elsewhere in
  // this file): https://docs.github.com/search-github/searching-on-github/understanding-the-search-syntax
  return `&created=${encodeURIComponent(`>=${scoped}`)}`;
}

async function findRunsForGeneration(
  api: GitHubApi,
  task: LedgerTaskRef,
  generation: LedgerGeneration,
): Promise<WorkflowRun[]> {
  const workflow = workerWorkflow(generation.pipeline);
  const root = repositoryPath(task);
  const createdFilter = createdAtOrAfterFilter(generation);
  const matches: WorkflowRun[] = [];
  for (let page = 1; page <= FIND_RUNS_FOR_GENERATION_MAX_PAGES; page += 1) {
    const data = await api.requestOk<WorkflowRunsListResponse>(
      `${root}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch${createdFilter}&per_page=100&page=${page}`,
    );
    const runs = data.workflow_runs ?? [];
    for (const run of runs) {
      if (displayTitleMatchesAttempt(run.display_title, generation)) {
        matches.push(run);
      }
    }
    if (runs.length < 100) break;
  }
  return matches;
}

// Removes a stale `agent:*` label as part of the broker's dual-label
// self-heal (#304 audit item 4). A 404 means the label is already gone --
// either a prior, interrupted heal attempt already removed it, or a
// maintainer removed it manually in the same window -- and is treated as
// success rather than an error, since the desired end state (the label is
// gone) already holds. Any other non-2xx status is a real failure and
// propagates so the broker falls back to its normal fail-closed path.
async function removeIssueLabel(
  api: GitHubApi,
  task: LedgerTaskRef,
  label: string,
): Promise<{ removed: boolean }> {
  const root = repositoryPath(task);
  const response = await api.request(
    `${root}/issues/${task.issue}/labels/${encodeURIComponent(label)}`,
    { method: 'DELETE' },
  );
  if (response.status === 404) return { removed: false };
  if (response.status < 200 || response.status >= 300) {
    throw new GitHubApiError(
      `Failed to remove stale label ${label}: HTTP ${response.status}`,
      response.status,
      response.data,
    );
  }
  return { removed: true };
}

async function failClosed(
  api: GitHubApi,
  task: LedgerTaskRef,
  maintainer: string,
  error: unknown,
): Promise<never> {
  const originalError =
    error instanceof Error ? error : new Error(String(error));
  let fallbackError: Error | undefined;
  try {
    await ensureNeedsHumanParked(api, task, maintainer);
  } catch (parkingError) {
    fallbackError =
      parkingError instanceof Error
        ? parkingError
        : new Error(String(parkingError));
  }
  if (fallbackError) {
    // A fallback failure must not replace the broker failure that caused us
    // to park. AggregateError keeps both stacks/status codes visible in the
    // Actions log while `cause` identifies the primary failure explicitly.
    throw new AggregateError(
      [originalError, fallbackError],
      `Dispatch broker failed (${originalError.message}); ` +
        `fail-closed parking also failed (${fallbackError.message})`,
      { cause: originalError },
    );
  }
  throw originalError;
}

async function issueHasLabel(
  api: GitHubApi,
  task: LedgerTaskRef,
  label: string,
): Promise<boolean> {
  const issue = await api.requestOk<GitHubIssueDetail>(
    `${repositoryPath(task)}/issues/${task.issue}`,
  );
  return (issue.labels ?? []).some(
    (entry) => (typeof entry === 'string' ? entry : entry.name) === label,
  );
}

async function issueHasAssignee(
  api: GitHubApi,
  task: LedgerTaskRef,
  login: string,
): Promise<boolean> {
  const issue = await api.requestOk<GitHubIssueDetail>(
    `${repositoryPath(task)}/issues/${task.issue}`,
  );
  return (issue.assignees ?? []).some((assignee) => assignee.login === login);
}

// The reconciler's bounded-retry parking path (#305's repair table:
// "unrepairable -> status:needs-human + maintainer assignee"), reusing
// report-failure.sh's verify-then-decide convention in JS: `gh`/the REST
// API occasionally returns a non-2xx or a parse hiccup on a mutation that
// actually landed (agent-lcars#346). Unlike failClosed (used for genuinely
// unexpected errors, which always throws after parking so the triggering
// job fails loudly), reaching the bounded-retry limit is an ANTICIPATED
// terminal outcome, not a job failure -- callers of this function decide
// separately whether to throw; this function itself only throws when the
// mutation is genuinely, confirmably absent.
// Shared by the label and assignee mutations below: attempt the mutation,
// and only surface its error if `verify` confirms the mutation genuinely
// did not land (see the ensureNeedsHumanParked comment above for why a
// failure here can still mean success). The bash equivalent of this same
// pattern is report-failure.sh's `mutate_or_verify`.
async function mutateOrVerify(
  mutate: () => Promise<unknown>,
  verify: () => Promise<boolean>,
): Promise<void> {
  try {
    await mutate();
  } catch (error) {
    if (!(await verify())) throw error;
  }
}

async function ensureNeedsHumanParked(
  api: GitHubApi,
  task: LedgerTaskRef,
  maintainer: string,
): Promise<void> {
  const root = repositoryPath(task);
  await mutateOrVerify(
    () =>
      api.requestOk(`${root}/issues/${task.issue}/labels`, {
        method: 'POST',
        body: { labels: ['status:needs-human'] },
      }),
    () => issueHasLabel(api, task, 'status:needs-human'),
  );
  if (!maintainer) return;
  await mutateOrVerify(
    () =>
      api.requestOk(`${root}/issues/${task.issue}/assignees`, {
        method: 'POST',
        body: { assignees: [maintainer] },
      }),
    () => issueHasAssignee(api, task, maintainer),
  );
}

export {
  agentWorkerPipelines,
  API_VERSION,
  brokerConcurrencyGroup,
  BrokerConcurrencyMismatchError,
  classifyAuthorityTaskInitialization,
  CLOSED_SWEEP_WINDOW_MS,
  CONCURRENCY_VERIFY_MAX_ATTEMPTS,
  CONCURRENCY_VERIFY_RETRY_DELAY_MS,
  createGitHubApi,
  createReconcileTransport,
  dispatchRouterEvent,
  dispatchWorker,
  ensureNeedsHumanParked,
  failClosed,
  findConflictingRouterRun,
  findRunsForGeneration,
  findSupersedingRouterRun,
  getWorkflowRun,
  GitHubApiError,
  LedgerProjectionRepairError,
  listAll,
  listOpenAgentLabeledIssues,
  listOpenIssuesAssignedTo,
  listRecentlyClosedAgentLabeledIssues,
  listRecentlyClosedIssuesAssignedTo,
  loadLedger,
  loadLedgerProjection,
  mapWithConcurrency,
  pinLedgerWhenUnoccupied,
  removeIssueLabel,
  repositoryPath,
  saveLedger,
  splitRepository,
  validateDispatchResponse,
  verifyBrokerConcurrency,
  workerWorkflow,
};
