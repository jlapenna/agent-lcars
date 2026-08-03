import {
  createLedger,
  LEDGER_MARKER,
  parseLedgerComment,
  renderLedgerComment,
} from './broker.mjs';

const API_VERSION = '2026-03-10';

// The concurrency-group listing is populated asynchronously by GitHub after
// a run starts, so `verifyBrokerConcurrency` can observe the group as
// "not yet present" even for a run that will report it moments later
// (issue #340). Bound the wait instead of failing on the first miss.
const CONCURRENCY_VERIFY_MAX_ATTEMPTS = 5;
const CONCURRENCY_VERIFY_RETRY_DELAY_MS = 3_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class GitHubApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.data = data;
  }
}

// Thrown by `validateBrokerConcurrencyResponse` (the event-triggered path)
// and `checkDispatchBrokerConcurrency` (the workflow_dispatch-triggered
// path, #348). `retryable` marks the failure modes that can resolve with
// more time: the event-triggered path's expected group simply hasn't
// materialized in its own listing yet; the dispatch-triggered path found
// another in-progress run currently reporting the group, which may finish
// imminently. Every other failure mode (config mismatch, malformed
// response, more than one match) is a real anomaly and must never be
// retried.
//
// A `retryable: true` error that survives verifyBrokerConcurrency's full
// retry budget has two possible explanations that look identical from
// here: ordinary contention/lag that never resolved, or a `queue: max`
// eviction (#344) where a newer run took this run's slot before the
// listing ever caught up. `main.mjs`'s broker() disambiguates the two via
// `findSupersedingRouterRun` before deciding whether to fail red or exit
// gracefully; when it finds corroborating evidence of eviction, this run's
// own control evidence for its triggering event is accepted as lost
// (never recorded in the ledger) rather than retried further — the newer,
// superseding run already carries the issue's dispatch state forward
// correctly, so nothing is lost except this one event's audit trail entry.
// This disambiguation applies identically regardless of which path
// produced the retryable mismatch.
class BrokerConcurrencyMismatchError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = 'BrokerConcurrencyMismatchError';
    this.retryable = retryable;
  }
}

function createGitHubApi({
  token,
  fetchImpl = fetch,
  baseUrl = 'https://api.github.com',
}) {
  async function request(
    path,
    { method = 'GET', body, timeoutMs = 30_000 } = {},
  ) {
    let response;
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
        `GitHub request transport failure: ${error.message}`,
        undefined,
      );
    }
    const text = await response.text();
    let data;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { malformedBody: text.slice(0, 500) };
      }
    }
    return { status: response.status, data, headers: response.headers };
  }

  async function requestOk(path, options) {
    const response = await request(path, options);
    if (response.status < 200 || response.status >= 300) {
      throw new GitHubApiError(
        `GitHub request failed with HTTP ${response.status}`,
        response.status,
        response.data,
      );
    }
    return response.data;
  }

  return { request, requestOk };
}

function splitRepository(repository) {
  const [owner, repo, extra] = repository.split('/');
  if (!owner || !repo || extra) throw new Error('Invalid repository identity');
  return { owner, repo };
}

