import assert from 'node:assert/strict';

import {
  acceptIntent,
  beginDispatch,
  bindRun,
  completeRun,
  createLedger,
  markDispatchUnknown,
  recordControlEvidence,
} from './broker.mjs';
import {
  BrokerConcurrencyMismatchError,
  CONCURRENCY_VERIFY_MAX_ATTEMPTS,
  GitHubApiError,
  verifyBrokerConcurrency,
} from './github-api.mjs';
import {
  assertWorkerRun,
  completionMatches,
  decode,
  discoverReconcileCandidates,
  dispatchReconcileScan,
  encode,
  FRESH_INTENT_OUTCOMES,
  handleCompletion,
  healStaleAgentLabels,
  isDefiniteDispatchRejection,
  RECONCILE_MISSING_RUN_GRACE_MS,
  RECONCILE_MISSING_RUN_MAX_ATTEMPTS,
  RECONCILE_MISSING_RUN_MIN_INTERVAL_MS,
  reconcileActive,
  reconcileLedger,
  resolveTask,
  wasSupersededEviction,
} from './main.mjs';
import { normalizeEvent } from './normalize.mjs';

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

const task = {
  repositoryId: 123,
  repository: 'jlapenna/agent-lcars',
  issue: 304,
};

function boundGeneration() {
  const ledger = createLedger(task);
  acceptIntent(ledger, {
    task,
    intentId: 'intent-1',
    sourceKind: 'manual',
    sourceId: 'source-1',
    transportRunId: 9001,
    occurredAt: '2026-08-01T00:00:00.000Z',
    pipeline: 'codex',
    mode: 'implement',
    runbook: '',
    context: '',
    digest: 'abc',
    authorization: { authorized: true },
  });
  beginDispatch(ledger, 1, 'dispatch_token_123456');
  bindRun(ledger, 1, {
    runId: 42,
    runUrl: 'https://api.github.com/repos/jlapenna/agent-lcars/actions/runs/42',
    htmlUrl: 'https://github.com/jlapenna/agent-lcars/actions/runs/42',
    workflow: 'codex.yml',
  });
  return ledger.generations[0];
}

function boundLedger() {
  const ledger = createLedger(task);
  acceptIntent(ledger, {
    task,
    intentId: 'intent-1',
    sourceKind: 'manual',
    sourceId: 'source-1',
    transportRunId: 9001,
    occurredAt: '2026-08-01T00:00:00.000Z',
    pipeline: 'codex',
    mode: 'implement',
    runbook: '',
    context: '',
    digest: 'abc',
    authorization: { authorized: true },
  });
  beginDispatch(ledger, 1, 'dispatch_token_123456');
  bindRun(ledger, 1, {
    runId: 42,
    runUrl: 'https://api.github.com/repos/jlapenna/agent-lcars/actions/runs/42',
    htmlUrl: 'https://github.com/jlapenna/agent-lcars/actions/runs/42',
    workflow: 'codex.yml',
  });
  return ledger;
}

function workerRun(status = 'in_progress') {
  return {
    id: 42,
    repository: { id: 123 },
    event: 'workflow_dispatch',
    path: '.github/workflows/codex.yml',
    display_title: '#304: Codex [dispatch:g1:intent-1]',
    status,
    conclusion: status === 'completed' ? 'success' : null,
    updated_at: '2026-08-01T00:03:00.000Z',
    url: 'https://api.github.com/repos/jlapenna/agent-lcars/actions/runs/42',
    html_url: 'https://github.com/jlapenna/agent-lcars/actions/runs/42',
  };
}

test('normalized payload encoding round-trips without shell quoting', () => {
  const value = { body: "apostrophe ' newline\n and unicode ✅" };
  assert.deepEqual(decode(encode(value)), value);
});

test('resolveTask recovers a canonical TaskRef from real normalize() output for every payload kind (#337)', () => {
  // Regression test for #337: broker() used to read `normalized.task`
  // unconditionally, but normalize()'s intent emitter (makeIntent) nests
  // the TaskRef at `.intent.task` while completion/anchor-control/
  // control-evidence carry `.task` at the top level. Every actual agent
  // dispatch is an intent, so this crashed broker() on every intent.
  //
  // This drives the REAL normalizeEvent() -- not a hand-built broker
  // input -- so it exercises the exact shape normalize() produces.
  const context = {
    repository: 'jlapenna/agent-lcars',
    repositoryId: 123,
    issue: 337,
    runId: 9001,
    actor: 'jlapenna',
    now: '2026-08-01T00:00:01.000Z',
  };
  const expectedTask = {
    repositoryId: 123,
    repository: 'jlapenna/agent-lcars',
    issue: 337,
  };
  const baseIssue = {
    id: 3370,
    number: 337,
    title: 'Fix dispatch',
    body: 'Do the work',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    labels: [{ name: 'agent:codex' }],
  };

  // intent -- an issues:labeled event with an agent:* label and a
  // maintainer actor: the exact shape of the live event that crashed
  // broker() on main (see #337 / #334 / #335 / #336).
  const labeled = normalizeEvent({
    eventName: 'issues',
    event: {
      action: 'labeled',
      issue: baseIssue,
      label: { name: 'agent:codex' },
      sender: { login: 'jlapenna' },
    },
    context,
    timeline: [
      {
        id: 77,
        event: 'labeled',
        created_at: baseIssue.updated_at,
        actor: { login: 'jlapenna' },
        label: { name: 'agent:codex' },
      },
    ],
    maintainer: 'jlapenna',
  });
  assert.equal(labeled.kind, 'intent');
  assert.equal(labeled.task, undefined);
  assert.deepEqual(resolveTask(labeled), expectedTask);

  // control-evidence -- unlabeled already carries `.task` at the top level.
  const unlabeled = normalizeEvent({
    eventName: 'issues',
    event: {
      action: 'unlabeled',
      issue: baseIssue,
      label: { name: 'agent:codex' },
      sender: { login: 'jlapenna' },
    },
    context,
    timeline: [
      {
        id: 78,
        event: 'unlabeled',
        created_at: baseIssue.updated_at,
        actor: { login: 'jlapenna' },
        label: { name: 'agent:codex' },
      },
    ],
    maintainer: 'jlapenna',
  });
  assert.equal(unlabeled.kind, 'control-evidence');
  assert.deepEqual(resolveTask(unlabeled), expectedTask);

  // anchor-control -- a closed issue.
  const closed = normalizeEvent({
    eventName: 'issues',
    event: {
      action: 'closed',
      issue: baseIssue,
      sender: { login: 'automation[bot]' },
    },
    context,
    timeline: [
      {
        id: 79,
        event: 'closed',
        created_at: baseIssue.updated_at,
        actor: { login: 'automation[bot]' },
      },
    ],
    maintainer: 'jlapenna',
  });
  assert.equal(closed.kind, 'anchor-control');
  assert.deepEqual(resolveTask(closed), expectedTask);

  // completion -- a worker callback payload also carries `.task` at the
  // top level.
  const completionPayload = Buffer.from(
    JSON.stringify({
      workerRunId: 42,
      generation: 1,
      intentId: 'intent-1',
      token: 'dispatch_token_123456',
      workflow: 'codex.yml',
    }),
  ).toString('base64url');
  const completion = normalizeEvent({
    eventName: 'workflow_dispatch',
    event: {},
    inputs: {
      kind: 'completion',
      issue: '337',
      completion_payload: completionPayload,
    },
    context: { ...context, actor: 'github-actions[bot]' },
    maintainer: 'jlapenna',
  });
  assert.equal(completion.kind, 'completion');
  assert.deepEqual(resolveTask(completion), expectedTask);

  // reconcile -- dispatch-reconcile.yml's scan-fired ping also carries
  // `.task` at the top level (#305).
  const reconcile = normalizeEvent({
    eventName: 'workflow_dispatch',
    event: {},
    inputs: { kind: 'reconcile', issue: '337' },
    context: { ...context, actor: 'github-actions[bot]' },
    maintainer: 'jlapenna',
  });
  assert.equal(reconcile.kind, 'reconcile');
  assert.deepEqual(resolveTask(reconcile), expectedTask);
});

