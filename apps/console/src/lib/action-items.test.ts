import { describe, expect, it, type Mock, vi } from 'vitest';

import { getActionItems, isDeployWaitOnly } from './action-items';
import { getGithubClient, getWatchedRepos } from './github-client';

const DEFAULT_REPO = { owner: 'supersprinklesracing', name: 'sprinkles' };

vi.mock('./github-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./github-client')>();
  return {
    ...actual,
    getGithubClient: vi.fn(),
    getWatchedRepos: vi.fn(() => [DEFAULT_REPO]),
  };
});

interface FakeRepoIssue {
  number: number;
  title: string;
  html_url: string;
  body?: string | null;
  updated_at: string;
  user?: { login?: string } | null;
  labels: string[];
  assignees?: { login?: string }[];
  pull_request?: object;
  comments?: number;
}

function makeItem(
  number: number,
  overrides: Partial<FakeRepoIssue> = {},
): FakeRepoIssue {
  return {
    number,
    title: `Issue ${number}`,
    html_url: `https://github.com/supersprinklesracing/sprinkles/issues/${number}`,
    body: null,
    updated_at: '2026-07-07T00:00:00Z',
    user: { login: 'someone' },
    labels: [],
    assignees: [],
    comments: 0,
    ...overrides,
  };
}

/** A `pulls.list` row. Only `requested_reviewers` is read (it answers the
 * review-requested predicate `issues.listForRepo` can't express). */
function makePull(number: number, reviewers: string[] = []) {
  return {
    number,
    requested_reviewers: reviewers.map((login) => ({ login })),
  };
}

/** `issues.listForRepo` returns a bare array (no `total_count` envelope) and
 * serves issues and PRs alike. Pages are keyed by repo so multi-repo tests
 * can hand each repo its own list. */
function pagedListForRepo(byRepo: Record<string, FakeRepoIssue[]>) {
  return vi.fn().mockImplementation(({ owner, repo, page = 1 }) => {
    const all = byRepo[`${owner}/${repo}`] ?? [];
    const start = (page - 1) * 100;
    return Promise.resolve({ data: all.slice(start, start + 100) });
  });
}

describe('isDeployWaitOnly', () => {
  it('is true only when every action type is post-deploy-action', () => {
    expect(
      isDeployWaitOnly({
        kind: 'issue',
        repo: DEFAULT_REPO,
        number: 1,
        title: 't',
        url: 'u',
        updatedAt: 'now',
        actionTypes: ['post-deploy-action'],
        labels: [],
        assigneeLogins: [],
      }),
    ).toBe(true);
    expect(
      isDeployWaitOnly({
        kind: 'issue',
        repo: DEFAULT_REPO,
        number: 1,
        title: 't',
        url: 'u',
        updatedAt: 'now',
        actionTypes: ['post-deploy-action', 'needs-human'],
        labels: [],
        assigneeLogins: [],
      }),
    ).toBe(false);
    expect(
      isDeployWaitOnly({
        kind: 'issue',
        repo: DEFAULT_REPO,
        number: 1,
        title: 't',
        url: 'u',
        updatedAt: 'now',
        actionTypes: [],
        labels: [],
        assigneeLogins: [],
      }),
    ).toBe(false);
  });
});

