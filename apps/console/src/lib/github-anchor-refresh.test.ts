import {
  type GithubAnchorProjection,
  MemoryStore,
} from '@agent-lcars/orchestrator';
import { describe, expect, it } from 'vitest';

import { refreshGithubAnchorProjection } from './github-anchor-refresh';

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
});
