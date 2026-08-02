// Production dispatch-broker canary lifecycle (#307, final child of epic
// #301). Reuses the SAME hardened GitHub API client and ledger parser the
// broker itself uses (dispatch-broker/github-api.mjs, dispatch-broker/
// broker.mjs) rather than a parallel implementation: create a dedicated,
// clearly-marked issue -> dispatch it through agent-router.yml's real
// `kind: 'canary'` broker path -> poll the real ledger comment to a
// terminal state -> clean up (close on success, park status:needs-human
// with evidence on failure, mirroring github-api.mjs's own failClosed/
// ensureNeedsHumanParked convention).
//
// Called by two workflows sharing this one action:
//   - dispatch-canary.yml: hourly + workflow_dispatch, no live-url probe.
//   - post-deploy-smoke.yml: chained off "Deploy console" completing,
//     supplies live-url so a broken deployed revision is caught before
//     (and instead of) exercising the broker.
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  LEDGER_MARKER,
  parseLedgerComment,
} from '../dispatch-broker/broker.mjs';
import {
  createGitHubApi,
  ensureNeedsHumanParked,
  listAll,
  repositoryPath,
  validateDispatchResponse,
} from '../dispatch-broker/github-api.mjs';

const CANARY_MARKER = '<!-- agent-lcars:dispatch-canary:v1 -->';
const CANARY_TITLE_PREFIX = '[dispatch-canary]';
const LIVE_URL_PROBE_MAX_ATTEMPTS = 5;
const LIVE_URL_PROBE_RETRY_DELAY_MS = 15_000;
const LEDGER_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const LEDGER_POLL_INTERVAL_MS = 10_000;
const TERMINAL_REJECTED_STATES = new Set([
  'dispatch-rejected',
  'superseded',
  'superseded-by-close',
]);
// A same-process try/catch (parkCanaryFailure in runDispatchCanary's own
// catch block) cannot survive the orchestrator's own job being killed --
// a job-level `timeout-minutes` or an operator/workflow cancellation tears
// down the whole runner process, including anything still awaiting inside
// pollCanaryLedger, before that catch block ever runs. Neither
// dispatch-canary.yml (timeout-minutes: 15) nor post-deploy-smoke.yml
// (timeout-minutes: 15) has a separate cleanup job to survive that -- this
// canary is a small, self-contained workflow, not embedded in
// deploy-console.yml's own job, so there is no natural place to split
// "verify" and "cleanup" into two jobs the way the epic design audit (#301)
// recommends for a job that also owns the production deploy itself.
//
// sweepStaleCanaries below is the deterministic-rediscovery backstop that
// design explicitly calls for instead: dispatch-canary.yml runs it, hourly,
// unconditionally, before creating its own new canary, so a killed run's
// issue is found and closed/parked within one hour at the very most --
// still "automatically cleaned up" per #307's acceptance bar, just not
// synchronously. The threshold is comfortably beyond
// LEDGER_POLL_TIMEOUT_MS (10 min) plus both orchestrators' own
// timeout-minutes: 15 job budget and ordinary API/network overhead: an
// open, marked canary issue older than this can only mean its own
// orchestrator run never reached its own cleanup path.
const STALE_CANARY_AGE_MS = 30 * 60 * 1000;

function env(name, required = true) {
  const value = process.env[name];
  if (required && !value) throw new Error(`${name} is required`);
  return value ?? '';
}

async function output(name, value) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  await fs.appendFile(path, `${name}=${value}\n`, 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeLiveUrl(
  url,
  {
    fetchImpl = fetch,
    maxAttempts = LIVE_URL_PROBE_MAX_ATTEMPTS,
    retryDelayMs = LIVE_URL_PROBE_RETRY_DELAY_MS,
    sleepImpl = sleep,
  } = {},
) {
  let lastReason = 'never attempted';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) return { ok: true, status: response.status };
      lastReason = `HTTP ${response.status}`;
    } catch (error) {
      lastReason = error.message;
    }
    if (attempt < maxAttempts) await sleepImpl(retryDelayMs);
  }
  return { ok: false, reason: lastReason };
}

function issueBody({ source, runUrl, deployRunUrl }) {
  const lines = [
    'Automated production canary for the dispatch broker (#307). Created, ' +
      'dispatched through the real dispatch broker and a dedicated no-op ' +
      'worker (`.github/workflows/agent-dispatch-canary.yml`), verified, ' +
      'and closed automatically. It never invokes a paid model, GCP ' +
      'credential, or self-hosted/privileged runner -- see ' +
      'docs/e2e-security-boundary.md.',
    '',
    `Source: ${source}`,
    `Orchestrator run: ${runUrl}`,
  ];
  if (deployRunUrl) lines.push(`Deploy run: ${deployRunUrl}`);
  lines.push('', CANARY_MARKER);
  return lines.join('\n');
}

