import {
  type GithubAnchorProjection,
  MemoryStore,
} from '@agent-lcars/orchestrator';
import { describe, expect, it, vi } from 'vitest';

import {
  enrichGithubAnchorProjections,
  refreshGithubAnchorProjection,
} from './github-anchor-refresh';

const anchor = { repo: 'jlapenna/agent-lcars', issue: 42 } as const;
const projection = (title = 'Refresh the anchor'): GithubAnchorProjection => ({
  anchor,
  kind: 'pr',
  state: 'open',
  title,
  body: 'Exact webhook refresh only.',
  url: `https://github.com/${anchor.repo}/issues/${anchor.issue}`,
  author: 'jlapenna',
  labels: [],
  assigneeLogins: [],
  sourceUpdatedAt: '2026-08-30T12:00:00.000Z',
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
  it('enriches an issue refresh with its latest comment', async () => {
    const issue: GithubAnchorProjection = {
      ...projection(),
      kind: 'issue',
    };
    const graphql = vi.fn().mockResolvedValue({
      repository: {
        i42: {
          body: 'The current issue body.',
          comments: {
            nodes: [
              {
                body: 'The current comment.',
                url: 'https://github.com/jlapenna/agent-lcars/issues/42#issuecomment-42',
                createdAt: '2026-08-31T12:00:00.000Z',
                updatedAt: '2026-08-31T12:01:00.000Z',
                author: { login: 'agent-lcars[bot]' },
              },
            ],
          },
        },
      },
    });

    const [enriched] = await enrichGithubAnchorProjections(
      anchor.repo,
      [issue],
      { graphql },
    );

    expect(enriched).toMatchObject({
      body: 'The current issue body.',
      lastComment: {
        body: 'The current comment.',
        author: 'agent-lcars[bot]',
        createdAt: '2026-08-31T12:00:00.000Z',
      },
    });
    expect(graphql).toHaveBeenCalledWith(
      expect.stringContaining('... on Issue { body comments(last: 1)'),
      { owner: 'jlapenna', name: 'agent-lcars' },
    );
  });

  it('turns a non-delete exact-load 404 into a fenced tombstone', async () => {
    const store = new MemoryStore();
    const generation = await store.beginGithubAnchorProjectionRefresh(anchor);
    await store.applyGithubAnchorProjectionRefresh({
      anchor,
      generation,
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
        anchor,
      ),
    ).resolves.toBeUndefined();
    await expect(
      store.readGithubAnchorProjection(anchor),
    ).resolves.toBeUndefined();
  });

  it('keeps a newer exact refresh over an older in-flight result', async () => {
    const store = new MemoryStore();
    const older = deferred<GithubAnchorProjection>();
    let calls = 0;
    const first = refreshGithubAnchorProjection(
      {
        store,
        load: () =>
          ++calls === 1
            ? older.promise
            : Promise.resolve(projection('current')),
      },
      anchor,
    );
    await Promise.resolve();
    await refreshGithubAnchorProjection(
      { store, load: async () => projection('current') },
      anchor,
    );
    older.resolve(projection('stale'));

    // The loser now returns undefined instead of re-loading to rewrite the
    // value the winner already wrote (#1762); what matters is that the
    // stored projection is the newer one, asserted below.
    await expect(first).resolves.toBeUndefined();
    await expect(
      store.readGithubAnchorProjection(anchor),
    ).resolves.toMatchObject({
      title: 'current',
    });
  });

  it('stops without retrying when a newer refresh supersedes its fence', async () => {
    const store = new MemoryStore();
    let applyCalls = 0;
    store.applyGithubAnchorProjectionRefresh = async () => {
      applyCalls++;
      return false;
    };
    const beginGithubAnchorProjectionRefresh =
      store.beginGithubAnchorProjectionRefresh.bind(store);
    let beginCalls = 0;
    store.beginGithubAnchorProjectionRefresh = async (input) => {
      beginCalls++;
      return beginGithubAnchorProjectionRefresh(input);
    };
    let loadCalls = 0;

    // Losing the fence means some racer called `begin` after this attempt
    // did, so its exact read is strictly fresher than anything this one
    // could produce. Re-`begin`ing to retry would invalidate that racer --
    // which is what turned a burst of deliveries for one anchor into
    // mutual starvation (#1762).
    await expect(
      refreshGithubAnchorProjection(
        {
          store,
          load: async () => {
            loadCalls++;
            return projection('current');
          },
        },
        anchor,
      ),
    ).resolves.toBeUndefined();

    expect(applyCalls).toBe(1);
    expect(beginCalls).toBe(1);
    expect(loadCalls).toBe(1);
  });

  it('still propagates a failing exact load rather than swallowing it', async () => {
    const store = new MemoryStore();

    await expect(
      refreshGithubAnchorProjection(
        {
          store,
          load: async () => {
            throw Object.assign(new Error('GitHub is down'), { status: 500 });
          },
        },
        anchor,
      ),
    ).rejects.toThrow('GitHub is down');
  });
});
