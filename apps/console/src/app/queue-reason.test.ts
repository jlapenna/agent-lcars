import { describe, expect, it } from 'vitest';

import type { ActionItem } from '../lib/action-items';
import { queueDisclosureLabels, queueReasonFor } from './queue-reason';

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
        actionTypes: ['run-failed', 'review-requested', 'human-needed'],
      }),
    );

    expect(reason).toEqual({
      type: 'human-needed',
      label: 'Human needed',
      color: 'blue',
      rank: 0,
    });
  });

  it('returns undefined when an item has no actionable reason', () => {
    expect(queueReasonFor(makeItem())).toBeUndefined();
  });
});

describe('queueDisclosureLabels', () => {
  it('keeps useful GitHub labels while hiding routing labels', () => {
    expect(
      queueDisclosureLabels(
        makeItem({
          labels: ['claude', 'human-needed', 'bug', 'console', 'priority'],
        }),
      ),
    ).toEqual(['bug', 'console', 'priority']);
  });
});