describe('getActionItems', () => {
  // Every item a test wants on the board has to satisfy the open-item
  // predicate (see isBoardItem) the way it would in production - by label,
  // by assignee, or by a requested review. `agent:claude` is the cheapest of
  // those for tests not specifically exercising selection.
  const ON_BOARD = { labels: ['agent:claude'] };

  /** A GraphQL enrichment node, in the shape `item-enrichment.ts` parses.
   * Enum values are SCREAMING_CASE exactly as the real API returns them, so
   * the lowercasing that maps them onto the old REST vocabulary stays under
   * test rather than being assumed. */
  function issueNode(
    comments: { body: string; url?: string; author?: string }[] = [],
  ) {
    return {
      __typename: 'Issue',
      comments: {
        nodes: comments.map((c) => ({
          body: c.body,
          url: c.url ?? 'https://github.com/o/r/issues/1#issuecomment-1',
          author: c.author ? { login: c.author } : null,
        })),
      },
    };
  }

  function prNode({
    comments = [],
    isDraft = false,
    mergeStateStatus = 'CLEAN',
    body = null,
    reviewers = [],
    checks = [],
    checksTotal,
    reviewThreads,
    reviewThreadsTotal,
  }: {
    comments?: { body: string; url?: string; author?: string }[];
    isDraft?: boolean;
    mergeStateStatus?: string;
    body?: string | null;
    reviewers?: string[];
    checks?: { name: string; status: string; conclusion: string | null }[];
    checksTotal?: number;
    /** `isResolved` for each `reviewThreads` node. */
    reviewThreads?: boolean[];
    reviewThreadsTotal?: number;
  } = {}) {
    return {
      ...issueNode(comments),
      __typename: 'PullRequest',
      isDraft,
      mergeStateStatus,
      body,
      reviewRequests: {
        nodes: reviewers.map((login) => ({ requestedReviewer: { login } })),
      },
      reviewThreads: {
        totalCount: reviewThreadsTotal ?? (reviewThreads ?? []).length,
        nodes: (reviewThreads ?? []).map((isResolved) => ({ isResolved })),
      },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  totalCount: checksTotal ?? checks.length,
                  nodes: checks.map((c) => ({
                    name: c.name,
                    status: c.status,
                    conclusion: c.conclusion,
                    detailsUrl: 'https://github.com/check',
                  })),
                },
              },
            },
          },
        ],
      },
    };
  }

  /** Stands in for `octokit.graphql`, keyed by item number the same way the
   * real query's aliases are. Captures each query string so tests can assert
   * on what was actually asked for. */
  function mockGraphql(byNumber: Record<number, unknown> = {}) {
    const queries: string[] = [];
    const fn = vi.fn().mockImplementation((query: string) => {
      queries.push(query);
      const repository: Record<string, unknown> = {};
      for (const [number, node] of Object.entries(byNumber)) {
        if (
          query.includes(`i${number}: issueOrPullRequest(number: ${number})`)
        ) {
          repository[`i${number}`] = node;
        }
      }
      return Promise.resolve({ repository });
    });
    return Object.assign(fn, { queries });
  }

  function setupOctokit({
    listForRepo,
    pullsList = vi.fn().mockResolvedValue({ data: [] }),
    graphql = mockGraphql(),
    searchSpy = vi.fn(),
  }: {
    listForRepo: Mock;
    pullsList?: Mock;
    graphql?: Mock & { queries?: string[] };
    searchSpy?: Mock;
  }) {
    (getGithubClient as Mock).mockReturnValue({
      graphql,
      rest: {
        // Present only so a regression back onto the search API is caught
        // by the assertion in the #13 guard below.
        search: { issuesAndPullRequests: searchSpy },
        issues: { listForRepo },
        pulls: { list: pullsList },
      },
    });
    return { searchSpy, graphql };
  }

  // #13: the board used to cost 14 search requests per repo against a
  // budget of 30 per minute. Selection now runs off two core-budget list
  // endpoints, and must never quietly go back.
  it('reads the board from list endpoints and never calls the search API', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [makeItem(1, ON_BOARD)],
    });
    const { searchSpy } = setupOctokit({ listForRepo });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([1]);
    expect(searchSpy).not.toHaveBeenCalled();
    expect(listForRepo).toHaveBeenCalledTimes(1);
    expect(listForRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'supersprinklesracing',
        repo: 'sprinkles',
        state: 'open',
      }),
    );
  });

  // The per-item REST fan-out this replaced was the one board cost that grew
  // with the board; a 20-item board must still cost exactly one query.
  it('enriches every item in one batched query per repo', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': Array.from({ length: 20 }, (_, i) =>
        makeItem(i + 1, { labels: ['status:needs-human'] }),
      ),
    });
    const graphql = mockGraphql();
    setupOctokit({ listForRepo, graphql });

    const result = await getActionItems();

    expect(result.items).toHaveLength(20);
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it('leaves open items that match no board predicate off the board', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(1, ON_BOARD),
        makeItem(2),
        makeItem(3, { labels: ['enhancement'] }),
      ],
    });
    setupOctokit({ listForRepo });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([1]);
  });

  it('selects each agent label, both ownership assignees, and needs-human', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(1, { labels: ['agent:claude'] }),
        makeItem(2, { labels: ['agent:opencode'] }),
        makeItem(3, { labels: ['agent:codex'] }),
        makeItem(4, { labels: ['status:needs-human'] }),
        makeItem(5, { assignees: [{ login: 'agent-lcars-bot' }] }),
        makeItem(6, { assignees: [{ login: 'jlapenna' }] }),
        makeItem(7), // control: must stay off
      ],
    });
    setupOctokit({ listForRepo });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it('classifies a groomed ready-for-agent issue as Inbox work', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(7, {
          body: `Editable issue description\n\n<!-- agent-lcars:quick-task-request:v1 id=11111111-1111-4111-8111-111111111111 digest=${'a'.repeat(64)} -->`,
          labels: ['status:ready-for-agent', 'type:bug'],
        }),
      ],
    });
    setupOctokit({ listForRepo });

    const result = await getActionItems();

    expect(result.items).toHaveLength(1);
    expect(result.items[0].actionTypes).toEqual(['ready-for-agent']);
    expect(result.items[0].labels).toEqual(['type:bug']);
    expect(result.items[0].body).toBe('Editable issue description');
  });

  it('selects a dispatched item using its repository integration label', async () => {
    const repo = {
      ...DEFAULT_REPO,
      agents: {
        codex: {
          label: 'agent:custom-codex',
          replyTrigger: '/custom-codex',
        },
      },
    };
    (getWatchedRepos as Mock).mockReturnValueOnce([repo]);
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(8, { labels: ['agent:custom-codex'] }),
        makeItem(9, { labels: ['agent:codex'] }),
      ],
    });
    setupOctokit({ listForRepo });

    const result = await getActionItems();

    expect(result.items.map((item) => item.number)).toEqual([8]);
  });

  it('selects a PR solely because it was authored by a known agent bot login (#216)', async () => {
    // Mirrors a PR whose assignee-based claim (agent-lcars-bot) never took and
    // whose review request already cleared (approved) - author is the last
    // signal keeping it from going invisible.
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(198, { pull_request: {}, user: { login: 'claude[bot]' } }),
        makeItem(199, {
          pull_request: {},
          user: { login: 'agent-lcars[bot]' },
        }),
        makeItem(200, {
          pull_request: {},
          user: { login: 'github-actions[bot]' },
        }), // control: glue automation is not an agent author
      ],
    });
    setupOctokit({ listForRepo });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number).sort((a, b) => a - b)).toEqual([
      198, 199,
    ]);
  });

  it('selects a PR solely because the maintainer has a review requested', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [makeItem(90, { pull_request: {} })],
    });
    const pullsList = vi
      .fn()
      .mockResolvedValue({ data: [makePull(90, ['jlapenna'])] });
    const graphql = mockGraphql({
      90: prNode({ reviewers: ['jlapenna'] }),
    });
    setupOctokit({ listForRepo, pullsList, graphql });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([90]);
    expect(result.items[0].actionTypes).toContain('review-requested');
  });

  it('does not raise review-requested on a draft PR', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(91, { ...ON_BOARD, pull_request: {} }),
      ],
    });
    const graphql = mockGraphql({
      91: prNode({ reviewers: ['jlapenna'], isDraft: true }),
    });
    setupOctokit({ listForRepo, graphql });

    const result = await getActionItems();

    expect(result.items[0].actionTypes).not.toContain('review-requested');
    expect(result.items[0].draft).toBe(true);
  });

  it('keeps label-selected items when the PR listing fails, and warns', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [makeItem(11, ON_BOARD)],
    });
    const pullsList = vi.fn().mockRejectedValue(new Error('403 Forbidden'));
    setupOctokit({ listForRepo, pullsList });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([11]);
    expect(
      result.warnings.some((w) => w.includes('Review requests unavailable')),
    ).toBe(true);
  });

  it('captures the newest comment author on needs-human items for context', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(7, {
          labels: ['agent:claude', 'status:needs-human'],
          comments: 2,
        }),
      ],
    });
    const graphql = mockGraphql({
      7: issueNode([
        { body: 'What should I do here?', author: 'claude[bot]' },
        {
          body: 'Use the second option.',
          url: 'https://github.com/o/r/issues/7#issuecomment-2',
          author: 'jlapenna',
        },
      ]),
    });
    setupOctokit({ listForRepo, graphql });

    const result = await getActionItems();

    expect(result.items).toHaveLength(1);
    expect(result.items[0].lastCommentAuthor).toBe('jlapenna');
  });

  it('paginates the open-item listing and collects every item', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': Array.from({ length: 120 }, (_, i) =>
        makeItem(i + 1, ON_BOARD),
      ),
    });
    setupOctokit({ listForRepo });

    const result = await getActionItems();

    expect(result.items).toHaveLength(120);
    expect(listForRepo).toHaveBeenCalledTimes(2);
    expect(result.warnings).toEqual([]);
  });

  it('flags truncation once the open-item listing hits the page cap', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': Array.from({ length: 1100 }, (_, i) =>
        makeItem(i + 1, ON_BOARD),
      ),
    });
    setupOctokit({ listForRepo });

    const result = await getActionItems();

    expect(result.items).toHaveLength(1000);
    expect(
      result.warnings.some((w) => w.includes('Open items truncated')),
    ).toBe(true);
  });

  it('records a warning and keeps other repos when one repo listing rejects', async () => {
    const repoA = { owner: 'org-a', name: 'repo-a' };
    const repoB = { owner: 'org-b', name: 'repo-b' };
    (getWatchedRepos as Mock).mockReturnValueOnce([repoA, repoB]);

    const listForRepo = vi.fn().mockImplementation(({ owner }) => {
      if (owner === 'org-a') {
        return Promise.reject(new Error('502 Bad Gateway'));
      }
      return Promise.resolve({ data: [makeItem(7, ON_BOARD)] });
    });
    setupOctokit({ listForRepo });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([7]);
    expect(
      result.warnings.some((w) =>
        w.includes('Open items unavailable for org-a/repo-a'),
      ),
    ).toBe(true);
  });

  it('flags truncated check runs on a PR without dropping the item', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(500, { ...ON_BOARD, pull_request: {} }),
      ],
    });
    const graphql = mockGraphql({
      500: prNode({
        checks: Array.from({ length: 100 }, (_, i) => ({
          name: `check-${i}`,
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
        })),
        checksTotal: 600,
      }),
    });
    setupOctokit({ listForRepo, graphql });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toContain(500);
    expect(
      result.warnings.some((w) => w.includes('Check runs truncated for #500')),
    ).toBe(true);
  });

  it('sorts a review-requested PR ahead of a run-failed PR, tied with needs-human', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(1, { ...ON_BOARD, pull_request: {} }), // run-failed
        makeItem(2, { pull_request: {} }), // review-requested
        makeItem(3, { labels: ['status:needs-human'] }),
      ],
    });
    const pullsList = vi
      .fn()
      .mockResolvedValue({ data: [makePull(1), makePull(2, ['jlapenna'])] });
    const graphql = mockGraphql({
      1: prNode({
        checks: [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }],
      }),
      2: prNode({ reviewers: ['jlapenna'] }),
      3: issueNode(),
    });
    setupOctokit({ listForRepo, pullsList, graphql });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([2, 3, 1]);
    expect(result.items[2].failingChecks?.[0].name).toBe('ci');
  });

  // A `cancelled` run is almost always superseded or manually killed;
  // badging it "CI run failed" sent the maintainer chasing retriggers.
  it('treats only a failure conclusion as run-failed, not cancelled', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(80, { ...ON_BOARD, pull_request: {} }),
      ],
    });
    const graphql = mockGraphql({
      80: prNode({
        checks: [
          { name: 'superseded', status: 'COMPLETED', conclusion: 'CANCELLED' },
          { name: 'running', status: 'IN_PROGRESS', conclusion: null },
        ],
      }),
    });
    setupOctokit({ listForRepo, graphql });

    const result = await getActionItems();

    expect(result.items[0].actionTypes).not.toContain('run-failed');
    // The in-progress run still marks CI as running.
    expect(result.items[0].ciRunning).toBe(true);
  });

  it('maps the GraphQL merge state onto the REST vocabulary the UI expects', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(81, { ...ON_BOARD, pull_request: {} }),
        makeItem(82, { ...ON_BOARD, pull_request: {} }),
      ],
    });
    const graphql = mockGraphql({
      81: prNode({ mergeStateStatus: 'BEHIND' }),
      // No REST equivalent in MergeableState - must degrade, not leak.
      82: prNode({ mergeStateStatus: 'HAS_HOOKS' }),
    });
    setupOctokit({ listForRepo, graphql });

    const result = await getActionItems();
    const byNumber = new Map(
      result.items.map((i) => [i.number, i.mergeableState]),
    );

    expect(byNumber.get(81)).toBe('behind');
    expect(byNumber.get(82)).toBe('unknown');
  });

  it('raises merge-blocked on an already-approved PR whose branch fell behind (#216)', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(83, { ...ON_BOARD, pull_request: {} }),
      ],
    });
    const graphql = mockGraphql({
      // No requested reviewers - review-requested already cleared (approved).
      83: prNode({ mergeStateStatus: 'BEHIND' }),
    });
    setupOctokit({ listForRepo, graphql });

    const result = await getActionItems();

    expect(result.items[0].actionTypes).toContain('merge-blocked');
  });

  it('does not raise merge-blocked while review is still outstanding', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(84, { ...ON_BOARD, pull_request: {} }),
      ],
    });
    const graphql = mockGraphql({
      84: prNode({ mergeStateStatus: 'BEHIND', reviewers: ['jlapenna'] }),
    });
    setupOctokit({ listForRepo, graphql });

    const result = await getActionItems();

    expect(result.items[0].actionTypes).toContain('review-requested');
    expect(result.items[0].actionTypes).not.toContain('merge-blocked');
  });

  it('does not raise merge-blocked on a draft PR', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(85, { ...ON_BOARD, pull_request: {} }),
      ],
    });
    const graphql = mockGraphql({
      85: prNode({ mergeStateStatus: 'BEHIND', isDraft: true }),
    });
    setupOctokit({ listForRepo, graphql });

    const result = await getActionItems();

    expect(result.items[0].actionTypes).not.toContain('merge-blocked');
  });

  // #538: the actual retro scenario (#521) - ten green-checked,
  // auto-merge-armed PRs sat unmergeable for hours behind 17 unresolved
  // Codex review threads, and nothing but tribal memory named the cause.
  it('raises merge-blocked with the unresolved thread count when threads are the reason (#538)', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(86, { ...ON_BOARD, pull_request: {} }),
      ],
    });
    const graphql = mockGraphql({
      86: prNode({
        mergeStateStatus: 'BLOCKED',
        reviewThreads: [false, false, true, false],
      }),
    });
    setupOctokit({ listForRepo, graphql });

    const result = await getActionItems();

    expect(result.items[0].actionTypes).toContain('merge-blocked');
    expect(result.items[0].unresolvedReviewThreadCount).toBe(3);
  });

  it('does not raise merge-blocked on a blocked PR with no unresolved threads', async () => {
    // mergeStateStatus BLOCKED has other causes (a missing required
    // reviewer, a required check) this classifier doesn't attribute to
    // threads - zero unresolved threads must not raise merge-blocked or
    // claim a reason this classifier can't back up.
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(87, { ...ON_BOARD, pull_request: {} }),
      ],
    });
    const graphql = mockGraphql({
      87: prNode({ mergeStateStatus: 'BLOCKED', reviewThreads: [true, true] }),
    });
    setupOctokit({ listForRepo, graphql });

    const result = await getActionItems();

    expect(result.items[0].actionTypes).not.toContain('merge-blocked');
    expect(result.items[0].unresolvedReviewThreadCount).toBeUndefined();
  });

  it('does not raise merge-blocked-by-threads while review is still outstanding', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(88, { ...ON_BOARD, pull_request: {} }),
      ],
    });
    const graphql = mockGraphql({
      88: prNode({
        mergeStateStatus: 'BLOCKED',
        reviewers: ['jlapenna'],
        reviewThreads: [false, false],
      }),
    });
    setupOctokit({ listForRepo, graphql });

    const result = await getActionItems();

    expect(result.items[0].actionTypes).toContain('review-requested');
    expect(result.items[0].actionTypes).not.toContain('merge-blocked');
    expect(result.items[0].unresolvedReviewThreadCount).toBeUndefined();
  });

  it('does not surface a thread count on a PR merely blocked by a behind base (behind, not blocked)', async () => {
    // 'behind' already has its own reason ("Base branch has moved"); a
    // stray unresolved thread on a `behind` PR isn't the operative blocker
    // and must not double up on the reason line.
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(89, { ...ON_BOARD, pull_request: {} }),
      ],
    });
    const graphql = mockGraphql({
      89: prNode({ mergeStateStatus: 'BEHIND', reviewThreads: [false] }),
    });
    setupOctokit({ listForRepo, graphql });

    const result = await getActionItems();

    expect(result.items[0].actionTypes).toContain('merge-blocked');
    expect(result.items[0].unresolvedReviewThreadCount).toBeUndefined();
  });

  it('warns when the review-thread window truncates a blocked PR carrying unresolved threads', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(92, { ...ON_BOARD, pull_request: {} }),
      ],
    });
    const graphql = mockGraphql({
      92: prNode({
        mergeStateStatus: 'BLOCKED',
        reviewThreads: Array.from({ length: 100 }, () => false),
        reviewThreadsTotal: 117,
      }),
    });
    setupOctokit({ listForRepo, graphql });

    const result = await getActionItems();

    expect(result.items[0].unresolvedReviewThreadCount).toBe(100);
    expect(
      result.warnings.some((w) =>
        w.includes('Review threads truncated for #92'),
      ),
    ).toBe(true);
  });

  it('still warns on truncation when every unresolved thread falls past the fetched page', async () => {
    // Regression for Codex review on #538/#575: if the real unresolved
    // thread sits past REVIEW_THREAD_WINDOW, the client-side count over the
    // fetched page can land at 0, making blockedByThreads false even though
    // the PR is genuinely blocked by threads. The truncation warning must
    // not be gated behind that (now-wrong) flag.
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(93, { ...ON_BOARD, pull_request: {} }),
      ],
    });
    const graphql = mockGraphql({
      93: prNode({
        mergeStateStatus: 'BLOCKED',
        reviewThreads: Array.from({ length: 100 }, () => true),
        reviewThreadsTotal: 117,
      }),
    });
    setupOctokit({ listForRepo, graphql });

    const result = await getActionItems();

    expect(result.items[0].unresolvedReviewThreadCount).toBeUndefined();
    expect(result.items[0].actionTypes).not.toContain('merge-blocked');
    expect(
      result.warnings.some((w) =>
        w.includes('Review threads truncated for #93'),
      ),
    ).toBe(true);
  });

  it('still renders an item when its enrichment is missing entirely', async () => {
    // A partial GraphQL failure drops individual items from the response;
    // the board must degrade to listing-only data, not lose the row.
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(70, { labels: ['status:needs-human'] }),
      ],
    });
    setupOctokit({ listForRepo, graphql: mockGraphql() });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([70]);
    expect(result.items[0].actionTypes).toContain('needs-human');
    expect(result.items[0].lastCommentBody).toBeUndefined();
  });

  it('drops a malformed listing entry and warns, without affecting siblings', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(10, ON_BOARD),
        // `labels` is not an array, so reading it throws. Before this was
        // guarded, one such entry threw out of the selection filter and
        // blanked the entire repo's board.
        { ...makeItem(20, ON_BOARD), labels: null } as unknown as FakeRepoIssue,
      ],
    });
    setupOctokit({ listForRepo });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([10]);
    expect(
      result.warnings.some((w) =>
        w.includes(
          'Skipped a malformed item from supersprinklesracing/sprinkles',
        ),
      ),
    ).toBe(true);
  });

  it('surfaces assignee logins on the item (#3024 stale-claim detection)', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(70, {
          assignees: [{ login: 'agent-lcars-bot' }],
          comments: 0,
        }),
      ],
    });
    setupOctokit({ listForRepo });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([70]);
    expect(result.items[0].assigneeLogins).toEqual(['agent-lcars-bot']);
  });

  it('requests comments for a Claude-labeled issue nobody has claimed (#306)', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(44, { labels: ['agent:claude'], comments: 3 }),
      ],
    });
    const graphql = mockGraphql({ 44: issueNode() });
    setupOctokit({ listForRepo, graphql });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([44]);
    expect(graphql.queries[0]).toContain('comments(');
  });

  it('surfaces a dispatched-but-unclaimed OpenCode-labeled issue (#3012)', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(60, { labels: ['agent:opencode'], comments: 0 }),
      ],
    });
    setupOctokit({ listForRepo });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([60]);
    expect(result.items[0].labels).toContain('agent:opencode');
  });

  it('does NOT derive needs-human from the assignee pair alone — label only (#2802 decided, #3023)', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(50, {
          assignees: [{ login: 'agent-lcars-bot' }, { login: 'jlapenna' }],
          comments: 1,
        }),
      ],
    });
    const graphql = mockGraphql({
      50: issueNode([
        { body: 'What should I do here?', author: 'claude[bot]' },
      ]),
    });
    setupOctokit({ listForRepo, graphql });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([50]);
    expect(result.items[0].actionTypes).not.toContain('needs-human');
  });

  it('does not derive needs-human from agent-lcars-bot alone (no maintainer assignee, no label)', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(51, {
          assignees: [{ login: 'agent-lcars-bot' }],
          comments: 0,
        }),
      ],
    });
    setupOctokit({ listForRepo });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([51]);
    expect(result.items[0].actionTypes).not.toContain('needs-human');
  });

  // Phase-1 exit criterion (see the multi-repo plan): composite-key
  // correctness can't be proven by any test configured with a single repo -
  // a bug that drops `repo` from a dedupe/join key silently cross-
  // contaminates data once a second repo is real.
  it('does not conflate identical issue numbers across two different watched repos', async () => {
    const repoA = { owner: 'org-a', name: 'repo-a' };
    const repoB = { owner: 'org-b', name: 'repo-b' };
    (getWatchedRepos as Mock).mockReturnValueOnce([repoA, repoB]);

    const listForRepo = pagedListForRepo({
      'org-a/repo-a': [makeItem(42, { ...ON_BOARD, title: 'Repo A issue 42' })],
      'org-b/repo-b': [makeItem(42, { ...ON_BOARD, title: 'Repo B issue 42' })],
    });
    setupOctokit({ listForRepo });

    const result = await getActionItems();

    const numbered42 = result.items.filter((item) => item.number === 42);
    expect(numbered42).toHaveLength(2);
    expect(numbered42.map((item) => item.title).sort()).toEqual([
      'Repo A issue 42',
      'Repo B issue 42',
    ]);
    expect(numbered42.map((item) => item.repo)).toEqual(
      expect.arrayContaining([repoA, repoB]),
    );
  });

  // Enrichment is repo-scoped, so two repos means two queries - and each
  // repo's items must be keyed apart, not merged into one alias space.
  it('enriches each watched repo with its own query', async () => {
    const repoA = { owner: 'org-a', name: 'repo-a' };
    const repoB = { owner: 'org-b', name: 'repo-b' };
    (getWatchedRepos as Mock).mockReturnValueOnce([repoA, repoB]);

    const listForRepo = pagedListForRepo({
      'org-a/repo-a': [makeItem(42, { labels: ['status:needs-human'] })],
      'org-b/repo-b': [makeItem(42, { labels: ['status:needs-human'] })],
    });
    const graphql = vi
      .fn()
      .mockImplementation((_q: string, vars: { name: string }) =>
        Promise.resolve({
          repository: {
            i42: issueNode([{ body: `comment from ${vars.name}` }]),
          },
        }),
      );
    setupOctokit({ listForRepo, graphql });

    const result = await getActionItems();

    expect(graphql).toHaveBeenCalledTimes(2);
    const bodies = result.items.map((i) => i.lastCommentBody).sort();
    expect(bodies).toEqual(['comment from repo-a', 'comment from repo-b']);
  });
});
