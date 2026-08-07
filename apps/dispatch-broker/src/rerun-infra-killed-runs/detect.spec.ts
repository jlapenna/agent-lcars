import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  buildRerunCommentBody,
  isEligibleForRerun,
  jobLooksInfraKilled,
  runLooksInfraKilled,
  selectAssociatedPullRequest,
} from './detect.js';

function step(conclusion, overrides = {}) {
  return { name: 'a step', status: 'completed', conclusion, ...overrides };
}

// Mirrors PR #469's Verify run (30893470148): conclusion `failure`, every
// recorded step's own conclusion `null` -- the runner died before any step
// resolved.
function infraKilledJob(overrides = {}) {
  return {
    name: 'Verify',
    conclusion: 'failure',
    steps: [step(null), step(null), step(null)],
    ...overrides,
  };
}

// A real test failure: steps before the break succeeded, the one that
// broke has a non-null `failure` conclusion, and anything after it is
// skipped -- never all-null.
function realFailureJob(overrides = {}) {
  return {
    name: 'Verify',
    conclusion: 'failure',
    steps: [step('success'), step('success'), step('failure'), step('skipped')],
    ...overrides,
  };
}

test('a job with every step conclusion null is infra-killed', () => {
  assert.equal(jobLooksInfraKilled(infraKilledJob()), true);
});

test('a job with one real failed step is not infra-killed', () => {
  assert.equal(jobLooksInfraKilled(realFailureJob()), false);
});

test('a successful job is never infra-killed', () => {
  assert.equal(
    jobLooksInfraKilled({
      name: 'Verify',
      conclusion: 'success',
      steps: [step('success'), step('success')],
    }),
    false,
  );
});

test('a cancelled job is not infra-killed (conclusion must be failure, not cancelled)', () => {
  assert.equal(
    jobLooksInfraKilled({
      name: 'Verify',
      conclusion: 'cancelled',
      steps: [step(null), step(null)],
    }),
    false,
  );
});

test('a failed job with zero recorded steps is not infra-killed', () => {
  // An empty steps array trivially satisfies Array.prototype.every, which
  // would otherwise be a false positive for a job that never even started
  // -- require at least one recorded step showing the null-conclusion
  // shape.
  assert.equal(
    jobLooksInfraKilled({ name: 'Verify', conclusion: 'failure', steps: [] }),
    false,
  );
  assert.equal(
    jobLooksInfraKilled({
      name: 'Verify',
      conclusion: 'failure',
      steps: undefined,
    }),
    false,
  );
});

test('a run whose only failed job is infra-killed matches', () => {
  assert.equal(
    runLooksInfraKilled([
      infraKilledJob(),
      { name: 'E2E', conclusion: 'success', steps: [] },
    ]),
    true,
  );
});

test('a run with a real step failure never matches, even alongside an infra-killed job', () => {
  // A mixed run (one job genuinely broken, another infra-killed) must not
  // be masked by an automatic rerun that can only ever re-fail the
  // genuinely broken job again -- leaving the whole run red is correct.
  assert.equal(
    runLooksInfraKilled([
      infraKilledJob({ name: 'Verify' }),
      realFailureJob({ name: 'E2E' }),
    ]),
    false,
  );
});

test('a run with no failed jobs at all does not match', () => {
  assert.equal(
    runLooksInfraKilled([
      { name: 'Verify', conclusion: 'success', steps: [step('success')] },
    ]),
    false,
  );
  assert.equal(runLooksInfraKilled([]), false);
  assert.equal(runLooksInfraKilled(undefined), false);
});

test('a run at attempt 1 with conclusion failure is eligible for rerun', () => {
  assert.equal(
    isEligibleForRerun({
      status: 'completed',
      conclusion: 'failure',
      run_attempt: 1,
    }),
    true,
  );
});

test('a run already rerun once (attempt 2+) is never eligible again -- the loop guard', () => {
  assert.equal(
    isEligibleForRerun({
      status: 'completed',
      conclusion: 'failure',
      run_attempt: 2,
    }),
    false,
  );
  assert.equal(
    isEligibleForRerun({
      status: 'completed',
      conclusion: 'failure',
      run_attempt: 3,
    }),
    false,
  );
});

test('a successful or still-running run is never eligible for rerun', () => {
  assert.equal(
    isEligibleForRerun({
      status: 'completed',
      conclusion: 'success',
      run_attempt: 1,
    }),
    false,
  );
  assert.equal(
    isEligibleForRerun({
      status: 'in_progress',
      conclusion: null,
      run_attempt: 1,
    }),
    false,
  );
});

test('selectAssociatedPullRequest prefers an open PR over a closed/merged one', () => {
  const pulls = [
    { number: 100, state: 'closed' },
    { number: 469, state: 'open' },
  ];
  assert.deepEqual(selectAssociatedPullRequest(pulls), {
    number: 469,
    state: 'open',
  });
});

test('selectAssociatedPullRequest falls back to the first result when none are open', () => {
  const pulls = [{ number: 100, state: 'closed' }];
  assert.deepEqual(selectAssociatedPullRequest(pulls), {
    number: 100,
    state: 'closed',
  });
});

test('selectAssociatedPullRequest returns undefined for no associated PRs', () => {
  assert.equal(selectAssociatedPullRequest([]), undefined);
  assert.equal(selectAssociatedPullRequest(undefined), undefined);
});

test('buildRerunCommentBody names the failed job(s), links the run, and cites the issue', () => {
  const body = buildRerunCommentBody({
    runUrl: 'https://github.com/jlapenna/agent-lcars/actions/runs/30893470148',
    workflowName: 'CI',
    jobNames: ['Verify'],
  });
  assert.match(body, /Verify/u);
  assert.match(body, /every step's conclusion `null`/u);
  assert.match(body, /agent-lcars#536/u);
  assert.match(
    body,
    /https:\/\/github\.com\/jlapenna\/agent-lcars\/actions\/runs\/30893470148/u,
  );
});