function repositoryPath(task) {
  const { owner, repo } = splitRepository(task.repository);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function brokerConcurrencyGroup(task) {
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

// Shared by validateBrokerConcurrencyResponse (the event-triggered path) and
// checkDispatchBrokerConcurrency (the workflow_dispatch-triggered path,
// #348): a config mismatch between a run's own supplied group and its
// TaskRef-derived expected group is never explained by listing lag — it
// means the two disagree right now and will keep disagreeing on every
// retry.
function assertSuppliedGroupMatches(suppliedGroup, expected) {
  if (suppliedGroup !== expected) {
    throw new BrokerConcurrencyMismatchError(
      'Broker concurrency output does not match its TaskRef',
    );
  }
}

// Shared by validateBrokerConcurrencyResponse, findConflictingRouterRun, and
// findSupersedingRouterRun: which entries of a `.../concurrency_groups`
// listing response (if any) name the expected group, matched
// case-insensitively. Returns the full matching array (not just a boolean)
// so validateBrokerConcurrencyResponse can still distinguish "zero matches"
// (retryable) from "more than one match" (a real anomaly); the two scan
// loops only ever care whether the array is non-empty.
function groupMembershipHolds(response, expected) {
  return (response?.concurrency_groups ?? []).filter(
    (group) =>
      typeof group?.group_name === 'string' &&
      group.group_name.toLowerCase() === expected.toLowerCase(),
  );
}

// Shared URL builder for the three call sites below that fetch a specific
// run's own concurrency-group listing.
function concurrencyGroupsPath(root, runId) {
  return `${root}/actions/runs/${runId}/concurrency_groups?per_page=100`;
}

function validateBrokerConcurrencyResponse(data, task, runId, suppliedGroup) {
  const expected = brokerConcurrencyGroup(task);
  assertSuppliedGroupMatches(suppliedGroup, expected);
  if (
    !Number.isSafeInteger(runId) ||
    runId <= 0 ||
    !Array.isArray(data?.concurrency_groups)
  ) {
    throw new BrokerConcurrencyMismatchError(
      'Malformed broker concurrency-group response',
    );
  }
  const matching = groupMembershipHolds(data, expected);
  if (matching.length !== 1) {
    // Zero matches is the eventually-consistent case: the listing hasn't
    // caught up with this run yet, and a later attempt can still succeed.
    // More than one match is a real anomaly (e.g. a stale/duplicate group)
    // that retrying cannot fix.
    throw new BrokerConcurrencyMismatchError(
      'Broker run does not report the expected concurrency group',
      { retryable: matching.length === 0 },
    );
  }
  return matching[0];
}

async function fetchAndValidateOwnListing(api, task, runId, suppliedGroup) {
  const path = concurrencyGroupsPath(repositoryPath(task), runId);
  const data = await api.requestOk(path);
  return validateBrokerConcurrencyResponse(data, task, runId, suppliedGroup);
}

// Bounds how many other in-progress `agent-router.yml` runs are checked per
// dispatch-run verification attempt. Realistically there are only ever a
// handful of concurrently in-progress router runs; this just keeps API
// usage bounded, mirroring SUPERSEDING_RUN_CANDIDATE_LIMIT below.
const DISPATCH_CONFLICT_CANDIDATE_LIMIT = 20;

// Empirically confirmed on issue #348: GitHub's own
// `/actions/runs/{id}/concurrency_groups` listing never reports membership
// for workflow_dispatch-triggered runs -- 5/5 sampled dispatch runs (some
// hours old, ruling out ordinary listing lag) returned zero matches, while
// every sampled issues-event run returned exactly one. Neither the run
// object (`GET /actions/runs/{id}`) nor the jobs API carries any
// concurrency field for any event type either, so there is no direct
// source of truth for a dispatch run's own group membership to fall back
// to. `fetchAndValidateOwnListing` above is therefore unusable for these
// runs -- it would always see zero matches and fail every single time,
// which is exactly #348's bug (a 100% failure rate for every
// workflow_dispatch-triggered broker run).
//
// `findConflictingRouterRun` verifies an equivalent invariant indirectly
// instead: it confirms no OTHER currently in-progress `agent-router.yml`
// run reports (via ITS OWN listing, which is reliable for event-triggered
// runs) holding this run's expected concurrency group. The broker job's
// `concurrency: { group, cancel-in-progress: false, queue: max }` block
// already guarantees GitHub itself never runs two broker jobs for the same
// group at once; this indirect check confirms that guarantee is actually
// holding for THIS run, the same thing the direct listing check confirms
// for event-triggered runs -- it just can't observe this run's own
// membership, only the absence of a conflicting one held by another run.
// It cannot detect two simultaneous dispatch-triggered runs racing each
// other (neither would ever self-report), so that residual gap is a known,
// accepted limitation rather than a silently assumed absence of risk.
//
// A candidate whose own listing request fails is NOT proof it is clean
// (PR #349 review, P1): if the one candidate that actually holds the group
// happens to be the one whose lookup times out or errors, silently
// skipping it and returning "no conflict" would verify a genuinely
// conflicting dispatch run by default -- fail-open on exactly the error
// path this whole mechanism exists to guard. So an inspection failure
// keeps scanning the remaining candidates (a later one might still show a
// definite, stronger conflict signal that should win), but if the scan
// ends without one, the run(s) that could never actually be inspected make
// the whole attempt inconclusive rather than "clean": throw retryable so
// the caller's retry loop re-scans from scratch, and only give up (fail
// closed, never silently verified) once the retry budget is exhausted.
async function findConflictingRouterRun(api, task, runId) {
  const expected = brokerConcurrencyGroup(task);
  const root = repositoryPath(task);
  const data = await api.requestOk(
    `${root}/actions/workflows/agent-router.yml/runs?status=in_progress&per_page=100`,
  );
  const candidates = (data.workflow_runs ?? [])
    .filter((run) => Number.isSafeInteger(run?.id) && run.id !== runId)
    .sort((left, right) => right.id - left.id)
    .slice(0, DISPATCH_CONFLICT_CANDIDATE_LIMIT);
  // Independent per-candidate lookups with no ordering dependency between
  // them -- fetch them all concurrently rather than one at a time.
  const inspections = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const response = await api.requestOk(
          concurrencyGroupsPath(root, candidate.id),
        );
        return {
          candidate,
          holdsExpectedGroup:
            groupMembershipHolds(response, expected).length > 0,
        };
      } catch {
        return { candidate, uninspectable: true };
      }
    }),
  );
  // A definite conflict is a stronger signal than "inconclusive" and wins,
  // even if some other candidate was uninspectable.
  const conflicting = inspections.find(
    (inspection) => inspection.holdsExpectedGroup,
  );
  if (conflicting) return conflicting.candidate;
  const uninspectedIds = inspections
    .filter((inspection) => inspection.uninspectable)
    .map((inspection) => inspection.candidate.id);
  if (uninspectedIds.length > 0) {
    throw new BrokerConcurrencyMismatchError(
      'Could not inspect in-progress agent-router.yml run(s) ' +
        `${uninspectedIds.join(', ')} for broker concurrency group ` +
        `${expected}; cannot rule out a conflict`,
      { retryable: true },
    );
  }
  return undefined;
}

