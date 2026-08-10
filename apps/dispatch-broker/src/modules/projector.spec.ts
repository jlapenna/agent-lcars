import assert from 'node:assert/strict';

import { classifyFailure } from '@agent-lcars/dispatch-contracts';
import { test } from 'vitest';

import {
  acceptIntent,
  addAnomaly,
  beginDispatch,
  bindRun,
  createLedger,
} from '../broker.js';
import { createGitHubApi } from '../github-api.js';
import { runPhase } from '../main.js';
import {
  projectComment,
  projectNeedsHumanPark,
  projectWorkerFailure,
  recordProjectionStatus,
  removeIssueLabel,
} from './projector.js';

const task = {
  repositoryId: 123,
  repository: 'jlapenna/agent-lcars',
  issue: 645,
};

function response(status, data) {
  return {
    status,
    headers: new Headers(),
    text: async () => (data === undefined ? '' : JSON.stringify(data)),
  };
}

function stubbedApi(fetchImpl) {
  return createGitHubApi({ token: 'token', fetchImpl });
}

// A ledger with one bound generation, the shape trackMissingRun/
// trackStuckRun/reconcileLedger's own tests use -- the fixture the
// "generation state untouched by a projection failure" tests snapshot
// against.
function ledgerWithBoundGeneration() {
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

// ---------------------------------------------------------------------------
// projectComment: idempotent marker + find-then-patch comment upsert.
// ---------------------------------------------------------------------------

test('projectComment creates a new comment when no projection with this key exists yet', async () => {
  const calls = [];
  const api = stubbedApi(async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET' });
    if (
      url.includes(`/issues/${task.issue}/comments`) &&
      options.method === 'GET'
    ) {
      return response(200, []);
    }
    if (options.method === 'POST') {
      return response(200, { id: 501, body: JSON.parse(options.body).body });
    }
    throw new Error(`Unexpected request: ${options.method ?? 'GET'} ${url}`);
  });
  const result = await projectComment(
    api,
    task,
    'needs-human-explanation',
    'g1:intent-1',
    (marker) => `${marker}\nExplanation.`,
  );
  assert.equal(result.action, 'created');
  assert.equal(result.id, 501);
  assert.ok(calls.some((call) => call.method === 'POST'));
});

test('projectComment retried finds and patches the existing comment instead of creating a second one', async () => {
  const marker =
    '<!-- agent-lcars:projection:needs-human-explanation:g1:intent-1 -->';
  const existingComment = {
    id: 501,
    body: `${marker}\nOld explanation.`,
  };
  const calls = [];
  const api = stubbedApi(async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET' });
    if (
      url.includes(`/issues/${task.issue}/comments`) &&
      options.method === 'GET'
    ) {
      return response(200, [existingComment]);
    }
    if (options.method === 'PATCH' && url.endsWith('/issues/comments/501')) {
      return response(200, { id: 501, body: JSON.parse(options.body).body });
    }
    if (options.method === 'POST') {
      throw new Error('must not create a second comment on a retry');
    }
    throw new Error(`Unexpected request: ${options.method ?? 'GET'} ${url}`);
  });

  // Run the SAME projection (same kind + key) twice, simulating an
  // at-least-once retry.
  const first = await projectComment(
    api,
    task,
    'needs-human-explanation',
    'g1:intent-1',
    (m) => `${m}\nNew explanation.`,
  );
  assert.equal(first.action, 'updated');
  assert.equal(first.id, 501);

  const second = await projectComment(
    api,
    task,
    'needs-human-explanation',
    'g1:intent-1',
    (m) => `${m}\nNew explanation.`,
  );
  assert.equal(second.action, 'updated');
  assert.equal(second.id, 501);
  assert.equal(
    calls.filter((call) => call.method === 'POST').length,
    0,
    'a retried projection must never POST a second comment',
  );
});

