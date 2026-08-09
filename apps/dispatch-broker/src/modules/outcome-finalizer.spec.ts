import { strict as assert } from 'node:assert';

import { test } from 'vitest';

import {
  MISSING_RUN_GRACE_MS,
  reconcileExecution,
  STUCK_RUN_GRACE_MS,
} from './outcome-finalizer';

const started = '2026-01-01T00:00:00.000Z';
const after = (milliseconds: number) =>
  new Date(Date.parse(started) + milliseconds).toISOString();

test('classifies an unbound attempt as not_started', () => {
  assert.deepEqual(
    reconcileExecution({
      attempt: { dispatchStartedAt: started },
      now: after(MISSING_RUN_GRACE_MS - 1),
      priorObservations: [],
    }),
    { state: 'not_started', action: 'wait', ageMs: MISSING_RUN_GRACE_MS - 1 },
  );
});

test('classifies a bound non-terminal attempt as running', () => {
  assert.deepEqual(
    reconcileExecution({
      attempt: { dispatchStartedAt: started, boundAt: started, runId: 7 },
      run: { status: 'in_progress' },
      now: after(STUCK_RUN_GRACE_MS - 1),
      priorObservations: [],
    }),
    { state: 'running', action: 'wait', ageMs: STUCK_RUN_GRACE_MS - 1 },
  );
});

for (const [conclusion, state] of [
  ['success', 'exited'],
  ['timed_out', 'timed_out'],
  ['cancelled', 'cancelled'],
] as const) {
  test(`classifies a completed ${conclusion} attempt as ${state}`, () => {
    assert.deepEqual(
      reconcileExecution({
        attempt: { dispatchStartedAt: started, runId: 7 },
        run: { status: 'completed', conclusion },
        now: started,
        priorObservations: [],
      }),
      { state, action: 'finalize' },
    );
  });
}

test('classifies an unbound attempt as lost at the bounded observation', () => {
  const now = after(MISSING_RUN_GRACE_MS);
  const decision = reconcileExecution({
    attempt: { dispatchStartedAt: started },
    now,
    priorObservations: [{ occurredAt: started }, { occurredAt: started }],
  });
  assert.equal(decision.state, 'lost');
  assert.equal(decision.action, 'escalate');
  if (decision.action === 'escalate') {
    assert.equal(decision.cause, 'run_missing');
    assert.equal(decision.observation, 3);
  }
});
