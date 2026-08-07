import { describe, expect, it } from 'vitest';

import {
  isWellFormedProjectionStatus,
  PROJECTION_CONVERGENCE_STATES,
} from './projection';

function statusFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    desiredRevision: 5,
    observedRevision: 5,
    state: 'converged',
    observedAt: '2026-08-06T00:00:00.000Z',
    ...overrides,
  };
}

describe('isWellFormedProjectionStatus', () => {
  it('accepts a converged checkpoint', () => {
    expect(isWellFormedProjectionStatus(statusFixture())).toBe(true);
  });

  it('accepts a diverged checkpoint whose observedRevision trails desiredRevision', () => {
    expect(
      isWellFormedProjectionStatus(
        statusFixture({
          desiredRevision: 7,
          observedRevision: 5,
          state: 'diverged',
        }),
      ),
    ).toBe(true);
  });

  it('accepts every declared convergence state', () => {
    for (const state of PROJECTION_CONVERGENCE_STATES) {
      expect(isWellFormedProjectionStatus(statusFixture({ state }))).toBe(true);
    }
  });

  it('rejects a non-object', () => {
    expect(isWellFormedProjectionStatus(undefined)).toBe(false);
    expect(isWellFormedProjectionStatus(null)).toBe(false);
    expect(isWellFormedProjectionStatus('converged')).toBe(false);
    expect(isWellFormedProjectionStatus([])).toBe(false);
  });

  it('rejects a negative or non-integer revision', () => {
    expect(
      isWellFormedProjectionStatus(statusFixture({ desiredRevision: -1 })),
    ).toBe(false);
    expect(
      isWellFormedProjectionStatus(statusFixture({ observedRevision: 1.5 })),
    ).toBe(false);
  });

  it('rejects an unknown convergence state', () => {
    expect(
      isWellFormedProjectionStatus(statusFixture({ state: 'convergd' })),
    ).toBe(false);
  });

  it('rejects a missing or empty observedAt', () => {
    expect(
      isWellFormedProjectionStatus(statusFixture({ observedAt: undefined })),
    ).toBe(false);
    expect(
      isWellFormedProjectionStatus(statusFixture({ observedAt: '' })),
    ).toBe(false);
  });
});
