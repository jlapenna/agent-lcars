import {
  type GithubAnchorProjection,
  MemoryStore,
} from '@agent-lcars/orchestrator';
import { describe, expect, it, vi } from 'vitest';

import {
  ANCHOR_RECONCILE_MAX_PAGES_PER_REPOSITORY,
  ANCHOR_RECONCILE_PAGE_SIZE,
  AnchorProjectionBackfillLimitError,
  compareSelectedGithubAnchorProjections,
  reconcileGithubAnchorProjections,
  refreshGithubAnchorProjection,
} from './github-anchor-reconcile';

const REPO = 'jlapenna/agent-lcars';
const anchor = {
  number: 42,
  title: 'Backfill the anchor',
  body: 'No queue fallback.',
  html_url: `https://github.com/${REPO}/issues/42`,
  state: 'open',
  updated_at: '2026-08-30T12:00:00.000Z',
  user: { login: 'jlapenna' },
  labels: [],
  assignees: [],
};
const projection = (title = anchor.title): GithubAnchorProjection => ({
  anchor: { repo: REPO, issue: 42 },
  kind: 'pr',
  state: 'open',
  title,
  body: anchor.body,
  url: anchor.html_url,
  author: 'jlapenna',
  labels: [],
  assigneeLogins: [],
  sourceUpdatedAt: anchor.updated_at,
  observedAt: '2026-08-30T12:00:01.000Z',
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('refreshGithubAnchorProjection', () => {
  it('keeps a newer webhook refresh over an older in-flight backfill fetch', async () => {
    const store = new MemoryStore();
    const older = deferred<GithubAnchorProjection>();
    const first = refreshGithubAnchorProjection(
      { store, load: () => older.promise },
      projection().anchor,
    );
    await Promise.resolve();
    const newer = await refreshGithubAnchorProjection(
      { store, load: async () => projection('webhook current') },
      projection().anchor,
    );
    older.resolve(projection('stale backfill'));
    await expect(first).resolves.toMatchObject({ applied: false });
    expect(newer).toMatchObject({ applied: true });
    await expect(
      store.readGithubAnchorProjection(projection().anchor),
    ).resolves.toMatchObject({ title: 'webhook current' });
  });

  it('keeps the exact-current review-thread state when resolve and unresolve deliveries race', async () => {
    const store = new MemoryStore();
    const older = deferred<GithubAnchorProjection>();
    const first = refreshGithubAnchorProjection(
      { store, load: () => older.promise },
      projection().anchor,
    );
    await Promise.resolve();
    await refreshGithubAnchorProjection(
      {
        store,
        load: async () => ({
          ...projection(),
          unresolvedReviewThreadCount: 1,
          unresolvedReviewThreadIds: ['PRRT_live'],
        }),
      },
      projection().anchor,
    );
    older.resolve({
      ...projection(),
      unresolvedReviewThreadCount: 0,
      unresolvedReviewThreadIds: [],
    });
    await expect(first).resolves.toMatchObject({ applied: false });
    await expect(
      store.readGithubAnchorProjection(projection().anchor),
    ).resolves.toMatchObject({ unresolvedReviewThreadIds: ['PRRT_live'] });
  });

  it('keeps a terminal check result when equal-timestamp lifecycle deliveries race', async () => {
    const store = new MemoryStore();
    const older = deferred<GithubAnchorProjection>();
    const first = refreshGithubAnchorProjection(
      { store, load: () => older.promise },
      projection().anchor,
    );
    await Promise.resolve();
    await refreshGithubAnchorProjection(
      {
        store,
        load: async () => ({
          ...projection(),
          checkRuns: [
            {
              name: 'Verify',
              url: 'https://example.test/check',
              status: 'completed',
              conclusion: 'failure',
            },
          ],
          failingChecks: [
            { name: 'Verify', url: 'https://example.test/check' },
          ],
          ciRunning: false,
        }),
      },
      projection().anchor,
    );
    older.resolve({
      ...projection(),
      checkRuns: [
        {
          name: 'Verify',
          url: 'https://example.test/check',
          status: 'in_progress',
          conclusion: null,
        },
      ],
      ciRunning: true,
    });
    await expect(first).resolves.toMatchObject({ applied: false });
    await expect(
      store.readGithubAnchorProjection(projection().anchor),
    ).resolves.toMatchObject({
      ciRunning: false,
      failingChecks: [{ name: 'Verify' }],
    });
  });

  it('keeps a newer complete anchor snapshot even with an equal source timestamp', async () => {
    const store = new MemoryStore();
    const older = deferred<GithubAnchorProjection>();
    const first = refreshGithubAnchorProjection(
      { store, load: () => older.promise },
      projection().anchor,
    );
    await Promise.resolve();
    await refreshGithubAnchorProjection(
      {
        store,
        load: async () => ({ ...projection('current title'), state: 'closed' }),
      },
      projection().anchor,
    );
    older.resolve(projection('stale title'));
    await expect(first).resolves.toMatchObject({ applied: false });
    await expect(
      store.readGithubAnchorProjection(projection().anchor),
    ).resolves.toMatchObject({ title: 'current title', state: 'closed' });
  });
});

describe('reconcileGithubAnchorProjections', () => {
  it('uses the bounded listing only to discover anchors, then refreshes each exactly', async () => {
    const store = new MemoryStore();
    const load = vi.fn(async () => projection());
    await expect(
      reconcileGithubAnchorProjections({
        store,
        repositories: [REPO],
        listOpenIssues: vi.fn().mockResolvedValue([anchor]),
        load,
        now: () => '2026-08-30T12:00:01.000Z',
      }),
    ).resolves.toEqual({ repositories: 1, anchors: 1 });
    expect(load).toHaveBeenCalledWith({ repo: REPO, issue: 42 });
  });

  it('accepts exactly 1,000 anchors only after an empty sentinel page', async () => {
    const listOpenIssues = vi.fn(async (_repository: string, page: number) =>
      page <= ANCHOR_RECONCILE_MAX_PAGES_PER_REPOSITORY
        ? Array.from({ length: ANCHOR_RECONCILE_PAGE_SIZE }, () => anchor)
        : [],
    );
    await expect(
      reconcileGithubAnchorProjections({
        store: new MemoryStore(),
        repositories: [REPO],
        listOpenIssues,
        load: async () => projection(),
        now: () => '2026-08-30T12:00:01.000Z',
      }),
    ).resolves.toMatchObject({ anchors: 1000 });
    expect(listOpenIssues).toHaveBeenLastCalledWith(
      REPO,
      ANCHOR_RECONCILE_MAX_PAGES_PER_REPOSITORY + 1,
    );
  });

  it('rejects a non-empty sentinel instead of silently truncating', async () => {
    await expect(
      reconcileGithubAnchorProjections({
        store: new MemoryStore(),
        repositories: [REPO],
        listOpenIssues: vi.fn(async (_repository: string, page: number) =>
          page <= ANCHOR_RECONCILE_MAX_PAGES_PER_REPOSITORY
            ? Array.from({ length: ANCHOR_RECONCILE_PAGE_SIZE }, () => anchor)
            : [anchor],
        ),
        load: async () => projection(),
        now: () => '2026-08-30T12:00:01.000Z',
      }),
    ).rejects.toBeInstanceOf(AnchorProjectionBackfillLimitError);
  });

  it('compares selected queue records separately from all open anchor totals', () => {
    expect(
      compareSelectedGithubAnchorProjections({
        currentQueue: [
          {
            key: `${REPO}#42`,
            title: anchor.title,
            url: anchor.html_url,
            author: 'jlapenna',
            assigneeLogins: [],
          },
        ],
        projections: [{ ...projection(), labels: ['agent:claude'] }],
      }),
    ).toMatchObject({ currentQueue: 1, projectedQueue: 1, matches: true });
  });
});
