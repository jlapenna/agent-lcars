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

function validateBrokerConcurrencyResponse(data, task, runId, suppliedGroup) {
  const expected = brokerConcurrencyGroup(task);
  if (suppliedGroup !== expected) {
    // A config mismatch between the run's own group and its TaskRef is
    // never explained by listing lag — it means the two disagree right now
    // and will keep disagreeing on every retry.
    throw new BrokerConcurrencyMismatchError(
      'Broker concurrency output does not match its TaskRef',
    );
  }
  if (
    !Number.isSafeInteger(runId) ||
    runId <= 0 ||
    !Array.isArray(data?.concurrency_groups)
  ) {
    throw new BrokerConcurrencyMismatchError(
      'Malformed broker concurrency-group response',
    );
  }
  const matching = data.concurrency_groups.filter(
    (group) =>
      typeof group?.group_name === 'string' &&
      group.group_name.toLowerCase() === expected.toLowerCase(),
  );
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
  const path = `${repositoryPath(task)}/actions/runs/${runId}/concurrency_groups?per_page=100`;
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
  const uninspectedIds = [];
  for (const candidate of candidates) {
    let response;
    try {
      response = await api.requestOk(
        `${root}/actions/runs/${candidate.id}/concurrency_groups?per_page=100`,
      );
    } catch {
      uninspectedIds.push(candidate.id);
      continue;
    }
    const holdsExpectedGroup = (response?.concurrency_groups ?? []).some(
      (group) =>
        typeof group?.group_name === 'string' &&
        group.group_name.toLowerCase() === expected.toLowerCase(),
    );
    // A definite conflict is a stronger signal than "inconclusive" and
    // wins immediately, even if an earlier candidate was uninspectable.
    if (holdsExpectedGroup) return candidate;
  }
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
  if (suppliedGroup !== expected) {
    // Same config-mismatch defense as the event-triggered path: never
    // explained by eventual consistency, so never retryable.
    throw new BrokerConcurrencyMismatchError(
      'Broker concurrency output does not match its TaskRef',
    );
  }
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
  for (const candidate of candidates) {
    let response;
    try {
      response = await api.requestOk(
        `${root}/actions/runs/${candidate.id}/concurrency_groups?per_page=100`,
      );
    } catch {
      // An unrelated fetch failure for one candidate doesn't disprove
      // eviction; keep looking rather than failing the whole check.
      continue;
    }
    const holdsExpectedGroup = (response?.concurrency_groups ?? []).some(
      (group) =>
        typeof group?.group_name === 'string' &&
        group.group_name.toLowerCase() === expected.toLowerCase(),
    );
    if (holdsExpectedGroup) return candidate;
  }
  return undefined;
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

async function findRunsForGeneration(api, task, generation) {
  const workflow = workerWorkflow(generation.pipeline);
  const data = await api.requestOk(
    `${repositoryPath(task)}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&per_page=100`,
  );
  const marker = `[dispatch:g${generation.generation}:${generation.intentId}]`;
  return (data.workflow_runs ?? []).filter((run) =>
    run.display_title?.includes(marker),
  );
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

export {
  API_VERSION,
  brokerConcurrencyGroup,
  BrokerConcurrencyMismatchError,
  CONCURRENCY_VERIFY_MAX_ATTEMPTS,
  CONCURRENCY_VERIFY_RETRY_DELAY_MS,
  createGitHubApi,
  dispatchWorker,
  failClosed,
  findConflictingRouterRun,
  findRunsForGeneration,
  findSupersedingRouterRun,
  getWorkflowRun,
  GitHubApiError,
  listAll,
  loadLedger,
  pinLedgerWhenUnoccupied,
  repositoryPath,
  saveLedger,
  splitRepository,
  validateBrokerConcurrencyResponse,
  validateDispatchResponse,
  verifyBrokerConcurrency,
  workerWorkflow,
};
