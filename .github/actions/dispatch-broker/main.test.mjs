import assert from 'node:assert/strict';

import {
  acceptIntent,
  beginDispatch,
  bindRun,
  completeRun,
  createLedger,
  recordControlEvidence,
} from './broker.mjs';
import { GitHubApiError } from './github-api.mjs';
import {
  assertWorkerRun,
  completionMatches,
  decode,
  encode,
  handleCompletion,
  isDefiniteDispatchRejection,
  reconcileActive,
} from './main.mjs';

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
