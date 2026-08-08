import assert from 'node:assert/strict';

import { formatRouterGroupMarker } from '@agent-lcars/dispatch-contracts';
import { test } from 'vitest';

import {
  acceptIntent,
  applyAnchorControl,
  beginDispatch,
  bindRun,
  completeRun,
  createLedger,
  markDispatchUnknown,
  recordControlEvidence,
  renderLedgerComment,
} from './broker.js';
import {
  BrokerConcurrencyMismatchError,
  CONCURRENCY_VERIFY_MAX_ATTEMPTS,
  GitHubApiError,
  verifyBrokerConcurrency,
} from './github-api.js';
import {
  applyAnchorControlTransition,
  assertWorkerRun,
  completionMatches,
  decode,
  discoverRecentlyClosedReconcileCandidates,
  discoverReconcileCandidates,
  dispatchAccepted,
  dispatchReconcileScan,
  encode,
  FRESH_INTENT_OUTCOMES,
  handleCompletion,
  healStaleAgentLabels,
  isDefiniteDispatchRejection,
  loadBrokerLedger,
  loadPreflightLedger,
  RECONCILE_DISPATCH_CONCURRENCY,
  RECONCILE_MISSING_RUN_GRACE_MS,
  RECONCILE_MISSING_RUN_MAX_ATTEMPTS,
  RECONCILE_MISSING_RUN_MIN_INTERVAL_MS,
  RECONCILE_STUCK_RUN_GRACE_MS,
  RECONCILE_STUCK_RUN_MAX_ATTEMPTS,
  RECONCILE_STUCK_RUN_MIN_INTERVAL_MS,
  reconcileActive,
  reconcileControlState,
  reconcileLedger,
  repairMissingIntentFromLabel,
  resolveTask,
  runPhase,
  saveProjectionCheckpoint,
  wasSupersededEviction,
} from './main.js';
import { digestQuickTask, normalizeEvent } from './normalize.js';
import { acquireAuthority } from './storage/authority.js';
import { InMemoryStoragePort } from './storage/in-memory-port.js';

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

test('storage-authoritative dispatch records the outbox and resolves it after persisting the run binding', async () => {
  const port = new InMemoryStoragePort();
  const seed = createLedger(task);
  acceptIntent(seed, {
    task,
    intentId: 'intent-authority',
    sourceKind: 'manual',
    sourceId: 'source-authority',
    transportRunId: 736,
    occurredAt: '2026-08-08T06:00:00.000Z',
    pipeline: 'codex',
    mode: 'implement',
    runbook: '',
    context: '',
    digest: 'authority',
    authorization: { authorized: true },
  });
  const authority = await acquireAuthority(
    port,
    task,
    'delivery:authority',
    seed,
  );
  const recordLaunchIntent = port.recordLaunchIntent.bind(port);
  port.recordLaunchIntent = async (operation, now) => {
    assert.equal(
      (await port.readTask(task))?.controllerState?.generations[0].state,
      'accepted',
      'the outbox intent must exist before dispatching state is persisted',
    );
    return recordLaunchIntent(operation, now);
  };
  const runId = 73601;
  const runUrl = `https://api.github.com/repos/jlapenna/agent-lcars/actions/runs/${runId}`;
  const htmlUrl = `https://github.com/jlapenna/agent-lcars/actions/runs/${runId}`;
  const client = {
    request: async (path, options = {}) => {
      assert.match(path, /actions\/workflows\/codex.yml\/dispatches$/u);
      assert.equal(options.method, 'POST');
      return {
        status: 200,
        data: { workflow_run_id: runId, run_url: runUrl, html_url: htmlUrl },
        headers: new Headers(),
      };
    },
    requestOk: async (path, options = {}) => {
      assert.match(path, /issues\/comments\/9$/u);
      assert.equal(options.method, 'PATCH');
      return { id: 9 };
    },
  };
  const loaded = {
    ledger: authority.ledger,
    comment: { id: 9 },
    created: false,
    authority: authority.session,
  };

  await dispatchAccepted(client, loaded);

  const attemptId = loaded.ledger.generations[0].attempt?.attemptId;
  assert.ok(attemptId);
  const operation = await port.readLaunchOperation(attemptId);
  assert.equal(operation?.status, 'launched');
  assert.equal(operation?.resolution?.status, 'launched');
  const stored = await port.readTask(task);
  assert.equal(stored?.controllerState?.generations[0].state, 'active');
  assert.equal(stored?.controllerState?.generations[0].attempt?.runId, runId);
});

test('a launched worker stays active when launch-outbox resolution fails', async () => {
  const port = new InMemoryStoragePort();
  const seed = createLedger(task);
  acceptIntent(seed, {
    task,
    intentId: 'intent-outbox-failure',
    sourceKind: 'manual',
    sourceId: 'source-outbox-failure',
    transportRunId: 737,
    occurredAt: '2026-08-08T06:45:00.000Z',
    pipeline: 'codex',
    mode: 'implement',
    runbook: '',
    context: '',
    digest: 'outbox-failure',
    authorization: { authorized: true },
  });
  const authority = await acquireAuthority(
    port,
    task,
    'delivery:outbox-failure',
    seed,
  );
  const resolveLaunchOutcome = port.resolveLaunchOutcome.bind(port);
  port.resolveLaunchOutcome = async () => {
    throw new Error('transient Firestore failure');
  };
  const runId = 73701;
  const client = {
    request: async () => ({
      status: 200,
      data: {
        workflow_run_id: runId,
        run_url: `https://api.github.com/repos/jlapenna/agent-lcars/actions/runs/${runId}`,
        html_url: `https://github.com/jlapenna/agent-lcars/actions/runs/${runId}`,
      },
      headers: new Headers(),
    }),
    requestOk: async () => ({ id: 9 }),
  };
  const loaded = {
    ledger: authority.ledger,
    comment: { id: 9 },
    created: false,
    authority: authority.session,
  };

  await dispatchAccepted(client, loaded);

  assert.equal(loaded.ledger.generations[0].state, 'active');
  assert.equal(loaded.ledger.generations[0].attempt?.runId, runId);
  assert.equal(
    (await port.readTask(task))?.controllerState?.generations[0].state,
    'active',
  );
  const attemptId = loaded.ledger.generations[0].attempt?.attemptId;
  assert.ok(attemptId);
  assert.equal((await port.readLaunchOperation(attemptId))?.status, 'pending');

  port.resolveLaunchOutcome = resolveLaunchOutcome;
  const run = {
    id: runId,
    repository: { id: task.repositoryId },
    event: 'workflow_dispatch',
    path: '.github/workflows/codex.yml',
    display_title: '#304: Codex [dispatch:g1:intent-outbox-failure]',
    status: 'in_progress',
    conclusion: null,
    updated_at: new Date().toISOString(),
    url: `https://api.github.com/repos/jlapenna/agent-lcars/actions/runs/${runId}`,
    html_url: `https://github.com/jlapenna/agent-lcars/actions/runs/${runId}`,
  };
  const reconcileClient = {
    requestOk: async (path) => {
      if (path.includes('/workflows/codex.yml/runs?')) {
        return { workflow_runs: [run] };
      }
      if (path.endsWith(`/actions/runs/${runId}`)) return run;
      throw new Error(`Unexpected reconciliation request: ${path}`);
    },
  };

  await reconcileActive(reconcileClient, loaded);

  assert.equal((await port.readLaunchOperation(attemptId))?.status, 'launched');
});

test('authority defers worker launch while the compatibility projection is unavailable', async () => {
  const port = new InMemoryStoragePort();
  const seed = createLedger(task);
  acceptIntent(seed, {
    task,
    intentId: 'intent-projection-unavailable',
    sourceKind: 'manual',
    sourceId: 'source-projection-unavailable',
    transportRunId: 738,
    occurredAt: '2026-08-08T07:00:00.000Z',
    pipeline: 'codex',
    mode: 'implement',
    runbook: '',
    context: '',
    digest: 'projection-unavailable',
    authorization: { authorized: true },
  });
  const authority = await acquireAuthority(
    port,
    task,
    'delivery:projection-unavailable',
    seed,
  );
  const client = {
    request: async () => {
      throw new Error('worker dispatch must be deferred');
    },
    requestOk: async () => {
      throw new Error('projection must remain untouched');
    },
  };

  await dispatchAccepted(client, {
    ledger: authority.ledger,
    comment: { id: 0 },
    created: false,
    authority: authority.session,
    projectionAvailable: false,
  });

  assert.equal(authority.ledger.generations[0].state, 'accepted');
  assert.equal(
    await port.readLaunchOperation('g1:intent-projection-unavailable'),
    undefined,
  );
});

test('authority restores accepted state when the scheduling projection PATCH fails', async () => {
  const port = new InMemoryStoragePort();
  const seed = createLedger(task);
  acceptIntent(seed, {
    task,
    intentId: 'intent-scheduling-projection-failure',
    sourceKind: 'manual',
    sourceId: 'source-scheduling-projection-failure',
    transportRunId: 739,
    occurredAt: '2026-08-08T07:15:00.000Z',
    pipeline: 'codex',
    mode: 'implement',
    runbook: '',
    context: '',
    digest: 'scheduling-projection-failure',
    authorization: { authorized: true },
  });
  const authority = await acquireAuthority(
    port,
    task,
    'delivery:scheduling-projection-failure',
    seed,
  );
  let dispatches = 0;
  const client = {
    request: async () => {
      dispatches += 1;
      throw new Error('worker dispatch must not happen');
    },
    requestOk: async () => {
      throw new Error('GitHub projection unavailable');
    },
  };
  const loaded = {
    ledger: authority.ledger,
    comment: { id: 9 },
    created: false,
    authority: authority.session,
    projectionAvailable: true,
  };

  await dispatchAccepted(client, loaded);

  assert.equal(dispatches, 0);
  assert.equal(loaded.projectionAvailable, false);
  assert.equal(loaded.ledger.generations[0].state, 'accepted');
  assert.equal(
    (await port.readTask(task))?.controllerState?.generations[0].state,
    'accepted',
  );
  assert.equal(
    (await port.readLaunchOperation('g1:intent-scheduling-projection-failure'))
      ?.status,
    'pending',
  );
});