test('worker run identity requires repository, event, workflow, and immutable marker', () => {
  const generation = boundGeneration();
  const run = {
    id: 42,
    repository: { id: 123 },
    event: 'workflow_dispatch',
    path: '.github/workflows/codex.yml',
    display_title: '#304: Codex [dispatch:g1:intent-1]',
  };
  assert.doesNotThrow(() =>
    assertWorkerRun(run, task, generation, 'codex.yml'),
  );
  for (const bad of [
    { ...run, repository: { id: 456 } },
    { ...run, event: 'push' },
    { ...run, path: '.github/workflows/claude.yml' },
    { ...run, display_title: '#304: fabricated' },
  ]) {
    assert.throws(() => assertWorkerRun(bad, task, generation, 'codex.yml'));
  }
});

test('completion binding rejects wrong run, intent, and token', () => {
  const generation = boundGeneration();
  const normalized = {
    intentId: 'intent-1',
    token: 'dispatch_token_123456',
    workerRunId: 42,
  };
  assert.equal(completionMatches(generation, normalized, { id: 42 }), true);
  assert.equal(
    completionMatches(
      generation,
      { ...normalized, workerRunId: 43 },
      { id: 43 },
    ),
    false,
  );
  assert.equal(
    completionMatches(
      generation,
      { ...normalized, intentId: 'other' },
      { id: 42 },
    ),
    false,
  );
  assert.equal(
    completionMatches(
      generation,
      { ...normalized, token: 'other' },
      { id: 42 },
    ),
    false,
  );
});

test('only unambiguous non-transient 4xx dispatch failures are definite rejections', () => {
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(
      isDefiniteDispatchRejection(new GitHubApiError('rejected', status)),
      true,
    );
  }
  for (const status of [408, 409, 429, 500]) {
    assert.equal(
      isDefiniteDispatchRejection(new GitHubApiError('ambiguous', status)),
      false,
    );
  }
  assert.equal(isDefiniteDispatchRejection(new Error('timeout')), false);
});

function labelHealStubClient({ deleteStatus = 200, currentLabels } = {}) {
  const deleteCalls = [];
  const saveCalls = [];
  return {
    client: {
      request: async (path, options) => {
        deleteCalls.push({ path, method: options?.method });
        return { status: deleteStatus, data: [] };
      },
      requestOk: async (path) => {
        if (/\/issues\/comments\/9(\?.*)?$/u.test(path)) {
          saveCalls.push(path);
          return { id: 9 };
        }
        if (/\/issues\/304$/u.test(path)) {
          if (!currentLabels) {
            throw new Error(`Unexpected live-label lookup for path: ${path}`);
          }
          return { labels: currentLabels.map((name) => ({ name })) };
        }
        throw new Error(`Unexpected API path: ${path}`);
      },
    },
    deleteCalls,
    saveCalls,
  };
}

test('FRESH_INTENT_OUTCOMES only admits the two acceptIntent outcomes that leave a non-superseded generation (#355 review)', () => {
  assert.deepEqual([...FRESH_INTENT_OUTCOMES].sort(), ['dispatch', 'pending']);
  for (const nonFresh of [
    'duplicate',
    'semantic-duplicate',
    'stale',
    'stale-control-state',
    'closed',
  ]) {
    assert.equal(FRESH_INTENT_OUTCOMES.has(nonFresh), false);
  }
});

test('healStaleAgentLabels removes the stale label via the API and records evidence before dispatching (#304)', async () => {
  const ledger = createLedger(task);
  const intent = {
    sourceId: 'timeline:501',
    transportRunId: 9001,
    pipeline: 'claude',
    staleAgentLabels: ['agent:codex'],
  };
  const { client, deleteCalls, saveCalls } = labelHealStubClient({
    currentLabels: ['agent:claude', 'agent:codex'],
  });
  await healStaleAgentLabels(client, { ledger, comment: { id: 9 } }, intent);
  assert.equal(deleteCalls.length, 1);
  assert.match(deleteCalls[0].path, /\/issues\/304\/labels\/agent%3Acodex$/u);
  assert.equal(deleteCalls[0].method, 'DELETE');
  assert.equal(saveCalls.length, 1);
  const evidence = ledger.sources.find(
    (source) => source.sourceKind === 'label-self-heal',
  );
  assert.ok(evidence, 'expected label-self-heal evidence in ledger.sources');
  assert.equal(evidence.sourceId, 'label-self-heal:timeline:501');
  assert.deepEqual(evidence.labels, ['agent:codex']);
});

