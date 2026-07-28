import { describe, expect, it, type Mock, vi } from 'vitest';

import {
  type ActionItem,
  getActionItems,
  isDeployWaitOnly,
  isHandedBack,
} from './action-items';
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
        actionTypes: ['post-deploy-action', 'human-needed'],
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

describe('isHandedBack', () => {
  function makeActionItem(overrides: Partial<ActionItem> = {}): ActionItem {
    return {
      kind: 'issue',
      repo: DEFAULT_REPO,
      number: 1,
      title: 't',
      url: 'u',
      updatedAt: 'now',
      actionTypes: ['human-needed'],
      labels: [],
      assigneeLogins: [],
      ...overrides,
    };
  }

  it('is true when the maintainer wrote the newest comment on a human-needed item', () => {
    expect(
      isHandedBack(makeActionItem({ lastCommentAuthor: 'jlapenna' })),
    ).toBe(true);
  });

  it('is false when the agent spoke last', () => {
    expect(
      isHandedBack(makeActionItem({ lastCommentAuthor: 'claude[bot]' })),
    ).toBe(false);
    expect(isHandedBack(makeActionItem())).toBe(false);
  });

  it('never hands back items that need the maintainer regardless of possession', () => {
    expect(
      isHandedBack(
        makeActionItem({
          actionTypes: ['human-needed', 'review-requested'],
          lastCommentAuthor: 'jlapenna',
        }),
      ),
    ).toBe(false);
    expect(
      isHandedBack(
        makeActionItem({
          actionTypes: ['human-needed', 'run-failed'],
          lastCommentAuthor: 'jlapenna',
        }),
      ),
    ).toBe(false);
  });

  it('still hands back when a post-deploy wait rides along', () => {
    expect(
      isHandedBack(
        makeActionItem({
          actionTypes: ['human-needed', 'post-deploy-action'],
          lastCommentAuthor: 'jlapenna',
        }),
      ),
    ).toBe(true);
  });
});