test('authority restores accepted state when pre-launch outbox recording fails', async () => {
  const port = new InMemoryStoragePort();
  const seed = createLedger(task);
  acceptIntent(seed, {
    task,
    intentId: 'intent-outbox-record-failure',
    sourceKind: 'manual',
    sourceId: 'source-outbox-record-failure',
    transportRunId: 740,
    occurredAt: '2026-08-08T07:20:00.000Z',
    pipeline: 'codex',
    mode: 'implement',
    runbook: '',
    context: '',
    digest: 'outbox-record-failure',
    authorization: { authorized: true },
  });
  const authority = await acquireAuthority(
    port,
    task,
    'delivery:outbox-record-failure',
    seed,
  );
  port.recordLaunchIntent = async () => {
    throw new Error('transient outbox write failure');
  };
  let dispatches = 0;
  let projectionWrites = 0;
  const client = {
    request: async () => {
      dispatches += 1;
      throw new Error('worker dispatch must not happen');
    },
    requestOk: async () => {
      projectionWrites += 1;
      return { id: 9 };
    },
  };
  const loaded = {
    ledger: authority.ledger,
    comment: { id: 9 },
    created: false,
    authority: authority.session,
    projectionAvailable: true,
  };

  await dispatchAccepted(client, loaded);

  assert.equal(dispatches, 0);
  assert.equal(projectionWrites, 0);
  assert.equal(loaded.ledger.generations[0].state, 'accepted');
  assert.equal(
    (await port.readTask(task))?.controllerState?.generations[0].state,
    'accepted',
  );
});

test('authority persists dispatch-unknown when auxiliary outbox resolution fails', async () => {
  const port = new InMemoryStoragePort();
  const seed = createLedger(task);
  acceptIntent(seed, {
    task,
    intentId: 'intent-unknown-outbox-failure',
    sourceKind: 'manual',
    sourceId: 'source-unknown-outbox-failure',
    transportRunId: 741,
    occurredAt: '2026-08-08T07:21:00.000Z',
    pipeline: 'codex',
    mode: 'implement',
    runbook: '',
    context: '',
    digest: 'unknown-outbox-failure',
    authorization: { authorized: true },
  });
  const authority = await acquireAuthority(
    port,
    task,
    'delivery:unknown-outbox-failure',
    seed,
  );
  port.resolveLaunchOutcome = async () => {
    throw new Error('transient outbox resolution failure');
  };
  const client = {
    request: async () => {
      throw new Error('dispatch response timeout');
    },
    requestOk: async () => ({ id: 9 }),
  };
  const loaded = {
    ledger: authority.ledger,
    comment: { id: 9 },
    created: false,
    authority: authority.session,
    projectionAvailable: true,
  };

  await dispatchAccepted(client, loaded);

  assert.equal(loaded.ledger.generations[0].state, 'dispatch-unknown');
  assert.equal(
    (await port.readTask(task))?.controllerState?.generations[0].state,
    'dispatch-unknown',
  );
});

test('authority preflight reads the exact Firestore binding without touching corrupt comments', async () => {
  const port = new InMemoryStoragePort();
  const ledger = boundLedger();
  await acquireAuthority(port, task, 'delivery:preflight', ledger);
  const explosiveClient = {
    requestOk: async () => {
      throw new Error('comment-backed preflight must not run in authority');
    },
  };

  const loaded = await loadPreflightLedger(
    explosiveClient,
    task,
    'authority',
    port,
  );

  assert.equal(loaded?.generations[0].attempt?.runId, 42);
});

test('authority records projection convergence only after the compatibility comment succeeds', async () => {
  const port = new InMemoryStoragePort();
  const ledger = createLedger(task);
  const authority = await acquireAuthority(
    port,
    task,
    'projection:success',
    ledger,
  );
  const order = [];
  const writeTask = port.writeTask.bind(port);
  port.writeTask = async (...args) => {
    order.push('storage');
    return writeTask(...args);
  };
  const loaded = {
    ledger: authority.ledger,
    comment: { id: 9 },
    created: false,
    authority: authority.session,
    projectionAvailable: true,
  };
  const client = {
    request: async () => {
      throw new Error('unexpected request');
    },
    requestOk: async () => {
      order.push('comment');
      return { id: 9 };
    },
  };

  await saveProjectionCheckpoint(client, loaded);

  assert.deepEqual(order, ['comment', 'storage']);
  assert.equal(
    (await port.readTask(task))?.controllerState?.projection.state,
    'converged',
  );
});

test('authority persists a non-converged projection checkpoint when the comment write fails', async () => {
  const port = new InMemoryStoragePort();
  const ledger = createLedger(task);
  const authority = await acquireAuthority(
    port,
    task,
    'projection:failure',
    ledger,
  );
  const loaded = {
    ledger: authority.ledger,
    comment: { id: 9 },
    created: false,
    authority: authority.session,
    projectionAvailable: true,
  };
  const client = {
    request: async () => {
      throw new Error('unexpected request');
    },
    requestOk: async () => {
      throw new Error('GitHub projection unavailable');
    },
  };

  await assert.rejects(() => saveProjectionCheckpoint(client, loaded));

  const projection = (await port.readTask(task))?.controllerState?.projection;
  assert.notEqual(projection?.state, 'converged');
  assert.equal(projection?.observedRevision, 0);
});

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

test('an ordinary pull request close with no dispatch ledger is an intentional no-op', async () => {
  const normalized = normalizeEvent({
    eventName: 'pull_request',
    event: {
      action: 'closed',
      pull_request: {
        id: 3040,
        number: task.issue,
        title: 'Ordinary pull request',
        body: '',
        labels: [],
        updated_at: '2026-08-05T00:00:00.000Z',
        merged: true,
      },
      sender: { login: 'jlapenna' },
    },
    context: {
      ...task,
      runId: 9001,
      actor: 'jlapenna',
      now: '2026-08-05T00:00:01.000Z',
    },
    maintainer: 'jlapenna',
  });
  const calls = [];
  const client = {
    requestOk: async (path, options = {}) => {
      calls.push({ path, method: options.method ?? 'GET' });
      if ((options.method ?? 'GET') === 'GET') return [];
      throw new Error(`Unexpected write: ${options.method} ${path}`);
    },
  };

  const loaded = await loadBrokerLedger(client, task, normalized, true);

  assert.equal(loaded, undefined);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['GET'],
  );
});

test('an issue close keeps the existing create-if-missing ledger behavior', async () => {
  const calls = [];
  const client = {
    requestOk: async (path, options = {}) => {
      const method = options.method ?? 'GET';
      calls.push({ path, method });
      if (method === 'GET') return [];
      if (method === 'POST' && path.endsWith('/issues/304/comments')) {
        return {
          id: 9,
          body: options.body.body,
          user: { login: 'github-actions[bot]', type: 'Bot' },
        };
      }
      throw new Error(`Unexpected API request: ${method} ${path}`);
    },
  };

  const loaded = await loadBrokerLedger(
    client,
    task,
    { kind: 'anchor-control' },
    false,
  );

  assert.equal(loaded.created, true);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['GET', 'POST'],
  );
});

test('authority rejects an existing comment-backed task that missed exact-state backfill', async () => {
  const ledger = createLedger(task);
  const port = new InMemoryStoragePort();
  const client = {
    requestOk: async () => [
      {
        id: 9,
        body: renderLedgerComment(ledger),
        user: { login: 'github-actions[bot]', type: 'Bot' },
      },
    ],
  };

  await assert.rejects(
    () =>
      loadBrokerLedger(
        client,
        task,
        { kind: 'reconcile', task },
        false,
        'authority',
        'delivery:missing-backfill',
        () => port,
      ),
    /no exact authoritative controller state/u,
  );
  assert.equal(await port.readTask(task), undefined);
});

test('authority may seed a genuinely new task with no compatibility projection', async () => {
  const port = new InMemoryStoragePort();
  const calls = [];
  const client = {
    requestOk: async (path, options = {}) => {
      calls.push({ path, method: options.method ?? 'GET' });
      if ((options.method ?? 'GET') === 'GET' && path.endsWith('/issues/304')) {
        return { created_at: '2026-08-09T00:00:00.000Z' };
      }
      if ((options.method ?? 'GET') === 'GET') return [];
      if (options.method === 'POST') {
        return {
          id: 9,
          body: options.body.body,
          user: { login: 'github-actions[bot]', type: 'Bot' },
        };
      }
      throw new Error(`Unexpected API request: ${options.method} ${path}`);
    },
  };

  const loaded = await loadBrokerLedger(
    client,
    task,
    { kind: 'reconcile', task },
    false,
    'authority',
    'delivery:new-task',
    () => port,
    '2026-08-08T00:00:00.000Z',
  );

  assert.equal(loaded.ledger.generations.length, 0);
  assert.ok((await port.readTask(task))?.controllerState);
  assert.deepEqual(
    calls.map(({ method }) => method),
    ['GET', 'GET', 'GET', 'POST'],
  );
});

test('authority does not seed a pre-cutover task after its marker is removed', async () => {
  const port = new InMemoryStoragePort();
  const client = {
    requestOk: async (path) =>
      path.endsWith('/issues/304')
        ? { created_at: '2026-08-07T00:00:00.000Z' }
        : [],
  };

  await assert.rejects(
    () =>
      loadBrokerLedger(
        client,
        task,
        { kind: 'reconcile', task },
        false,
        'authority',
        'delivery:removed-marker',
        () => port,
        '2026-08-08T00:00:00.000Z',
      ),
    /no exact authoritative controller state/u,
  );
  assert.equal(await port.readTask(task), undefined);
});