async function createCanaryIssue(api, repository, context) {
  const root = repositoryPath({ repository });
  const timestamp = new Date().toISOString();
  const issue = await api.requestOk(`${root}/issues`, {
    method: 'POST',
    body: {
      title: `[dispatch-canary] Production dispatch broker canary — ${timestamp}`,
      body: issueBody(context),
    },
  });
  if (!Number.isSafeInteger(issue?.number)) {
    throw new Error('GitHub did not return the created canary issue number');
  }
  return issue;
}

async function dispatchRouterCanary(api, repository, issueNumber) {
  const root = repositoryPath({ repository });
  const response = await api.request(
    `${root}/actions/workflows/agent-router.yml/dispatches`,
    {
      method: 'POST',
      body: {
        ref: 'main',
        inputs: { kind: 'canary', issue: String(issueNumber) },
      },
    },
  );
  validateDispatchResponse(response, { repository });
}

// The canary issue is a public GitHub issue: any user (or a compromised
// third-party integration) can comment on it before the real broker ever
// writes its own ledger comment, including a fabricated-but-parseable
// comment containing LEDGER_MARKER and a completed/successful canary
// generation. Trusting "the first marker-bearing comment" the way an
// earlier version of this file did would let that forged comment make the
// orchestrator close the issue and report a false green even if the real
// broker never ran or genuinely failed.
//
// This is exactly the trust boundary dispatch-broker/github-api.mjs's own
// loadLedger already defends for every other ledger read in this
// codebase: exactly one marker-bearing comment is ever trusted (more than
// one is treated as an anomaly and fails closed, never "pick the first"),
// and that one comment must be authored by the same workflow identity
// (REST-shaped `github-actions[bot]` login + `type: 'Bot'` -- see
// docs/bot-identity-formats.md) every ledger write in this repo already
// uses. Do not weaken or duplicate that rule here.
const LEDGER_WORKFLOW_IDENTITY = 'github-actions[bot]';

// Shared by the live poll below and sweepStaleCanaries' one-shot read: find
// this issue's ledger comment (if any) and the 'canary'-pipeline generation
// within it. Returns undefined when no ledger comment exists yet, or none
// of its generations is the canary pipeline. Throws (never silently
// ignores) when more than one marker-bearing comment exists, or the sole
// candidate was not authored by the trusted workflow identity -- see
// LEDGER_WORKFLOW_IDENTITY above.
function findCanaryGeneration(comments, task) {
  const candidates = comments.filter((comment) =>
    comment.body?.includes(LEDGER_MARKER),
  );
  if (candidates.length > 1) {
    throw new Error('Duplicate dispatch ledger comments');
  }
  if (candidates.length === 0) return undefined;
  const [ledgerComment] = candidates;
  if (
    ledgerComment.user?.login !== LEDGER_WORKFLOW_IDENTITY ||
    ledgerComment.user?.type !== 'Bot'
  ) {
    throw new Error('Dispatch ledger author is not the workflow identity');
  }
  const ledger = parseLedgerComment(ledgerComment.body, task);
  const generation = ledger.generations.find(
    (candidate) => candidate.pipeline === 'canary',
  );
  return generation ? { ledger, generation } : undefined;
}

async function pollCanaryLedger(
  api,
  task,
  {
    timeoutMs = LEDGER_POLL_TIMEOUT_MS,
    intervalMs = LEDGER_POLL_INTERVAL_MS,
    sleepImpl = sleep,
    now = () => Date.now(),
  } = {},
) {
  const root = repositoryPath(task);
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const comments = await api.requestOk(
      `${root}/issues/${task.issue}/comments`,
    );
    const found = findCanaryGeneration(comments, task);
    if (found?.generation.state === 'completed') {
      return found;
    }
    if (found && TERMINAL_REJECTED_STATES.has(found.generation.state)) {
      return { ...found, rejected: true };
    }
    await sleepImpl(intervalMs);
  }
  throw new Error(
    'Timed out waiting for the canary dispatch ledger to reach a terminal state',
  );
}

async function closeCanaryIssue(api, task, { generation, runUrl }) {
  const root = repositoryPath(task);
  await api.requestOk(`${root}/issues/${task.issue}/comments`, {
    method: 'POST',
    body: {
      body:
        `✅ Canary verified: dispatch broker generation g${generation.generation} ` +
        `completed successfully (worker run ${generation.attempt?.htmlUrl ?? 'n/a'}). ` +
        `Closing automatically. Orchestrator run: ${runUrl}`,
    },
  });
  await api.requestOk(`${root}/issues/${task.issue}`, {
    method: 'PATCH',
    body: { state: 'closed', state_reason: 'completed' },
  });
}

