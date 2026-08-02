import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  acceptIntent,
  applyAnchorControl,
  awaitTerminal,
  beginDispatch,
  bindRun,
  completeRun,
  createLedger,
  digest,
  markDispatchUnknown,
  observeCompletion,
  parseLedgerComment,
  renderLedgerComment,
  verifyPreflight,
} from './broker.mjs';

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

const task = {
  repositoryId: 123,
  repository: 'jlapenna/agent-lcars',
  issue: 304,
};
const baseTime = '2026-08-01T00:00:00.000Z';

function intent(overrides = {}) {
  const payload = {
    task,
    intentId: 'intent-1',
    sourceKind: 'manual',
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

function activeLedger() {
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
      workflow: 'codex.yml',
    },
    baseTime,
  );
  return ledger;
}

test('ledger comments round-trip and reject a canonical identity mismatch', () => {
  const ledger = createLedger(task, baseTime);
  const parsed = parseLedgerComment(renderLedgerComment(ledger), task);
  assert.deepEqual(parsed, ledger);
  assert.throws(
    () =>
      parseLedgerComment(renderLedgerComment(ledger), { ...task, issue: 305 }),
    /TaskRef mismatch/u,
  );
});

test('same source and same transport rerun are durable no-ops', () => {
  const ledger = createLedger(task, baseTime);
  assert.equal(acceptIntent(ledger, intent()).outcome, 'dispatch');
  assert.equal(acceptIntent(ledger, intent()).outcome, 'duplicate');
  assert.equal(
    acceptIntent(ledger, intent({ sourceId: 'another-source' })).outcome,
    'duplicate',
  );
  assert.equal(ledger.generations.length, 1);
});

test('opened and labeled Quick Task evidence attach to one semantic generation', () => {
  const ledger = createLedger(task, baseTime);
  const intentId = 'quick:11111111-1111-4111-8111-111111111111:abc';
  assert.equal(
    acceptIntent(ledger, intent({ intentId, sourceKind: 'opened' })).outcome,
    'dispatch',
  );
  assert.equal(
    acceptIntent(
      ledger,
      intent({
        intentId,
        sourceKind: 'labeled',
        sourceId: 'timeline-label-event-1',
        transportRunId: 9002,
      }),
    ).outcome,
    'semantic-duplicate',
  );
  assert.equal(ledger.generations.length, 1);
  assert.equal(ledger.sources.length, 2);
});

test('multiple newer intents while active retain only the newest pending intent', () => {
  const ledger = activeLedger();
  assert.equal(
    acceptIntent(
      ledger,
      intent({
        intentId: 'intent-2',
        sourceId: 'source-2',
        transportRunId: 9002,
        occurredAt: '2026-08-01T00:01:00.000Z',
      }),
    ).outcome,
    'pending',
  );
  assert.equal(
    acceptIntent(
      ledger,
      intent({
        intentId: 'intent-3',
        sourceId: 'source-3',
        transportRunId: 9003,
        occurredAt: '2026-08-01T00:02:00.000Z',
      }),
    ).outcome,
    'pending',
  );
  assert.equal(ledger.generations[1].state, 'superseded');
  assert.equal(ledger.generations[2].state, 'pending');
});

test('out-of-order older intent cannot displace newer pending intent', () => {
  const ledger = activeLedger();
  acceptIntent(
    ledger,
    intent({
      intentId: 'new',
      sourceId: 'new-source',
      transportRunId: 9002,
      occurredAt: '2026-08-01T00:02:00.000Z',
    }),
  );
  const result = acceptIntent(
    ledger,
    intent({
      intentId: 'old',
      sourceId: 'old-source',
      transportRunId: 9003,
      occurredAt: '2026-08-01T00:01:00.000Z',
    }),
  );
  assert.equal(result.outcome, 'stale');
  assert.equal(ledger.generations.at(-1).state, 'superseded');
});

test('dispatch uses a two-phase transition and ambiguous response never reopens dispatch', () => {
  const ledger = createLedger(task, baseTime);
  acceptIntent(ledger, intent());
  beginDispatch(ledger, 1, 'dispatch_token_123456');
  markDispatchUnknown(ledger, 1, 'malformed-200');
  assert.equal(ledger.generations[0].state, 'dispatch-unknown');
  assert.throws(
    () => beginDispatch(ledger, 1, 'different_token_123456'),
    /not dispatchable/u,
  );
});

