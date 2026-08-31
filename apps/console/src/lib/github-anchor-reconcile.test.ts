import {
  type GithubAnchorProjection,
  MemoryStore,
} from '@agent-lcars/orchestrator';
import { describe, expect, it, vi } from 'vitest';

import {
  ANCHOR_RECONCILE_MAX_PAGES_PER_REPOSITORY,
  ANCHOR_RECONCILE_PAGE_SIZE,
  ANCHOR_RECONCILE_REFRESH_CONCURRENCY,
  AnchorProjectionBackfillLimitError,
  compareSelectedGithubAnchorProjections,
  enrichBackfillAnchors,
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

function staleThenCurrent(
  stale: ReturnType<typeof deferred<GithubAnchorProjection>>,
  current: GithubAnchorProjection,
) {
  let calls = 0;
  return () => (++calls === 1 ? stale.promise : Promise.resolve(current));
}

describe('refreshGithubAnchorProjection', () => {
  it('turns a non-delete exact-load 404 into a fenced tombstone', async () => {
    const store = new MemoryStore();
    const initialGeneration = await store.beginGithubAnchorProjectionRefresh(
      projection().anchor,
    );
    await store.applyGithubAnchorProjectionRefresh({
      anchor: projection().anchor,
      generation: initialGeneration,
      projection: projection(),
    });

    await expect(
      refreshGithubAnchorProjection(
        {
          store,
          load: async () =>
            Promise.reject(
              Object.assign(new Error('Not Found'), { status: 404 }),
            ),
        },
        projection().anchor,
      ),
    ).resolves.toBeUndefined();
    await expect(
      store.readGithubAnchorProjection(projection().anchor),
    ).resolves.toBeUndefined();
  });

  it('keeps a newer webhook refresh over an older in-flight backfill fetch', async () => {
    const store = new MemoryStore();
    const older = deferred<GithubAnchorProjection>();
    const first = refreshGithubAnchorProjection(
      { store, load: staleThenCurrent(older, projection('webhook current')) },
      projection().anchor,
    );
    await Promise.resolve();
    const newer = await refreshGithubAnchorProjection(
      { store, load: async () => projection('webhook current') },
      projection().anchor,
    );
    older.resolve(projection('stale backfill'));
    await expect(first).resolves.toMatchObject({ title: 'webhook current' });
    expect(newer).toMatchObject({ title: 'webhook current' });
    await expect(
      store.readGithubAnchorProjection(projection().anchor),
    ).resolves.toMatchObject({ title: 'webhook current' });
  });

  it('keeps the exact-current review-thread state when resolve and unresolve deliveries race', async () => {
    const store = new MemoryStore();
    const older = deferred<GithubAnchorProjection>();
    const current = {
      ...projection(),
      unresolvedReviewThreadCount: 1,
      unresolvedReviewThreadIds: ['PRRT_live'],
    };
    const first = refreshGithubAnchorProjection(
      { store, load: staleThenCurrent(older, current) },
      projection().anchor,
    );
    await Promise.resolve();
    await refreshGithubAnchorProjection(
      {
        store,
        load: async () => current,
      },
      projection().anchor,
    );
    older.resolve({
      ...projection(),
      unresolvedReviewThreadCount: 0,
      unresolvedReviewThreadIds: [],
    });
    await expect(first).resolves.toMatchObject({
      unresolvedReviewThreadIds: ['PRRT_live'],
    });
    await expect(
      store.readGithubAnchorProjection(projection().anchor),
    ).resolves.toMatchObject({ unresolvedReviewThreadIds: ['PRRT_live'] });
  });

  it('keeps a terminal check result when equal-timestamp lifecycle deliveries race', async () => {
    const store = new MemoryStore();
    const older = deferred<GithubAnchorProjection>();
    const current = {
      ...projection(),
      checkRuns: [
        {
          name: 'Verify',
          url: 'https://example.test/check',
          status: 'completed',
          conclusion: 'failure' as const,
        },
      ],
      failingChecks: [{ name: 'Verify', url: 'https://example.test/check' }],
      ciRunning: false,
    };
    const first = refreshGithubAnchorProjection(
      { store, load: staleThenCurrent(older, current) },
      projection().anchor,
    );
    await Promise.resolve();
    await refreshGithubAnchorProjection(
      {
        store,
        load: async () => current,
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
    await expect(first).resolves.toMatchObject({ ciRunning: false });
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
    const current = {
      ...projection('current title'),
      state: 'closed' as const,
    };
    const first = refreshGithubAnchorProjection(
      { store, load: staleThenCurrent(older, current) },
      projection().anchor,
    );
    await Promise.resolve();
    await refreshGithubAnchorProjection(
      {
        store,
        load: async () => current,
      },
      projection().anchor,
    );
    older.resolve(projection('stale title'));
    await expect(first).resolves.toMatchObject({
      title: 'current title',
      state: 'closed',
    });
    await expect(
      store.readGithubAnchorProjection(projection().anchor),
    ).resolves.toMatchObject({ title: 'current title', state: 'closed' });
  });
});

describe('reconcileGithubAnchorProjections', () => {
  it('does not mark checks truncated when all returned context nodes fit', async () => {
    const graphql = vi.fn().mockResolvedValue({
      repository: {
        i42: {
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      totalCount: 2,
                      nodes: [
                        {
                          name: 'Verify',
                          status: 'COMPLETED',
                          conclusion: 'SUCCESS',
                          detailsUrl: 'https://example.test/verify',
                        },
                        {},
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      },
    });
    const [enriched] = await enrichBackfillAnchors(REPO, [projection()], {
      graphql,
    } as never);
    expect(enriched?.checksTruncated).toBe(false);
  });

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

  it('tombstones every persisted open anchor absent from the complete listing', async () => {
    const store = new MemoryStore();
    const staleAnchor = { repo: 'retired-org/retired-repo', issue: 99 };
    const staleGeneration =
      await store.beginGithubAnchorProjectionRefresh(staleAnchor);
    await store.applyGithubAnchorProjectionRefresh({
      anchor: staleAnchor,
      generation: staleGeneration,
      projection: {
        ...projection('Stale anchor'),
        anchor: staleAnchor,
        url: 'https://github.com/retired-org/retired-repo/issues/99',
      },
    });

    await expect(
      reconcileGithubAnchorProjections({
        store,
        repositories: [REPO],
        listOpenIssues: vi.fn().mockResolvedValue([anchor]),
        load: async (current) => ({ ...projection(), anchor: current }),
        now: () => '2026-08-30T12:00:01.000Z',
      }),
    ).resolves.toEqual({ repositories: 1, anchors: 1 });

    await expect(store.readGithubAnchorProjection(staleAnchor)).resolves.toBe(
      undefined,
    );
    await expect(store.listOpenGithubAnchorProjections(1001)).resolves.toEqual([
      expect.objectContaining({ anchor: projection().anchor }),
    ]);
  });

  it('revalidates a configured-repository anchor absent from its earlier page', async () => {
    const store = new MemoryStore();
    const reopenedAnchor = { repo: REPO, issue: 77 };
    const generation =
      await store.beginGithubAnchorProjectionRefresh(reopenedAnchor);
    await store.applyGithubAnchorProjectionRefresh({
      anchor: reopenedAnchor,
      generation,
      projection: {
        ...projection('Reopened after listing'),
        anchor: reopenedAnchor,
        url: `https://github.com/${REPO}/issues/77`,
      },
    });
    const load = vi.fn(async (current) => ({
      ...projection(
        current.issue === 77 ? 'Reopened after listing' : anchor.title,
      ),
      anchor: current,
      url: `https://github.com/${current.repo}/issues/${current.issue}`,
    }));

    await expect(
      reconcileGithubAnchorProjections({
        store,
        repositories: [REPO],
        listOpenIssues: vi.fn().mockResolvedValue([anchor]),
        load,
        now: () => '2026-08-30T12:00:01.000Z',
      }),
    ).resolves.toEqual({ repositories: 1, anchors: 1 });

    expect(load).toHaveBeenCalledWith(reopenedAnchor);
    await expect(
      store.readGithubAnchorProjection(reopenedAnchor),
    ).resolves.toMatchObject({
      state: 'open',
      title: 'Reopened after listing',
    });
  });

  it('refreshes exactly 1,000 anchors with bounded exact-read concurrency', async () => {
    const listOpenIssues = vi.fn(async (_repository: string, page: number) =>
      page <= ANCHOR_RECONCILE_MAX_PAGES_PER_REPOSITORY
        ? Array.from(
            { length: ANCHOR_RECONCILE_PAGE_SIZE },
            (_value, index) => ({
              ...anchor,
              number: (page - 1) * ANCHOR_RECONCILE_PAGE_SIZE + index + 1,
            }),
          )
        : [],
    );
    let inFlight = 0;
    let maxInFlight = 0;
    await expect(
      reconcileGithubAnchorProjections({
        store: new MemoryStore(),
        repositories: [REPO],
        listOpenIssues,
        load: async (current) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Promise.resolve();
          inFlight--;
          return { ...projection(), anchor: current };
        },
        now: () => '2026-08-30T12:00:01.000Z',
      }),
    ).resolves.toMatchObject({ anchors: 1000 });
    expect(listOpenIssues).toHaveBeenLastCalledWith(
      REPO,
      ANCHOR_RECONCILE_MAX_PAGES_PER_REPOSITORY + 1,
    );
    expect(maxInFlight).toBe(ANCHOR_RECONCILE_REFRESH_CONCURRENCY);
  });

  it('rejects a non-empty sentinel instead of silently truncating', async () => {
    await expect(
      reconcileGithubAnchorProjections({
        store: new MemoryStore(),
        repositories: [REPO],
        listOpenIssues: vi.fn(async (_repository: string, page: number) =>
          page <= ANCHOR_RECONCILE_MAX_PAGES_PER_REPOSITORY
            ? Array.from(
                { length: ANCHOR_RECONCILE_PAGE_SIZE },
                (_value, index) => ({
                  ...anchor,
                  number: (page - 1) * ANCHOR_RECONCILE_PAGE_SIZE + index + 1,
                }),
              )
            : [anchor],
        ),
        load: async (current) => ({ ...projection(), anchor: current }),
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
