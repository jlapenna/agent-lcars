import { describe, expect, it } from 'vitest';

import type { ActionItem } from '../lib/action-items';
import {
  mergeBlockedReason,
  queueDisclosureLabels,
  queueReasonFor,
} from './queue-reason';

function makeItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    kind: 'issue',
    repo: { owner: 'agent', name: 'lcars' },
    number: 249,
    title: 'Responsive Inbox',
    url: 'https://github.com/agent/lcars/issues/249',
    updatedAt: '2026-07-30T00:00:00Z',
    actionTypes: [],
    labels: [],
    assigneeLogins: [],
    ...overrides,
  };
}

describe('queueReasonFor', () => {
  it('returns one highest-priority reason instead of every action type', () => {
    const reason = queueReasonFor(
      makeItem({
        actionTypes: ['run-failed', 'review-requested', 'needs-human'],
      }),
    );

    expect(reason).toEqual({
      type: 'needs-human',
      label: 'Human needed',
      color: 'blue',
      rank: 0,
    });
  });

  it('returns undefined when an item has no actionable reason', () => {
    expect(queueReasonFor(makeItem())).toBeUndefined();
  });

  it('describes a groomed item awaiting agent dispatch', () => {
    expect(
      queueReasonFor(makeItem({ actionTypes: ['ready-for-agent'] })),
    ).toEqual({
      type: 'ready-for-agent',
      label: 'Ready for agent',
      color: 'cyan',
      rank: 2,
    });
  });
});

describe('mergeBlockedReason', () => {
  it('names the unresolved review-thread count when that is the reason (#538)', () => {
    expect(
      mergeBlockedReason(
        makeItem({
          actionTypes: ['merge-blocked'],
          unresolvedReviewThreadCount: 3,
        }),
      ),
    ).toBe('3 unresolved review threads');
  });

  it('singularizes a count of one', () => {
    expect(
      mergeBlockedReason(
        makeItem({
          actionTypes: ['merge-blocked'],
          unresolvedReviewThreadCount: 1,
        }),
      ),
    ).toBe('1 unresolved review thread');
  });

  it('is undefined when merge-blocked came from a behind base, not threads', () => {
    expect(
      mergeBlockedReason(makeItem({ actionTypes: ['merge-blocked'] })),
    ).toBeUndefined();
  });

  it('is undefined for an item with no merge-blocked reason at all', () => {
    expect(mergeBlockedReason(makeItem())).toBeUndefined();
  });
});

describe('queueDisclosureLabels', () => {
  it('keeps useful GitHub labels while hiding routing labels', () => {
    expect(
      queueDisclosureLabels(
        makeItem({
          labels: [
            'agent:claude',
            'status:ready-for-agent',
            'status:needs-human',
            'type:bug',
            'app:console',
            'priority',
          ],
        }),
      ),
    ).toEqual(['type:bug', 'app:console', 'priority']);
  });
});
