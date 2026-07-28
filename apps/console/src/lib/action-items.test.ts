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

  function setupOctokit({
    listForRepo,
    pullsList = vi.fn().mockResolvedValue({ data: [] }),
    listComments = vi.fn().mockResolvedValue({ data: [] }),
    pullsGet = vi.fn(),
    checksListForRef = vi
      .fn()
      .mockResolvedValue({ data: { total_count: 0, check_runs: [] } }),
    searchSpy = vi.fn(),
  }: {
    listForRepo: Mock;
    pullsList?: Mock;
    listComments?: Mock;
    pullsGet?: Mock;
    checksListForRef?: Mock;
    searchSpy?: Mock;
  }) {
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        // Present only so a regression back onto the search API is caught
        // by the assertion in the #13 guard below rather than silently
        // reintroducing the 30-req/min bottleneck.
        search: { issuesAndPullRequests: searchSpy },
        issues: { listForRepo, listComments },
        pulls: { list: pullsList, get: pullsGet },
        checks: { listForRef: checksListForRef },
      },
    });
    return searchSpy;
  }

  // #13: the board used to cost 14 search requests per repo against a
  // budget of 30 per minute. Selection now runs off two core-budget list
  // endpoints, and must never quietly go back.
  it('reads the board from list endpoints and never calls the search API', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [makeItem(1, ON_BOARD)],
    });
    const searchSpy = setupOctokit({ listForRepo });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([1]);
    expect(searchSpy).not.toHaveBeenCalled();
    // One listing pass per repo, not one per qualifier.
    expect(listForRepo).toHaveBeenCalledTimes(1);
    expect(listForRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'supersprinklesracing',
        repo: 'sprinkles',
        state: 'open',
      }),
    );
  });

  it('leaves open items that match no board predicate off the board', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(1, ON_BOARD),
        makeItem(2), // no label, no assignee, no review request
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
    // The one predicate issues.listForRepo cannot express - it comes from
    // the PR listing instead.
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [makeItem(90, { pull_request: {} })],
    });
    const pullsList = vi
      .fn()
      .mockResolvedValue({ data: [makePull(90, ['jlapenna'])] });
    const pullsGet = vi.fn().mockResolvedValue({
      data: {
        draft: false,
        mergeable_state: 'clean',
        head: { sha: 'deadbeef' },
        body: null,
        requested_reviewers: [{ login: 'jlapenna' }],
      },
    });
    setupOctokit({ listForRepo, pullsList, pullsGet });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([90]);
    expect(result.items[0].actionTypes).toContain('review-requested');
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
    const listComments = vi.fn().mockResolvedValue({
      data: [
        {
          body: 'What should I do here?',
          html_url: 'https://github.com/o/r/issues/7#issuecomment-1',
          user: { login: 'claude[bot]' },
        },
        {
          body: 'Use the second option.',
          html_url: 'https://github.com/o/r/issues/7#issuecomment-2',
          user: { login: 'jlapenna' },
        },
      ],
    });
    setupOctokit({ listForRepo, listComments });

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
    const pullsGet = vi.fn().mockResolvedValue({
      data: {
        draft: false,
        mergeable_state: 'clean',
        head: { sha: 'deadbeef' },
        body: null,
        requested_reviewers: [],
      },
    });
    const checksListForRef = vi.fn().mockImplementation(({ page }) => {
      return Promise.resolve({
        data: {
          total_count: 600,
          check_runs: Array.from({ length: 100 }, (_, i) => ({
            name: `check-${page}-${i}`,
            html_url: 'https://github.com/check',
            status: 'completed',
            conclusion: 'success',
          })),
        },
      });
    });
    setupOctokit({ listForRepo, pullsGet, checksListForRef });

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
    const pullsGet = vi.fn().mockImplementation(({ pull_number }) =>
      Promise.resolve({
        data: {
          draft: false,
          mergeable_state: 'clean',
          head: { sha: `sha-${pull_number}` },
          body: null,
          requested_reviewers: pull_number === 2 ? [{ login: 'jlapenna' }] : [],
        },
      }),
    );
    const checksListForRef = vi.fn().mockImplementation(({ ref }) =>
      Promise.resolve({
        data: {
          total_count: ref === 'sha-1' ? 1 : 0,
          check_runs:
            ref === 'sha-1'
              ? [
                  {
                    name: 'ci',
                    html_url: 'https://github.com/check',
                    status: 'completed',
                    conclusion: 'failure',
                  },
                ]
              : [],
        },
      }),
    );
    setupOctokit({ listForRepo, pullsList, pullsGet, checksListForRef });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([2, 3, 1]);
  });

  it('drops an item and records a warning when classification throws, without affecting siblings', async () => {
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(10, ON_BOARD),
        makeItem(20, { ...ON_BOARD, pull_request: {} }),
      ],
    });
    const pullsGet = vi
      .fn()
      .mockImplementation(({ pull_number }) =>
        pull_number === 20
          ? Promise.reject(new Error('404 Not Found'))
          : Promise.resolve({ data: {} }),
      );
    setupOctokit({ listForRepo, pullsGet });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([10]);
    expect(
      result.warnings.some((w) =>
        w.includes('Failed to classify supersprinklesracing/sprinkles#20'),
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
    const listComments = vi.fn().mockResolvedValue({
      data: [
        {
          body: 'Session takeover:\n```\n~/p/members/tools/claude-agent-session.sh resume abc-123\n```',
          html_url: 'https://github.com/o/r/pull/42#issuecomment-1',
          user: { login: 'claude[bot]' },
        },
      ],
    });
    const pullsGet = vi.fn().mockResolvedValue({
      data: {
        draft: false,
        mergeable_state: 'clean',
        head: { sha: 'deadbeef' },
        body: null,
        requested_reviewers: [],
      },
    });
    setupOctokit({ listForRepo, listComments, pullsGet });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([42]);
    expect(result.items[0].takeoverCommand).toBe(
      '~/p/members/tools/claude-agent-session.sh resume abc-123',
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
    const listComments = vi.fn().mockResolvedValue({
      data: [
        {
          body: '~/p/members/tools/claude-agent-session.sh resume def-456',
          html_url: 'https://github.com/o/r/issues/43#issuecomment-1',
          user: { login: 'jlapenna' },
        },
      ],
    });
    setupOctokit({ listForRepo, listComments });

    const result = await getActionItems();

    expect(result.items[0].takeoverCommand).toBe(
      '~/p/members/tools/claude-agent-session.sh resume def-456',
    );
  });

  it('does not scan comments for a claude-labeled issue nobody has claimed', async () => {
    // Dispatched-but-unclaimed (runner never started): there is no session
    // yet, so there is no takeover command to find - the claim assignee,
    // not the dispatch label, is what says a session exists (#2783).
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(44, { labels: ['claude'], comments: 3 }),
      ],
    });
    const listComments = vi.fn().mockResolvedValue({ data: [] });
    setupOctokit({ listForRepo, listComments });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([44]);
    expect(result.items[0].takeoverCommand).toBeUndefined();
    expect(listComments).not.toHaveBeenCalled();
  });

  it('surfaces a dispatched-but-unclaimed opencode-labeled issue (#3012)', async () => {
    // Same belt-and-suspenders shape as the claude-labeled case above,
    // parity for the experimental opencode.yml pipeline: without this
    // predicate a stalled opencode run (runner never picked it up) would be
    // invisible on the console.
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
    // Assignees are additive-only: un-parking removes the label but never
    // the assignees, so a pair-based derivation kept answered items in the
    // queue forever. The label is the single park signal, matching
    // claude.yml's deliverable check and pr-heal's park-check.
    const listForRepo = pagedListForRepo({
      'supersprinklesracing/sprinkles': [
        makeItem(50, {
          assignees: [{ login: 'jclaw-bot' }, { login: 'jlapenna' }],
          comments: 1,
        }),
      ],
    });
    const listComments = vi.fn().mockResolvedValue({
      data: [
        {
          body: 'What should I do here?',
          html_url: 'https://github.com/o/r/issues/50#issuecomment-1',
          user: { login: 'claude[bot]' },
        },
      ],
    });
    setupOctokit({ listForRepo, listComments });

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
  // contaminates data once a second repo is real. Two watched repos both
  // surfacing issue #42 must survive as two distinct items, not collapse
  // into one.
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
});
