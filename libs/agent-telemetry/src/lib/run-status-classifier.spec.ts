import { describe, expect, it } from 'vitest';

import {
  ClassifierRunInput,
  ClassifierSessionInput,
  classifyRunStatus,
  isLikelyTimeoutRun,
  LIKELY_TIMEOUT_FRACTION,
} from './run-status-classifier';

const TIMEOUT_MINUTES = 90;

function run(overrides: Partial<ClassifierRunInput> = {}): ClassifierRunInput {
  return {
    status: 'completed',
    conclusion: 'success',
    elapsedSeconds: 300,
    timeoutMinutes: TIMEOUT_MINUTES,
    ...overrides,
  };
}

function session(
  overrides: Partial<ClassifierSessionInput> = {},
): ClassifierSessionInput {
  return {
    turns: 5,
    ...overrides,
  };
}

describe('classifyRunStatus', () => {
  describe('non-completed runs', () => {
    it.each([['queued'], ['running']] as const)(
      'status %s (any conclusion, any session) classifies as running',
      (status) => {
        expect(classifyRunStatus(run({ status }))).toEqual({
          status: 'running',
        });
        expect(
          classifyRunStatus(run({ status }), session({ turns: 0 })),
        ).toEqual({ status: 'running' });
      },
    );
  });

  describe('timeout vs. manual cancel', () => {
    it('flags a cancelled run at exactly the timeout fraction as timeout', () => {
      const elapsedSeconds = TIMEOUT_MINUTES * 60 * LIKELY_TIMEOUT_FRACTION;
      const result = classifyRunStatus(
        run({ conclusion: 'cancelled', elapsedSeconds }),
      );
      expect(result.status).toBe('timeout');
      expect(result.diagnosis).toContain('90-minute wall-clock budget');
    });

    it('flags a cancelled run past the timeout fraction as timeout', () => {
      const result = classifyRunStatus(
        run({ conclusion: 'cancelled', elapsedSeconds: TIMEOUT_MINUTES * 60 }),
      );
      expect(result.status).toBe('timeout');
    });

    it('does not flag a cancelled run just under the timeout fraction', () => {
      const elapsedSeconds = TIMEOUT_MINUTES * 60 * LIKELY_TIMEOUT_FRACTION - 1;
      const result = classifyRunStatus(
        run({ conclusion: 'cancelled', elapsedSeconds }),
      );
      expect(result.status).toBe('cancelled');
    });

    it('classifies a quickly-cancelled run (manual/API cancel) as cancelled, not timeout', () => {
      const result = classifyRunStatus(
        run({ conclusion: 'cancelled', elapsedSeconds: 30 }),
      );
      expect(result).toEqual({ status: 'cancelled', diagnosis: undefined });
    });

    it('timeout classification does not require a session', () => {
      const result = classifyRunStatus(
        run({ conclusion: 'cancelled', elapsedSeconds: TIMEOUT_MINUTES * 60 }),
        session({ result: { subtype: 'success', isError: false } }),
      );
      // The elapsed-time signal wins outright over anything the session says.
      expect(result.status).toBe('timeout');
    });

    it('isLikelyTimeoutRun matches classifyRunStatus exactly', () => {
      const cancelledAtBudget = run({
        conclusion: 'cancelled',
        elapsedSeconds: TIMEOUT_MINUTES * 60,
      });
      expect(isLikelyTimeoutRun(cancelledAtBudget)).toBe(true);
      expect(classifyRunStatus(cancelledAtBudget).status).toBe('timeout');

      const cancelledEarly = run({
        conclusion: 'cancelled',
        elapsedSeconds: 5,
      });
      expect(isLikelyTimeoutRun(cancelledEarly)).toBe(false);
      expect(classifyRunStatus(cancelledEarly).status).toBe('cancelled');
    });
  });

  describe('conclusion: failure', () => {
    it('with no session: failed, no diagnosis', () => {
      expect(classifyRunStatus(run({ conclusion: 'failure' }))).toEqual({
        status: 'failed',
        diagnosis: undefined,
      });
    });

    it('with a normal (non-error) session: failed, no diagnosis', () => {
      const result = classifyRunStatus(
        run({ conclusion: 'failure' }),
        session({ result: { subtype: 'success', isError: false } }),
      );
      expect(result).toEqual({ status: 'failed', diagnosis: undefined });
    });

    it('with a max-turns session: failed, max-turns diagnosis', () => {
      const result = classifyRunStatus(
        run({ conclusion: 'failure' }),
        session({ result: { subtype: 'error_max_turns', isError: true } }),
      );
      expect(result.status).toBe('failed');
      expect(result.diagnosis).toContain('max-turns');
    });

    it('with an auth-error session (isError + $0 cost): failed, auth diagnosis', () => {
      const result = classifyRunStatus(
        run({ conclusion: 'failure' }),
        session({
          result: { subtype: 'error_during_execution', isError: true },
          totalCostUsd: 0,
        }),
      );
      expect(result.status).toBe('failed');
      expect(result.diagnosis).toContain('expired or invalid OAuth token');
    });

    it('with an auth-error session (isError + no cost field at all): failed, auth diagnosis', () => {
      const result = classifyRunStatus(
        run({ conclusion: 'failure' }),
        session({
          result: { subtype: 'error_during_execution', isError: true },
        }),
      );
      expect(result.diagnosis).toContain('expired or invalid OAuth token');
    });

    it('with a crash session (isError + real cost): failed, crash diagnosis', () => {
      const result = classifyRunStatus(
        run({ conclusion: 'failure' }),
        session({
          result: { subtype: 'error_during_execution', isError: true },
          totalCostUsd: 2.1,
        }),
      );
      expect(result.status).toBe('failed');
      expect(result.diagnosis).toContain('Session errored during execution');
    });

    it('does not apply the success-only zero-work heuristic to a failed run with zero turns (noise guard)', () => {
      const result = classifyRunStatus(
        run({ conclusion: 'failure' }),
        session({ turns: 0 }),
      );
      expect(result).toEqual({ status: 'failed', diagnosis: undefined });
    });
  });

  describe('conclusion: cancelled (below the timeout fraction)', () => {
    it('with no session: cancelled, no diagnosis', () => {
      expect(
        classifyRunStatus(run({ conclusion: 'cancelled', elapsedSeconds: 10 })),
      ).toEqual({ status: 'cancelled', diagnosis: undefined });
    });

    it('with a max-turns session: cancelled, max-turns diagnosis', () => {
      const result = classifyRunStatus(
        run({ conclusion: 'cancelled', elapsedSeconds: 10 }),
        session({ result: { subtype: 'error_max_turns', isError: true } }),
      );
      expect(result.status).toBe('cancelled');
      expect(result.diagnosis).toContain('max-turns');
    });
  });

  // The success branch only flags `silent-error` on session-PROVABLE
  // anomalies (an error result, zero turns, or zero cost across at most one
  // turn) - never on "no PR/commit", since claude.yml's own server-side
  // gates ("Verify Claude run status" / "Verify a deliverable exists")
  // already fail the job before a run can report `success` with no
  // deliverable evidence in GitHub state. A comment-only @claude-reply or a
  // post-deploy-verify run is therefore expected to classify as plain
  // `succeeded`, not `silent-error`.
  describe('conclusion: success', () => {
    it('with no session: succeeded, no diagnosis (graceful degradation)', () => {
      expect(classifyRunStatus(run({ conclusion: 'success' }))).toEqual({
        status: 'succeeded',
        diagnosis: undefined,
      });
    });

    it('with a normal session (comment-only reply shape - real turns, no PR/commit, no cost data): succeeded, no diagnosis', () => {
      const result = classifyRunStatus(
        run({ conclusion: 'success' }),
        session({ result: { subtype: 'success', isError: false }, turns: 3 }),
      );
      expect(result).toEqual({ status: 'succeeded', diagnosis: undefined });
    });

    it('with an error result (e.g. max-turns exhaustion) despite GitHub reporting success: silent-error', () => {
      const result = classifyRunStatus(
        run({ conclusion: 'success' }),
        session({ result: { subtype: 'error_max_turns', isError: true } }),
      );
      expect(result.status).toBe('silent-error');
      expect(result.diagnosis).toContain('failure signature');
    });

    it('with an error result (auth/startup crash) despite GitHub reporting success: silent-error', () => {
      const result = classifyRunStatus(
        run({ conclusion: 'success' }),
        session({
          result: { subtype: 'error_during_execution', isError: true },
          totalCostUsd: 0,
        }),
      );
      expect(result.status).toBe('silent-error');
    });

    it('with zero recorded turns: silent-error', () => {
      const result = classifyRunStatus(
        run({ conclusion: 'success' }),
        session({ turns: 0 }),
      );
      expect(result.status).toBe('silent-error');
      expect(result.diagnosis).toContain('zero turns');
    });

    it('with $0 cost and exactly one turn: silent-error', () => {
      const result = classifyRunStatus(
        run({ conclusion: 'success' }),
        session({ turns: 1, totalCostUsd: 0 }),
      );
      expect(result.status).toBe('silent-error');
    });

    it('with $0 cost and zero turns: silent-error (both signals agree)', () => {
      const result = classifyRunStatus(
        run({ conclusion: 'success' }),
        session({ turns: 0, totalCostUsd: 0 }),
      );
      expect(result.status).toBe('silent-error');
    });

    it('with $0 cost but more than one turn: succeeded, no diagnosis', () => {
      const result = classifyRunStatus(
        run({ conclusion: 'success' }),
        session({ turns: 2, totalCostUsd: 0 }),
      );
      expect(result).toEqual({ status: 'succeeded', diagnosis: undefined });
    });

    it('with real cost and one turn: succeeded, no diagnosis', () => {
      const result = classifyRunStatus(
        run({ conclusion: 'success' }),
        session({ turns: 1, totalCostUsd: 0.05 }),
      );
      expect(result).toEqual({ status: 'succeeded', diagnosis: undefined });
    });

    it('absent totalCostUsd never flags on its own (PRD story 16 degradation)', () => {
      const result = classifyRunStatus(
        run({ conclusion: 'success' }),
        session({ turns: 5, totalCostUsd: undefined }),
      );
      expect(result).toEqual({ status: 'succeeded', diagnosis: undefined });
    });
  });

  describe('conclusion: other/undefined (defensive fallback)', () => {
    it('treats an unexpected conclusion as failed rather than throwing', () => {
      expect(() =>
        classifyRunStatus(run({ conclusion: 'other' })),
      ).not.toThrow();
      expect(classifyRunStatus(run({ conclusion: 'other' })).status).toBe(
        'failed',
      );
    });

    it('treats a missing conclusion on a completed run as failed', () => {
      expect(classifyRunStatus(run({ conclusion: undefined })).status).toBe(
        'failed',
      );
    });
  });
});
