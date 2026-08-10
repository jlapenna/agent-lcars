import assert from 'node:assert/strict';

import { test } from 'vitest';

import { acceptIntent, createLedger } from './broker.js';
import {
  applyPipelineReassignment,
  PipelineReassignmentError,
} from './main.js';

const task = {
  repositoryId: 123,
  repository: 'jlapenna/agent-lcars',
  issue: 304,
};

const authorization = {
  authorized: true,
  actor: 'jlapenna',
  configuredMaintainer: 'jlapenna',
  rule: 'manual-maintainer',
};

const DEFAULT_PIPELINE_LABELS = [
  'agent:claude',
  'agent:codex',
  'agent:opencode',
];

function normalizedEvent(overrides = {}) {
  return {
    kind: 'pipeline-reassignment',
    task,
    sourceKind: 'pipeline-reassignment',
    sourceId: '11111111-1111-4111-8111-111111111111',
    transportRunId: 9001,
    occurredAt: '2026-08-10T00:00:00.000Z',
    targetPipeline: 'codex',
    targetLabel: 'agent:codex',
    pipelineLabels: DEFAULT_PIPELINE_LABELS,
    authorization,
    ...overrides,
  };
}

function stubClient({ currentLabels } = {}) {
  const putCalls = [];
  const saveCalls = [];
  return {
    client: {
      // replaceIssueLabels (github-api.ts) is a plain PUT through
      // requestOk() -- .request() is never called on this path.
      request: async (path) => {
        throw new Error(`Unexpected raw request() call for path: ${path}`);
      },
      requestOk: async (path, options) => {
        if (/\/issues\/comments\/9(\?.*)?$/u.test(path)) {
          saveCalls.push(path);
          return { id: 9 };
        }
        if (/\/issues\/304\/labels$/u.test(path)) {
          assert.equal(options?.method, 'PUT');
          putCalls.push({ path, body: options?.body });
          return (options?.body?.labels ?? []).map((name) => ({ name }));
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
    putCalls,
    saveCalls,
  };
}

test('applyPipelineReassignment atomically replaces exactly one pipeline label, preserving unrelated labels (#811)', async () => {
  const ledger = createLedger(task);
  const { client, putCalls, saveCalls } = stubClient({
    currentLabels: ['agent:claude', 'status:needs-human', 'type:bug'],
  });

  await applyPipelineReassignment(
    client,
    { ledger, comment: { id: 9 } },
    normalizedEvent(),
  );

  assert.equal(putCalls.length, 1);
  // status:needs-human and the stale pipeline label are both dropped in the
  // same write; the unrelated label survives untouched.
  assert.deepEqual(putCalls[0].body.labels, ['type:bug', 'agent:codex']);
  assert.equal(saveCalls.length, 1);
  const evidence = ledger.sources.find(
    (source) => source.sourceKind === 'pipeline-reassignment',
  );
  assert.ok(
    evidence,
    'expected pipeline-reassignment evidence in ledger.sources',
  );
  assert.equal(evidence.sourceId, '11111111-1111-4111-8111-111111111111');
  assert.equal(evidence.label, 'agent:codex');
  assert.deepEqual(evidence.authorization, authorization);
});

// #811 Codex review on #904: a watched repo's own `agents` config can
// declare a custom `agent:*` label per pipeline. applyPipelineReassignment
// must recognize and write exactly the labels the command itself carries,
// never a fleet-wide `agent:${pipeline}` it reconstructs on its own -- that
// would silently reject or mislabel any repo using a custom integration.
test('applyPipelineReassignment honors a caller-supplied custom label contract instead of the fleet-wide default', async () => {
  const ledger = createLedger(task);
  const { client, putCalls } = stubClient({
    currentLabels: ['bot:claude', 'type:bug'],
  });

  await applyPipelineReassignment(
    client,
    { ledger, comment: { id: 9 } },
    normalizedEvent({
      targetLabel: 'bot:codex',
      pipelineLabels: ['bot:claude', 'bot:codex'],
    }),
  );

  assert.equal(putCalls.length, 1);
  assert.deepEqual(putCalls[0].body.labels, ['type:bug', 'bot:codex']);
  const evidence = ledger.sources.find(
    (source) => source.sourceKind === 'pipeline-reassignment',
  );
  assert.equal(evidence.label, 'bot:codex');
});

test('applyPipelineReassignment rejects an issue with no pipeline label, without mutating GitHub or the ledger', async () => {
  const ledger = createLedger(task);
  const { client, putCalls, saveCalls } = stubClient({
    currentLabels: ['type:bug'],
  });

  await assert.rejects(
    () =>
      applyPipelineReassignment(
        client,
        { ledger, comment: { id: 9 } },
        normalizedEvent(),
      ),
    (error) => {
      assert.ok(error instanceof PipelineReassignmentError);
      assert.equal(error.reason, 'no-pipeline');
      return true;
    },
  );
  assert.equal(putCalls.length, 0);
  assert.equal(saveCalls.length, 0);
  assert.equal(ledger.sources.length, 0);
});

test('applyPipelineReassignment rejects a target that already matches the live label', async () => {
  const ledger = createLedger(task);
  const { client, putCalls, saveCalls } = stubClient({
    currentLabels: ['agent:codex'],
  });

  await assert.rejects(
    () =>
      applyPipelineReassignment(
        client,
        { ledger, comment: { id: 9 } },
        normalizedEvent(),
      ),
    (error) => {
      assert.ok(error instanceof PipelineReassignmentError);
      assert.equal(error.reason, 'already-targeted');
      return true;
    },
  );
  assert.equal(putCalls.length, 0);
  assert.equal(saveCalls.length, 0);
  assert.equal(ledger.sources.length, 0);
});

test('applyPipelineReassignment rejects a contradictory multi-pipeline label state rather than silently resolving it', async () => {
  const ledger = createLedger(task);
  const { client, putCalls, saveCalls } = stubClient({
    currentLabels: ['agent:claude', 'agent:opencode'],
  });

  await assert.rejects(
    () =>
      applyPipelineReassignment(
        client,
        { ledger, comment: { id: 9 } },
        normalizedEvent(),
      ),
    (error) => {
      assert.ok(error instanceof PipelineReassignmentError);
      assert.equal(error.reason, 'conflicting-pipeline');
      return true;
    },
  );
  assert.equal(putCalls.length, 0);
  assert.equal(saveCalls.length, 0);
  assert.equal(ledger.sources.length, 0);
});

test('applyPipelineReassignment converges a retry with the same request ID without a second write (#811 idempotence)', async () => {
  const ledger = createLedger(task);
  const { client, putCalls, saveCalls } = stubClient({
    currentLabels: ['agent:claude'],
  });

  await applyPipelineReassignment(
    client,
    { ledger, comment: { id: 9 } },
    normalizedEvent(),
  );
  assert.equal(putCalls.length, 1);
  assert.equal(saveCalls.length, 1);

  // A second call carrying the exact same sourceId (the console's stable
  // request UUID) must short-circuit before any GitHub read at all -- the
  // stub client throws on an unexpected path/live-label lookup, so any
  // second GitHub call here would fail the test outright.
  await applyPipelineReassignment(
    client,
    { ledger, comment: { id: 9 } },
    normalizedEvent(),
  );
  assert.equal(putCalls.length, 1);
  assert.equal(saveCalls.length, 1);
  assert.equal(
    ledger.sources.filter(
      (source) => source.sourceKind === 'pipeline-reassignment',
    ).length,
    1,
  );
});

test('applyPipelineReassignment never adds a ledger.generations entry -- it manufactures no worker run', async () => {
  const ledger = createLedger(task);
  const { client } = stubClient({ currentLabels: ['agent:claude'] });

  await applyPipelineReassignment(
    client,
    { ledger, comment: { id: 9 } },
    normalizedEvent(),
  );

  assert.equal(ledger.generations.length, 0);
});

// Codex review (P1) on #904: neither 'accepted' nor 'pending' is in
// ACTIVE_STATES, so reconcileActive() never touches either -- only the
// unconditional dispatchAccepted() call at the end of every controller pass
// does. Dropping status:needs-human as part of the label write can unblock
// that call into launching whichever OTHER pipeline's held generation was
// accepted/queued before this reassignment, unless applyPipelineReassignment
// itself supersedes it first.
test('applyPipelineReassignment supersedes an accepted generation for a DIFFERENT pipeline so dispatchAccepted cannot launch it', async () => {
  const ledger = createLedger(task);
  acceptIntent(ledger, {
    task,
    intentId: 'intent-codex-accepted',
    sourceKind: 'labeled',
    sourceId: 'timeline:1',
    transportRunId: 1,
    occurredAt: '2026-08-09T00:00:00.000Z',
    pipeline: 'codex',
    mode: 'implement',
    reply: '',
    runbook: '',
    context: '',
    digest: 'digest-1',
    authorization: { authorized: true },
  });
  assert.equal(ledger.generations[0].state, 'accepted');
  const { client } = stubClient({
    currentLabels: ['agent:codex', 'status:needs-human'],
  });

  await applyPipelineReassignment(
    client,
    { ledger, comment: { id: 9 } },
    normalizedEvent({ targetPipeline: 'claude', targetLabel: 'agent:claude' }),
  );

  assert.equal(ledger.generations[0].pipeline, 'codex');
  assert.equal(ledger.generations[0].state, 'superseded');
});

test('applyPipelineReassignment leaves an accepted generation for the SAME (new target) pipeline alone', async () => {
  const ledger = createLedger(task);
  acceptIntent(ledger, {
    task,
    intentId: 'intent-claude-accepted',
    sourceKind: 'labeled',
    sourceId: 'timeline:1',
    transportRunId: 1,
    occurredAt: '2026-08-09T00:00:00.000Z',
    pipeline: 'claude',
    mode: 'implement',
    reply: '',
    runbook: '',
    context: '',
    digest: 'digest-1',
    authorization: { authorized: true },
  });
  const { client } = stubClient({
    currentLabels: ['agent:codex', 'status:needs-human'],
  });

  await applyPipelineReassignment(
    client,
    { ledger, comment: { id: 9 } },
    normalizedEvent({ targetPipeline: 'claude', targetLabel: 'agent:claude' }),
  );

  assert.equal(ledger.generations[0].pipeline, 'claude');
  assert.equal(ledger.generations[0].state, 'accepted');
});

test('a retry that short-circuits on already-recorded evidence does not re-run generation supersession', async () => {
  const ledger = createLedger(task);
  acceptIntent(ledger, {
    task,
    intentId: 'intent-codex-accepted',
    sourceKind: 'labeled',
    sourceId: 'timeline:1',
    transportRunId: 1,
    occurredAt: '2026-08-09T00:00:00.000Z',
    pipeline: 'codex',
    mode: 'implement',
    reply: '',
    runbook: '',
    context: '',
    digest: 'digest-1',
    authorization: { authorized: true },
  });
  const { client } = stubClient({
    currentLabels: ['agent:codex', 'status:needs-human'],
  });

  await applyPipelineReassignment(
    client,
    { ledger, comment: { id: 9 } },
    normalizedEvent({ targetPipeline: 'claude', targetLabel: 'agent:claude' }),
  );
  assert.equal(ledger.generations[0].state, 'superseded');

  // A separately-seeded, freshly accepted codex generation added AFTER the
  // first pass must survive an idempotent retry: the retry short-circuits
  // purely on the recorded sourceId, before touching ledger.generations at
  // all (the stub client would also throw on any unexpected GitHub call).
  acceptIntent(ledger, {
    task,
    intentId: 'intent-codex-accepted-2',
    sourceKind: 'labeled',
    sourceId: 'timeline:2',
    transportRunId: 2,
    occurredAt: '2026-08-09T01:00:00.000Z',
    pipeline: 'codex',
    mode: 'implement',
    reply: '',
    runbook: '',
    context: '',
    digest: 'digest-2',
    authorization: { authorized: true },
  });
  await applyPipelineReassignment(
    client,
    { ledger, comment: { id: 9 } },
    normalizedEvent({ targetPipeline: 'claude', targetLabel: 'agent:claude' }),
  );
  assert.equal(ledger.generations[1].state, 'accepted');
});
