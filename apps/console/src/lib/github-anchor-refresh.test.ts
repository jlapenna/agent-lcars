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

    await expect(first).resolves.toMatchObject({ title: 'current' });
    await expect(
      store.readGithubAnchorProjection(anchor),
    ).resolves.toMatchObject({
      title: 'current',
    });
  });

  it('backs off between fenced retries and applies once the fence clears', async () => {
    const store = new MemoryStore();
    let applyCalls = 0;
    const applyGithubAnchorProjectionRefresh =
      store.applyGithubAnchorProjectionRefresh.bind(store);
    store.applyGithubAnchorProjectionRefresh = async (input) => {
      applyCalls++;
      // Simulate two concurrent racers beating this attempt's fence before
      // any real contention is involved, so the retry/backoff path runs
      // deterministically.
      return applyCalls <= 2
        ? false
        : applyGithubAnchorProjectionRefresh(input);
    };
    const waits: number[] = [];

    const result = await refreshGithubAnchorProjection(
      {
        store,
        load: async () => projection('current'),
        wait: async (ms) => {
          waits.push(ms);
        },
      },
      anchor,
    );

    expect(result).toMatchObject({ title: 'current' });
    expect(applyCalls).toBe(3);
    // One backoff before each retry (attempts 1 and 2), none before the
    // first attempt.
    expect(waits).toHaveLength(2);
  });

  it('throws only after exhausting every fenced retry', async () => {
    const store = new MemoryStore();
    store.applyGithubAnchorProjectionRefresh = async () => false;
    const waits: number[] = [];

    await expect(
      refreshGithubAnchorProjection(
        {
          store,
          load: async () => projection('current'),
          wait: async (ms) => {
            waits.push(ms);
          },
        },
        anchor,
      ),
    ).rejects.toThrow(/could not apply after 6 fenced attempts/);

    // A backoff before every retry attempt but the very first.
    expect(waits).toHaveLength(5);
  });
});
