import { describe, expect, it, type Mock, vi } from 'vitest';

import { getGithubClient } from './github-client';
import { enrichItems, type EnrichmentRequest } from './item-enrichment';

const DEFAULT_REPO = { owner: 'supersprinklesracing', name: 'sprinkles' };

vi.mock('./github-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./github-client')>();
  return { ...actual, getGithubClient: vi.fn() };
});

function setupGraphql(response: unknown) {
  const graphql = vi.fn().mockResolvedValue(response);
  (getGithubClient as Mock).mockReturnValue({ graphql });
  return graphql;
}

const wantsComments: EnrichmentRequest = {
  number: 42,
  isPr: false,
  wantsComments: true,
};

describe('enrichItems - comments', () => {
  it('attaches the fetched comment window in API order', async () => {
    setupGraphql({
      repository: {
        i42: {
          __typename: 'Issue',
          comments: {
            nodes: [
              {
                body: 'a normal comment',
                url: 'https://x/1',
                author: { login: 'joe' },
              },
              {
                body: 'a follow-up',
                url: 'https://x/2',
                author: { login: 'agent-lcars[bot]' },
              },
            ],
          },
        },
      },
    });

    const result = await enrichItems(DEFAULT_REPO, [wantsComments]);

    expect(result.warnings).toEqual([]);
    const enrichment = result.byNumber.get(42);
    expect(enrichment?.comments).toEqual([
      { body: 'a normal comment', url: 'https://x/1', author: 'joe' },
      { body: 'a follow-up', url: 'https://x/2', author: 'agent-lcars[bot]' },
    ]);
  });

  it('attaches no comments when the window was not requested', async () => {
    setupGraphql({
      repository: {
        i42: { __typename: 'Issue' },
      },
    });

    const result = await enrichItems(DEFAULT_REPO, [
      { number: 42, isPr: false, wantsComments: false },
    ]);

    expect(result.warnings).toEqual([]);
    expect(result.byNumber.get(42)?.comments).toEqual([]);
  });
});

describe('enrichItems - merged deliverable relationships', () => {
  it('returns only authoritative merged PR references for an issue when requested', async () => {
    const graphql = setupGraphql({
      repository: {
        i42: {
          __typename: 'Issue',
          closedByPullRequestsReferences: {
            nodes: [
              {
                number: 77,
                url: 'https://github.com/example/repo/pull/77',
                mergedAt: '2026-08-08T00:00:00Z',
              },
              {
                number: 78,
                url: 'https://github.com/example/repo/pull/78',
                mergedAt: null,
              },
            ],
          },
        },
      },
    });

    const result = await enrichItems(DEFAULT_REPO, [
      {
        ...wantsComments,
        wantsMergedDeliverables: true,
      },
    ]);

    expect(result.byNumber.get(42)?.mergedDeliverables).toEqual([
      {
        number: 77,
        url: 'https://github.com/example/repo/pull/77',
        mergedAt: '2026-08-08T00:00:00Z',
      },
    ]);
    expect(graphql.mock.calls[0]?.[0]).toContain(
      'closedByPullRequestsReferences',
    );
  });

  it('reports a merged PR anchor as its own merged deliverable', async () => {
    setupGraphql({
      repository: {
        i42: {
          __typename: 'PullRequest',
          number: 42,
          url: 'https://github.com/example/repo/pull/42',
          mergedAt: '2026-08-08T00:00:00Z',
          isDraft: false,
          mergeStateStatus: 'UNKNOWN',
          reviewRequests: { nodes: [] },
          reviewThreads: { totalCount: 0, nodes: [] },
          commits: { nodes: [] },
        },
      },
    });

    const result = await enrichItems(DEFAULT_REPO, [
      {
        number: 42,
        isPr: true,
        wantsComments: true,
        wantsMergedDeliverables: true,
      },
    ]);

    expect(result.byNumber.get(42)?.mergedDeliverables?.[0]?.number).toBe(42);
  });
});

// #538: GitHub's `reviewThreads` connection has no `isResolved` filter
// argument, so the unresolved count has to come from fetching nodes and
// filtering client-side - this is the one place that logic lives.
describe('enrichItems - review threads (#538)', () => {
  function prResponse(reviewThreads: {
    totalCount: number;
    nodes: { isResolved: boolean }[];
  }) {
    return {
      repository: {
        i42: {
          __typename: 'PullRequest',
          isDraft: false,
          mergeStateStatus: 'BLOCKED',
          reviewRequests: { nodes: [] },
          reviewThreads,
          commits: { nodes: [] },
        },
      },
    };
  }

  const wantsPr: EnrichmentRequest = {
    number: 42,
    isPr: true,
    wantsComments: false,
  };

  it('counts only nodes with isResolved: false', async () => {
    setupGraphql(
      prResponse({
        totalCount: 4,
        nodes: [
          { isResolved: false },
          { isResolved: true },
          { isResolved: false },
          { isResolved: false },
        ],
      }),
    );

    const result = await enrichItems(DEFAULT_REPO, [wantsPr]);

    expect(result.byNumber.get(42)?.pr?.unresolvedReviewThreadCount).toBe(3);
    expect(result.byNumber.get(42)?.pr?.reviewThreadsTruncated).toBe(false);
  });

  it('reports zero for a PR with no unresolved threads', async () => {
    setupGraphql(
      prResponse({
        totalCount: 2,
        nodes: [{ isResolved: true }, { isResolved: true }],
      }),
    );

    const result = await enrichItems(DEFAULT_REPO, [wantsPr]);

    expect(result.byNumber.get(42)?.pr?.unresolvedReviewThreadCount).toBe(0);
  });

  it('flags truncation when totalCount exceeds the fetched node window', async () => {
    setupGraphql(
      prResponse({
        totalCount: 150,
        nodes: Array.from({ length: 100 }, () => ({ isResolved: false })),
      }),
    );

    const result = await enrichItems(DEFAULT_REPO, [wantsPr]);

    expect(result.byNumber.get(42)?.pr?.unresolvedReviewThreadCount).toBe(100);
    expect(result.byNumber.get(42)?.pr?.reviewThreadsTruncated).toBe(true);
  });

  it('defaults to zero and not-truncated when reviewThreads is absent', async () => {
    setupGraphql({
      repository: {
        i42: {
          __typename: 'PullRequest',
          isDraft: false,
          mergeStateStatus: 'CLEAN',
          reviewRequests: { nodes: [] },
          commits: { nodes: [] },
        },
      },
    });

    const result = await enrichItems(DEFAULT_REPO, [wantsPr]);

    expect(result.byNumber.get(42)?.pr?.unresolvedReviewThreadCount).toBe(0);
    expect(result.byNumber.get(42)?.pr?.reviewThreadsTruncated).toBe(false);
  });
});