test('projectComment for a different key creates a distinct comment, not a collision with another key of the same kind', async () => {
  const existingComment = {
    id: 501,
    body: '<!-- agent-lcars:projection:needs-human-explanation:g1:intent-1 -->\nFor g1.',
  };
  const api = stubbedApi(async (url, options = {}) => {
    if (
      url.includes(`/issues/${task.issue}/comments`) &&
      options.method === 'GET'
    ) {
      return response(200, [existingComment]);
    }
    if (options.method === 'POST') {
      return response(200, { id: 502, body: JSON.parse(options.body).body });
    }
    throw new Error(`Unexpected request: ${options.method ?? 'GET'} ${url}`);
  });
  const result = await projectComment(
    api,
    task,
    'needs-human-explanation',
    'g2:intent-2',
    (marker) => `${marker}\nFor g2.`,
  );
  assert.equal(result.action, 'created');
  assert.equal(result.id, 502);
});

test('projectComment refuses to guess between two comments that both carry the same projection marker', async () => {
  const marker =
    '<!-- agent-lcars:projection:needs-human-explanation:g1:intent-1 -->';
  const api = stubbedApi(async (url, options = {}) => {
    if (
      url.includes(`/issues/${task.issue}/comments`) &&
      options.method === 'GET'
    ) {
      return response(200, [
        { id: 501, body: `${marker}\nFirst.` },
        { id: 502, body: `${marker}\nSecond.` },
      ]);
    }
    throw new Error(`Unexpected request: ${options.method ?? 'GET'} ${url}`);
  });
  await assert.rejects(
    () =>
      projectComment(
        api,
        task,
        'needs-human-explanation',
        'g1:intent-1',
        (m) => `${m}\nUpdated.`,
      ),
    /Duplicate .* projection comment/u,
  );
});

// ---------------------------------------------------------------------------
// projectNeedsHumanPark: routes the parking decision through needsMaintainer,
// never re-deriving it locally.
// ---------------------------------------------------------------------------

test('projectNeedsHumanPark does not park a retryable infrastructure failure (backoff)', async () => {
  const api = stubbedApi(async (url) => {
    throw new Error(`must not call GitHub at all: ${url}`);
  });
  const failure = classifyFailure({
    phase: 'provider_execution',
    reason: 'provider_unavailable',
    retryDisposition: 'backoff',
  });
  const result = await projectNeedsHumanPark(api, task, 'jlapenna', failure);
  assert.deepEqual(result, { parked: false });
});

test('projectNeedsHumanPark does not park an immediately-retryable failure', async () => {
  const api = stubbedApi(async (url) => {
    throw new Error(`must not call GitHub at all: ${url}`);
  });
  const failure = classifyFailure({
    phase: 'runner_allocation',
    reason: 'runner_allocation_timeout',
    retryDisposition: 'immediate',
  });
  const result = await projectNeedsHumanPark(api, task, 'jlapenna', failure);
  assert.deepEqual(result, { parked: false });
});

test('projectNeedsHumanPark does not park a "never, superseded" failure -- the one `never` case that is not a human handoff', async () => {
  const api = stubbedApi(async (url) => {
    throw new Error(`must not call GitHub at all: ${url}`);
  });
  const failure = classifyFailure({
    phase: 'intent',
    reason: 'intent_superseded',
    retryDisposition: 'never',
  });
  const result = await projectNeedsHumanPark(api, task, 'jlapenna', failure);
  assert.deepEqual(result, { parked: false });
});

test('projectNeedsHumanPark parks a maintainer-owned (manual) failure', async () => {
  const calls = [];
  const api = stubbedApi(async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET' });
    return response(200, {});
  });
  const failure = classifyFailure({
    phase: 'reporting',
    reason: 'github_write_failed',
    retryDisposition: 'manual',
  });
  const result = await projectNeedsHumanPark(api, task, 'jlapenna', failure);
  assert.deepEqual(result, { parked: true });
  assert.ok(calls.some((call) => call.url.endsWith('/labels')));
  assert.ok(calls.some((call) => call.url.endsWith('/assignees')));
});

