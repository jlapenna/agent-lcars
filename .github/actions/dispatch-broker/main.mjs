import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  acceptIntent,
  ACTIVE_STATES,
  addAnomaly,
  applyAnchorControl,
  awaitTerminal,
  beginDispatch,
  bindRun,
  completeRun,
  markDispatchRejected,
  markDispatchUnknown,
  observeCompletion,
  recordControlEvidence,
  verifyPreflight,
} from './broker.mjs';
import {
  createGitHubApi,
  dispatchWorker,
  failClosed,
  findRunsForGeneration,
  findSupersedingRouterRun,
  getWorkflowRun,
  GitHubApiError,
  loadLedger,
  pinLedgerWhenUnoccupied,
  repositoryPath,
  saveLedger,
  validateDispatchResponse,
  verifyBrokerConcurrency,
  workerWorkflow,
} from './github-api.mjs';
import { normalizeEvent } from './normalize.mjs';

function env(name, required = true) {
  const value = process.env[name];
  if (required && !value) throw new Error(`${name} is required`);
  return value ?? '';
}

function output(name, value) {
  const path = env('GITHUB_OUTPUT');
  return fs.appendFile(path, `${name}=${value}\n`, 'utf8');
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decode(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function api() {
  return createGitHubApi({ token: env('GITHUB_TOKEN') });
}

function contextFor(event, inputs) {
  return {
    repository: event.repository?.full_name ?? env('GITHUB_REPOSITORY'),
    repositoryId: event.repository?.id ?? Number(env('GITHUB_REPOSITORY_ID')),
    issue: inputs.issue,
    runId: Number(env('GITHUB_RUN_ID')),
    actor: env('GITHUB_ACTOR'),
    now: new Date().toISOString(),
  };
}

async function normalize() {
  const event = JSON.parse(await fs.readFile(env('GITHUB_EVENT_PATH'), 'utf8'));
  const eventName = env('GITHUB_EVENT_NAME');
  const inputs = event.inputs ?? {};
  const context = contextFor(event, inputs);
  const client = api();
  if (eventName === 'workflow_dispatch') {
    const issue = await client.requestOk(
      `${repositoryPath({ repository: context.repository })}/issues/${inputs.issue}`,
    );
    event.issue = issue;
  }
  let timeline = [];
  if (
    eventName === 'issues' &&
    ['labeled', 'unlabeled', 'closed', 'reopened'].includes(event.action)
  ) {
    timeline = await client.requestOk(
      `${repositoryPath({ repository: context.repository })}/issues/${event.issue.number}/timeline?per_page=100`,
    );
  }
  const normalized = normalizeEvent({
    eventName,
    event,
    inputs,
    context,
    timeline,
    maintainer: env('MAINTAINER_LOGIN'),
  });
  const issue =
    normalized.task?.issue ?? event.issue?.number ?? Number(inputs.issue);
  await output('eligible', normalized.kind === 'ignored' ? 'false' : 'true');
  await output('issue', String(issue || ''));
  await output('repository-id', String(context.repositoryId));
  await output(
    'group',
    issue
      ? `agent-lcars-dispatch-v1-${context.repositoryId}-${issue}`.toLowerCase()
      : '',
  );
  await output('payload', encode(normalized));
  await output('reason', normalized.reason ?? '');
}

function activeGeneration(ledger) {
  return ledger.generations.find((generation) =>
    ACTIVE_STATES.has(generation.state),
  );
}

function assertWorkerRun(run, task, generation, expectedWorkflow) {
  const marker = `[dispatch:g${generation.generation}:${generation.intentId}]`;
  if (
    run.repository?.id !== task.repositoryId ||
    run.event !== 'workflow_dispatch' ||
    run.path !== `.github/workflows/${expectedWorkflow}` ||
    !run.display_title?.includes(marker)
  ) {
    throw new Error('Worker run identity does not match its ledger binding');
  }
}

async function reconcileActive(client, loaded) {
  let active = activeGeneration(loaded.ledger);
  if (!active) return;
  const expectedWorkflow = workerWorkflow(active.pipeline);
  const matchingRuns = await findRunsForGeneration(
    client,
    loaded.ledger.task,
    active,
  );
  if (matchingRuns.length > 1) {
    addAnomaly(loaded.ledger, 'duplicate-attempt', {
      generation: active.generation,
      runIds: matchingRuns.map((run) => run.id),
    });
    await saveLedger(client, loaded);
    throw new Error('Multiple worker runs match one dispatch generation');
  }
  if (
    ['dispatching', 'dispatch-unknown'].includes(active.state) &&
    matchingRuns.length === 1
  ) {
    const run = matchingRuns[0];
    assertWorkerRun(run, loaded.ledger.task, active, expectedWorkflow);
    bindRun(loaded.ledger, active.generation, {
      runId: run.id,
      runUrl: run.url,
      htmlUrl: run.html_url,
      workflow: expectedWorkflow,
    });
    await saveLedger(client, loaded);
    active = activeGeneration(loaded.ledger);
  }
  if (!active?.attempt?.runId) return;
  const run = await getWorkflowRun(
    client,
    loaded.ledger.task,
    active.attempt.runId,
  );
  assertWorkerRun(run, loaded.ledger.task, active, expectedWorkflow);
  if (run.status === 'completed') {
    completeRun(loaded.ledger, active.generation, {
      runId: run.id,
      status: run.status,
      conclusion: run.conclusion,
      completedAt: run.updated_at,
    });
    await saveLedger(client, loaded);
  }
}

function isDefiniteDispatchRejection(error) {
  return (
    error instanceof GitHubApiError &&
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 409, 429].includes(error.status)
  );
}

async function dispatchAccepted(client, loaded) {
  while (!loaded.ledger.control.closed) {
    const generation = loaded.ledger.generations.find(
      (candidate) => candidate.state === 'accepted',
    );
    if (!generation || activeGeneration(loaded.ledger)) return;
    beginDispatch(
      loaded.ledger,
      generation.generation,
      crypto.randomBytes(24).toString('base64url'),
    );
    await saveLedger(client, loaded);
    try {
      const binding = await dispatchWorker(
        client,
        generation,
        loaded.ledger.task,
      );
      bindRun(loaded.ledger, generation.generation, binding);
      await saveLedger(client, loaded);
      return;
    } catch (error) {
      if (isDefiniteDispatchRejection(error)) {
        markDispatchRejected(
          loaded.ledger,
          generation.generation,
          `HTTP ${error.status}`,
        );
        await saveLedger(client, loaded);
        throw error;
      }
      markDispatchUnknown(
        loaded.ledger,
        generation.generation,
        error.message.slice(0, 300),
      );
      await saveLedger(client, loaded);
      return;
    }
  }
}

function completionMatches(generation, normalized, run) {
  return (
    generation &&
    generation.intentId === normalized.intentId &&
    generation.attempt?.token === normalized.token &&
    generation.attempt?.runId === normalized.workerRunId &&
    run.id === normalized.workerRunId
  );
}

async function handleCompletion(client, loaded, normalized) {
  const generation = loaded.ledger.generations.find(
    (candidate) => candidate.generation === normalized.generation,
  );
  let run = await getWorkflowRun(
    client,
    normalized.task,
    normalized.workerRunId,
  );
  const expectedWorkflow = workerWorkflow(generation?.pipeline);
  assertWorkerRun(run, normalized.task, generation, expectedWorkflow);
  if (
    normalized.workflow !== expectedWorkflow ||
    !completionMatches(generation, normalized, run)
  ) {
    throw new Error('Completion callback does not match the bound worker run');
  }
  const evidence = recordControlEvidence(loaded.ledger, {
    sourceKind: 'completion',
    sourceId: normalized.sourceId,
    transportRunId: normalized.transportRunId,
    occurredAt: new Date().toISOString(),
    runId: normalized.workerRunId,
    authorization: { observed: true, workflow: expectedWorkflow },
  });
  if (generation.state === 'completed') {
    if (evidence.outcome === 'recorded') await saveLedger(client, loaded);
    return;
  }
  if (generation.state === 'active') {
    observeCompletion(loaded.ledger, generation.generation, run.id);
  }
  await saveLedger(client, loaded);

  const deadline = Date.now() + 120_000;
  let delay = 2_000;
  while (run.status !== 'completed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 15_000);
    try {
      run = await getWorkflowRun(
        client,
        normalized.task,
        normalized.workerRunId,
      );
      assertWorkerRun(run, normalized.task, generation, expectedWorkflow);
    } catch (error) {
      if (
        error instanceof GitHubApiError &&
        (error.status === 404 || error.status >= 500)
      ) {
        continue;
      }
      throw error;
    }
  }
  if (run.status !== 'completed') {
    if (generation.state === 'completion-observed') {
      awaitTerminal(loaded.ledger, generation.generation);
      await saveLedger(client, loaded);
    }
    return;
  }
  completeRun(loaded.ledger, generation.generation, {
    runId: run.id,
    status: run.status,
    conclusion: run.conclusion,
    completedAt: run.updated_at,
  });
  await saveLedger(client, loaded);
}

function resolveTask(normalized) {
  // Every normalized kind carries a canonical TaskRef, but intents nest
  // theirs under `.intent.task` (see normalize.mjs's makeIntent) while
  // completion/anchor-control/control-evidence carry `.task` at the top
  // level. Resolve per kind so broker() reads one consistent value.
  return normalized.kind === 'intent'
    ? normalized.intent.task
    : normalized.task;
}

// Only a `retryable: true` mismatch is eligible: every other failure mode
// (config mismatch, malformed response, more than one match) is a real
// anomaly that retrying or supersession-checking cannot explain away, so
// it must keep failing red immediately (issue #344's "genuinely
// unexplained mismatch" requirement). Even for the eligible case, absence
// of a corroborating superseding run must NOT be treated as proof of
// eviction -- it just means this run's mismatch is still unexplained, so
// the caller keeps failing red.
async function wasSupersededEviction(client, task, runId, group, error) {
  if (error?.name !== 'BrokerConcurrencyMismatchError' || !error.retryable) {
    return false;
  }
  const superseding = await findSupersedingRouterRun(client, task, runId);
  if (!superseding) return false;
  console.log(
    `::notice::Broker run ${runId} (group ${group}, issue #${task.issue}) ` +
      `was evicted from its concurrency queue by newer run ${superseding.id}, ` +
      'which now reports the expected group. Treating this run as ' +
      "superseded rather than failing (#344): this run's own control " +
      'evidence for its triggering event is not recorded in the ledger -- ' +
      'the superseding run already carries the issue forward correctly.',
  );
  return true;
}

async function broker() {
  const normalized = decode(env('BROKER_PAYLOAD'));
  if (normalized.kind === 'ignored') return;
  const task = resolveTask(normalized);
  const client = api();
  const runId = Number(env('GITHUB_RUN_ID'));
  const group = env('BROKER_GROUP');
  try {
    await verifyBrokerConcurrency(client, task, runId, group);
  } catch (error) {
    if (await wasSupersededEviction(client, task, runId, group, error)) return;
    throw error;
  }
  let loaded;
  try {
    loaded = await loadLedger(client, task);
  } catch (error) {
    await failClosed(
      client,
      task,
      env('MAINTAINER_LOGIN', false),
      error.message,
    );
  }
  await pinLedgerWhenUnoccupied(
    client,
    loaded,
    env('ANCHOR_IS_PR', false) === 'true',
  );
  try {
    await reconcileActive(client, loaded);
    if (normalized.kind === 'intent') {
      acceptIntent(loaded.ledger, normalized.intent);
      await saveLedger(client, loaded);
    } else if (normalized.kind === 'anchor-control') {
      applyAnchorControl(loaded.ledger, normalized.control);
      await saveLedger(client, loaded);
    } else if (normalized.kind === 'control-evidence') {
      recordControlEvidence(loaded.ledger, normalized.evidence);
      await saveLedger(client, loaded);
    } else if (normalized.kind === 'completion') {
      await handleCompletion(client, loaded, normalized);
    } else {
      throw new Error(`Unsupported normalized event kind: ${normalized.kind}`);
    }
    await dispatchAccepted(client, loaded);
  } catch (error) {
    await failClosed(
      client,
      task,
      env('MAINTAINER_LOGIN', false),
      error.message,
    );
  }
}

async function preflight() {
  const task = {
    repositoryId: Number(env('GITHUB_REPOSITORY_ID')),
    repository: env('GITHUB_REPOSITORY'),
    issue: Number(env('BROKER_ISSUE')),
  };
  const expected = {
    task,
    generation: Number(env('BROKER_GENERATION')),
    intentId: env('BROKER_INTENT_ID'),
    token: env('BROKER_DISPATCH_TOKEN'),
    runId: Number(env('GITHUB_RUN_ID')),
  };
  const client = api();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const loaded = await loadLedger(client, task, 'github-actions[bot]', {
      createIfMissing: false,
    });
    if (loaded && verifyPreflight(loaded.ledger, expected)) {
      const generation = loaded.ledger.generations.find(
        (candidate) => candidate.generation === expected.generation,
      );
      const run = await getWorkflowRun(client, task, expected.runId);
      assertWorkerRun(
        run,
        task,
        generation,
        workerWorkflow(generation.pipeline),
      );
      await output('authorized', 'true');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('Worker preflight could not verify an exact broker binding');
}

async function completionCallback() {
  const client = api();
  const task = {
    repositoryId: Number(env('GITHUB_REPOSITORY_ID')),
    repository: env('GITHUB_REPOSITORY'),
    issue: Number(env('BROKER_ISSUE')),
  };
  const completionPayload = encode({
    workerRunId: Number(env('GITHUB_RUN_ID')),
    generation: Number(env('BROKER_GENERATION')),
    intentId: env('BROKER_INTENT_ID'),
    token: env('BROKER_DISPATCH_TOKEN'),
    workflow: env('BROKER_WORKER_WORKFLOW'),
  });
  const response = await client.request(
    `${repositoryPath(task)}/actions/workflows/agent-router.yml/dispatches`,
    {
      method: 'POST',
      body: {
        ref: 'main',
        inputs: {
          kind: 'completion',
          issue: String(task.issue),
          completion_payload: completionPayload,
        },
      },
    },
  );
  validateDispatchResponse(response, task);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const operation = process.argv[2];
  if (operation === 'normalize') await normalize();
  else if (operation === 'broker') await broker();
  else if (operation === 'preflight') await preflight();
  else if (operation === 'completion-callback') await completionCallback();
  else throw new Error(`Unsupported dispatch broker operation: ${operation}`);
}

export {
  assertWorkerRun,
  completionMatches,
  contextFor,
  decode,
  encode,
  handleCompletion,
  isDefiniteDispatchRejection,
  reconcileActive,
  resolveTask,
  wasSupersededEviction,
};
