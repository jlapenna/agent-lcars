/**
 * The writer/reader join, which had no test at all.
 *
 * broker.mjs writes the dispatch ledger; the console reads it. Their shapes
 * were maintained as two independent hand-written definitions, and they had
 * already drifted — the reader's types were missing `context`, `reply`, and
 * `digest` on a generation and seven fields on an attempt, and nothing
 * anywhere would have noticed.
 *
 * Both now derive from libs/dispatch-contracts. This file proves the join
 * end to end: a ledger driven through real broker transitions, rendered as a
 * real comment, must survive the reader's own structural gate. It lives on
 * the broker side because only the broker can produce authentic writer output
 * — the shared package cannot import it without inverting the dependency.
 */
import assert from 'node:assert/strict';

import {
  classifyFailure,
  extractLedgerComment,
  isWellFormedLedger,
} from '../../../libs/dispatch-contracts/src/index.js';
import {
  acceptIntent,
  addAnomaly,
  beginDispatch,
  bindRun,
  completeRun,
  createLedger,
  digest,
  observeCompletion,
  renderLedgerComment,
} from './broker.mjs';

// A local collector rather than `node:test`, matching every sibling file in
// this directory. That convention is load-bearing: the repo's eslint config
// enables @vitest/eslint-plugin's recommended rules, whose autofix rewrites a
// `node:test` import to `vitest` — which then throws under `node --test`, the
// command ci.yml actually runs these with.
const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

const task = {
  repositoryId: 123,
  repository: 'jlapenna/agent-lcars',
  issue: 645,
};
const baseTime = '2026-08-01T00:00:00.000Z';

function intent(overrides = {}) {
  const payload = {
    task,
    intentId: 'intent-1',
    sourceKind: 'labeled',
    sourceId: '11111111-1111-4111-8111-111111111111',
    transportRunId: 9001,
    occurredAt: baseTime,
    pipeline: 'codex',
    mode: 'implement',
    runbook: '',
    context: '',
    authorization: { authorized: true, actor: 'jlapenna', rule: 'maintainer' },
    ...overrides,
  };
  return { ...payload, digest: overrides.digest ?? digest(payload) };
}

/** A ledger driven all the way to a terminal run, exercising every
 * transition that writes an attempt field. */
function completedLedger() {
  const ledger = createLedger(task, baseTime);
  acceptIntent(ledger, intent(), baseTime);
  beginDispatch(ledger, 1, 'dispatch_token_123456', baseTime);
  bindRun(
    ledger,
    1,
    {
      runId: 42,
      runUrl:
        'https://api.github.com/repos/jlapenna/agent-lcars/actions/runs/42',
      htmlUrl: 'https://github.com/jlapenna/agent-lcars/actions/runs/42',
    },
    baseTime,
  );
  observeCompletion(ledger, 1, 42, baseTime);
  completeRun(
    ledger,
    1,
    { runId: 42, status: 'completed', conclusion: 'success' },
    baseTime,
  );
  addAnomaly(
    ledger,
    'duplicate-attempt',
    { generation: 1, runIds: [42, 43] },
    baseTime,
    // Exercises the writer's real classification path (main.mjs's own
    // duplicate-attempt call site), not a hand-rolled stand-in -- this is
    // the fixture the "every field the writer emits" test below pins keys
    // against, so it needs to carry a real `failure` field, not merely a
    // plausible one.
    classifyFailure({
      phase: 'reconciliation',
      owningSystem: 'controller',
      reason: 'internal_error',
      retryDisposition: 'never',
    }),
  );
  return ledger;
}

test('a freshly created ledger satisfies the read-side gate', () => {
  assert.equal(isWellFormedLedger(createLedger(task, baseTime)), true);
});

test('a ledger driven to completion satisfies the read-side gate', () => {
  assert.equal(isWellFormedLedger(completedLedger()), true);
});

test('a rendered ledger comment round-trips back through the reader', () => {
  const ledger = completedLedger();
  const extracted = extractLedgerComment(renderLedgerComment(ledger));
  assert.equal(extracted.ok, true);
  assert.deepEqual(extracted.ledger, JSON.parse(JSON.stringify(ledger)));
  assert.equal(isWellFormedLedger(extracted.ledger), true);
});

test('every field the writer emits is described by the shared contract', () => {
  // The drift this guards is silent by nature: the writer gains a field, the
  // reader's type never hears about it, and consumers keep compiling against
  // a shape that no longer matches production. Comparing against the JSDoc
  // is not possible at runtime, so this pins the emitted key sets instead —
  // a new key here is a deliberate prompt to update libs/dispatch-contracts'
  // typedefs in the same change.
  const ledger = completedLedger();

  assert.deepEqual(Object.keys(ledger).sort(), [
    'anomalies',
    'control',
    'createdAt',
    'generations',
    'revision',
    'schema',
    'sources',
    'task',
    'updatedAt',
  ]);

  assert.deepEqual(Object.keys(ledger.task).sort(), [
    'issue',
    'repository',
    'repositoryId',
  ]);

  assert.deepEqual(Object.keys(ledger.generations[0]).sort(), [
    'attempt',
    'context',
    'digest',
    'generation',
    'intentId',
    'mode',
    'occurredAt',
    'pipeline',
    'reply',
    'runbook',
    'sourceId',
    'state',
  ]);

  assert.deepEqual(Object.keys(ledger.generations[0].attempt).sort(), [
    'attemptId',
    'boundAt',
    'completedAt',
    'completionObservedAt',
    'conclusion',
    'dispatchStartedAt',
    'htmlUrl',
    'runId',
    'runUrl',
    'status',
    'token',
  ]);

  assert.deepEqual(Object.keys(ledger.sources[0]).sort(), [
    'authorization',
    'digest',
    'intentId',
    'occurredAt',
    'sourceId',
    'sourceKind',
    'transportRunId',
  ]);

  assert.deepEqual(Object.keys(ledger.anomalies[0]).sort(), [
    'detail',
    'failure',
    'kind',
    'occurredAt',
  ]);

  assert.deepEqual(Object.keys(ledger.anomalies[0].failure).sort(), [
    'owningSystem',
    'phase',
    'reason',
    'retryDisposition',
  ]);
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