test('late binding repairs dispatch-unknown and preflight requires exact binding', () => {
  const ledger = createLedger(task, baseTime);
  acceptIntent(ledger, intent());
  beginDispatch(ledger, 1, 'dispatch_token_123456');
  markDispatchUnknown(ledger, 1, 'timeout');
  bindRun(ledger, 1, {
    runId: 42,
    runUrl: 'https://api.github.com/repos/jlapenna/agent-lcars/actions/runs/42',
    htmlUrl: 'https://github.com/jlapenna/agent-lcars/actions/runs/42',
    workflow: 'codex.yml',
  });
  const expected = {
    task,
    generation: 1,
    intentId: 'intent-1',
    token: 'dispatch_token_123456',
    runId: 42,
  };
  assert.equal(verifyPreflight(ledger, expected), true);
  assert.equal(verifyPreflight(ledger, { ...expected, runId: 43 }), false);
  assert.equal(
    verifyPreflight(ledger, { ...expected, token: 'fabricated' }),
    false,
  );
  assert.equal(verifyPreflight(ledger, { ...expected, generation: 2 }), false);
});

test('completion callback records observation without premature pending promotion', () => {
  const ledger = activeLedger();
  acceptIntent(
    ledger,
    intent({
      intentId: 'intent-2',
      sourceId: 'source-2',
      transportRunId: 9002,
      occurredAt: '2026-08-01T00:01:00.000Z',
    }),
  );
  observeCompletion(ledger, 1, 42);
  assert.equal(ledger.generations[0].state, 'completion-observed');
  assert.equal(ledger.generations[1].state, 'pending');
  awaitTerminal(ledger, 1);
  assert.equal(ledger.generations[0].state, 'completion-awaiting-terminal');
  assert.equal(ledger.generations[1].state, 'pending');
});

test('authoritative terminal completion promotes pending exactly once', () => {
  const ledger = activeLedger();
  acceptIntent(
    ledger,
    intent({
      intentId: 'intent-2',
      sourceId: 'source-2',
      transportRunId: 9002,
      occurredAt: '2026-08-01T00:01:00.000Z',
    }),
  );
  observeCompletion(ledger, 1, 42);
  const result = completeRun(ledger, 1, {
    runId: 42,
    status: 'completed',
    conclusion: 'success',
    completedAt: '2026-08-01T00:03:00.000Z',
  });
  assert.equal(result.promotedGeneration, 2);
  assert.equal(ledger.generations[0].state, 'completed');
  assert.equal(ledger.generations[1].state, 'accepted');
  assert.throws(() =>
    completeRun(ledger, 1, {
      runId: 42,
      status: 'completed',
      conclusion: 'success',
    }),
  );
});

test('close supersedes pending but lets bound work complete without promotion', () => {
  const ledger = activeLedger();
  acceptIntent(
    ledger,
    intent({
      intentId: 'intent-2',
      sourceId: 'source-2',
      transportRunId: 9002,
      occurredAt: '2026-08-01T00:01:00.000Z',
    }),
  );
  applyAnchorControl(ledger, {
    kind: 'closed',
    sourceId: 'timeline-close-1',
    transportRunId: 9003,
    occurredAt: '2026-08-01T00:02:00.000Z',
    authorization: { observed: true },
    merged: false,
  });
  assert.equal(ledger.generations[0].state, 'active');
  assert.equal(ledger.generations[1].state, 'superseded-by-close');
  completeRun(ledger, 1, {
    runId: 42,
    status: 'completed',
    conclusion: 'success',
  });
  assert.equal(ledger.generations[0].state, 'completed');
});

test('reopen clears closure but never resurrects a prior intent', () => {
  const ledger = createLedger(task, baseTime);
  applyAnchorControl(ledger, {
    kind: 'closed',
    sourceId: 'close-1',
    transportRunId: 9001,
    occurredAt: baseTime,
    authorization: { observed: true },
  });
  assert.equal(
    acceptIntent(ledger, intent({ transportRunId: 9002 })).outcome,
    'closed',
  );
  applyAnchorControl(ledger, {
    kind: 'reopened',
    sourceId: 'reopen-1',
    transportRunId: 9003,
    occurredAt: '2026-08-01T00:01:00.000Z',
    authorization: { observed: true },
  });
  assert.equal(ledger.control.closed, false);
  assert.equal(ledger.generations[0].state, 'superseded-by-close');
});

test('invalid authorization and malformed active cardinality fail closed', () => {
  const ledger = createLedger(task, baseTime);
  assert.throws(
    () =>
      acceptIntent(ledger, intent({ authorization: { authorized: false } })),
    /Unauthorized/u,
  );
  const malformed = activeLedger();
  malformed.generations.push({
    ...malformed.generations[0],
    generation: 2,
    intentId: 'other',
  });
  assert.throws(
    () => parseLedgerComment(renderLedgerComment(malformed), task),
    /cardinality/u,
  );
});

test('dispatch tokens are cryptographically unique fixture values', () => {
  const tokens = new Set(
    Array.from({ length: 100 }, () =>
      crypto.randomBytes(24).toString('base64url'),
    ),
  );
  assert.equal(tokens.size, 100);
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