async function checkDispatchBrokerConcurrency(api, task, runId, suppliedGroup) {
  const expected = brokerConcurrencyGroup(task);
  // Same config-mismatch defense as the event-triggered path: never
  // explained by eventual consistency, so never retryable.
  assertSuppliedGroupMatches(suppliedGroup, expected);
  const conflicting = await findConflictingRouterRun(api, task, runId);
  if (conflicting) {
    // Retryable: the conflicting run may simply be mid-flight (about to
    // complete) or -- indistinguishably from here -- this dispatch run
    // itself may be the one that got queue-evicted (#344/#345), in which
    // case main.mjs's wasSupersededEviction disambiguates once retries are
    // exhausted, exactly as it already does for the event-triggered path.
    throw new BrokerConcurrencyMismatchError(
      `Another in-progress agent-router.yml run (${conflicting.id}) ` +
        `reports holding broker concurrency group ${expected}`,
      { retryable: true },
    );
  }
  return { group_name: expected, group_members: [] };
}

async function verifyBrokerConcurrency(
  api,
  task,
  runId,
  suppliedGroup,
  {
    maxAttempts = CONCURRENCY_VERIFY_MAX_ATTEMPTS,
    retryDelayMs = CONCURRENCY_VERIFY_RETRY_DELAY_MS,
    sleepImpl = sleep,
    eventName,
  } = {},
) {
  const isDispatchTriggered = eventName === 'workflow_dispatch';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = isDispatchTriggered
        ? await checkDispatchBrokerConcurrency(api, task, runId, suppliedGroup)
        : await fetchAndValidateOwnListing(api, task, runId, suppliedGroup);
      if (isDispatchTriggered) {
        console.log(
          '::notice::' +
            `Dispatch-triggered broker run ${runId} verified concurrency ` +
            `group ${suppliedGroup} indirectly (#348: GitHub never reports ` +
            'concurrency-group membership for workflow_dispatch runs). No ' +
            'other in-progress agent-router.yml run currently reports ' +
            'holding it.',
        );
      }
      return result;
    } catch (error) {
      const canRetry = error.retryable === true && attempt < maxAttempts;
      if (!canRetry) {
        if (attempt > 1) {
          error.message = `${error.message} (after ${attempt} attempts)`;
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

async function findSupersedingRouterRun(api, task, runId) {
  const expected = brokerConcurrencyGroup(task);
  const root = repositoryPath(task);
  const data = await api.requestOk(
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
        const response = await api.requestOk(
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

async function listAll(api, path) {
  const all = [];
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
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runNext() {
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
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) {
    workers.push(runNext());
  }
  await Promise.all(workers);
  return results;
}

// The three `agent:*` labels dispatch-capable issues/PRs carry (normalize.mjs
// owns the authoritative AGENT_LABELS map keyed the other direction; this is
// a small, stable literal duplication rather than a new cross-module export
// for three constants). GitHub's issues-list-by-label filter is an AND
// across a comma-separated `labels` value, so discovering "any agent:*
// label" requires one query per label rather than one combined query --
// each is independently cheap and reliably paginated (no search-index
// replication lag), unlike a full-text search over the ledger's hidden
// marker comment, which the epic design audit (#301) explicitly rejected as
// a discovery mechanism.
const RECONCILE_DISCOVERY_LABELS = [
  'agent:claude',
  'agent:codex',
  'agent:opencode',
];

// Read-only discovery for dispatch-reconcile.yml's scan job (#305): every
// currently open issue or pull request carrying any `agent:*` label (the
// Issues API returns both; a PR item carries a `pull_request` key). Merges
// and deduplicates by issue number across the per-label queries so an issue
// with (invalidly) more than one agent:* label is still only scanned once.
//
// Cost: up to 3 paginated `state=open&labels=agent:<pipeline>` requests per
// scan (almost always a single page each at this repo's scale -- a healthy
// dispatch backlog is a handful of issues, not hundreds), well inside the
// 1,000 requests/hour GITHUB_TOKEN budget even at a 30-minute cadence,
// before adding one workflow_dispatch call per discovered candidate (see
// dispatchReconcileScan in main.mjs).
async function listOpenAgentLabeledIssues(api, task) {
  const root = repositoryPath(task);
  const byNumber = new Map();
  for (const label of RECONCILE_DISCOVERY_LABELS) {
    const items = await listAll(
      api,
      `${root}/issues?state=open&labels=${encodeURIComponent(label)}`,
    );
    for (const item of items) {
      if (Number.isSafeInteger(item?.number)) byNumber.set(item.number, item);
    }
  }
  return [...byNumber.values()].sort(
    (left, right) => left.number - right.number,
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
async function listOpenIssuesAssignedTo(api, task, login) {
  if (!login) return [];
  const root = repositoryPath(task);
  return listAll(
    api,
    `${root}/issues?state=open&assignee=${encodeURIComponent(login)}`,
  );
}

async function loadLedger(
  api,
  task,
  workflowIdentity = 'github-actions[bot]',
  { createIfMissing = true } = {},
) {
  const root = repositoryPath(task);
  const comments = await listAll(api, `${root}/issues/${task.issue}/comments`);
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
  const comment = await api.requestOk(`${root}/issues/${task.issue}/comments`, {
    method: 'POST',
    body: { body: renderLedgerComment(ledger) },
  });
  if (!Number.isSafeInteger(comment?.id)) {
    throw new Error('GitHub did not return the created ledger comment ID');
  }
  return { comment, ledger, created: true, existingComments: comments };
}

async function saveLedger(api, loaded) {
  const root = repositoryPath(loaded.ledger.task);
  const comment = await api.requestOk(
    `${root}/issues/comments/${loaded.comment.id}`,
    {
      method: 'PATCH',
      body: { body: renderLedgerComment(loaded.ledger) },
    },
  );
  loaded.comment = comment;
  return loaded;
}

async function pinLedgerWhenUnoccupied(api, loaded, isPullRequest) {
  if (!loaded.created || isPullRequest)
    return { pinned: false, reason: 'ineligible' };
  if (loaded.existingComments.some((comment) => comment.pin)) {
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
      reason: `best-effort-failed:${error.status ?? 'transport'}`,
    };
  }
}

function workerWorkflow(pipeline) {
  const workflow = {
    claude: 'claude.yml',
    codex: 'codex.yml',
    opencode: 'opencode.yml',
    // #307's no-op production canary pipeline -- see broker.mjs's PIPELINES
    // comment and normalize.mjs's `kind: 'canary'` branch for why this is
    // the only worker that pipeline can ever resolve to.
    canary: 'agent-dispatch-canary.yml',
  }[pipeline];
  if (!workflow) throw new Error(`Unsupported worker pipeline: ${pipeline}`);
  return workflow;
}

function validateDispatchResponse(response, task) {
  if (response.status !== 200) {
    throw new GitHubApiError(
      `Workflow dispatch returned HTTP ${response.status}`,
      response.status,
      response.data,
    );
  }
  const runId = response.data?.workflow_run_id;
  const runUrl = response.data?.run_url;
  const htmlUrl = response.data?.html_url;
  const { owner, repo } = splitRepository(task.repository);
  const expectedRunUrl = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}`;
  const expectedHtmlUrl = `https://github.com/${owner}/${repo}/actions/runs/${runId}`;
  if (
    !Number.isSafeInteger(runId) ||
    runId <= 0 ||
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
  return { runId, runUrl, htmlUrl };
}

// Shared by main.mjs's completionCallback/dispatchReconcileScan and
// run-dispatch-canary/run.mjs's dispatchRouterCanary: every caller posts
// the same workflow_dispatch shape at this repo's own agent-router.yml
// (ref: 'main', a caller-supplied `inputs` object naming the `kind`) and
// then validates the same response contract via validateDispatchResponse.
// Only the `inputs` payload differs per caller.
async function dispatchRouterEvent(api, task, inputs) {
  const response = await api.request(
    `${repositoryPath(task)}/actions/workflows/agent-router.yml/dispatches`,
    {
      method: 'POST',
      body: { ref: 'main', inputs },
    },
  );
  return validateDispatchResponse(response, task);
}

async function dispatchWorker(api, generation, task) {
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
          broker_dispatch_token: generation.attempt.token,
        },
      },
    },
  );
  return { ...validateDispatchResponse(response, task), workflow };
}

async function getWorkflowRun(api, task, runId) {
  return api.requestOk(`${repositoryPath(task)}/actions/runs/${runId}`);
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

function createdAtOrAfterFilter(generation) {
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

async function findRunsForGeneration(api, task, generation) {
  const workflow = workerWorkflow(generation.pipeline);
  const root = repositoryPath(task);
  const marker = `[dispatch:g${generation.generation}:${generation.intentId}]`;
  const createdFilter = createdAtOrAfterFilter(generation);
  const matches = [];
  for (let page = 1; page <= FIND_RUNS_FOR_GENERATION_MAX_PAGES; page += 1) {
    const data = await api.requestOk(
      `${root}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch${createdFilter}&per_page=100&page=${page}`,
    );
    const runs = data.workflow_runs ?? [];
    for (const run of runs) {
      if (run.display_title?.includes(marker)) matches.push(run);
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
async function removeIssueLabel(api, task, label) {
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

async function failClosed(api, task, maintainer, message) {
  const root = repositoryPath(task);
  await api.requestOk(`${root}/issues/${task.issue}/labels`, {
    method: 'POST',
    body: { labels: ['status:needs-human'] },
  });
  if (maintainer) {
    await api.requestOk(`${root}/issues/${task.issue}/assignees`, {
      method: 'POST',
      body: { assignees: [maintainer] },
    });
  }
  throw new Error(message);
}

async function issueHasLabel(api, task, label) {
  const issue = await api.requestOk(
    `${repositoryPath(task)}/issues/${task.issue}`,
  );
  return (issue.labels ?? []).some(
    (entry) => (typeof entry === 'string' ? entry : entry.name) === label,
  );
}

async function issueHasAssignee(api, task, login) {
  const issue = await api.requestOk(
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
async function mutateOrVerify(mutate, verify) {
  try {
    await mutate();
  } catch (error) {
    if (!(await verify())) throw error;
  }
}

async function ensureNeedsHumanParked(api, task, maintainer) {
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
  API_VERSION,
  brokerConcurrencyGroup,
  BrokerConcurrencyMismatchError,
  CONCURRENCY_VERIFY_MAX_ATTEMPTS,
  CONCURRENCY_VERIFY_RETRY_DELAY_MS,
  createGitHubApi,
  dispatchRouterEvent,
  dispatchWorker,
  ensureNeedsHumanParked,
  failClosed,
  findConflictingRouterRun,
  findRunsForGeneration,
  findSupersedingRouterRun,
  getWorkflowRun,
  GitHubApiError,
  listAll,
  listOpenAgentLabeledIssues,
  listOpenIssuesAssignedTo,
  loadLedger,
  mapWithConcurrency,
  pinLedgerWhenUnoccupied,
  removeIssueLabel,
  repositoryPath,
  saveLedger,
  splitRepository,
  validateBrokerConcurrencyResponse,
  validateDispatchResponse,
  verifyBrokerConcurrency,
  workerWorkflow,
};
