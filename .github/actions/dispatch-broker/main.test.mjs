import assert from 'node:assert/strict';

import {
  acceptIntent,
  beginDispatch,
  bindRun,
  completeRun,
  createLedger,
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
  encode,
  handleCompletion,
  isDefiniteDispatchRejection,
  reconcileActive,
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
