import assert from 'node:assert/strict';

import { needsMaintainer } from '@agent-lcars/dispatch-contracts';
import { test } from 'vitest';

import { classifyWorkerFailureOutcome } from './worker-failure';

test('classifies startup-failure as a manual, worker-owned bootstrap failure', () => {
  const failure = classifyWorkerFailureOutcome('startup-failure');
  assert.ok(failure);
  assert.equal(failure.owningSystem, 'worker');
  assert.equal(failure.phase, 'bootstrap');
  assert.equal(failure.reason, 'worker_startup_failed');
  assert.equal(failure.retryDisposition, 'manual');
});

test('classifies trajectory-failure as a manual, worker-owned execution failure', () => {
  const failure = classifyWorkerFailureOutcome('trajectory-failure');
  assert.ok(failure);
  assert.equal(failure.owningSystem, 'worker');
  assert.equal(failure.phase, 'agent_execution');
  assert.equal(failure.reason, 'agent_exited_nonzero');
  assert.equal(failure.retryDisposition, 'manual');
});

test('classifies outcome-gate-failure as a manual, finalizer-owned validation failure', () => {
  const failure = classifyWorkerFailureOutcome('outcome-gate-failure');
  assert.ok(failure);
  assert.equal(failure.owningSystem, 'finalizer');
  assert.equal(failure.phase, 'validation');
  assert.equal(failure.reason, 'deliverable_absent');
  assert.equal(failure.retryDisposition, 'manual');
});

test('every failure-kind classification needs a maintainer -- a completed worker attempt is never automatically retried at this layer', () => {
  for (const outcome of [
    'startup-failure',
    'trajectory-failure',
    'outcome-gate-failure',
  ] as const) {
    const failure = classifyWorkerFailureOutcome(outcome);
    assert.ok(failure);
    assert.equal(
      needsMaintainer(failure),
      true,
      `${outcome} must satisfy needsMaintainer so projectNeedsHumanPark actually parks it`,
    );
  }
});

test('returns undefined for every non-failure outcome kind -- nothing to project', () => {
  for (const outcome of [
    'park',
    'no-op',
    'pull-request',
    'merged-deliverable',
    'review',
    'comment',
    'closed',
    'unknown-success',
  ] as const) {
    assert.equal(classifyWorkerFailureOutcome(outcome), undefined);
  }
});