// Mirrors github-api.mjs's failClosed/ensureNeedsHumanParked convention: a
// failure is never a silent log line. The issue stays OPEN with evidence
// (not auto-closed) so a maintainer has something concrete to act on --
// cleanup only ever closes a canary that actually verified successfully.
async function parkCanaryFailure(api, task, maintainer, reason) {
  const root = repositoryPath(task);
  try {
    await api.requestOk(`${root}/issues/${task.issue}/comments`, {
      method: 'POST',
      body: {
        body:
          `🚨 Canary failed: ${reason}\n\nThis issue is left open with ` +
          'evidence instead of being auto-closed. A maintainer must ' +
          'investigate.',
      },
    });
  } catch {
    // Best-effort: the label/assignee park below is the loud signal that
    // actually matters; a lost diagnostic comment must not mask it.
  }
  await ensureNeedsHumanParked(api, task, maintainer);
}

// Deterministic-rediscovery backstop for an orchestrator run that never
// reached its own runDispatchCanary catch block (job timeout, workflow
// cancellation, runner loss -- see STALE_CANARY_AGE_MS above). Lists every
// currently open issue (a single paginated, fully-consistent listing --
// deliberately not the Search API: github-api.mjs's own discovery comment
// notes the epic design audit explicitly rejected full-text/marker search
// as a discovery mechanism because of search-index replication lag),
// filters to this canary's own title prefix plus marker, and for every
// candidate older than the threshold that is not already parked:
//   - closes it (with evidence) if its ledger already shows a successful
//     canary completion -- the orchestrator verified success but never got
//     to call closeCanaryIssue itself;
//   - otherwise parks status:needs-human, identical to parkCanaryFailure.
// A per-issue failure is recorded and reported but never blocks sweeping
// the remaining candidates.
async function sweepStaleCanaries(
  api,
  repository,
  repositoryId,
  maintainer,
  { now = () => Date.now(), ageMs = STALE_CANARY_AGE_MS } = {},
) {
  const root = repositoryPath({ repository });
  const openIssues = await listAll(api, `${root}/issues?state=open`);
  const stale = openIssues.filter((issue) => {
    if (issue.pull_request) return false;
    if (!issue.title?.startsWith(CANARY_TITLE_PREFIX)) return false;
    if (!issue.body?.includes(CANARY_MARKER)) return false;
    const ageMsActual = now() - Date.parse(issue.created_at);
    return Number.isFinite(ageMsActual) && ageMsActual >= ageMs;
  });

  const swept = [];
  for (const issue of stale) {
    const alreadyParked = (issue.labels ?? []).some(
      (label) =>
        (typeof label === 'string' ? label : label.name) ===
        'status:needs-human',
    );
    if (alreadyParked) continue;

    const task = { repositoryId, repository, issue: issue.number };
    try {
      const comments = await api.requestOk(
        `${root}/issues/${issue.number}/comments`,
      );
      const found = findCanaryGeneration(comments, task);
      const conclusion = found?.generation?.attempt?.conclusion;
      if (found?.generation.state === 'completed' && conclusion === 'success') {
        await api.requestOk(`${root}/issues/${issue.number}/comments`, {
          method: 'POST',
          body: {
            body:
              "🧹 Swept by the scheduled canary janitor: this canary's own " +
              'orchestrator run never returned (job timeout or workflow ' +
              'cancellation), but its dispatch broker ledger shows ' +
              `generation g${found.generation.generation} completed ` +
              'successfully. Closing.',
          },
        });
        await api.requestOk(`${root}/issues/${issue.number}`, {
          method: 'PATCH',
          body: { state: 'closed', state_reason: 'completed' },
        });
        swept.push({ issue: issue.number, outcome: 'closed' });
      } else {
        await parkCanaryFailure(
          api,
          task,
          maintainer,
          "Swept by the scheduled canary janitor: this canary's own " +
            'orchestrator run never returned (job timeout or workflow ' +
            'cancellation) and its dispatch broker ledger never reached ' +
            'a successful terminal state.',
        );
        swept.push({ issue: issue.number, outcome: 'parked' });
      }
    } catch (error) {
      swept.push({
        issue: issue.number,
        outcome: 'error',
        error: error.message,
      });
    }
  }
  return swept;
}