test('healStaleAgentLabels is a no-op for an intent without staleAgentLabels', async () => {
  const ledger = createLedger(task);
  const { client, deleteCalls, saveCalls } = labelHealStubClient();
  await healStaleAgentLabels(
    client,
    { ledger, comment: { id: 9 } },
    { sourceId: 'timeline:501', transportRunId: 9001, pipeline: 'claude' },
  );
  assert.equal(deleteCalls.length, 0);
  assert.equal(saveCalls.length, 0);
  assert.equal(ledger.sources.length, 0);
});

test('healStaleAgentLabels skips a stale label whose live state no longer matches the dual-label snapshot, and records nothing (#355 review)', async () => {
  // The maintainer switched back: live GitHub state now shows only the
  // label this payload calls "stale" (agent:codex), not the event's own
  // label (agent:claude) alongside it. Deleting agent:codex here would
  // strip the maintainer's actual current selection.
  const ledger = createLedger(task);
  const intent = {
    sourceId: 'timeline:501',
    transportRunId: 9001,
    pipeline: 'claude',
    staleAgentLabels: ['agent:codex'],
  };
  const { client, deleteCalls, saveCalls } = labelHealStubClient({
    currentLabels: ['agent:codex'],
  });
  const logs = [];
  const originalLog = console.log;
  console.log = (message) => logs.push(message);
  try {
    await healStaleAgentLabels(client, { ledger, comment: { id: 9 } }, intent);
  } finally {
    console.log = originalLog;
  }
  assert.equal(deleteCalls.length, 0);
  assert.equal(saveCalls.length, 0);
  assert.equal(ledger.sources.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^::notice::/u);
  assert.match(logs[0], /agent:codex/u);
});

test('healStaleAgentLabels skips a stale label that is simply gone (already healed), recording nothing on redelivery', async () => {
  const ledger = createLedger(task);
  const intent = {
    sourceId: 'timeline:501',
    transportRunId: 9001,
    pipeline: 'claude',
    staleAgentLabels: ['agent:codex'],
  };
  const { client, deleteCalls, saveCalls } = labelHealStubClient({
    currentLabels: ['agent:claude'],
  });
  await healStaleAgentLabels(client, { ledger, comment: { id: 9 } }, intent);
  assert.equal(deleteCalls.length, 0);
  assert.equal(saveCalls.length, 0);
  assert.equal(ledger.sources.length, 0);
});

test('broker()-style gating: a fresh intent heals, a redelivered/duplicate intent never reaches healStaleAgentLabels (#355 review)', async () => {
  // Mirrors broker()'s exact sequence: acceptIntent(), then only call
  // healStaleAgentLabels when the outcome is in FRESH_INTENT_OUTCOMES.
  const ledger = createLedger(task);
  const intent = {
    task,
    intentId: 'intent-501',
    sourceKind: 'labeled',
    sourceId: 'timeline:501',
    transportRunId: 9001,
    occurredAt: '2026-08-01T00:00:00.000Z',
    pipeline: 'claude',
    mode: 'implement',
    runbook: '',
    context: '',
    digest: 'abc',
    authorization: { authorized: true },
    staleAgentLabels: ['agent:codex'],
  };

  const first = acceptIntent(ledger, intent);
  assert.equal(first.outcome, 'dispatch');
  const firstClient = labelHealStubClient({
    currentLabels: ['agent:claude', 'agent:codex'],
  });
  if (FRESH_INTENT_OUTCOMES.has(first.outcome)) {
    await healStaleAgentLabels(
      firstClient.client,
      { ledger, comment: { id: 9 } },
      intent,
    );
  }
  assert.equal(firstClient.deleteCalls.length, 1);

  // A redelivery/rerun of the exact same source: acceptIntent reports it
  // as a duplicate no-op, so the gate must never call healStaleAgentLabels
  // at all -- regardless of what live labels look like now.
  const second = acceptIntent(ledger, intent);
  assert.equal(second.outcome, 'duplicate');
  const secondClient = labelHealStubClient();
  if (FRESH_INTENT_OUTCOMES.has(second.outcome)) {
    await healStaleAgentLabels(
      secondClient.client,
      { ledger, comment: { id: 9 } },
      intent,
    );
  }
  assert.equal(secondClient.deleteCalls.length, 0);
});

test('a self-healed dual-label intent produces only a benign follow-on unlabeled control-evidence event -- no loop (#304)', async () => {
  // End-to-end regression using the real normalizeEvent() -- the exact
  // shape main.mjs's broker() consumes. A manual relabel produces a
  // self-heal intent carrying staleAgentLabels; healStaleAgentLabels
  // removes the stale label via the API, which fires a genuine `unlabeled`
  // webhook for that same label back through the router. Feeding that
  // follow-on event through normalizeEvent + recordControlEvidence must
  // never create a second generation, dispatch anything, or throw.
  const context = {
    repository: 'jlapenna/agent-lcars',
    repositoryId: 123,
    issue: 304,
    runId: 9001,
    actor: 'jlapenna',
    now: '2026-08-01T00:00:01.000Z',
  };
  const dualLabelIssue = {
    id: 3040,
    number: 304,
    title: 'Fix dispatch',
    body: 'Do the work',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    labels: [{ name: 'agent:claude' }, { name: 'agent:codex' }],
  };
  const labeled = normalizeEvent({
    eventName: 'issues',
    event: {
      action: 'labeled',
      issue: dualLabelIssue,
      label: { name: 'agent:claude' },
      sender: { login: 'jlapenna' },
    },
    context,
    timeline: [
      {
        id: 501,
        event: 'labeled',
        created_at: dualLabelIssue.updated_at,
        actor: { login: 'jlapenna' },
        label: { name: 'agent:claude' },
      },
    ],
    maintainer: 'jlapenna',
  });
  assert.equal(labeled.kind, 'intent');
  assert.deepEqual(labeled.intent.staleAgentLabels, ['agent:codex']);

  const ledger = createLedger(task);
  const accepted = acceptIntent(ledger, labeled.intent);
  assert.equal(FRESH_INTENT_OUTCOMES.has(accepted.outcome), true);
  const { client } = labelHealStubClient({
    currentLabels: ['agent:claude', 'agent:codex'],
  });
  await healStaleAgentLabels(
    client,
    { ledger, comment: { id: 9 } },
    labeled.intent,
  );
  assert.equal(ledger.generations.length, 1);

  // GitHub's own unlabeled webhook for the label the broker just removed.
  const unlabeled = normalizeEvent({
    eventName: 'issues',
    event: {
      action: 'unlabeled',
      issue: { ...dualLabelIssue, labels: [{ name: 'agent:claude' }] },
      label: { name: 'agent:codex' },
      sender: { login: 'github-actions[bot]' },
    },
    context: { ...context, runId: 9002 },
    timeline: [
      {
        id: 502,
        event: 'unlabeled',
        created_at: dualLabelIssue.updated_at,
        actor: { login: 'github-actions[bot]' },
        label: { name: 'agent:codex' },
      },
    ],
    maintainer: 'jlapenna',
  });
  assert.equal(unlabeled.kind, 'control-evidence');
  const evidenceResult = recordControlEvidence(ledger, unlabeled.evidence);
  assert.equal(evidenceResult.outcome, 'recorded');
  // No new generation and no dispatch -- purely an audit-trail addition.
  assert.equal(ledger.generations.length, 1);
  assert.equal(ledger.generations[0].state, 'accepted');
});

