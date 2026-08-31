import { describe, expect, it, vi } from 'vitest';

import {
  ANCHOR_RECONCILE_MAX_PAGES_PER_REPOSITORY,
  ANCHOR_RECONCILE_PAGE_SIZE,
  AnchorProjectionBackfillLimitError,
  compareSelectedGithubAnchorProjections,
  reconcileGithubAnchorProjections,
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
  labels: [{ name: 'status:needs-human' }],
  assignees: [],
};

describe('reconcileGithubAnchorProjections', () => {
  it('ingests a bounded GitHub listing into durable anchor projections', async () => {
    const upsertGithubAnchorProjection = vi.fn();
    const enrich = vi.fn(async (_repository: string, projections: unknown[]) =>
      projections.map((projection) => ({
        ...(projection as object),
        requestedReviewerLogins: ['jlapenna'],
        failingChecks: [{ name: 'Verify', url: 'https://example.test/check' }],
        ciRunning: false,
        unresolvedReviewThreadCount: 2,
      })),
    );
    const result = await reconcileGithubAnchorProjections({
      store: { upsertGithubAnchorProjection },
      repositories: [REPO],
      listOpenIssues: vi.fn().mockResolvedValue([anchor]),
      enrich,
      now: () => '2026-08-30T12:00:01.000Z',
    });

    expect(result).toEqual({ repositories: 1, anchors: 1 });
    expect(upsertGithubAnchorProjection).toHaveBeenCalledWith(
      expect.objectContaining({
        anchor: { repo: REPO, issue: 42 },
        requestedReviewerLogins: ['jlapenna'],
        failingChecks: [{ name: 'Verify', url: 'https://example.test/check' }],
        unresolvedReviewThreadCount: 2,
      }),
    );
    expect(enrich).toHaveBeenCalledWith(REPO, [expect.anything()]);
  });

  it('fails closed when a repository exceeds the explicit page bound', async () => {
    await expect(
      reconcileGithubAnchorProjections({
        store: { upsertGithubAnchorProjection: vi.fn() },
        repositories: [REPO],
        listOpenIssues: vi
          .fn()
          .mockResolvedValue(
            Array.from({ length: ANCHOR_RECONCILE_PAGE_SIZE }, () => anchor),
          ),
        now: () => '2026-08-30T12:00:01.000Z',
      }),
    ).rejects.toBeInstanceOf(AnchorProjectionBackfillLimitError);
    expect(ANCHOR_RECONCILE_MAX_PAGES_PER_REPOSITORY).toBeGreaterThan(0);
  });

  it('reports queue parity separately from the total open-anchor backfill', async () => {
    const result = await reconcileGithubAnchorProjections({
      store: { upsertGithubAnchorProjection: vi.fn() },
      repositories: [REPO],
      listOpenIssues: vi.fn().mockResolvedValue([anchor]),
      currentQueue: async () => ({
        items: [
          {
            key: `${REPO}#42`,
            title: anchor.title,
            url: anchor.html_url,
            author: 'jlapenna',
            assigneeLogins: [],
          },
        ],
        warnings: [],
      }),
      now: () => '2026-08-30T12:00:01.000Z',
    });

    expect(result).toMatchObject({
      anchors: 1,
      comparison: {
        currentQueue: 1,
        projectedQueue: 1,
        matches: true,
      },
    });
  });

  it('identifies selection, critical-field, and current-queue degradation mismatches', () => {
    const result = compareSelectedGithubAnchorProjections({
      currentQueue: [
        {
          key: `${REPO}#42`,
          title: 'Stale title',
          url: anchor.html_url,
          author: 'jlapenna',
          assigneeLogins: ['jlapenna'],
        },
      ],
      projections: [
        {
          anchor: { repo: REPO, issue: 42 },
          kind: 'issue',
          state: 'open',
          title: anchor.title,
          body: '',
          url: anchor.html_url,
          author: 'jlapenna',
          labels: ['status:needs-human'],
          assigneeLogins: [],
          sourceUpdatedAt: anchor.updated_at,
          observedAt: '2026-08-30T12:00:01.000Z',
        },
      ],
      warnings: ['Open items unavailable for another/repo.'],
    });

    expect(result).toMatchObject({
      matches: false,
      criticalFieldMismatches: [
        {
          key: `${REPO}#42`,
          fields: ['title', 'assigneeLogins'],
        },
      ],
      warnings: ['Open items unavailable for another/repo.'],
    });
  });
});