async function runDispatchCanary({
  api,
  repository,
  repositoryId,
  maintainer,
  source,
  runUrl,
  deployRunUrl,
  liveUrl,
  probeOptions = {},
  pollOptions = {},
}) {
  if (liveUrl) {
    const probe = await probeLiveUrl(liveUrl, probeOptions);
    if (!probe.ok) {
      // No canary issue exists yet to attach evidence to; create one so
      // this failure gets the same anchored, needs-human-parked audit
      // trail as every other broker failure instead of a silent log line.
      // A broken deploy is not the broker's fault, so the canary dispatch
      // itself is deliberately skipped -- it would only be misleading.
      const issue = await createCanaryIssue(api, repository, {
        source,
        runUrl,
        deployRunUrl,
      });
      const task = { repositoryId, repository, issue: issue.number };
      const reason = `Live URL probe failed for ${liveUrl}: ${probe.reason}`;
      await parkCanaryFailure(api, task, maintainer, reason);
      throw new Error(`Post-deploy smoke: ${reason}`);
    }
  }

  const issue = await createCanaryIssue(api, repository, {
    source,
    runUrl,
    deployRunUrl,
  });
  const task = { repositoryId, repository, issue: issue.number };

  try {
    await dispatchRouterCanary(api, repository, issue.number);
    const result = await pollCanaryLedger(api, task, pollOptions);
    const conclusion = result.generation?.attempt?.conclusion;
    if (result.rejected || conclusion !== 'success') {
      throw new Error(
        `Canary dispatch generation g${result.generation?.generation} ended ` +
          `in state '${result.generation?.state}'` +
          (conclusion ? ` with conclusion '${conclusion}'` : '') +
          '.',
      );
    }
    await closeCanaryIssue(api, task, {
      generation: result.generation,
      runUrl,
    });
    return { issue: issue.number };
  } catch (error) {
    await parkCanaryFailure(api, task, maintainer, error.message);
    throw error;
  }
}

async function main() {
  const api = createGitHubApi({ token: env('GITHUB_TOKEN') });
  const repository = env('GITHUB_REPOSITORY');
  const repositoryId = Number(env('GITHUB_REPOSITORY_ID'));
  const maintainer = env('MAINTAINER_LOGIN');
  const source = env('CANARY_SOURCE');
  const runUrl = `${env('GITHUB_SERVER_URL')}/${repository}/actions/runs/${env('GITHUB_RUN_ID')}`;
  const deployRunUrl = env('DEPLOY_RUN_URL', false);
  const liveUrl = env('LIVE_URL', false);
  const sweepStale = env('SWEEP_STALE', false) === 'true';

  // The sweep is entirely best-effort with respect to the primary canary
  // below: a listing failure (e.g. a transient GitHub API error) is caught
  // here, not just a per-issue failure inside sweepStaleCanaries itself, so
  // an unhealthy janitor pass can never prevent this run's own primary
  // canary from creating, dispatching, and verifying. Any sweep problem is
  // still surfaced loudly -- just after the primary result, never instead
  // of it.
  let sweepError;
  if (sweepStale) {
    try {
      const swept = await sweepStaleCanaries(
        api,
        repository,
        repositoryId,
        maintainer,
      );
      const sweepFailures = swept.filter((entry) => entry.outcome === 'error');
      for (const entry of swept) {
        const marker = entry.outcome === 'error' ? '::error::' : '::notice::';
        const detail = entry.error ? ` (${entry.error})` : '';
        console.log(
          `${marker}canary janitor: #${entry.issue} ${entry.outcome}${detail}`,
        );
      }
      if (sweepFailures.length > 0) {
        sweepError = new Error(
          `Canary janitor sweep failed for ${sweepFailures.length} issue(s): ` +
            sweepFailures.map((entry) => `#${entry.issue}`).join(', '),
        );
      }
    } catch (error) {
      console.log(`::error::canary janitor sweep aborted: ${error.message}`);
      sweepError = error;
    }
  }

  const result = await runDispatchCanary({
    api,
    repository,
    repositoryId,
    maintainer,
    source,
    runUrl,
    deployRunUrl,
    liveUrl,
  });
  await output('issue', String(result.issue));

  // The primary canary lifecycle above always gets to run and report its
  // own outcome first; a sweep failure still fails this job loud afterward
  // rather than silently -- cleanup failure is itself a red required job,
  // same convention as the primary canary's own parkCanaryFailure path.
  if (sweepError) throw sweepError;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}

export {
  closeCanaryIssue,
  createCanaryIssue,
  dispatchRouterCanary,
  issueBody,
  parkCanaryFailure,
  pollCanaryLedger,
  probeLiveUrl,
  runDispatchCanary,
  STALE_CANARY_AGE_MS,
  sweepStaleCanaries,
};