test('authority ignores an ordinary pre-cutover pull request close with no compatibility projection', async () => {
  const port = new InMemoryStoragePort();
  const calls = [];
  const client = {
    requestOk: async (path, options = {}) => {
      calls.push({ path, method: options.method ?? 'GET' });
      return path.endsWith('/issues/304')
        ? { created_at: '2026-08-07T00:00:00.000Z' }
        : [
            {
              id: 9,
              body: renderLedgerComment(createLedger(task)),
              user: { login: 'agent-lcars[bot]', type: 'Bot' },
            },
          ];
    },
  };

  const loaded = await loadBrokerLedger(
    client,
    task,
    { kind: 'anchor-control' },
    true,
    'authority',
    'delivery:ordinary-pr-close',
    () => port,
    '2026-08-08T00:00:00.000Z',
  );

  assert.equal(loaded, undefined);
  assert.equal(await port.readTask(task), undefined);
  assert.deepEqual(
    calls.map(({ method }) => method),
    ['GET', 'GET'],
  );
});

test('authority fails closed for a tracked pull request control event that missed backfill', async () => {
  const port = new InMemoryStoragePort();
  const ledger = createLedger(task);
  const client = {
    requestOk: async () => [
      {
        id: 9,
        body: renderLedgerComment(ledger),
        user: { login: 'github-actions[bot]', type: 'Bot' },
      },
    ],
  };

  await assert.rejects(
    () =>
      loadBrokerLedger(
        client,
        task,
        { kind: 'anchor-control' },
        true,
        'authority',
        'delivery:tracked-pr-close',
        () => port,
        '2026-08-08T00:00:00.000Z',
      ),
    /no exact authoritative controller state/u,
  );
  assert.equal(await port.readTask(task), undefined);
});