test('reconciliation binds a run found after a crash left dispatching state', async () => {
  const ledger = createLedger(task);
  acceptIntent(ledger, {
    task,
    intentId: 'intent-1',
    sourceKind: 'manual',
    sourceId: 'source-1',
    transportRunId: 9001,
    occurredAt: '2026-08-01T00:00:00.000Z',
    pipeline: 'codex',
    mode: 'implement',
    runbook: '',
    context: '',
    digest: 'abc',
    authorization: { authorized: true },
  });
  beginDispatch(ledger, 1, 'dispatch_token_123456');
  const run = workerRun();
  const client = {
    requestOk: async (path) => {
      if (path.includes('/workflows/codex.yml/runs?')) {
        return { workflow_runs: [run] };
      }
      if (path.endsWith('/actions/runs/42')) return run;
      if (path.includes('/issues/comments/9')) return { id: 9 };
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  await reconcileActive(client, { ledger, comment: { id: 9 } });
  assert.equal(ledger.generations[0].state, 'active');
  assert.equal(ledger.generations[0].attempt.runId, 42);
});

test('a redelivered completion after terminal reconciliation is a no-op', async () => {
  const ledger = boundLedger();
  completeRun(ledger, 1, {
    runId: 42,
    status: 'completed',
    conclusion: 'success',
  });
  recordControlEvidence(ledger, {
    sourceKind: 'completion',
    sourceId: 'worker-run:42',
    transportRunId: 9002,
    occurredAt: '2026-08-01T00:03:00.000Z',
    runId: 42,
    authorization: { observed: true, workflow: 'codex.yml' },
  });
  let writes = 0;
  const client = {
    requestOk: async (path) => {
      if (path.endsWith('/actions/runs/42')) return workerRun('completed');
      if (path.includes('/issues/comments/9')) {
        writes += 1;
        return { id: 9 };
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  await handleCompletion(
    client,
    { ledger, comment: { id: 9 } },
    {
      task,
      generation: 1,
      intentId: 'intent-1',
      token: 'dispatch_token_123456',
      workerRunId: 42,
      workflow: 'codex.yml',
      sourceId: 'worker-run:42',
      transportRunId: 9003,
    },
  );
  assert.equal(ledger.generations[0].state, 'completed');
  assert.equal(writes, 0);
});

// --- reconcileLedger / trackMissingRun (#305) -------------------------

const RECONCILE_T0 = '2026-08-01T00:00:00.000Z';
function addMinutes(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

function dispatchingLedger({ unknown = false } = {}) {
  const ledger = createLedger(task);
  acceptIntent(
    ledger,
    {
      task,
      intentId: 'intent-1',
      sourceKind: 'manual',
      sourceId: 'source-1',
      transportRunId: 9001,
      occurredAt: RECONCILE_T0,
      pipeline: 'codex',
      mode: 'implement',
      runbook: '',
      context: '',
      digest: 'abc',
      authorization: { authorized: true },
    },
    RECONCILE_T0,
  );
  beginDispatch(ledger, 1, 'dispatch_token_123456', RECONCILE_T0);
  if (unknown) markDispatchUnknown(ledger, 1, 'timeout', RECONCILE_T0);
  return { ledger, comment: { id: 9 } };
}

// Tracks every requestOk call and answers exactly what reconcileLedger's
// dependencies need: saveLedger's PATCH, ensureNeedsHumanParked's
// label/assignee POSTs, and (only when a park mutation is made to fail) its
// verify-then-decide re-read of the issue.
function reconcileStubClient({ failParkStatus } = {}) {
  const calls = [];
  const client = {
    requestOk: async (path, options = {}) => {
      calls.push({ path, method: options.method ?? 'GET' });
      if (path.includes('/issues/comments/9')) return { id: 9 };
      if (
        failParkStatus &&
        options.method === 'POST' &&
        (path.endsWith('/labels') || path.endsWith('/assignees'))
      ) {
        throw new GitHubApiError('parking failed', failParkStatus);
      }
      if (options.method === 'POST' && path.endsWith('/labels')) return {};
      if (options.method === 'POST' && path.endsWith('/assignees')) return {};
      if (path.endsWith(`/issues/${task.issue}`)) {
        return { labels: [], assignees: [] };
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  return { client, calls };
}

test('reconcileLedger stays silent while a dispatching generation is still within its grace period', async () => {
  const { ledger, comment } = dispatchingLedger();
  const client = {
    requestOk: async (path) => {
      throw new Error(`Unexpected API call during grace period: ${path}`);
    },
  };
  const now = addMinutes(
    RECONCILE_T0,
    RECONCILE_MISSING_RUN_GRACE_MS / 60_000 - 1,
  );
  await reconcileLedger(client, { ledger, comment }, now);
  assert.equal(ledger.anomalies.length, 0);
  assert.equal(ledger.revision, 2); // unchanged since acceptIntent+beginDispatch
});

test('reconcileLedger walks a stuck dispatching generation through grace, idempotent re-observation, bounded escalation, and permanent parking (#305)', async () => {
  process.env.MAINTAINER_LOGIN = 'jlapenna';
  try {
    const { ledger, comment } = dispatchingLedger();
    const { client, calls } = reconcileStubClient();
    const loaded = { ledger, comment };

    // Pass 1: grace period has just elapsed -- first counted observation.
    const t1 = addMinutes(
      RECONCILE_T0,
      RECONCILE_MISSING_RUN_GRACE_MS / 60_000,
    );
    await reconcileLedger(client, loaded, t1);
    let missing = ledger.anomalies.filter(
      (anomaly) => anomaly.kind === 'reconcile-missing-run',
    );
    assert.equal(missing.length, 1);
    assert.equal(missing[0].detail.attempt, 1);
    assert.equal(
      calls.filter((call) => call.path.includes('/issues/comments/9')).length,
      1,
    );
    assert.equal(
      calls.some((call) => call.path.endsWith('/labels')),
      false,
      'must not park on the first observation',
    );

    // Pass 2: re-observed immediately after (same instant) -- idempotent
    // no-op, proving a duplicate/overlapping scan never double-counts.
    const savesBefore = calls.filter((call) =>
      call.path.includes('/issues/comments/9'),
    ).length;
    await reconcileLedger(client, loaded, t1);
    assert.equal(
      ledger.anomalies.filter(
        (anomaly) => anomaly.kind === 'reconcile-missing-run',
      ).length,
      1,
      'a repeated pass at the same instant must not add a second observation',
    );
    assert.equal(
      calls.filter((call) => call.path.includes('/issues/comments/9')).length,
      savesBefore,
      'an idempotent no-op pass must not write the ledger again',
    );

    // Pass 3: still inside the min-observation-interval window (less than a
    // full interval after t1) -- still a no-op even though time did pass.
    const tStillTooSoon = addMinutes(
      t1,
      RECONCILE_MISSING_RUN_MIN_INTERVAL_MS / 60_000 - 1,
    );
    await reconcileLedger(client, loaded, tStillTooSoon);
    assert.equal(
      ledger.anomalies.filter(
        (anomaly) => anomaly.kind === 'reconcile-missing-run',
      ).length,
      1,
    );

    // Pass 4: a full interval past the last COUNTED observation -- records
    // the second attempt.
    const t2 = addMinutes(t1, RECONCILE_MISSING_RUN_MIN_INTERVAL_MS / 60_000);
    await reconcileLedger(client, loaded, t2);
    missing = ledger.anomalies.filter(
      (anomaly) => anomaly.kind === 'reconcile-missing-run',
    );
    assert.equal(missing.length, 2);
    assert.equal(missing[1].detail.attempt, 2);
    assert.equal(
      calls.some((call) => call.path.endsWith('/labels')),
      false,
      'still under the bound -- must not park yet',
    );

    // Pass 5: the third interval-separated observation reaches
    // RECONCILE_MISSING_RUN_MAX_ATTEMPTS -- parks needs-human + maintainer,
    // and records both the observation and the park in the ledger.
    const t3 = addMinutes(t2, RECONCILE_MISSING_RUN_MIN_INTERVAL_MS / 60_000);
    await reconcileLedger(client, loaded, t3);
    missing = ledger.anomalies.filter(
      (anomaly) => anomaly.kind === 'reconcile-missing-run',
    );
    assert.equal(missing.length, RECONCILE_MISSING_RUN_MAX_ATTEMPTS);
    assert.equal(missing[2].detail.attempt, RECONCILE_MISSING_RUN_MAX_ATTEMPTS);
    const parked = ledger.anomalies.filter(
      (anomaly) => anomaly.kind === 'reconcile-parked',
    );
    assert.equal(parked.length, 1);
    assert.equal(parked[0].detail.generation, 1);
    assert.ok(calls.some((call) => call.path.endsWith('/labels')));
    assert.ok(calls.some((call) => call.path.endsWith('/assignees')));

    // Pass 6+: parked is permanent -- every later pass, at any later time,
    // is a true no-op: no API calls at all, no ledger mutation.
    const callsBeforeFinal = calls.length;
    const revisionBeforeFinal = ledger.revision;
    await reconcileLedger(
      client,
      loaded,
      addMinutes(t3, 10 * RECONCILE_MISSING_RUN_MIN_INTERVAL_MS),
    );
    assert.equal(calls.length, callsBeforeFinal);
    assert.equal(ledger.revision, revisionBeforeFinal);
  } finally {
    delete process.env.MAINTAINER_LOGIN;
  }
});

test('trackMissingRun leaves the ledger untouched when the park mutation genuinely fails, so a retry reuses the same attempt number', async () => {
  process.env.MAINTAINER_LOGIN = 'jlapenna';
  try {
    const { ledger, comment } = dispatchingLedger();
    const loaded = { ledger, comment };
    const { client: failingClient } = reconcileStubClient({
      failParkStatus: 403,
    });

    // Drive attempts 1 and 2 with a client that never needs to park.
    const { client: healthyClient } = reconcileStubClient();
    const t1 = addMinutes(
      RECONCILE_T0,
      RECONCILE_MISSING_RUN_GRACE_MS / 60_000,
    );
    await reconcileLedger(healthyClient, loaded, t1);
    const t2 = addMinutes(t1, RECONCILE_MISSING_RUN_MIN_INTERVAL_MS / 60_000);
    await reconcileLedger(healthyClient, loaded, t2);
    assert.equal(
      ledger.anomalies.filter(
        (anomaly) => anomaly.kind === 'reconcile-missing-run',
      ).length,
      2,
    );

    // Attempt 3 reaches the bound; the park mutation itself fails and
    // verification confirms it never landed -- reconcileLedger must reject,
    // and the ledger must record NEITHER the third observation NOR a park,
    // so the next pass retries at attempt 3 again rather than skipping it.
    const t3 = addMinutes(t2, RECONCILE_MISSING_RUN_MIN_INTERVAL_MS / 60_000);
    await assert.rejects(() => reconcileLedger(failingClient, loaded, t3));
    assert.equal(
      ledger.anomalies.filter(
        (anomaly) => anomaly.kind === 'reconcile-missing-run',
      ).length,
      2,
      'a failed park attempt must not record a partial observation',
    );
    assert.equal(
      ledger.anomalies.some((anomaly) => anomaly.kind === 'reconcile-parked'),
      false,
    );

    // Retry with a healthy client at the same instant: since nothing was
    // recorded, the interval gate does not block it, and it succeeds.
    await reconcileLedger(healthyClient, loaded, t3);
    assert.equal(
      ledger.anomalies.filter(
        (anomaly) => anomaly.kind === 'reconcile-missing-run',
      ).length,
      3,
    );
    assert.equal(
      ledger.anomalies.some((anomaly) => anomaly.kind === 'reconcile-parked'),
      true,
    );
  } finally {
    delete process.env.MAINTAINER_LOGIN;
  }
});

test('reconcileLedger treats a dispatch-unknown generation identically to dispatching', async () => {
  const { ledger, comment } = dispatchingLedger({ unknown: true });
  const { client } = reconcileStubClient();
  const now = addMinutes(RECONCILE_T0, RECONCILE_MISSING_RUN_GRACE_MS / 60_000);
  await reconcileLedger(client, { ledger, comment }, now);
  assert.equal(
    ledger.anomalies.filter(
      (anomaly) => anomaly.kind === 'reconcile-missing-run',
    ).length,
    1,
  );
});

test('reconcileLedger no-ops when there is no active generation at all', async () => {
  const ledger = createLedger(task);
  const client = {
    requestOk: async (path) => {
      throw new Error(`Unexpected API call: ${path}`);
    },
  };
  await reconcileLedger(client, { ledger, comment: { id: 9 } });
  assert.equal(ledger.anomalies.length, 0);
});

test('reconcileLedger no-ops once a generation is already bound (active state, not dispatching/dispatch-unknown)', async () => {
  const ledger = boundLedger();
  const client = {
    requestOk: async (path) => {
      throw new Error(`Unexpected API call: ${path}`);
    },
  };
  await reconcileLedger(client, { ledger, comment: { id: 9 } });
  assert.equal(ledger.anomalies.length, 0);
});

test('reconcileLedger surfaces and parks a pending generation stranded with no contemporaneous active generation (defensive invariant)', async () => {
  process.env.MAINTAINER_LOGIN = 'jlapenna';
  try {
    // Construct the otherwise-unreachable state directly: broker.mjs's own
    // transitions never leave a `pending` generation without a
    // contemporaneous active one, so this simulates ledger data corruption
    // (or a future bug) rather than a reachable live sequence.
    const ledger = boundLedger();
    completeRun(ledger, 1, {
      runId: 42,
      status: 'completed',
      conclusion: 'success',
    });
    ledger.generations.push({
      ...ledger.generations[0],
      generation: 2,
      intentId: 'intent-2',
      state: 'pending',
      attempt: undefined,
    });
    const { client, calls } = reconcileStubClient();
    await reconcileLedger(client, { ledger, comment: { id: 9 } });
    assert.ok(
      ledger.anomalies.some(
        (anomaly) => anomaly.kind === 'reconcile-invariant-violation',
      ),
    );
    assert.ok(calls.some((call) => call.path.endsWith('/labels')));
    assert.ok(calls.some((call) => call.path.endsWith('/assignees')));
  } finally {
    delete process.env.MAINTAINER_LOGIN;
  }
});

test('dispatchReconcileScan fires one workflow_dispatch per candidate with kind=reconcile and the exact issue number', async () => {
  const requests = [];
  const client = {
    request: async (path, options) => {
      requests.push({ path, options });
      return {
        status: 200,
        data: {
          workflow_run_id: 500 + requests.length,
          run_url: `https://api.github.com/repos/jlapenna/agent-lcars/actions/runs/${500 + requests.length}`,
          html_url: `https://github.com/jlapenna/agent-lcars/actions/runs/${500 + requests.length}`,
        },
      };
    },
  };
  const results = await dispatchReconcileScan(
    client,
    'jlapenna/agent-lcars',
    [304, 305],
  );
  assert.deepEqual(results, { dispatched: 2, failed: [] });
  assert.equal(requests.length, 2);
  for (const [index, issueNumber] of [304, 305].entries()) {
    assert.equal(
      requests[index].path,
      '/repos/jlapenna/agent-lcars/actions/workflows/agent-router.yml/dispatches',
    );
    assert.equal(requests[index].options.method, 'POST');
    assert.deepEqual(requests[index].options.body.inputs, {
      kind: 'reconcile',
      issue: String(issueNumber),
    });
  }
});

test('dispatchReconcileScan continues past a per-candidate dispatch failure and reports it without blocking the rest', async () => {
  const client = {
    request: async (_path, options) => {
      const issue = options.body.inputs.issue;
      if (issue === '305') {
        return { status: 500, data: { message: 'boom' } };
      }
      return {
        status: 200,
        data: {
          workflow_run_id: 9,
          run_url:
            'https://api.github.com/repos/jlapenna/agent-lcars/actions/runs/9',
          html_url: 'https://github.com/jlapenna/agent-lcars/actions/runs/9',
        },
      };
    },
  };
  const results = await dispatchReconcileScan(
    client,
    'jlapenna/agent-lcars',
    [304, 305, 306],
  );
  assert.equal(results.dispatched, 2);
  assert.equal(results.failed.length, 1);
  assert.equal(results.failed[0].issue, 305);
});

// --- discoverReconcileCandidates (#363 review: label-independent lane) --

test('discoverReconcileCandidates includes an unlabeled issue with an active generation via the fleet-assignee lane, merged with labeled candidates (#363 review)', async () => {
  // Issue #500: its last agent:* label was removed while the worker was
  // still active (recorded only as control-evidence -- see #363's review),
  // so it carries no agent:* label anymore, but claim-issue's assignment of
  // the fleet login is durable and was never cleared. Issue #304 is the
  // ordinary, still-labeled case.
  const seenUrls = [];
  const client = {
    requestOk: async (url) => {
      seenUrls.push(url);
      if (url.includes('labels=agent%3Aclaude')) {
        return [{ number: 304 }];
      }
      if (
        url.includes('labels=agent%3Acodex') ||
        url.includes('labels=agent%3Aopencode')
      ) {
        return [];
      }
      if (url.includes('assignee=jclaw-bot')) {
        return [{ number: 500 }];
      }
      throw new Error(`Unexpected API path: ${url}`);
    },
  };
  const candidates = await discoverReconcileCandidates(
    client,
    'jlapenna/agent-lcars',
    'jclaw-bot',
  );
  assert.deepEqual(
    candidates.map((issue) => issue.number),
    [304, 500],
  );
  assert.ok(seenUrls.some((url) => url.includes('assignee=jclaw-bot')));
});

test('discoverReconcileCandidates dedupes an issue that is both labeled and fleet-assigned', async () => {
  const client = {
    requestOk: async (url) => {
      if (url.includes('labels=agent%3Aclaude')) return [{ number: 304 }];
      if (url.includes('labels=')) return [];
      if (url.includes('assignee=')) return [{ number: 304 }];
      throw new Error(`Unexpected API path: ${url}`);
    },
  };
  const candidates = await discoverReconcileCandidates(
    client,
    'jlapenna/agent-lcars',
    'jclaw-bot',
  );
  assert.deepEqual(
    candidates.map((issue) => issue.number),
    [304],
  );
});

test('discoverReconcileCandidates skips the fleet-assignee lane entirely when no fleet login is configured', async () => {
  const seenUrls = [];
  const client = {
    requestOk: async (url) => {
      seenUrls.push(url);
      if (url.includes('labels=')) return [];
      throw new Error(
        `Unexpected API path (assignee lane should be skipped): ${url}`,
      );
    },
  };
  const candidates = await discoverReconcileCandidates(
    client,
    'jlapenna/agent-lcars',
    '',
  );
  assert.deepEqual(candidates, []);
  assert.ok(seenUrls.every((url) => !url.includes('assignee=')));
});

// --- end-to-end: findRunsForGeneration truncation no longer false-parks --

test('an old dispatch buried past 100 newer unrelated runs is found and bound, not falsely parked, once the scoped/paginated query is applied (#363 review)', async () => {
  const { ledger, comment } = dispatchingLedger();
  const generation = ledger.generations[0];
  const marker = `[dispatch:g${generation.generation}:${generation.intentId}]`;
  const targetRun = {
    id: 777,
    repository: { id: task.repositoryId },
    event: 'workflow_dispatch',
    path: '.github/workflows/codex.yml',
    display_title: `#304: Codex ${marker}`,
    status: 'in_progress',
    conclusion: null,
    updated_at: '2026-08-01T00:10:00.000Z',
    url: 'https://api.github.com/repos/jlapenna/agent-lcars/actions/runs/777',
    html_url: 'https://github.com/jlapenna/agent-lcars/actions/runs/777',
  };
  const unrelatedPage = Array.from({ length: 100 }, (_, index) => ({
    id: index,
    repository: { id: task.repositoryId },
    event: 'workflow_dispatch',
    path: '.github/workflows/codex.yml',
    display_title: `#999: unrelated run ${index}`,
  }));
  const client = {
    requestOk: async (path) => {
      if (path.includes('/workflows/codex.yml/runs?')) {
        const page = Number(
          new URL(`https://x${path}`).searchParams.get('page'),
        );
        return { workflow_runs: page === 1 ? unrelatedPage : [targetRun] };
      }
      if (path.endsWith('/actions/runs/777')) return targetRun;
      if (path.includes('/issues/comments/9')) return { id: 9 };
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  const loaded = { ledger, comment };

  // Reproduces broker()'s exact composition for a `reconcile` event: bind
  // first via reconcileActive(), then reconcileLedger()'s missing-run
  // tracking only ever sees a still-dispatching generation with no runId.
  await reconcileActive(client, loaded);
  assert.equal(ledger.generations[0].state, 'active');
  assert.equal(ledger.generations[0].attempt.runId, 777);

  const now = addMinutes(RECONCILE_T0, RECONCILE_MISSING_RUN_GRACE_MS / 60_000);
  await reconcileLedger(client, loaded, now);
  assert.equal(
    ledger.anomalies.filter(
      (anomaly) => anomaly.kind === 'reconcile-missing-run',
    ).length,
    0,
    'a genuinely bound run must never be recorded as missing',
  );
});

function supersedingClient(group, { holds = true } = {}) {
  return {
    requestOk: async (path) => {
      if (path.includes('/workflows/agent-router.yml/runs?')) {
        return {
          workflow_runs: [
            { id: 9002, display_title: 'route #304: labeled agent:codex' },
          ],
        };
      }
      if (path.includes('/actions/runs/9002/concurrency_groups')) {
        return {
          concurrency_groups: holds ? [{ group_name: group }] : [],
        };
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
}

// Drives the REAL verifyBrokerConcurrency (dispatch path, #348) against a
// fake API where a genuinely newer router run (9002) holds this run's
// (9001) expected group -- indistinguishable, from the dispatch run's own
// perspective, from ordinary contention. Retries exhaust into a retryable
// BrokerConcurrencyMismatchError, proving #348's indirect verification path
// feeds the exact same error shape #345/#347's eviction handling already
// expects, regardless of which path (event-triggered listing vs.
// dispatch-triggered indirect corroboration) produced it.
async function exhaustedDispatchConflictError(group) {
  const client = supersedingClient(group);
  const sleeps = [];
  let verifyError;
  try {
    await verifyBrokerConcurrency(client, task, 9001, group, {
      eventName: 'workflow_dispatch',
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.fail('expected verifyBrokerConcurrency to throw');
  } catch (error) {
    verifyError = error;
  }
  assert.equal(verifyError.name, 'BrokerConcurrencyMismatchError');
  assert.equal(verifyError.retryable, true);
  assert.equal(sleeps.length, CONCURRENCY_VERIFY_MAX_ATTEMPTS - 1);
  return { client, verifyError };
}

test('wasSupersededEviction exits gracefully when evicted control-evidence has a corroborated superseding run (#344)', async () => {
  const group = 'agent-lcars-dispatch-v1-123-304';
  const client = supersedingClient(group);
  const error = new BrokerConcurrencyMismatchError(
    'Broker run does not report the expected concurrency group (after 5 attempts)',
    { retryable: true },
  );
  const originalLog = console.log;
  const logged = [];
  console.log = (message) => logged.push(message);
  let handled;
  try {
    handled = await wasSupersededEviction(
      client,
      task,
      9001,
      group,
      'control-evidence',
      error,
    );
  } finally {
    console.log = originalLog;
  }
  assert.equal(handled, true);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^::notice::/u);
  assert.match(logged[0], /evicted/u);
  assert.match(logged[0], /9002/u);
});

test('wasSupersededEviction also exits gracefully for an evicted reconcile ping with a corroborated superseding run (#305) -- it carries no unique evidence and dispatch-reconcile.yml re-fires it on its own cadence regardless', async () => {
  const group = 'agent-lcars-dispatch-v1-123-304';
  const client = supersedingClient(group);
  const error = new BrokerConcurrencyMismatchError(
    'Broker run does not report the expected concurrency group (after 5 attempts)',
    { retryable: true },
  );
  const originalLog = console.log;
  const logged = [];
  console.log = (message) => logged.push(message);
  let handled;
  try {
    handled = await wasSupersededEviction(
      client,
      task,
      9001,
      group,
      'reconcile',
      error,
    );
  } finally {
    console.log = originalLog;
  }
  assert.equal(handled, true);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^::notice::/u);
  assert.match(logged[0], /9002/u);
});

test('wasSupersededEviction still fails a genuinely unexplained mismatch when no run corroborates eviction', async () => {
  const group = 'agent-lcars-dispatch-v1-123-304';
  const client = {
    requestOk: async (path) => {
      if (path.includes('/workflows/agent-router.yml/runs?')) {
        return { workflow_runs: [] };
      }
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  const error = new BrokerConcurrencyMismatchError(
    'Broker run does not report the expected concurrency group (after 5 attempts)',
    { retryable: true },
  );
  assert.equal(
    await wasSupersededEviction(
      client,
      task,
      9001,
      group,
      'control-evidence',
      error,
    ),
    false,
  );
});

test('wasSupersededEviction never queries for a superseding run on a non-retryable mismatch (a real anomaly)', async () => {
  const client = {
    requestOk: async () => {
      throw new Error('must not query for supersession on a real anomaly');
    },
  };
  const error = new BrokerConcurrencyMismatchError(
    'Broker concurrency output does not match its TaskRef',
    { retryable: false },
  );
  assert.equal(
    await wasSupersededEviction(
      client,
      task,
      9001,
      'group',
      'control-evidence',
      error,
    ),
    false,
  );
});

test('a queue-evicted dispatch-triggered run carrying control-evidence is still corroborated end-to-end and exits gracefully (#348 + #344 + #347)', async () => {
  // Post-#347: only an evicted control-evidence payload may be dropped on
  // a corroborated eviction. This proves #348's new dispatch-path
  // verification composes correctly with that: the retryable error it
  // produces still reaches wasSupersededEviction's graceful-skip branch
  // for the one kind that's actually eligible for it.
  const group = 'agent-lcars-dispatch-v1-123-304';
  const { client, verifyError } = await exhaustedDispatchConflictError(group);

  const originalLog = console.log;
  const logged = [];
  console.log = (message) => logged.push(message);
  let handled;
  try {
    handled = await wasSupersededEviction(
      client,
      task,
      9001,
      group,
      'control-evidence',
      verifyError,
    );
  } finally {
    console.log = originalLog;
  }
  assert.equal(handled, true);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^::notice::/u);
  assert.match(logged[0], /9002/u);
});

test('a queue-evicted dispatch-triggered intent with a corroborated superseding run still fails red end-to-end -- an authorized intent must never be silently dropped (#348 + #347)', async () => {
  // Same #348 dispatch-path exhaustion as above, but for an intent: #347
  // restricted the graceful skip to control-evidence only, so this must
  // still throw naming the superseding run rather than being silently
  // accepted, proving #348's new path doesn't bypass #347's contract for
  // non-evidence payload kinds.
  const group = 'agent-lcars-dispatch-v1-123-304';
  const { client, verifyError } = await exhaustedDispatchConflictError(group);

  await assert.rejects(
    () =>
      wasSupersededEviction(client, task, 9001, group, 'intent', verifyError),
    (thrown) => {
      assert.match(thrown.message, /intent/u);
      assert.match(thrown.message, /9002/u);
      assert.match(thrown.message, /manually re-dispatch/u);
      assert.equal(thrown.cause, verifyError);
      return true;
    },
  );
});

test('wasSupersededEviction ignores errors that are not a retryable BrokerConcurrencyMismatchError', async () => {
  const client = {
    requestOk: async () => {
      throw new Error('must not query for supersession on an unrelated error');
    },
  };
  assert.equal(
    await wasSupersededEviction(
      client,
      task,
      9001,
      'group',
      'control-evidence',
      new GitHubApiError('boom', 500),
    ),
    false,
  );
});

test('wasSupersededEviction still fails red for an evicted intent even with a corroborated superseding run -- an authorized intent must never be silently dropped (#344 follow-up)', async () => {
  const group = 'agent-lcars-dispatch-v1-123-304';
  const client = supersedingClient(group);
  const error = new BrokerConcurrencyMismatchError(
    'Broker run does not report the expected concurrency group (after 5 attempts)',
    { retryable: true },
  );
  await assert.rejects(
    () => wasSupersededEviction(client, task, 9001, group, 'intent', error),
    (thrown) => {
      assert.match(thrown.message, /intent/u);
      assert.match(thrown.message, /9002/u);
      assert.match(thrown.message, /manually re-dispatch/u);
      assert.equal(thrown.cause, error);
      return true;
    },
  );
});

test('wasSupersededEviction still fails red for an evicted completion even with a corroborated superseding run -- a stuck-active generation must never be silently accepted (#344 follow-up)', async () => {
  const group = 'agent-lcars-dispatch-v1-123-304';
  const client = supersedingClient(group);
  const error = new BrokerConcurrencyMismatchError(
    'Broker run does not report the expected concurrency group (after 5 attempts)',
    { retryable: true },
  );
  await assert.rejects(
    () => wasSupersededEviction(client, task, 9001, group, 'completion', error),
    (thrown) => {
      assert.match(thrown.message, /completion/u);
      assert.match(thrown.message, /manually re-dispatch/u);
      assert.equal(thrown.cause, error);
      return true;
    },
  );
});

test('wasSupersededEviction still fails red for an evicted anchor-control even with a corroborated superseding run', async () => {
  const group = 'agent-lcars-dispatch-v1-123-304';
  const client = supersedingClient(group);
  const error = new BrokerConcurrencyMismatchError(
    'Broker run does not report the expected concurrency group (after 5 attempts)',
    { retryable: true },
  );
  await assert.rejects(() =>
    wasSupersededEviction(client, task, 9001, group, 'anchor-control', error),
  );
});

let failures = 0;
for (const { name, run } of tests) {
  try {
    await run();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`not ok - ${name}\n${error.stack}\n`);
  }
}
if (failures > 0) process.exitCode = 1;
