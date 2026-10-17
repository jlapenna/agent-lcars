import { describe, expect, it } from 'vitest';

import type { ActionItem } from '../lib/action-items';
import { decisionRows } from './decision-rows';
import type { InboxCard } from './inbox-card';

const item = (overrides: Partial<ActionItem>): ActionItem =>
  ({
    kind: 'issue',
    repo: { owner: 'octo', name: 'example' },
    number: 7,
    title: 'Decide the retention window',
    url: 'https://github.com/octo/example/issues/7',
    updatedAt: '2026-10-13T01:00:00Z',
    actionTypes: ['needs-human'],
    labels: ['agent:claude'],
    assigneeLogins: [],
    ...overrides,
  }) as ActionItem;

describe('decisionRows', () => {
  it('orders by reason rank with onsite links', () => {
    const cards = [
      { item: item({ number: 9, actionTypes: ['run-failed'], labels: [] }) },
      {
        item: item({
          number: 8,
          kind: 'pr',
          actionTypes: ['review-requested'],
          updatedAt: '2026-10-13T00:00:00Z',
        }),
      },
      { item: item({}) },
    ] as unknown as InboxCard[];

    const rows = decisionRows(cards, 'octo/example');

    // Human needed (rank 0) precedes review requested (rank 1).
    expect(rows.map((row) => row.key)).toEqual([
      'octo/example#7',
      'octo/example#8',
      'octo/example#9',
    ]);
    expect(rows[1]).toMatchObject({
      reason: 'Review requested',
      ref: 'example PR #8',
      refHref: '/task/octo/example/8',
      agent: 'claude',
    });
    expect(rows[0]?.respondHref).toBe(
      '/inbox?repo=octo%2Fexample&item=octo%2Fexample%237',
    );
    expect(rows[2]?.agent).toBeUndefined();
  });
});

it('reads a native report as a report, after every decision', () => {
  const native = (kind: 'decision' | 'report', id: string) => ({
    kind,
    queued: true,
    canReply: true,
    work: {
      id,
      anchor: { workId: id.slice('work:'.length) },
      state: kind === 'report' ? 'done' : 'parked',
      updatedAt: '2026-10-13T00:00:00Z',
      spec: {
        title: 'Audit',
        pipeline: 'claude',
        target: { repo: 'octo/example' },
      },
      runs: [
        {
          result: {
            ok: true,
            summary: kind === 'report' ? 'report' : 'park',
            message: 'text',
          },
        },
      ],
    },
  });
  const rows = decisionRows([
    native('report', 'work:A'),
    native('decision', 'work:B'),
  ] as unknown as InboxCard[]);
  expect(rows.map((row) => [row.key, row.reason])).toEqual([
    ['work:B', 'Human needed'],
    ['work:A', 'Report ready'],
  ]);
});