test('projectNeedsHumanPark parks an after_configuration_change failure', async () => {
  const calls = [];
  const api = stubbedApi(async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET' });
    return response(200, {});
  });
  const failure = classifyFailure({
    phase: 'provider_admission',
    reason: 'provider_admission_denied',
    retryDisposition: 'after_configuration_change',
  });
  const result = await projectNeedsHumanPark(api, task, 'jlapenna', failure);
  assert.deepEqual(result, { parked: true });
  assert.ok(calls.some((call) => call.url.endsWith('/labels')));
});

test("projectNeedsHumanPark preserves ensureNeedsHumanParked's verify-then-decide handling of a landed-but-misreported mutation (#346)", async () => {
  // Same fixture shape as github-api.spec.ts's own #346 regression test:
  // the label POST reports a parse hiccup, but a re-read confirms the label
  // actually landed -- this must resolve, not throw, exactly as calling
  // ensureNeedsHumanParked directly would.
  const api = stubbedApi(async (url, options = {}) => {
    if (options.method === 'POST' && url.endsWith('/labels')) {
      return response(422, { message: 'response-parse hiccup' });
    }
    if (url.endsWith(`/issues/${task.issue}`)) {
      return response(200, {
        labels: [{ name: 'status:needs-human' }],
        assignees: [{ login: 'jlapenna' }],
      });
    }
    return response(200, {});
  });
  const failure = classifyFailure({
    phase: 'reporting',
    reason: 'github_write_failed',
    retryDisposition: 'manual',
  });
  await assert.doesNotReject(() =>
    projectNeedsHumanPark(api, task, 'jlapenna', failure),
  );
});

// ---------------------------------------------------------------------------
// projectWorkerFailure (#813): the ONE writer for a worker attempt's own
// reported failure -- one comment, one park, keyed on attemptId, converging
// across duplicate/independent callers of this same function.
// ---------------------------------------------------------------------------

const workerFailureAttempt = {
  attemptId: 'g1:intent-1',
  pipeline: 'codex',
  runUrl: 'https://github.com/jlapenna/agent-lcars/actions/runs/42',
};

test('projectWorkerFailure creates the failure comment and parks a manual (needs-human) classification', async () => {
  const calls = [];
  const api = stubbedApi(async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET' });
    if (
      url.includes(`/issues/${task.issue}/comments`) &&
      (options.method ?? 'GET') === 'GET'
    ) {
      return response(200, []);
    }
    if (options.method === 'POST') {
      return response(200, { id: 601, body: JSON.parse(options.body).body });
    }
    return response(200, {});
  });
  const failure = classifyFailure({
    phase: 'agent_execution',
    reason: 'agent_exited_nonzero',
    retryDisposition: 'manual',
  });
  const result = await projectWorkerFailure(
    api,
    task,
    'jlapenna',
    workerFailureAttempt,
    failure,
  );
  assert.equal(result.comment.action, 'created');
  assert.deepEqual(result.park, { parked: true });
  assert.ok(
    calls.some(
      (call) => call.url.endsWith('/comments') && call.method === 'POST',
    ),
  );
  assert.ok(calls.some((call) => call.url.endsWith('/labels')));
  assert.ok(calls.some((call) => call.url.endsWith('/assignees')));
});

