import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import {
  CLOSED_SWEEP_WINDOW_MS,
  RECONCILE_DISPATCH_CONCURRENCY,
  type ReconcileIssue,
  type ReconcileIssueQuery,
  type ReconcileTransport,
  runReconcileScan,
} from './scan';

function transport(options?: {
  list?: (query: ReconcileIssueQuery) => Promise<ReconcileIssue[]>;
  dispatch?: (repository: string, issue: number) => Promise<unknown>;
}): ReconcileTransport {
  return {
    listIssues: options?.list ?? (async () => []),
    dispatchReconcile: options?.dispatch ?? (async () => undefined),
  };
}

describe('host-independent reconciliation scan', () => {
  it('unions labeled and fleet-assigned open and recent closed anchors', async () => {
    const now = '2026-08-07T12:00:00.000Z';
    const expectedSince = new Date(
      Date.parse(now) - CLOSED_SWEEP_WINDOW_MS,
    ).toISOString();
    const queries: ReconcileIssueQuery[] = [];
    const dispatched: number[] = [];
    const result = await runReconcileScan(
      transport({
        list: async (query) => {
          queries.push(query);
          if (query.state === 'open' && query.label === 'agent:claude') {
            return [{ number: 5 }, { number: 10 }];
          }
          if (query.state === 'open' && query.assignee === 'jclaw-bot') {
            return [{ number: 10 }, { number: 20 }];
          }
          if (query.state === 'closed' && query.label === 'review:codex') {
            return [{ number: 30 }];
          }
          if (query.state === 'closed' && query.assignee === 'jclaw-bot') {
            return [{ number: 30 }, { number: 40 }];
          }
          return [];
        },
        dispatch: async (_repository, issue) => {
          dispatched.push(issue);
        },
      }),
      'jlapenna/agent-lcars',
      'jclaw-bot',
      now,
    );

    assert.deepEqual(dispatched, [5, 10, 20, 30, 40]);
    assert.deepEqual(result, {
      candidates: 5,
      dispatched: 5,
      failed: [],
      openCandidates: 3,
      closedCandidates: 2,
    });
    assert.equal(
      queries.filter((query) => query.state === 'open' && query.label).length,
      6,
      'one open query per agent/review label',
    );
    const closed = queries.filter((query) => query.state === 'closed');
    assert.equal(closed.length, 7, 'six labels plus the fleet assignee lane');
    for (const query of closed) assert.equal(query.since, expectedSince);
  });

  it('omits both fleet-assignee lanes when no fleet login is configured', async () => {
    const queries: ReconcileIssueQuery[] = [];
    await runReconcileScan(
      transport({
        list: async (query) => {
          queries.push(query);
          return [];
        },
      }),
      'jlapenna/agent-lcars',
      '',
    );
    assert.equal(queries.length, 12, 'six labels for each of two states');
    assert.ok(queries.every((query) => query.assignee === undefined));
  });

  it('paginates every discovery lane and rejects an unbounded response', async () => {
    const pages: number[] = [];
    const pageOne = Array.from({ length: 100 }, (_, index) => ({
      number: index + 1,
    }));
    const result = await runReconcileScan(
      transport({
        list: async (query) => {
          if (query.state === 'open' && query.label === 'agent:claude') {
            pages.push(query.page);
            return query.page === 1 ? pageOne : [{ number: 101 }];
          }
          return [];
        },
      }),
      'jlapenna/agent-lcars',
      '',
    );
    assert.deepEqual(pages, [1, 2]);
    assert.equal(result.candidates, 101);
  });

  it('bounds concurrent dispatches and reports failures without skipping later candidates', async () => {
    let active = 0;
    let maxActive = 0;
    const candidates = Array.from(
      { length: RECONCILE_DISPATCH_CONCURRENCY * 3 + 1 },
      (_, index) => ({ number: index + 1 }),
    );
    const seen: number[] = [];
    const result = await runReconcileScan(
      transport({
        list: async (query) =>
          query.state === 'open' && query.label === 'agent:claude'
            ? candidates
            : [],
        dispatch: async (_repository, issue) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active -= 1;
          seen.push(issue);
          if (issue === 2) throw new Error('dispatch rejected');
        },
      }),
      'jlapenna/agent-lcars',
      '',
    );

    assert.equal(maxActive, RECONCILE_DISPATCH_CONCURRENCY);
    assert.equal(seen.length, candidates.length);
    assert.equal(result.dispatched, candidates.length - 1);
    assert.deepEqual(result.failed, [
      { issue: 2, message: 'dispatch rejected' },
    ]);
  });
});