describe('getActionItems', () => {
  // Every item a test wants on the board has to satisfy the open-item
  // predicate (see isBoardItem) the way it would in production - by label,
  // by assignee, or by a requested review. `claude` is the cheapest of
  // those for tests not specifically exercising selection.
  const ON_BOARD = { labels: ['claude'] };

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
  }: {
    comments?: { body: string; url?: string; author?: string }[];
    isDraft?: boolean;
    mergeStateStatus?: string;
    body?: string | null;
    reviewers?: string[];
    checks?: { name: string; status: string; conclusion: string | null }[];
    checksTotal?: number;
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
        makeItem(i + 1, { labels: ['human-needed'] }),
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

  it('selects each pipeline label, both ownership assignees, and human-needed', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(1, { labels: ['claude'] }),
        makeItem(2, { labels: ['opencode'] }),
        makeItem(3, { labels: ['codex'] }),
        makeItem(4, { labels: ['human-needed'] }),
        makeItem(5, { assignees: [{ login: 'jclaw-bot' }] }),
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

  it('captures the newest comment author on human-needed items (possession signal)', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(7, { labels: ['claude', 'human-needed'], comments: 2 }),
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
    expect(isHandedBack(result.items[0])).toBe(true);
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

  it('sorts a review-requested PR ahead of a run-failed PR, tied with human-needed', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(1, { ...ON_BOARD, pull_request: {} }), // run-failed
        makeItem(2, { pull_request: {} }), // review-requested
        makeItem(3, { labels: ['human-needed'] }), // human-needed
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

  it('still renders an item when its enrichment is missing entirely', async () => {
    // A partial GraphQL failure drops individual items from the response;
    // the board must degrade to listing-only data, not lose the row.
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(70, { labels: ['human-needed'] }),
      ],
    });
    setupOctokit({ listForRepo, graphql: mockGraphql() });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([70]);
    expect(result.items[0].actionTypes).toContain('human-needed');
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

  it('surfaces the takeover command on a jclaw-bot-assigned PR', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(42, {
          pull_request: {},
          assignees: [{ login: 'jclaw-bot' }],
          comments: 1,
        }),
      ],
    });
    const graphql = mockGraphql({
      42: prNode({
        comments: [
          {
            body: 'Session takeover:\n```\n~/p/members/tools/claude-agent-session.sh resume abc-123\n```',
            author: 'claude[bot]',
          },
        ],
      }),
    });
    setupOctokit({ listForRepo, graphql });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([42]);
    expect(result.items[0].takeoverCommand).toBe(
      '~/p/members/tools/claude-agent-session.sh resume abc-123',
    );
  });

  it('takes the newest takeover command when a thread has several', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(45, { assignees: [{ login: 'jclaw-bot' }], comments: 2 }),
      ],
    });
    const graphql = mockGraphql({
      45: issueNode([
        { body: 'tools/claude-agent-session.sh resume old-session' },
        { body: 'tools/claude-agent-session.sh resume new-session' },
      ]),
    });
    setupOctokit({ listForRepo, graphql });

    const result = await getActionItems();

    expect(result.items[0].takeoverCommand).toBe(
      'tools/claude-agent-session.sh resume new-session',
    );
  });

  it('surfaces assignee logins on the item (#3024 stale-claim detection)', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(70, { assignees: [{ login: 'jclaw-bot' }], comments: 0 }),
      ],
    });
    setupOctokit({ listForRepo });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([70]);
    expect(result.items[0].assigneeLogins).toEqual(['jclaw-bot']);
  });

  it('scans takeover for a jclaw-bot-assigned issue without the claude label (interactive claim)', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(43, { assignees: [{ login: 'jclaw-bot' }], comments: 1 }),
      ],
    });
    const graphql = mockGraphql({
      43: issueNode([
        {
          body: '~/p/members/tools/claude-agent-session.sh resume def-456',
          author: 'jlapenna',
        },
      ]),
    });
    setupOctokit({ listForRepo, graphql });

    const result = await getActionItems();

    expect(result.items[0].takeoverCommand).toBe(
      '~/p/members/tools/claude-agent-session.sh resume def-456',
    );
  });

  it('does not request comments for a claude-labeled issue nobody has claimed', async () => {
    // Dispatched-but-unclaimed (runner never started): there is no session
    // yet, so there is no takeover command to find - the claim assignee,
    // not the dispatch label, is what says a session exists (#2783). The
    // comment window is the expensive part of the query, so it must not be
    // requested for items that will never read it.
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(44, { labels: ['claude'], comments: 3 }),
      ],
    });
    const graphql = mockGraphql({ 44: issueNode() });
    setupOctokit({ listForRepo, graphql });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([44]);
    expect(result.items[0].takeoverCommand).toBeUndefined();
    expect(graphql.queries[0]).not.toContain('comments(');
  });

  it('surfaces a dispatched-but-unclaimed opencode-labeled issue (#3012)', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(60, { labels: ['opencode'], comments: 0 }),
      ],
    });
    setupOctokit({ listForRepo });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([60]);
    expect(result.items[0].labels).toContain('opencode');
  });

  it('does NOT derive human-needed from the assignee pair alone — label only (#2802 decided, #3023)', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(50, {
          assignees: [{ login: 'jclaw-bot' }, { login: 'jlapenna' }],
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
    expect(result.items[0].actionTypes).not.toContain('human-needed');
  });

  it('does not derive human-needed from jclaw-bot alone (no maintainer assignee, no label)', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(51, { assignees: [{ login: 'jclaw-bot' }], comments: 0 }),
      ],
    });
    setupOctokit({ listForRepo });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([51]);
    expect(result.items[0].actionTypes).not.toContain('human-needed');
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
      'org-a/repo-a': [makeItem(42, { labels: ['human-needed'] })],
      'org-b/repo-b': [makeItem(42, { labels: ['human-needed'] })],
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
