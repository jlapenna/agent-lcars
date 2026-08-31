import { describe, expect, it } from 'vitest';

import { MemoryStore } from './memory-store';
import type { GithubAnchorProjection } from './model';

const anchor = { repo: 'jlapenna/agent-lcars', issue: 42 };
const base: GithubAnchorProjection = {
  anchor,
  kind: 'pr',
  state: 'open',
  title: 'Anchor',
  body: '',
  url: 'https://github.com/jlapenna/agent-lcars/issues/42',
  labels: [],
  assigneeLogins: [],
  sourceUpdatedAt: '2026-08-30T12:00:00.000Z',
  observedAt: '2026-08-30T12:00:01.000Z',
};

describe('GitHub anchor projection refresh generations', () => {
  it('rejects an older in-flight refresh after a newer generation begins', async () => {
    const store = new MemoryStore();
    const first = await store.beginGithubAnchorProjectionRefresh(anchor);
    const second = await store.beginGithubAnchorProjectionRefresh(anchor);
    await expect(
      store.applyGithubAnchorProjectionRefresh({
        anchor,
        generation: first,
        projection: { ...base, title: 'stale' },
      }),
    ).resolves.toBe(false);
    await expect(
      store.applyGithubAnchorProjectionRefresh({
        anchor,
        generation: second,
        projection: { ...base, title: 'current' },
      }),
    ).resolves.toBe(true);
    await expect(
      store.readGithubAnchorProjection(anchor),
    ).resolves.toMatchObject({ title: 'current' });
  });

  it('replaces removed optional fields from the exact current snapshot', async () => {
    const store = new MemoryStore();
    const first = await store.beginGithubAnchorProjectionRefresh(anchor);
    await store.applyGithubAnchorProjectionRefresh({
      anchor,
      generation: first,
      projection: { ...base, parentNumber: 7, linkedIssueNumbers: [8] },
    });
    const second = await store.beginGithubAnchorProjectionRefresh(anchor);
    await store.applyGithubAnchorProjectionRefresh({
      anchor,
      generation: second,
      projection: base,
    });
    await expect(store.readGithubAnchorProjection(anchor)).resolves.toEqual(
      base,
    );
  });

  it('removes a deleted anchor behind the refresh generation fence', async () => {
    const store = new MemoryStore();
    const first = await store.beginGithubAnchorProjectionRefresh(anchor);
    await store.applyGithubAnchorProjectionRefresh({
      anchor,
      generation: first,
      projection: base,
    });
    const deleted = await store.beginGithubAnchorProjectionRefresh(anchor);
    await expect(
      store.applyGithubAnchorProjectionRefresh({ anchor, generation: deleted }),
    ).resolves.toBe(true);
    await expect(
      store.readGithubAnchorProjection(anchor),
    ).resolves.toBeUndefined();
    await expect(store.listOpenGithubAnchorProjections()).resolves.toEqual([]);
  });

  it('returns every open projection through a bounded continuation feed', async () => {
    const store = new MemoryStore();
    for (const issue of [1, 2, 3]) {
      const nextAnchor = { ...anchor, issue };
      const generation =
        await store.beginGithubAnchorProjectionRefresh(nextAnchor);
      await store.applyGithubAnchorProjectionRefresh({
        anchor: nextAnchor,
        generation,
        projection: {
          ...base,
          anchor: nextAnchor,
          sourceUpdatedAt: `2026-08-30T12:0${issue}:00.000Z`,
        },
      });
    }

    const first = await store.listOpenGithubAnchorProjectionPage({ limit: 2 });
    const second = await store.listOpenGithubAnchorProjectionPage({
      limit: 2,
      cursor: first.nextCursor,
    });

    expect(
      first.projections.map((projection) => projection.anchor.issue),
    ).toEqual([3, 2]);
    expect(
      second.projections.map((projection) => projection.anchor.issue),
    ).toEqual([1]);
    expect(second.nextCursor).toBeUndefined();
  });
});
