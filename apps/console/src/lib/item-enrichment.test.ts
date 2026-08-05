import { describe, expect, it, type Mock, vi } from 'vitest';

import { LEDGER_MARKER } from './dispatch-ledger';
import { getGithubClient } from './github-client';
import { enrichItems, type EnrichmentRequest } from './item-enrichment';

const DEFAULT_REPO = { owner: 'supersprinklesracing', name: 'sprinkles' };

vi.mock('./github-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./github-client')>();
  return { ...actual, getGithubClient: vi.fn() };
});

function ledgerJson(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'agent-lcars.dispatch-ledger/v1',
    revision: 2,
    task: { repository: 'supersprinklesracing/sprinkles', issue: 42 },
    createdAt: '2026-07-07T00:00:00Z',
    updatedAt: '2026-07-07T00:00:00Z',
    control: { closed: false },
    sources: [
      {
        sourceKind: 'labeled',
        sourceId: 'src-1',
        transportRunId: 1,
        occurredAt: '2026-07-07T00:00:00Z',
      },
    ],
    generations: [
      {
        generation: 1,
        intentId: 'intent-abc',
        sourceId: 'src-1',
        occurredAt: '2026-07-07T00:00:00Z',
        pipeline: 'claude',
        state: 'active',
      },
    ],
    anomalies: [],
    ...overrides,
  };
}

function ledgerCommentBody(ledger: object): string {
  return `${LEDGER_MARKER}\nDispatch broker: g1 claude is active.\n\n\`\`\`json\n${JSON.stringify(ledger)}\n\`\`\``;
}

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

describe('enrichItems - dispatch ledger parsing', () => {
  it('attaches a well-formed ledger parsed from the fetched comment window', async () => {
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
                body: ledgerCommentBody(ledgerJson()),
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
    expect(enrichment?.ledger?.revision).toBe(2);
    expect(enrichment?.ledger?.generations).toHaveLength(1);
    expect(enrichment?.comments).toHaveLength(2);
  });

  it('records a warning and leaves ledger undefined for a malformed ledger comment', async () => {
    setupGraphql({
      repository: {
        i42: {
          __typename: 'Issue',
          comments: {
            nodes: [
              {
                body: `${LEDGER_MARKER}\nno json block here`,
                url: 'https://x/1',
              },
            ],
          },
        },
      },
    });

    const result = await enrichItems(DEFAULT_REPO, [wantsComments]);

    expect(result.warnings.some((w) => w.includes('sprinkles#42'))).toBe(true);
    expect(result.byNumber.get(42)?.ledger).toBeUndefined();
  });

  it('leaves ledger undefined (no warning) when the comment window was not requested', async () => {
    setupGraphql({
      repository: {
        i42: { __typename: 'Issue' },
      },
    });

    const result = await enrichItems(DEFAULT_REPO, [
      { number: 42, isPr: false, wantsComments: false },
    ]);

    expect(result.warnings).toEqual([]);
    expect(result.byNumber.get(42)?.ledger).toBeUndefined();
  });

  it('leaves ledger undefined (no warning) when comments were fetched but none carry the marker', async () => {
    setupGraphql({
      repository: {
        i42: {
          __typename: 'Issue',
          comments: { nodes: [{ body: 'just chatting', url: 'https://x/1' }] },
        },
      },
    });

    const result = await enrichItems(DEFAULT_REPO, [wantsComments]);

    expect(result.warnings).toEqual([]);
    expect(result.byNumber.get(42)?.ledger).toBeUndefined();
  });

  // Codex review (#364, P2): a ledger comment whose own `task` field names
  // a different issue than the one whose comment window produced it (e.g.
  // copy-pasted, or a stray marker in an unrelated thread) must not be
  // trusted and attributed to this item.
  it('rejects and warns on a structurally valid ledger whose task field points at a different issue', async () => {
    setupGraphql({
      repository: {
        i42: {
          __typename: 'Issue',
          comments: {
            nodes: [
              {
                body: ledgerCommentBody(
                  ledgerJson({
                    task: {
                      repository: 'supersprinklesracing/sprinkles',
                      issue: 999,
                    },
                  }),
                ),
                url: 'https://x/1',
              },
            ],
          },
        },
      },
    });

    const result = await enrichItems(DEFAULT_REPO, [wantsComments]);

    expect(result.byNumber.get(42)?.ledger).toBeUndefined();
    expect(
      result.warnings.some(
        (w) => w.includes('sprinkles#42') && w.includes('999'),
      ),
    ).toBe(true);
  });

  it('rejects and warns on a structurally valid ledger whose task field points at a different repository', async () => {
    setupGraphql({
      repository: {
        i42: {
          __typename: 'Issue',
          comments: {
            nodes: [
              {
                body: ledgerCommentBody(
                  ledgerJson({
                    task: { repository: 'someone-else/other-repo', issue: 42 },
                  }),
                ),
                url: 'https://x/1',
              },
            ],
          },
        },
      },
    });

    const result = await enrichItems(DEFAULT_REPO, [wantsComments]);

    expect(result.byNumber.get(42)?.ledger).toBeUndefined();
    expect(
      result.warnings.some((w) => w.includes('someone-else/other-repo')),
    ).toBe(true);
  });

  it('attaches a ledger to a pull request item alongside its PR enrichment', async () => {
    setupGraphql({
      repository: {
        i42: {
          __typename: 'PullRequest',
          isDraft: false,
          mergeStateStatus: 'CLEAN',
          comments: {
            nodes: [
              { body: ledgerCommentBody(ledgerJson()), url: 'https://x/1' },
            ],
          },
          reviewRequests: { nodes: [] },
          commits: { nodes: [] },
        },
      },
    });

    const result = await enrichItems(DEFAULT_REPO, [
      { number: 42, isPr: true, wantsComments: true },
    ]);

    const enrichment = result.byNumber.get(42);
    expect(enrichment?.pr?.mergeableState).toBe('clean');
    expect(enrichment?.ledger?.generations).toHaveLength(1);
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
