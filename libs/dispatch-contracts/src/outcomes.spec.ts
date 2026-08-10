import { describe, expect, it } from 'vitest';

import {
  DISPATCH_OUTCOME_KINDS,
  dispatchOutcomeReferenceSchema,
  isDispatchOutcomeKind,
  isDispatchOutcomeReference,
  isFailureOutcomeKind,
} from './outcomes';

describe('isDispatchOutcomeKind', () => {
  it('accepts every declared outcome kind', () => {
    for (const kind of DISPATCH_OUTCOME_KINDS) {
      expect(isDispatchOutcomeKind(kind)).toBe(true);
    }
  });

  it('rejects an unknown string', () => {
    expect(isDispatchOutcomeKind('bogus-outcome')).toBe(false);
  });
});

describe('isDispatchOutcomeReference', () => {
  it('accepts a well-formed pull-request reference', () => {
    expect(
      isDispatchOutcomeReference({ kind: 'pull-request', number: 42 }),
    ).toBe(true);
  });

  it('rejects a non-positive number', () => {
    expect(
      dispatchOutcomeReferenceSchema.safeParse({
        kind: 'pull-request',
        number: 0,
      }).success,
    ).toBe(false);
  });
});

// isFailureOutcomeKind is the ONE place "does this outcome mean the attempt
// itself failed" is decided (agent-lcars#813) -- the dispatch broker's
// worker-failure classification reads this instead of re-deriving its own
// list, so this is worth pinning exactly.
describe('isFailureOutcomeKind', () => {
  it.each([
    'startup-failure',
    'trajectory-failure',
    'outcome-gate-failure',
  ] as const)('classifies %s as a failure outcome', (kind) => {
    expect(isFailureOutcomeKind(kind)).toBe(true);
  });

  it.each([
    'park',
    'no-op',
    'pull-request',
    'merged-deliverable',
    'review',
    'comment',
    'closed',
    'unknown-success',
  ] as const)('does not classify %s as a failure outcome', (kind) => {
    expect(isFailureOutcomeKind(kind)).toBe(false);
  });

  it('partitions DISPATCH_OUTCOME_KINDS exactly into failure/non-failure with no gap', () => {
    const failureCount =
      DISPATCH_OUTCOME_KINDS.filter(isFailureOutcomeKind).length;
    expect(failureCount).toBe(3);
    expect(DISPATCH_OUTCOME_KINDS.length - failureCount).toBe(8);
  });
});