test('projectWorkerFailure converges duplicate delivery of the same attempt onto exactly one comment (update, not a second create) and one park', async () => {
  let existingComment;
  const calls = [];
  const api = stubbedApi(async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET' });
    if (
      url.includes(`/issues/${task.issue}/comments`) &&
      (options.method ?? 'GET') === 'GET'
    ) {
      return response(200, existingComment ? [existingComment] : []);
    }
    if (url.endsWith('/comments') && options.method === 'POST') {
      existingComment = { id: 701, body: JSON.parse(options.body).body };
      return response(200, existingComment);
    }
    if (options.method === 'PATCH' && url.endsWith('/issues/comments/701')) {
      existingComment = { id: 701, body: JSON.parse(options.body).body };
      return response(200, existingComment);
    }
    return response(200, {});
  });
  const failure = classifyFailure({
    phase: 'agent_execution',
    reason: 'agent_exited_nonzero',
    retryDisposition: 'manual',
  });

  const first = await projectWorkerFailure(
    api,
    task,
    'jlapenna',
    workerFailureAttempt,
    failure,
  );
  const second = await projectWorkerFailure(
    api,
    task,
    'jlapenna',
    workerFailureAttempt,
    failure,
  );

  assert.equal(first.comment.action, 'created');
  assert.equal(second.comment.action, 'updated');
  assert.equal(second.comment.id, first.comment.id);
  assert.equal(
    calls.filter(
      (call) => call.url.endsWith('/comments') && call.method === 'POST',
    ).length,
    1,
    'a duplicate delivery must never POST a second worker-failure comment',
  );
});

test('projectWorkerFailure is a full no-op (no comment, no park) for a retryable classification', async () => {
  const api = stubbedApi(async (url) => {
    throw new Error(`must not call GitHub at all: ${url}`);
  });
  const failure = classifyFailure({
    phase: 'provider_execution',
    reason: 'provider_unavailable',
    retryDisposition: 'backoff',
  });
  const result = await projectWorkerFailure(
    api,
    task,
    'jlapenna',
    workerFailureAttempt,
    failure,
  );
  assert.equal(result.comment, undefined);
  assert.deepEqual(result.park, { parked: false });
});

// ---------------------------------------------------------------------------
// removeIssueLabel: re-exported unchanged, under the projector's own surface.
// ---------------------------------------------------------------------------

test("the projector's removeIssueLabel is github-api.ts's own export, unchanged", async () => {
  const calls = [];
  const api = stubbedApi(async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET' });
    return response(404, {});
  });
  const result = await removeIssueLabel(api, task, 'agent:codex');
  assert.deepEqual(result, { removed: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'DELETE');
});

// ---------------------------------------------------------------------------
// recordProjectionStatus: the ProjectionStatus checkpoint, ledger.projection
// only.
// ---------------------------------------------------------------------------

test("recordProjectionStatus records a converged checkpoint at the ledger's current revision", () => {
  const ledger = ledgerWithBoundGeneration();
  const revisionBefore = ledger.revision;
  recordProjectionStatus(ledger, true, '2026-08-06T00:10:00.000Z');
  assert.deepEqual(ledger.projection, {
    desiredRevision: revisionBefore,
    observedRevision: revisionBefore,
    state: 'converged',
    observedAt: '2026-08-06T00:10:00.000Z',
  });
});

test('recordProjectionStatus records a diverged checkpoint that keeps observedRevision at the last converged value', () => {
  const ledger = ledgerWithBoundGeneration();
  recordProjectionStatus(ledger, true, '2026-08-06T00:10:00.000Z');
  const convergedRevision = ledger.projection.observedRevision;

  // Something else advances the ledger's own revision (e.g. a reconciler
  // observation) before the next convergence attempt fails.
  addAnomaly(ledger, 'reconcile-missing-run', { generation: 1 });
  recordProjectionStatus(ledger, false, '2026-08-06T00:20:00.000Z');
  assert.equal(ledger.projection.state, 'diverged');
  assert.equal(ledger.projection.observedRevision, convergedRevision);
  assert.ok(ledger.projection.desiredRevision > convergedRevision);
});

test('recordProjectionStatus reports "pending" when a failed convergence has never once succeeded', () => {
  const ledger = ledgerWithBoundGeneration();
  recordProjectionStatus(ledger, false, '2026-08-06T00:10:00.000Z');
  assert.equal(ledger.projection.state, 'pending');
  assert.equal(ledger.projection.observedRevision, 0);
});