test('tracked pull request close and reopen transitions persist to the existing ledger', async () => {
  let persistedBody = renderLedgerComment(
    createLedger(task, '2026-08-05T00:00:00.000Z'),
  );
  const calls = [];
  const client = {
    requestOk: async (path, options = {}) => {
      const method = options.method ?? 'GET';
      calls.push({ path, method });
      if (method === 'GET') {
        return [
          {
            id: 9,
            body: persistedBody,
            user: { login: 'github-actions[bot]', type: 'Bot' },
          },
        ];
      }
      if (method === 'PATCH' && path.endsWith('/issues/comments/9')) {
        persistedBody = options.body.body;
        return {
          id: 9,
          body: persistedBody,
          user: { login: 'github-actions[bot]', type: 'Bot' },
        };
      }
      throw new Error(`Unexpected API request: ${method} ${path}`);
    },
  };
  const normalizePullRequest = (action, updatedAt, merged, runId) =>
    normalizeEvent({
      eventName: 'pull_request',
      event: {
        action,
        pull_request: {
          id: 3040,
          number: task.issue,
          title: 'Tracked pull request',
          body: '',
          labels: [],
          updated_at: updatedAt,
          merged,
        },
        sender: { login: 'jlapenna' },
      },
      context: {
        ...task,
        runId,
        actor: 'jlapenna',
        now: updatedAt,
      },
      maintainer: 'jlapenna',
    });

  const closed = normalizePullRequest(
    'closed',
    '2026-08-05T00:01:00.000Z',
    true,
    9001,
  );
  const closedLedger = await loadBrokerLedger(client, task, closed, true);
  await applyAnchorControlTransition(client, closedLedger, closed.control);
  assert.equal(closedLedger.ledger.control.closed, true);
  assert.equal(closedLedger.ledger.control.merged, true);

  const reopened = normalizePullRequest(
    'reopened',
    '2026-08-05T00:02:00.000Z',
    false,
    9002,
  );
  const reopenedLedger = await loadBrokerLedger(client, task, reopened, true);
  await applyAnchorControlTransition(client, reopenedLedger, reopened.control);
  assert.equal(reopenedLedger.ledger.control.closed, false);
  assert.deepEqual(
    reopenedLedger.ledger.sources.map((source) => source.sourceKind),
    ['closed', 'reopened'],
  );
  assert.equal(calls.filter((call) => call.method === 'PATCH').length, 2);
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

test('healStaleAgentLabels resolves the stale label in the review:* namespace for a review-mode intent', async () => {
  const ledger = createLedger(task);
  const intent = {
    sourceId: 'timeline:501',
    transportRunId: 9001,
    pipeline: 'claude',
    mode: 'review',
    staleAgentLabels: ['review:codex'],
  };
  const { client, deleteCalls, saveCalls } = labelHealStubClient({
    currentLabels: ['review:claude', 'review:codex'],
  });
  await healStaleAgentLabels(client, { ledger, comment: { id: 9 } }, intent);
  assert.equal(deleteCalls.length, 1);
  assert.match(deleteCalls[0].path, /\/issues\/304\/labels\/review%3Acodex$/u);
  assert.equal(saveCalls.length, 1);
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
  // shape main.js's broker() consumes. A manual relabel produces a
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

test('authority renews its lease before every completion poll that can cross the original expiry', async () => {
  const port = new InMemoryStoragePort();
  const ledger = boundLedger();
  const startedAt = Date.now();
  let clock = startedAt;
  const authority = await acquireAuthority(
    port,
    task,
    'delivery:completion-poll',
    ledger,
    { now: () => new Date(clock).toISOString() },
  );
  let crossedOriginalExpiry = false;
  const client = {
    requestOk: async (path) => {
      if (path.endsWith('/actions/runs/42')) {
        if (clock - startedAt >= 120_000) {
          crossedOriginalExpiry = true;
          assert.ok(Date.parse(authority.session.lease.expiresAt) > clock);
          return workerRun('completed');
        }
        return workerRun();
      }
      if (path.includes('/issues/comments/9')) return { id: 9 };
      throw new Error(`Unexpected API path: ${path}`);
    },
  };

  await handleCompletion(
    client,
    {
      ledger: authority.ledger,
      comment: { id: 9 },
      authority: authority.session,
    },
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
    {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
  );

  assert.equal(crossedOriginalExpiry, true);
  assert.equal(authority.ledger.generations[0].state, 'completed');
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
function reconcileStubClient({ failParkStatus, issue, timeline } = {}) {
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
      if (path.includes(`/issues/${task.issue}/timeline`)) {
        return timeline ?? [];
      }
      if (path.endsWith(`/issues/${task.issue}`)) {
        return issue ?? { id: 9304, labels: [], assignees: [] };
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

test('reconcileLedger retries a durably pending launch after bounded run discovery instead of parking it', async () => {
  const port = new InMemoryStoragePort();
  const seed = dispatchingLedger().ledger;
  const authority = await acquireAuthority(
    port,
    task,
    'delivery:pending-launch-recovery',
    seed,
  );
  const generation = authority.ledger.generations[0];
  const attemptId = generation.attempt?.attemptId;
  assert.ok(attemptId);
  await port.recordLaunchIntent({
    operationId: attemptId,
    task,
    attemptId,
  });
  const { client, calls } = reconcileStubClient();
  const retriedRunId = 304736;
  client.request = async () => ({
    status: 200,
    data: {
      workflow_run_id: retriedRunId,
      run_url: `https://api.github.com/repos/jlapenna/agent-lcars/actions/runs/${retriedRunId}`,
      html_url: `https://github.com/jlapenna/agent-lcars/actions/runs/${retriedRunId}`,
    },
    headers: new Headers(),
  });
  const loaded = {
    ledger: authority.ledger,
    comment: { id: 9 },
    created: false,
    authority: authority.session,
    projectionAvailable: true,
  };
  const t1 = addMinutes(RECONCILE_T0, RECONCILE_MISSING_RUN_GRACE_MS / 60_000);
  const t2 = addMinutes(t1, RECONCILE_MISSING_RUN_MIN_INTERVAL_MS / 60_000);
  const t3 = addMinutes(t2, RECONCILE_MISSING_RUN_MIN_INTERVAL_MS / 60_000);

  await reconcileLedger(client, loaded, t1);
  await reconcileLedger(client, loaded, t2);
  await reconcileLedger(client, loaded, t3);

  assert.equal(loaded.ledger.generations[0].state, 'accepted');
  assert.equal(loaded.ledger.generations[0].attempt, undefined);
  assert.equal(
    loaded.ledger.anomalies.filter(
      (anomaly) => anomaly.kind === 'reconcile-launch-retry',
    ).length,
    1,
  );
  assert.equal(
    loaded.ledger.anomalies.some(
      (anomaly) => anomaly.kind === 'reconcile-parked',
    ),
    false,
  );
  assert.equal(
    calls.some((call) => call.path.endsWith('/labels')),
    false,
  );

  await dispatchAccepted(client, loaded);

  assert.equal(loaded.ledger.generations[0].state, 'active');
  assert.equal(loaded.ledger.generations[0].attempt?.runId, retriedRunId);
  assert.equal((await port.readLaunchOperation(attemptId))?.status, 'launched');
});

test('reconcileLedger abandons a closed anchor pending launch after bounded discovery without retrying or parking', async () => {
  const port = new InMemoryStoragePort();
  const seed = dispatchingLedger().ledger;
  applyAnchorControl(
    seed,
    {
      kind: 'closed',
      sourceId: 'closed:pending-launch',
      occurredAt: RECONCILE_T0,
      transportRunId: 304737,
      authorization: { observed: true, actor: 'dispatch-broker' },
      merged: false,
    },
    RECONCILE_T0,
  );
  const authority = await acquireAuthority(
    port,
    task,
    'delivery:closed-pending-launch',
    seed,
  );
  const attemptId = authority.ledger.generations[0].attempt?.attemptId;
  assert.ok(attemptId);
  await port.recordLaunchIntent({ operationId: attemptId, task, attemptId });
  const readLaunchOperation = port.readLaunchOperation.bind(port);
  let failNextOutboxRead = true;
  port.readLaunchOperation = async (operationId) => {
    if (failNextOutboxRead) {
      failNextOutboxRead = false;
      throw new Error('transient outbox read failure');
    }
    return readLaunchOperation(operationId);
  };
  const { client, calls } = reconcileStubClient();
  const loaded = {
    ledger: authority.ledger,
    comment: { id: 9 },
    created: false,
    authority: authority.session,
    projectionAvailable: true,
  };
  const t1 = addMinutes(RECONCILE_T0, RECONCILE_MISSING_RUN_GRACE_MS / 60_000);
  const t2 = addMinutes(t1, RECONCILE_MISSING_RUN_MIN_INTERVAL_MS / 60_000);
  const t3 = addMinutes(t2, RECONCILE_MISSING_RUN_MIN_INTERVAL_MS / 60_000);

  await reconcileLedger(client, loaded, t1, 304738, true);
  assert.equal(
    loaded.ledger.anomalies.length,
    0,
    'a failed outbox read must defer without consuming an observation',
  );
  await reconcileLedger(client, loaded, t1, 304738, true);
  await reconcileLedger(client, loaded, t2, 304739, true);
  await reconcileLedger(client, loaded, t3, 304740, true);

  assert.equal(loaded.ledger.generations[0].state, 'superseded-by-close');
  assert.equal(
    loaded.ledger.generations[0].attempt?.rejectionReason,
    'anchor closed before launch was observed',
  );
  assert.equal((await port.readLaunchOperation(attemptId))?.status, 'rejected');
  assert.equal(
    loaded.ledger.anomalies.filter(
      (anomaly) => anomaly.kind === 'reconcile-launch-abandoned',
    ).length,
    1,
  );
  assert.equal(
    loaded.ledger.anomalies.some(
      (anomaly) => anomaly.kind === 'reconcile-parked',
    ),
    false,
  );
  assert.equal(
    calls.some((call) => call.path.endsWith('/labels')),
    false,
  );
});

// --- reconcileActive / trackStuckRun (#645 Phase 3) --------------------

// A generation that is already bound to a worker run at RECONCILE_T0 --
// unlike dispatchingLedger() above, this starts past the point
// reconcileActive()'s own bind branch has anything to do, so every call
// below only ever exercises the run-status-check / trackStuckRun path.
function stuckDispatchLedger(now = RECONCILE_T0) {
  const ledger = createLedger(task);
  acceptIntent(
    ledger,
    {
      task,
      intentId: 'intent-1',
      sourceKind: 'manual',
      sourceId: 'source-1',
      transportRunId: 9001,
      occurredAt: now,
      pipeline: 'codex',
      mode: 'implement',
      runbook: '',
      context: '',
      digest: 'abc',
      authorization: { authorized: true },
    },
    now,
  );
  beginDispatch(ledger, 1, 'dispatch_token_123456', now);
  bindRun(
    ledger,
    1,
    {
      runId: 42,
      runUrl:
        'https://api.github.com/repos/jlapenna/agent-lcars/actions/runs/42',
      htmlUrl: 'https://github.com/jlapenna/agent-lcars/actions/runs/42',
      workflow: 'codex.yml',
    },
    now,
  );
  return { ledger, comment: { id: 9 } };
}

// Answers reconcileActive()'s own dependencies (findRunsForGeneration's
// list, getWorkflowRun's single-run GET, saveLedger's PATCH) plus
// ensureNeedsHumanParked's label/assignee POSTs -- same shape as
// reconcileStubClient above, adapted for reconcileActive's endpoints.
function stuckRunStubClient({ status = 'in_progress', failParkStatus } = {}) {
  const calls = [];
  const run = {
    id: 42,
    repository: { id: task.repositoryId },
    event: 'workflow_dispatch',
    path: '.github/workflows/codex.yml',
    display_title: '#304: Codex [dispatch:g1:intent-1]',
    status,
    conclusion: status === 'completed' ? 'success' : null,
    updated_at: RECONCILE_T0,
    url: 'https://api.github.com/repos/jlapenna/agent-lcars/actions/runs/42',
    html_url: 'https://github.com/jlapenna/agent-lcars/actions/runs/42',
  };
  const client = {
    requestOk: async (path, options = {}) => {
      calls.push({ path, method: options.method ?? 'GET' });
      if (path.includes('/workflows/codex.yml/runs?')) {
        return { workflow_runs: [run] };
      }
      if (path.endsWith('/actions/runs/42')) return run;
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
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  return { client, calls };
}

test('reconcileActive stays silent while a bound, still-running run is within its stuck-run grace period', async () => {
  const { ledger, comment } = stuckDispatchLedger();
  const { client, calls } = stuckRunStubClient();
  const now = addMinutes(
    RECONCILE_T0,
    RECONCILE_STUCK_RUN_GRACE_MS / 60_000 - 1,
  );
  await reconcileActive(client, { ledger, comment }, now);
  assert.equal(ledger.anomalies.length, 0);
  assert.equal(ledger.revision, 3); // unchanged since acceptIntent+beginDispatch+bindRun
  assert.equal(
    calls.some((call) => call.path.includes('/issues/comments/9')),
    false,
    'must not write the ledger while still inside grace',
  );
});

test('reconcileActive walks a stuck bound run through grace, idempotent re-observation, bounded escalation, and permanent parking (#645)', async () => {
  process.env.MAINTAINER_LOGIN = 'jlapenna';
  try {
    const loaded = stuckDispatchLedger();
    const { ledger } = loaded;
    const { client, calls } = stuckRunStubClient();

    // Pass 1: grace period has just elapsed -- first counted observation.
    const t1 = addMinutes(RECONCILE_T0, RECONCILE_STUCK_RUN_GRACE_MS / 60_000);
    await reconcileActive(client, loaded, t1);
    let stuck = ledger.anomalies.filter(
      (anomaly) => anomaly.kind === 'reconcile-stuck-run',
    );
    assert.equal(stuck.length, 1);
    assert.equal(stuck[0].detail.attempt, 1);
    assert.equal(stuck[0].detail.runId, 42);
    assert.equal(stuck[0].failure.owningSystem, 'runner');
    assert.equal(stuck[0].failure.reason, 'runner_lost');
    assert.equal(stuck[0].failure.retryDisposition, 'backoff');
    assert.equal(
      calls.some((call) => call.path.endsWith('/labels')),
      false,
      'must not park on the first observation',
    );

    // Pass 2: re-observed immediately after (same instant) -- idempotent
    // no-op, proving a duplicate/overlapping reconcile pass never
    // double-counts.
    const savesBefore = calls.filter((call) =>
      call.path.includes('/issues/comments/9'),
    ).length;
    await reconcileActive(client, loaded, t1);
    assert.equal(
      ledger.anomalies.filter(
        (anomaly) => anomaly.kind === 'reconcile-stuck-run',
      ).length,
      1,
      'a repeated pass at the same instant must not add a second observation',
    );
    assert.equal(
      calls.filter((call) => call.path.includes('/issues/comments/9')).length,
      savesBefore,
      'an idempotent no-op pass must not write the ledger again',
    );

    // Pass 3: still inside the min-observation-interval window -- still a
    // no-op even though time did pass.
    const tStillTooSoon = addMinutes(
      t1,
      RECONCILE_STUCK_RUN_MIN_INTERVAL_MS / 60_000 - 1,
    );
    await reconcileActive(client, loaded, tStillTooSoon);
    assert.equal(
      ledger.anomalies.filter(
        (anomaly) => anomaly.kind === 'reconcile-stuck-run',
      ).length,
      1,
    );

    // Pass 4: a full interval past the last COUNTED observation -- records
    // the second attempt.
    const t2 = addMinutes(t1, RECONCILE_STUCK_RUN_MIN_INTERVAL_MS / 60_000);
    await reconcileActive(client, loaded, t2);
    stuck = ledger.anomalies.filter(
      (anomaly) => anomaly.kind === 'reconcile-stuck-run',
    );
    assert.equal(stuck.length, 2);
    assert.equal(stuck[1].detail.attempt, 2);
    assert.equal(
      calls.some((call) => call.path.endsWith('/labels')),
      false,
      'still under the bound -- must not park yet',
    );

    // Pass 5: the third interval-separated observation reaches
    // RECONCILE_STUCK_RUN_MAX_ATTEMPTS -- parks needs-human + maintainer,
    // and records both the observation and a distinctly-kinded park anomaly.
    const t3 = addMinutes(t2, RECONCILE_STUCK_RUN_MIN_INTERVAL_MS / 60_000);
    await reconcileActive(client, loaded, t3);
    stuck = ledger.anomalies.filter(
      (anomaly) => anomaly.kind === 'reconcile-stuck-run',
    );
    assert.equal(stuck.length, RECONCILE_STUCK_RUN_MAX_ATTEMPTS);
    assert.equal(stuck[2].detail.attempt, RECONCILE_STUCK_RUN_MAX_ATTEMPTS);
    const parked = ledger.anomalies.filter(
      (anomaly) => anomaly.kind === 'reconcile-stuck-run-parked',
    );
    assert.equal(parked.length, 1);
    assert.equal(parked[0].detail.generation, 1);
    assert.equal(parked[0].failure.retryDisposition, 'manual');
    // Distinct kind from trackMissingRun's own park anomaly, so the two
    // orphan classes are distinguishable in the ledger.
    assert.equal(
      ledger.anomalies.some((anomaly) => anomaly.kind === 'reconcile-parked'),
      false,
    );
    assert.ok(calls.some((call) => call.path.endsWith('/labels')));
    assert.ok(calls.some((call) => call.path.endsWith('/assignees')));

    // Pass 6+: parked is permanent -- every later pass, at any later time,
    // is a true no-op: no ledger mutation, and no further park calls.
    const revisionBeforeFinal = ledger.revision;
    const parkCallsBeforeFinal = calls.filter((call) =>
      call.path.endsWith('/labels'),
    ).length;
    await reconcileActive(
      client,
      loaded,
      addMinutes(t3, 10 * RECONCILE_STUCK_RUN_MIN_INTERVAL_MS),
    );
    assert.equal(ledger.revision, revisionBeforeFinal);
    assert.equal(
      calls.filter((call) => call.path.endsWith('/labels')).length,
      parkCallsBeforeFinal,
    );
  } finally {
    delete process.env.MAINTAINER_LOGIN;
  }
});

test('trackStuckRun leaves the ledger untouched when the park mutation genuinely fails, so a retry reuses the same attempt number', async () => {
  process.env.MAINTAINER_LOGIN = 'jlapenna';
  try {
    const loaded = stuckDispatchLedger();
    const { ledger } = loaded;
    const { client: healthyClient } = stuckRunStubClient();
    const { client: failingClient } = stuckRunStubClient({
      failParkStatus: 403,
    });

    const t1 = addMinutes(RECONCILE_T0, RECONCILE_STUCK_RUN_GRACE_MS / 60_000);
    await reconcileActive(healthyClient, loaded, t1);
    const t2 = addMinutes(t1, RECONCILE_STUCK_RUN_MIN_INTERVAL_MS / 60_000);
    await reconcileActive(healthyClient, loaded, t2);
    assert.equal(
      ledger.anomalies.filter(
        (anomaly) => anomaly.kind === 'reconcile-stuck-run',
      ).length,
      2,
    );

    // Attempt 3 reaches the bound; the park mutation itself fails --
    // reconcileActive must reject, and the ledger must record NEITHER the
    // third observation NOR a park, so the next pass retries at attempt 3
    // again rather than skipping it.
    const t3 = addMinutes(t2, RECONCILE_STUCK_RUN_MIN_INTERVAL_MS / 60_000);
    await assert.rejects(() => reconcileActive(failingClient, loaded, t3));
    assert.equal(
      ledger.anomalies.filter(
        (anomaly) => anomaly.kind === 'reconcile-stuck-run',
      ).length,
      2,
      'a failed park attempt must not record a partial observation',
    );
    assert.equal(
      ledger.anomalies.some(
        (anomaly) => anomaly.kind === 'reconcile-stuck-run-parked',
      ),
      false,
    );

    // Retry with a healthy client at the same instant: since nothing was
    // recorded, the interval gate does not block it, and it succeeds.
    await reconcileActive(healthyClient, loaded, t3);
    assert.equal(
      ledger.anomalies.filter(
        (anomaly) => anomaly.kind === 'reconcile-stuck-run',
      ).length,
      3,
    );
    assert.equal(
      ledger.anomalies.some(
        (anomaly) => anomaly.kind === 'reconcile-stuck-run-parked',
      ),
      true,
    );
  } finally {
    delete process.env.MAINTAINER_LOGIN;
  }
});

test('reconcileActive terminalizes a run that completes normally before the stuck-run bound, recording no stuck-run anomaly at all', async () => {
  const loaded = stuckDispatchLedger();
  const { ledger } = loaded;
  const { client: runningClient } = stuckRunStubClient();

  // One counted stuck-run observation, well before the bound.
  const t1 = addMinutes(RECONCILE_T0, RECONCILE_STUCK_RUN_GRACE_MS / 60_000);
  await reconcileActive(runningClient, loaded, t1);
  assert.equal(
    ledger.anomalies.filter((anomaly) => anomaly.kind === 'reconcile-stuck-run')
      .length,
    1,
  );

  // The run then genuinely finishes -- GitHub now reports it completed.
  // reconcileActive must terminalize it via completeRun(), the same as any
  // ordinary completion, and must never add a second stuck-run observation
  // or a park for a generation that just reached its real terminal state.
  const { client: completedClient } = stuckRunStubClient({
    status: 'completed',
  });
  const t2 = addMinutes(t1, RECONCILE_STUCK_RUN_MIN_INTERVAL_MS / 60_000);
  await reconcileActive(completedClient, loaded, t2);
  assert.equal(ledger.generations[0].state, 'completed');
  assert.equal(
    ledger.anomalies.filter((anomaly) => anomaly.kind === 'reconcile-stuck-run')
      .length,
    1,
    'a run that reaches its real terminal state must not accrue a second observation',
  );
  assert.equal(
    ledger.anomalies.some(
      (anomaly) => anomaly.kind === 'reconcile-stuck-run-parked',
    ),
    false,
    'a normally-terminalized run must never be parked',
  );
});

test('reconcileLedger no-ops on an empty ledger when the live issue carries no agent label', async () => {
  const ledger = createLedger(task);
  const { client } = reconcileStubClient({
    issue: { id: 9304, labels: [], assignees: [] },
  });
  await reconcileLedger(client, { ledger, comment: { id: 9 } });
  assert.equal(ledger.anomalies.length, 0);
  assert.equal(ledger.generations.length, 0);
});

test('reconcileLedger no-ops on an empty ledger when the live issue carries contradictory agent labels', async () => {
  const ledger = createLedger(task);
  const { client } = reconcileStubClient({
    issue: {
      id: 9304,
      labels: [{ name: 'agent:codex' }, { name: 'agent:claude' }],
      assignees: [],
    },
  });
  await reconcileLedger(client, { ledger, comment: { id: 9 } });
  assert.equal(ledger.anomalies.length, 0);
  assert.equal(ledger.generations.length, 0);
});

// The repair's own authorization check (Codex review, P1) needs a
// timeline entry showing WHO most recently applied the label, mirroring
// what a live `labeled` event's `event.sender` would carry.
function maintainerLabelTimeline(login = 'jlapenna') {
  return [
    {
      event: 'labeled',
      label: { name: 'agent:codex' },
      actor: { login },
      created_at: '2026-08-04T05:59:00.000Z',
    },
  ];
}

test('reconcileLedger repairs a queue-evicted labeled intent: empty ledger + a live, unambiguous agent label applied by the maintainer (#520)', async () => {
  process.env.MAINTAINER_LOGIN = 'jlapenna';
  try {
    const ledger = createLedger(task);
    const { client, calls } = reconcileStubClient({
      issue: { id: 9304, labels: [{ name: 'agent:codex' }], assignees: [] },
      timeline: maintainerLabelTimeline(),
    });
    const now = '2026-08-04T06:00:00.000Z';
    await reconcileLedger(
      client,
      { ledger, comment: { id: 9 } },
      now,
      30880000,
    );

    assert.equal(ledger.generations.length, 1);
    const generation = ledger.generations[0];
    assert.equal(generation.pipeline, 'codex');
    assert.equal(generation.state, 'accepted');
    assert.equal(
      ledger.sources.some(
        (source) =>
          source.sourceKind === 'reconcile-label-repair' &&
          source.sourceId === 'reconcile-label-repair:9304',
      ),
      true,
    );
    assert.ok(
      calls.some(
        (call) => call.method === 'GET' && call.path.endsWith('/issues/304'),
      ),
    );
  } finally {
    delete process.env.MAINTAINER_LOGIN;
  }
});

test('reconcileLedger repair falls through to the review:* namespace on a pull request with no agent:* label (#567)', async () => {
  process.env.MAINTAINER_LOGIN = 'jlapenna';
  try {
    const ledger = createLedger(task);
    const { client, calls } = reconcileStubClient({
      issue: {
        id: 9304,
        pull_request: {},
        labels: [{ name: 'review:codex' }],
        assignees: [],
      },
      timeline: [
        {
          event: 'labeled',
          label: { name: 'review:codex' },
          actor: { login: 'jlapenna' },
          created_at: '2026-08-04T05:59:00.000Z',
        },
      ],
    });
    const now = '2026-08-04T06:00:00.000Z';
    await reconcileLedger(
      client,
      { ledger, comment: { id: 9 } },
      now,
      30880000,
    );

    assert.equal(ledger.generations.length, 1);
    const generation = ledger.generations[0];
    assert.equal(generation.pipeline, 'codex');
    assert.equal(generation.mode, 'review');
    assert.ok(
      calls.some(
        (call) => call.method === 'GET' && call.path.endsWith('/issues/304'),
      ),
    );
  } finally {
    delete process.env.MAINTAINER_LOGIN;
  }
});

test('reconcileLedger repair does NOT fire when the label was most recently applied by a non-maintainer (Codex review P1, #520)', async () => {
  process.env.MAINTAINER_LOGIN = 'jlapenna';
  try {
    const ledger = createLedger(task);
    const { client, calls } = reconcileStubClient({
      issue: { id: 9304, labels: [{ name: 'agent:codex' }], assignees: [] },
      timeline: maintainerLabelTimeline('some-other-collaborator'),
    });
    const now = '2026-08-04T06:00:00.000Z';
    await reconcileLedger(
      client,
      { ledger, comment: { id: 9 } },
      now,
      30880000,
    );

    assert.equal(ledger.generations.length, 0);
    assert.equal(
      calls.some((call) => call.method !== 'GET'),
      false,
      'a non-maintainer-applied label must never dispatch anything',
    );
  } finally {
    delete process.env.MAINTAINER_LOGIN;
  }
});

test('reconcileLedger repair does NOT fire when the issue timeline has no matching labeled event at all', async () => {
  process.env.MAINTAINER_LOGIN = 'jlapenna';
  try {
    const ledger = createLedger(task);
    const { client } = reconcileStubClient({
      issue: { id: 9304, labels: [{ name: 'agent:codex' }], assignees: [] },
      timeline: [],
    });
    const now = '2026-08-04T06:00:00.000Z';
    await reconcileLedger(
      client,
      { ledger, comment: { id: 9 } },
      now,
      30880000,
    );
    assert.equal(ledger.generations.length, 0);
  } finally {
    delete process.env.MAINTAINER_LOGIN;
  }
});

test('reconcileLedger repair pages through the full timeline: a non-maintainer relabel past the first 100 entries still blocks the repair (Codex review P1 follow-up, #520)', async () => {
  process.env.MAINTAINER_LOGIN = 'jlapenna';
  try {
    // Page 1: 100 old, irrelevant timeline events plus a maintainer-applied
    // labeling of agent:codex -- what a single per_page=100 read alone
    // would see and (wrongly) trust as "most recent".
    const page1 = Array.from({ length: 99 }, (_, index) => ({
      event: 'commented',
      created_at: `2026-08-01T00:${String(index).padStart(2, '0')}:00.000Z`,
    }));
    page1.push({
      event: 'labeled',
      label: { name: 'agent:codex' },
      actor: { login: 'jlapenna' },
      created_at: '2026-08-04T05:00:00.000Z',
    });
    // Page 2: a genuinely later re-application of the same label by a
    // non-maintainer -- the actual most-recent event, only reachable by
    // paging past the first 100.
    const page2 = [
      {
        event: 'unlabeled',
        label: { name: 'agent:codex' },
        actor: { login: 'jlapenna' },
        created_at: '2026-08-04T05:30:00.000Z',
      },
      {
        event: 'labeled',
        label: { name: 'agent:codex' },
        actor: { login: 'some-other-collaborator' },
        created_at: '2026-08-04T05:59:00.000Z',
      },
    ];
    const calls = [];
    const client = {
      requestOk: async (path, options = {}) => {
        calls.push({ path, method: options.method ?? 'GET' });
        if (path.includes(`/issues/${task.issue}/timeline`)) {
          const pageParam = new URL(`https://x${path}`).searchParams.get(
            'page',
          );
          return pageParam === '2' ? page2 : page1;
        }
        if (path.endsWith(`/issues/${task.issue}`)) {
          return { id: 9304, labels: [{ name: 'agent:codex' }] };
        }
        throw new Error(`Unexpected API path: ${path}`);
      },
    };
    const ledger = createLedger(task);
    const now = '2026-08-04T06:00:00.000Z';
    await reconcileLedger(
      client,
      { ledger, comment: { id: 9 } },
      now,
      30880000,
    );

    assert.equal(
      ledger.generations.length,
      0,
      'the true most-recent (non-maintainer) label application lives on page 2 and must block the repair',
    );
    assert.ok(
      calls.some((call) => call.path.includes('page=2')),
      'expected the repair to actually page past the first 100 timeline entries',
    );
  } finally {
    delete process.env.MAINTAINER_LOGIN;
  }
});

test('reconcileLedger repair is idempotent: a second reconcile pass creates no second generation', async () => {
  process.env.MAINTAINER_LOGIN = 'jlapenna';
  try {
    const ledger = createLedger(task);
    const { client } = reconcileStubClient({
      issue: { id: 9304, labels: [{ name: 'agent:codex' }], assignees: [] },
      timeline: maintainerLabelTimeline(),
    });
    const now = '2026-08-04T06:00:00.000Z';
    await repairMissingIntentFromLabel(
      client,
      { ledger, comment: { id: 9 } },
      now,
      30880000,
    );
    assert.equal(ledger.generations.length, 1);
    const revisionAfterRepair = ledger.revision;

    // A second reconcile pass (e.g. the next scheduled scan, 30 minutes
    // later) must not touch the ledger again: generations is no longer
    // empty, so the repair branch's own gate excludes it, and the resulting
    // 'accepted' generation isn't in a dispatching/dispatch-unknown state
    // reconcileActive()/trackMissingRun() would otherwise act on either.
    await reconcileLedger(
      client,
      { ledger, comment: { id: 9 } },
      now,
      30882222,
    );
    assert.equal(ledger.generations.length, 1);
    assert.equal(ledger.revision, revisionAfterRepair);
  } finally {
    delete process.env.MAINTAINER_LOGIN;
  }
});

test('reconcileLedger repair honors a Quick Task marker for its intentId (dedupes against the original opened-event intent)', async () => {
  process.env.MAINTAINER_LOGIN = 'jlapenna';
  try {
    const ledger = createLedger(task);
    const description = 'Do the thing';
    const digest = digestQuickTask({
      repository: task.repository,
      pipeline: 'codex',
      title: 'Quick task issue',
      description,
    });
    const requestId = '11111111-1111-4111-8111-111111111111';
    const { client } = reconcileStubClient({
      issue: {
        id: 9304,
        title: 'Quick task issue',
        body: `${description}\n\n<!-- agent-lcars:quick-task-request:v1 id=${requestId} digest=${digest} -->`,
        labels: [{ name: 'agent:codex' }],
        assignees: [],
      },
      timeline: maintainerLabelTimeline(),
    });
    const now = '2026-08-04T06:00:00.000Z';
    await reconcileLedger(
      client,
      { ledger, comment: { id: 9 } },
      now,
      30880000,
    );

    assert.equal(ledger.generations.length, 1);
    assert.equal(
      ledger.generations[0].intentId,
      `quick:${requestId}:${digest}`,
    );
  } finally {
    delete process.env.MAINTAINER_LOGIN;
  }
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
    // Construct the otherwise-unreachable state directly: broker.js's own
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

// --- reconcileControlState / closed-anchor convergence (#663) -----------
//
// The success-path bug: GitHub closes an anchor (an automerge-linked PR's
// `Fixes #N` auto-close, or agent-automerge.yml's own `gh issue close`
// backstop) using GITHUB_TOKEN, whose recursion guard drops the resulting
// `issues.closed`/`pull_request.closed` webhook before agent-router.yml
// ever sees it -- so applyAnchorControlTransition (the live path's own
// write) never runs and `control.closed` stays stale forever. These tests
// exercise the read-and-catch-up half: `issueClosed`, threaded from
// normalize.mjs's ReconcileEvent, is what a bounded closed-issue sweep
// (listRecentlyClosedAgentLabeledIssues, github-api.mjs) puts back in front
// of a reconcile pass.

function completedLedger() {
  const ledger = boundLedger();
  completeRun(ledger, 1, {
    runId: 42,
    status: 'completed',
    conclusion: 'success',
  });
  return ledger;
}

test('reconcileControlState converges a closed issue whose ledger still says control.closed: false, writing through the same applyAnchorControl path a live close event uses (#663)', async () => {
  const ledger = completedLedger();
  assert.equal(ledger.control.closed, false);
  const revisionBefore = ledger.revision;
  const { client, calls } = reconcileStubClient();
  const isClosed = await reconcileControlState(
    client,
    { ledger, comment: { id: 9 } },
    true,
    '2026-08-07T19:00:00.000Z',
    30990000,
  );
  assert.equal(isClosed, true);
  assert.equal(ledger.control.closed, true);
  assert.ok(
    ledger.revision > revisionBefore,
    'a genuine convergence must write the ledger',
  );
  assert.ok(
    ledger.sources.some(
      (source) =>
        source.sourceKind === 'closed' &&
        source.sourceId.startsWith('reconcile-control:'),
    ),
    'must record evidence through the same source vocabulary a live close event uses',
  );
  assert.ok(
    calls.some((call) => call.path.includes('/issues/comments/9')),
    'a genuine convergence must save the ledger comment',
  );
});

test('reconcileControlState is a no-op when the ledger already agrees with the live closed state: no ledger write, no revision churn (#663)', async () => {
  const ledger = completedLedger();
  // Converge once, as an earlier reconcile pass would have.
  await reconcileControlState(
    reconcileStubClient().client,
    { ledger, comment: { id: 9 } },
    true,
    '2026-08-07T19:00:00.000Z',
    30990000,
  );
  assert.equal(ledger.control.closed, true);
  const revisionAfterFirstConvergence = ledger.revision;

  // A second pass observing the same live state must change nothing.
  const { client, calls } = reconcileStubClient();
  const isClosed = await reconcileControlState(
    client,
    { ledger, comment: { id: 9 } },
    true,
    '2026-08-07T19:30:00.000Z',
    30990001,
  );
  assert.equal(isClosed, true);
  assert.equal(ledger.revision, revisionAfterFirstConvergence);
  assert.equal(
    calls.length,
    0,
    'an already-converged closed issue must not touch the ledger at all',
  );
});

test("reconcileControlState falls back to the ledger's own last-known control.closed when the live issue state is unknown (issueClosed undefined)", async () => {
  const openLedger = boundLedger();
  const { client, calls } = reconcileStubClient();
  const result = await reconcileControlState(
    client,
    { ledger: openLedger, comment: { id: 9 } },
    undefined,
    '2026-08-07T19:00:00.000Z',
    30990000,
  );
  assert.equal(result, false);
  assert.equal(calls.length, 0);

  const closedLedger = completedLedger();
  closedLedger.control = { closed: true };
  const result2 = await reconcileControlState(
    client,
    { ledger: closedLedger, comment: { id: 9 } },
    undefined,
    '2026-08-07T19:00:00.000Z',
    30990000,
  );
  assert.equal(result2, true);
});

test('reconcileControlState converges a reopened issue whose ledger still says control.closed: true, mirroring the closed direction (#663)', async () => {
  const ledger = completedLedger();
  await reconcileControlState(
    reconcileStubClient().client,
    { ledger, comment: { id: 9 } },
    true,
    '2026-08-07T19:00:00.000Z',
    30990000,
  );
  assert.equal(ledger.control.closed, true);

  const { client, calls } = reconcileStubClient();
  const isClosed = await reconcileControlState(
    client,
    { ledger, comment: { id: 9 } },
    false,
    '2026-08-07T20:00:00.000Z',
    30990002,
  );
  assert.equal(isClosed, false);
  assert.equal(ledger.control.closed, false);
  assert.ok(ledger.sources.some((source) => source.sourceKind === 'reopened'));
  assert.ok(calls.some((call) => call.path.includes('/issues/comments/9')));
});

test('reconciling a closed issue never dispatches a new generation, whatever its labels say -- even an empty ledger with an unambiguous, maintainer-applied agent:* label the #520 repair would otherwise act on (#663)', async () => {
  process.env.MAINTAINER_LOGIN = 'jlapenna';
  try {
    const ledger = createLedger(task);
    // Exactly the fixture 'reconcileLedger repairs a queue-evicted labeled
    // intent' (#520, above) uses to PROVE repairMissingIntentFromLabel DOES
    // create a fresh 'accepted' generation for an open issue -- the only
    // difference here is `issueClosed: true`.
    const { client, calls } = reconcileStubClient({
      issue: { id: 9304, labels: [{ name: 'agent:codex' }], assignees: [] },
      timeline: maintainerLabelTimeline(),
    });
    const now = '2026-08-04T06:00:00.000Z';
    await reconcileLedger(
      client,
      { ledger, comment: { id: 9 } },
      now,
      30880000,
      /* issueClosed */ true,
    );

    assert.equal(
      ledger.generations.length,
      0,
      'a closed issue must never gain a fresh generation, regardless of its live labels',
    );
    assert.equal(ledger.control.closed, true);
    assert.equal(
      calls.some((call) => call.path.includes('/issues/304/timeline')),
      false,
      'must never even consult the label timeline once the issue is known closed',
    );

    // Second, independent layer: even if a generation had somehow been
    // created anyway, dispatchAccepted's own gate must refuse to dispatch
    // it once control.closed is true -- prove that directly with a client
    // that throws on any call at all, so a dispatch attempt fails the test
    // loudly instead of silently succeeding.
    const explosiveClient = {
      requestOk: async (path) => {
        throw new Error(`Must never call GitHub while closed: ${path}`);
      },
      request: async (path) => {
        throw new Error(`Must never dispatch while closed: ${path}`);
      },
    };
    await dispatchAccepted(explosiveClient, { ledger, comment: { id: 9 } });
    assert.equal(ledger.generations.length, 0);
  } finally {
    delete process.env.MAINTAINER_LOGIN;
  }
});

test('reconcileLedger with issueClosed: false (the live, common case for an open issue) still repairs a queue-evicted labeled intent exactly as before -- open-issue reconcile behavior is unchanged (#663)', async () => {
  process.env.MAINTAINER_LOGIN = 'jlapenna';
  try {
    const ledger = createLedger(task);
    const { client } = reconcileStubClient({
      issue: { id: 9304, labels: [{ name: 'agent:codex' }], assignees: [] },
      timeline: maintainerLabelTimeline(),
    });
    const now = '2026-08-04T06:00:00.000Z';
    await reconcileLedger(
      client,
      { ledger, comment: { id: 9 } },
      now,
      30880000,
      /* issueClosed */ false,
    );

    assert.equal(ledger.generations.length, 1);
    assert.equal(ledger.generations[0].pipeline, 'codex');
    assert.equal(ledger.generations[0].state, 'accepted');
    assert.equal(ledger.control.closed, false);
  } finally {
    delete process.env.MAINTAINER_LOGIN;
  }
});

// findRunsForGeneration matches by display-title marker, not run id (see
// displayTitleMatchesAttempt in dispatch-contracts) -- two runs carrying
// the identical `[dispatch:g1:intent-1]` marker is exactly what
// reconcileActive()'s own duplicate-attempt anomaly detects and throws on,
// entirely independent of whether the anchor itself is open or closed.
function duplicateAttemptStubClient() {
  const calls = [];
  const makeRun = (id) => ({
    id,
    repository: { id: task.repositoryId },
    event: 'workflow_dispatch',
    path: '.github/workflows/codex.yml',
    display_title: '#304: Codex [dispatch:g1:intent-1]',
    status: 'in_progress',
    conclusion: null,
    updated_at: '2026-08-01T00:03:00.000Z',
    url: `https://api.github.com/repos/jlapenna/agent-lcars/actions/runs/${id}`,
    html_url: `https://github.com/jlapenna/agent-lcars/actions/runs/${id}`,
  });
  const client = {
    requestOk: async (path, options = {}) => {
      calls.push({ path, method: options.method ?? 'GET' });
      if (path.includes('/workflows/codex.yml/runs?')) {
        return { workflow_runs: [makeRun(42), makeRun(43)] };
      }
      if (path.includes('/issues/comments/9')) return { id: 9 };
      throw new Error(`Unexpected API path: ${path}`);
    },
  };
  return { client, calls };
}

test('an anchor whose reconcileActive() throws on an unrelated duplicate-attempt anomaly still converges control.closed, because broker() now converges it first -- and the anomaly still surfaces rather than being swallowed (#715 Codex P2 on #645/#663)', async () => {
  // Reproduces broker()'s new composition for a `reconcile` event carrying
  // `issueClosed: true` (see broker() in main.mjs): reconcileControlState()
  // now runs BEFORE reconcileActive(), specifically so an anomaly in the
  // anchor's own active generation -- unrelated to whether the anchor is
  // closed -- can never again starve control-state convergence the way it
  // did before #715 (every later reconcile pass would re-observe the same
  // anomaly, reconcileActive() would throw again before reconcileLedger()
  // was ever reached, and control.closed would never become true).
  const ledger = boundLedger();
  assert.equal(ledger.control.closed, false);
  const loaded = { ledger, comment: { id: 9 } };
  const { client, calls } = duplicateAttemptStubClient();

  const isClosed = await reconcileControlState(
    client,
    loaded,
    /* issueClosed */ true,
    '2026-08-07T19:00:00.000Z',
    30990000,
  );
  assert.equal(isClosed, true);
  assert.equal(
    ledger.control.closed,
    true,
    'control state must converge before reconcileActive() ever runs',
  );
  assert.ok(
    calls.some((call) => call.path.includes('/issues/comments/9')),
    'the convergence write must have actually landed',
  );

  // reconcileActive() still runs next, exactly as broker() does, and still
  // throws on the unrelated duplicate-attempt anomaly -- that anomaly is a
  // genuine, distinct problem (>1 worker run bound to one generation) this
  // fix does not paper over; it must still surface, not be swallowed
  // (broker()'s own catch routes any throw here to failClosed(), which
  // always parks needs-human AND rethrows -- see failClosed in
  // github-api.mjs).
  await assert.rejects(
    () => reconcileActive(client, loaded),
    /Multiple worker runs match one dispatch generation/,
  );
  assert.ok(
    ledger.anomalies.some((anomaly) => anomaly.kind === 'duplicate-attempt'),
    'the unrelated anomaly must still be recorded, not silently dropped',
  );

  // The earlier convergence must survive the later throw untouched -- the
  // whole point of running it first.
  assert.equal(ledger.control.closed, true);
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

// PR #374 review (P2): an unbounded Promise.allSettled over a large
// fleet-assignee discovery backlog fired one workflow_dispatch POST per
// candidate simultaneously, risking GitHub's secondary rate limits.
test('dispatchReconcileScan bounds concurrent workflow_dispatch POSTs to RECONCILE_DISPATCH_CONCURRENCY while still dispatching every candidate', async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const client = {
    request: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls += 1;
      const runId = 700 + calls;
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {
        status: 200,
        data: {
          workflow_run_id: runId,
          run_url: `https://api.github.com/repos/jlapenna/agent-lcars/actions/runs/${runId}`,
          html_url: `https://github.com/jlapenna/agent-lcars/actions/runs/${runId}`,
        },
      };
    },
  };
  const issueNumbers = Array.from(
    { length: RECONCILE_DISPATCH_CONCURRENCY * 3 + 1 },
    (_, index) => 400 + index,
  );
  const results = await dispatchReconcileScan(
    client,
    'jlapenna/agent-lcars',
    issueNumbers,
  );
  assert.equal(results.dispatched, issueNumbers.length);
  assert.equal(results.failed.length, 0);
  assert.equal(active, 0);
  assert.ok(
    maxActive <= RECONCILE_DISPATCH_CONCURRENCY,
    `expected at most ${RECONCILE_DISPATCH_CONCURRENCY} concurrent dispatches, saw ${maxActive}`,
  );
  assert.equal(
    maxActive,
    RECONCILE_DISPATCH_CONCURRENCY,
    'expected the pool to actually reach its concurrency limit given a backlog larger than it',
  );
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
        url.includes('labels=agent%3Aopencode') ||
        url.includes('labels=review%3Aclaude') ||
        url.includes('labels=review%3Acodex') ||
        url.includes('labels=review%3Aopencode')
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

// --- discoverRecentlyClosedReconcileCandidates (#715 review: closed
// counterpart to the fleet-assignee lane) --------------------------------

test('discoverRecentlyClosedReconcileCandidates discovers a closed, fleet-assigned, unlabeled anchor merged with closed labeled candidates, and that anchor then converges control.closed (#715 Codex P2 on #645/#663)', async () => {
  // Issue #500: closed via GITHUB_TOKEN (agent-automerge.yml's `gh issue
  // close` backstop, or an automerge-linked PR's `Fixes #N` auto-close)
  // after its last agent:* label was already removed while its worker was
  // still active -- exactly the case listRecentlyClosedIssuesAssignedTo
  // exists to cover, mirroring listOpenIssuesAssignedTo's own open-side
  // coverage (#363 review). Issue #304 is the ordinary, still-labeled
  // closed case listRecentlyClosedAgentLabeledIssues already covered
  // before this fix.
  const seenUrls = [];
  const client = {
    requestOk: async (url) => {
      seenUrls.push(url);
      if (url.includes('labels=agent%3Aclaude')) {
        return [{ number: 304 }];
      }
      if (
        url.includes('labels=agent%3Acodex') ||
        url.includes('labels=agent%3Aopencode') ||
        url.includes('labels=review%3Aclaude') ||
        url.includes('labels=review%3Acodex') ||
        url.includes('labels=review%3Aopencode')
      ) {
        return [];
      }
      if (url.includes('assignee=jclaw-bot')) {
        assert.ok(url.includes('state=closed'));
        return [{ number: 500 }];
      }
      throw new Error(`Unexpected API path: ${url}`);
    },
  };
  const candidates = await discoverRecentlyClosedReconcileCandidates(
    client,
    'jlapenna/agent-lcars',
    'jclaw-bot',
    '2026-08-07T12:00:00.000Z',
  );
  assert.deepEqual(
    candidates.map((issue) => issue.number),
    [304, 500],
  );
  assert.ok(seenUrls.some((url) => url.includes('assignee=jclaw-bot')));

  // Discovery alone only proves the anchor is back in front of a reconcile
  // pass; the repair this whole PR is about is that such a pass then
  // converges the ledger's own control.closed copy. Prove that second half
  // directly: exactly what a `reconcile` event for issue #500, carrying
  // `issueClosed: true`, does to its ledger.
  const ledger = boundLedger();
  assert.equal(ledger.control.closed, false);
  const isClosed = await reconcileControlState(
    reconcileStubClient().client,
    { ledger, comment: { id: 9 } },
    true,
    '2026-08-07T12:00:01.000Z',
    30990000,
  );
  assert.equal(isClosed, true);
  assert.equal(ledger.control.closed, true);
});

test('discoverRecentlyClosedReconcileCandidates dedupes an issue that is both closed-labeled and closed-fleet-assigned', async () => {
  const client = {
    requestOk: async (url) => {
      if (url.includes('labels=agent%3Aclaude')) return [{ number: 304 }];
      if (url.includes('labels=')) return [];
      if (url.includes('assignee=')) return [{ number: 304 }];
      throw new Error(`Unexpected API path: ${url}`);
    },
  };
  const candidates = await discoverRecentlyClosedReconcileCandidates(
    client,
    'jlapenna/agent-lcars',
    'jclaw-bot',
  );
  assert.deepEqual(
    candidates.map((issue) => issue.number),
    [304],
  );
});

test('discoverRecentlyClosedReconcileCandidates skips the closed fleet-assignee lane entirely when no fleet login is configured', async () => {
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
  const candidates = await discoverRecentlyClosedReconcileCandidates(
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

// Run 9002's display_title carries the router-group marker (#545) -- what
// makes it, from `findConflictingRouterRun`'s point of view, a genuine
// candidate for `task`'s group -- and its `broker` job is `in_progress`,
// which is what actually makes it a conflict: the marker alone only narrows
// candidates, the per-candidate jobs listing decides (see the long comment
// above `findConflictingRouterRun` in github-api.mjs). It is ALSO checked
// against `/actions/runs/9002/concurrency_groups` -- what
// `findSupersedingRouterRun` (untouched by that fix) separately still needs
// to positively corroborate an eviction. `holds` controls only the latter.
function supersedingClient(group, { holds = true } = {}) {
  const marker = formatRouterGroupMarker({
    repositoryId: task.repositoryId,
    issue: task.issue,
  });
  return {
    requestOk: async (path) => {
      if (path.includes('/workflows/agent-router.yml/runs?')) {
        return {
          workflow_runs: [
            {
              id: 9002,
              display_title: `route #304: labeled agent:codex ${marker}`,
            },
          ],
        };
      }
      if (path.includes('/actions/runs/9002/jobs')) {
        return { jobs: [{ name: 'broker', status: 'in_progress' }] };
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
// fake API where a genuinely newer router run (9002) carries this run's
// (9001) expected group's router-group marker (#545) -- indistinguishable,
// from the dispatch run's own perspective, from ordinary contention.
// Retries exhaust into a retryable BrokerConcurrencyMismatchError, proving
// #348's indirect verification path feeds the exact same error shape
// #345/#347's eviction handling already expects, regardless of which
// concrete signal (previously per-run concurrency_groups self-listing,
// now the router-group marker) produced it.
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

// #645 Phase 2 module failure isolation: runPhase() classifies, records,
// and rethrows a fallible controller step's own exception rather than
// letting it propagate as a bare, unattributed crash.

function savingStubClient({ failSave = false } = {}) {
  const saves = [];
  const client = {
    requestOk: async (path, options = {}) => {
      if (options.method === 'PATCH' && path.includes('/issues/comments/9')) {
        if (failSave) throw new GitHubApiError('save failed', 500);
        saves.push(options.body);
        return { id: 9 };
      }
      throw new Error(`Unexpected API call: ${path}`);
    },
  };
  return { client, saves };
}

function captureLogs() {
  const logs = [];
  const originalLog = console.log;
  console.log = (message) => logs.push(message);
  return {
    logs,
    restore: () => {
      console.log = originalLog;
    },
  };
}

test('runPhase attributes and records a Quick Task digest mismatch instead of letting it crash normalization unattributed (#645 Phase 2)', async () => {
  // The concrete regression case #645 Phase 2 names: a Quick Task digest
  // mismatch (quickTaskRequest, called from normalizeEvent in
  // normalize.mjs) used to crash normalize()'s call to normalizeEvent() as
  // a bare, unattributed exception -- no phase, no owning system, no record
  // anywhere. This drives the REAL normalizeEvent() through the REAL
  // runPhase() wrapper main.js's normalize() now uses at that exact call
  // site, with no ledger available -- exactly like the real job, since no
  // ledger exists yet at normalization time (see the comment on that call
  // site in main.mjs).
  const context = {
    repository: 'jlapenna/agent-lcars',
    repositoryId: 123,
    issue: 950,
    runId: 9001,
    actor: 'jlapenna',
    now: '2026-08-01T00:00:01.000Z',
  };
  const marker = `<!-- agent-lcars:quick-task-request:v1 id=11111111-1111-4111-8111-111111111111 digest=${'0'.repeat(64)} -->`;
  const issue = {
    id: 9500,
    number: 950,
    title: 'Fix dispatch',
    body: `Do the work\n\n${marker}`,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    labels: [{ name: 'agent:codex' }],
  };

  const { logs, restore } = captureLogs();
  try {
    // Still fails closed: the same digest-mismatch error still rejects the
    // call, unchanged. Module failure isolation adds attribution and a
    // record -- it never swallows or downgrades the failure.
    await assert.rejects(
      () =>
        runPhase(undefined, 'signal', () =>
          normalizeEvent({
            eventName: 'issues',
            event: { action: 'opened', issue, sender: { login: 'jlapenna' } },
            context,
            maintainer: 'jlapenna',
          }),
        ),
      /Quick Task marker digest mismatch/u,
    );
  } finally {
    restore();
  }
  // Attributed and recorded: a classified ::error:: annotation exists
  // naming the phase and owning system, not just a bare stack trace.
  const errorLogs = logs.filter((line) => line.startsWith('::error::'));
  assert.equal(errorLogs.length, 1);
  assert.match(errorLogs[0], /\[controller\/signal\]/u);
  assert.match(errorLogs[0], /internal_error/u);
  assert.match(errorLogs[0], /Quick Task marker digest mismatch/u);
});

test('runPhase returns the step result unchanged on success, recording nothing', async () => {
  const { logs, restore } = captureLogs();
  let result;
  try {
    result = await runPhase(undefined, 'signal', () => 'ok');
  } finally {
    restore();
  }
  assert.equal(result, 'ok');
  assert.equal(logs.length, 0);
});

test('runPhase classifies a failing step, records it as a ledger anomaly, and rethrows the original error unchanged when a ledger is available', async () => {
  const ledger = createLedger(task);
  const loaded = { ledger, comment: { id: 9 } };
  const { client, saves } = savingStubClient();
  const original = new Error('acceptIntent boom');

  const { logs, restore } = captureLogs();
  try {
    await assert.rejects(
      () =>
        runPhase({ client, loaded }, 'intent', () => {
          throw original;
        }),
      (thrown) => thrown === original,
    );
  } finally {
    restore();
  }

  assert.equal(saves.length, 1, 'the anomaly-carrying ledger was persisted');
  const anomaly = ledger.anomalies.at(-1);
  assert.equal(anomaly.kind, 'phase-failure');
  assert.equal(anomaly.failure.phase, 'intent');
  assert.equal(anomaly.failure.owningSystem, 'controller');
  assert.equal(anomaly.failure.reason, 'internal_error');
  assert.equal(anomaly.failure.retryDisposition, 'manual');
  const errorLogs = logs.filter((line) => line.startsWith('::error::'));
  assert.equal(errorLogs.length, 1);
  assert.match(errorLogs[0], /\[controller\/intent\]/u);
});

test('runPhase never lets a failed recording attempt replace or swallow the original error (#645 Phase 2)', async () => {
  const ledger = createLedger(task);
  const loaded = { ledger, comment: { id: 9 } };
  const { client } = savingStubClient({ failSave: true });
  const original = new Error('scheduling boom');

  const { logs, restore } = captureLogs();
  try {
    await assert.rejects(
      () =>
        runPhase({ client, loaded }, 'scheduling', () => {
          throw original;
        }),
      (thrown) => thrown === original,
    );
  } finally {
    restore();
  }

  // The anomaly mutation itself is pure/in-memory and never fails; only
  // persisting it does -- so it is still on the in-memory ledger even
  // though the save that would have durably recorded it did not land.
  assert.equal(ledger.anomalies.length, 1);
  assert.equal(ledger.anomalies[0].failure.phase, 'scheduling');
  const errorLogs = logs.filter((line) => line.startsWith('::error::'));
  assert.equal(
    errorLogs.length,
    2,
    'both the original failure and the secondary recording failure are logged',
  );
  assert.match(errorLogs[0], /\[controller\/scheduling\]/u);
  assert.match(errorLogs[1], /Failed to record/u);
});
