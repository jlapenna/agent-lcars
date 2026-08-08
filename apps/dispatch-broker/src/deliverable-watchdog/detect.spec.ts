import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  evaluateDeliverable,
  normalizeGraphqlBotLogin,
  parseAgentBotLogins,
  renderAttentionComment,
  selectLatestRequiredCheck,
  WATCHDOG_ATTENTION_STATE,
  watchdogMarker,
} from './detect.js';

function pullRequest(overrides = {}) {
  return {
    number: 666,
    url: 'https://github.com/jlapenna/agent-lcars/pull/666',
    authorLogin: 'agent-lcars[bot]',
    createdAt: '2026-08-01T00:00:00Z',
    headCommittedAt: '2026-08-01T01:00:00Z',
    headSha: 'abc123',
    isDraft: false,
    anchors: [660],
    ...overrides,
  };
}

function checkRun(overrides = {}) {
  return {
    id: 1,
    name: 'Verify',
    status: 'completed',
    conclusion: 'failure',
    startedAt: '2026-08-01T01:01:00Z',
    completedAt: '2026-08-01T01:10:00Z',
    url: 'https://github.com/jlapenna/agent-lcars/actions/runs/1',
    ...overrides,
  };
}

test('normalizes GraphQL App authors into the repository REST login contract', () => {
  assert.equal(normalizeGraphqlBotLogin('app/agent-lcars'), 'agent-lcars[bot]');
  assert.equal(normalizeGraphqlBotLogin('jlapenna'), 'jlapenna');
  assert.deepEqual(
    [...parseAgentBotLogins('["claude[bot]","agent-lcars[bot]"]')],
    ['claude[bot]', 'agent-lcars[bot]'],
  );
  assert.throws(() => parseAgentBotLogins('{}'), /non-empty JSON array/u);
  assert.throws(() => parseAgentBotLogins('not json'), /valid JSON/u);
});

test('selects the latest matching required check instead of an older failed attempt', () => {
  const older = checkRun({ id: 1, completedAt: '2026-08-01T01:10:00Z' });
  const latest = checkRun({
    id: 2,
    conclusion: 'success',
    completedAt: '2026-08-01T03:10:00Z',
  });
  assert.equal(
    selectLatestRequiredCheck(
      [older, checkRun({ name: 'E2E', id: 3 }), latest],
      'Verify',
    ),
    latest,
  );
});

test('a stale failed check alerts with one exact marker and actionable evidence', () => {
  const pr = pullRequest();
  const evaluation = evaluateDeliverable(
    pr,
    [checkRun()],
    'Verify',
    6 * 60 * 60 * 1000,
    new Date('2026-08-02T00:00:00Z'),
  );
  assert.equal(evaluation.needsAttention, true);
  assert.match(evaluation.reason, /concluded failure/u);
  const body = renderAttentionComment(pr, evaluation, 'Verify');
  assert.ok(body.startsWith(watchdogMarker(666)));
  assert.ok(body.includes(WATCHDOG_ATTENTION_STATE));
  assert.match(body, /never rebases or merges/u);
  assert.match(body, /22\.8 hours/u);
});

test('recent required-check activity clears the abandonment condition even while the check is red', () => {
  const evaluation = evaluateDeliverable(
    pullRequest(),
    [checkRun({ completedAt: '2026-08-01T22:00:00Z' })],
    'Verify',
    6 * 60 * 60 * 1000,
    new Date('2026-08-02T00:00:00Z'),
  );
  assert.equal(evaluation.needsAttention, false);
  assert.equal(evaluation.activityAt, '2026-08-01T22:00:00.000Z');
});

test('a stale green-but-unmerged PR alerts because the deliverable still did not land', () => {
  const evaluation = evaluateDeliverable(
    pullRequest(),
    [checkRun({ conclusion: 'success' })],
    'Verify',
    6 * 60 * 60 * 1000,
    new Date('2026-08-02T00:00:00Z'),
  );
  assert.equal(evaluation.needsAttention, true);
  assert.match(evaluation.reason, /passed, but the PR remains open/u);
});

test('a missing required check becomes actionable only after the inactivity window', () => {
  const stale = evaluateDeliverable(
    pullRequest(),
    [],
    'Verify',
    6 * 60 * 60 * 1000,
    new Date('2026-08-02T00:00:00Z'),
  );
  assert.equal(stale.needsAttention, true);
  assert.match(stale.reason, /is missing/u);

  const recent = evaluateDeliverable(
    pullRequest({ headCommittedAt: '2026-08-01T23:00:00Z' }),
    [],
    'Verify',
    6 * 60 * 60 * 1000,
    new Date('2026-08-02T00:00:00Z'),
  );
  assert.equal(recent.needsAttention, false);
});