test('recordProjectionStatus bumps ledger.revision and updatedAt like any other ledger mutation', () => {
  const ledger = ledgerWithBoundGeneration();
  const revisionBefore = ledger.revision;
  recordProjectionStatus(ledger, true, '2026-08-06T00:10:00.000Z');
  assert.equal(ledger.revision, revisionBefore + 1);
  assert.equal(ledger.updatedAt, '2026-08-06T00:10:00.000Z');
});

test('recordProjectionStatus cannot alter controller-owned ledger state', () => {
  const ledger = ledgerWithBoundGeneration();
  const controllerStateBefore = structuredClone({
    task: ledger.task,
    sources: ledger.sources,
    generations: ledger.generations,
    control: ledger.control,
    anomalies: ledger.anomalies,
    createdAt: ledger.createdAt,
  });

  recordProjectionStatus(ledger, true, '2026-08-06T00:10:00.000Z');

  assert.deepEqual(
    {
      task: ledger.task,
      sources: ledger.sources,
      generations: ledger.generations,
      control: ledger.control,
      anomalies: ledger.anomalies,
      createdAt: ledger.createdAt,
    },
    controllerStateBefore,
  );
});

// ---------------------------------------------------------------------------
// Failure containment: a projection failure is recorded as a projector-
// phase failure and leaves generation state and outcome untouched. This is
// #645 Phase 4's exit criterion -- "reporting failure cannot alter outcome
// truth" -- exercised through main.ts's runPhase, the one mechanism this
// module deliberately reuses rather than duplicating (see projector.ts's
// header comment).
// ---------------------------------------------------------------------------

test('a projection failure records a projector-phase failure and leaves generation state and outcome untouched', async () => {
  const ledger = ledgerWithBoundGeneration();
  const generationsBefore = structuredClone(ledger.generations);
  const controlBefore = structuredClone(ledger.control);
  const client = stubbedApi(async () => {
    throw new Error('GitHub is unreachable');
  });

  await assert.rejects(() =>
    runPhase(
      { client, loaded: { ledger, comment: { id: 1 } } },
      'reporting',
      () =>
        projectComment(
          client,
          task,
          'needs-human-explanation',
          'g1:intent-1',
          (m) => m,
        ),
      'projector',
    ),
  );

  // The generation/control state -- attempt outcome truth -- is exactly
  // what it was before the failed projection, byte for byte.
  assert.deepEqual(ledger.generations, generationsBefore);
  assert.deepEqual(ledger.control, controlBefore);

  // The failure IS recorded, correctly attributed to the projector, not the
  // controller.
  const phaseFailures = ledger.anomalies.filter(
    (anomaly) => anomaly.kind === 'phase-failure',
  );
  assert.equal(phaseFailures.length, 1);
  assert.equal(phaseFailures[0].failure.owningSystem, 'projector');
  assert.equal(phaseFailures[0].failure.phase, 'reporting');
});

test('a needs-human park failure recorded through runPhase is attributed to the projector and leaves generation state untouched', async () => {
  const ledger = ledgerWithBoundGeneration();
  const generationsBefore = structuredClone(ledger.generations);
  const client = stubbedApi(async (url, options = {}) => {
    if (options.method === 'POST' && url.endsWith('/labels')) {
      return response(403, { message: 'Forbidden' });
    }
    if (url.endsWith(`/issues/${task.issue}`)) {
      return response(200, { labels: [], assignees: [] });
    }
    return response(200, {});
  });
  const failure = classifyFailure({
    phase: 'reporting',
    reason: 'github_write_failed',
    retryDisposition: 'manual',
  });

  await assert.rejects(() =>
    runPhase(
      { client, loaded: { ledger, comment: { id: 1 } } },
      'reporting',
      () => projectNeedsHumanPark(client, task, 'jlapenna', failure),
      'projector',
    ),
  );

  assert.deepEqual(ledger.generations, generationsBefore);
  const phaseFailures = ledger.anomalies.filter(
    (anomaly) => anomaly.kind === 'phase-failure',
  );
  assert.equal(phaseFailures.length, 1);
  assert.equal(phaseFailures[0].failure.owningSystem, 'projector');
});
