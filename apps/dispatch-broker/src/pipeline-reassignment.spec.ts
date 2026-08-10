import assert from 'node:assert/strict';

import { test } from 'vitest';

import { createLedger } from './broker.js';
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

function normalizedEvent(overrides = {}) {
  return {
    kind: 'pipeline-reassignment',
    task,
    sourceKind: 'pipeline-reassignment',
    sourceId: '11111111-1111-4111-8111-111111111111',
    transportRunId: 9001,
    occurredAt: '2026-08-10T00:00:00.000Z',
    targetPipeline: 'codex',
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

test('applyPipelineReassignment never touches ledger.generations -- it manufactures no worker run', async () => {
  const ledger = createLedger(task);
  const { client } = stubClient({ currentLabels: ['agent:claude'] });

  await applyPipelineReassignment(
    client,
    { ledger, comment: { id: 9 } },
    normalizedEvent(),
  );

  assert.equal(ledger.generations.length, 0);
});
