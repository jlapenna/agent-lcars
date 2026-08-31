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

  it('clears absent anchor relationships while preserving independently delivered signals', async () => {
    const store = new MemoryStore();
    await store.upsertGithubAnchorProjection({
      ...older,
      parentNumber: 7,
      linkedIssueNumbers: [8, 9],
      checkRuns: [
        {
          id: '1000',
          name: 'Verify',
          url: 'https://example.test/checks/1',
          status: 'completed',
          conclusion: 'failure',
          updatedAt: '2026-08-30T10:00:00.000Z',
        },
      ],
      failingChecks: [{ name: 'Verify', url: 'https://example.test/checks/1' }],
      ciRunning: false,
    });
    await store.upsertGithubAnchorProjection({
      ...older,
      title: 'Current snapshot without old links',
      sourceUpdatedAt: '2026-08-30T11:00:00.000Z',
    });

    await expect(
      store.readGithubAnchorProjection(older.anchor),
    ).resolves.toEqual(
      expect.objectContaining({
        title: 'Current snapshot without old links',
        checkRuns: [expect.objectContaining({ name: 'Verify' })],
      }),
    );
    const stored = await store.readGithubAnchorProjection(older.anchor);
    expect(stored?.parentNumber).toBeUndefined();
    expect(stored?.linkedIssueNumbers).toBeUndefined();
  });

  it('applies a signal updater to the latest stored projection', async () => {
    const store = new MemoryStore();
    await store.upsertGithubAnchorProjection(older);
    await store.upsertGithubAnchorProjection({
      ...older,
      title: 'Latest title',
      sourceUpdatedAt: '2026-08-30T11:00:00.000Z',
    });
    await store.updateGithubAnchorProjection(older.anchor, (current) =>
      current === undefined
        ? undefined
        : {
            ...current,
            ciRunning: true,
            observedAt: '2026-08-30T11:01:00.000Z',
          },
    );

    await expect(
      store.readGithubAnchorProjection(older.anchor),
    ).resolves.toEqual(
      expect.objectContaining({ title: 'Latest title', ciRunning: true }),
    );
  });
});
