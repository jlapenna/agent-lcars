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
  repositoryPath,
  validateDispatchResponse,
} from '../dispatch-broker/github-api.mjs';

const CANARY_MARKER = '<!-- agent-lcars:dispatch-canary:v1 -->';
const LIVE_URL_PROBE_MAX_ATTEMPTS = 5;
const LIVE_URL_PROBE_RETRY_DELAY_MS = 15_000;
const LEDGER_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const LEDGER_POLL_INTERVAL_MS = 10_000;
const TERMINAL_REJECTED_STATES = new Set([
  'dispatch-rejected',
  'superseded',
  'superseded-by-close',
]);

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
    const ledgerComment = comments.find((comment) =>
      comment.body?.includes(LEDGER_MARKER),
    );
    if (ledgerComment) {
      const ledger = parseLedgerComment(ledgerComment.body, task);
      const generation = ledger.generations.find(
        (candidate) => candidate.pipeline === 'canary',
      );
      if (generation?.state === 'completed') {
        return { ledger, generation };
      }
      if (generation && TERMINAL_REJECTED_STATES.has(generation.state)) {
        return { ledger, generation, rejected: true };
      }
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
};
