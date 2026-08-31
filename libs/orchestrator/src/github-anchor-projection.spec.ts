import { describe, expect, it } from 'vitest';

import { MemoryStore } from './memory-store';

const older = {
  anchor: { repo: 'jlapenna/agent-lcars', issue: 42 },
  kind: 'issue' as const,
  state: 'open' as const,
  title: 'Older title',
  body: 'Older body',
  url: 'https://github.com/jlapenna/agent-lcars/issues/42',
  labels: ['status:needs-human'],
  assigneeLogins: [],
  sourceUpdatedAt: '2026-08-30T10:00:00.000Z',
  observedAt: '2026-08-30T10:00:01.000Z',
};

describe('GitHub anchor projections', () => {
  it('keeps the newest webhook snapshot and lists only open anchors', async () => {
    const store = new MemoryStore();
    await store.upsertGithubAnchorProjection(older);
    await store.upsertGithubAnchorProjection({
      ...older,
      title: 'Newer title',
      sourceUpdatedAt: '2026-08-30T11:00:00.000Z',
      observedAt: '2026-08-30T11:00:01.000Z',
    });
    await store.upsertGithubAnchorProjection({
      ...older,
      title: 'Stale redelivery',
      observedAt: '2026-08-30T12:00:01.000Z',
    });

    expect(await store.listOpenGithubAnchorProjections()).toEqual([
      expect.objectContaining({ title: 'Newer title' }),
    ]);

    await store.upsertGithubAnchorProjection({
      ...older,
      state: 'closed',
      sourceUpdatedAt: '2026-08-30T12:00:00.000Z',
      observedAt: '2026-08-30T12:00:01.000Z',
    });
    expect(await store.listOpenGithubAnchorProjections()).toEqual([]);
  });
});
