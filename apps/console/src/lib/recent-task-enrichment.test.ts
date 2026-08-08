import { beforeEach, describe, expect, it, vi } from 'vitest';

import { enrichItems } from './item-enrichment';
import { getCachedRecentTaskEnrichment } from './recent-task-enrichment';

vi.mock('next/cache', () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

vi.mock('./item-enrichment', () => ({
  enrichItems: vi.fn(),
}));

const REPO_A = { owner: 'example', name: 'alpha' };
const REPO_B = { owner: 'example', name: 'beta' };

describe('getCachedRecentTaskEnrichment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deduplicates recent anchors, batches per repo, and preserves closed-task outcome evidence', async () => {
    vi.mocked(enrichItems).mockImplementation(async (repo) => ({
      byNumber: new Map([
        [
          42,
          {
            comments: [],
            ledger: {
              schema: 'agent-lcars.dispatch-ledger/v1',
              revision: 1,
              task: {
                repositoryId: repo.name === 'alpha' ? 1 : 2,
                repository: `${repo.owner}/${repo.name}`,
                issue: 42,
              },
              createdAt: '2026-08-08T00:00:00Z',
              updatedAt: '2026-08-08T00:00:00Z',
              control: { closed: true },
              sources: [],
              generations: [],
              anomalies: [],
            },
            mergedDeliverables: [
              {
                number: repo.name === 'alpha' ? 77 : 88,
                url: `https://github.com/${repo.owner}/${repo.name}/pull/77`,
                mergedAt: '2026-08-08T00:00:00Z',
              },
            ],
          },
        ],
      ]),
      warnings: [],
    }));

    const result = await getCachedRecentTaskEnrichment([
      { repo: REPO_A, issueNumber: 42 },
      { repo: REPO_A, issueNumber: 42 },
      { repo: REPO_B, issueNumber: 42 },
    ]);

    expect(enrichItems).toHaveBeenCalledTimes(2);
    for (const [, requests] of vi.mocked(enrichItems).mock.calls) {
      expect(requests).toEqual([
        expect.objectContaining({
          number: 42,
          wantsComments: true,
          wantsMergedDeliverables: true,
        }),
      ]);
    }
    expect(result.data.entries).toHaveLength(2);
    expect(
      result.data.entries.map((entry) => entry.mergedDeliverableNumbers),
    ).toEqual([[77], [88]]);
    expect(
      result.data.entries.every((entry) => entry.ledger?.control.closed),
    ).toBe(true);
  });
});
