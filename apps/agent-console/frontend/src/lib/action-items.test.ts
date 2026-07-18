import { describe, expect, it, type Mock, vi } from 'vitest';

import {
  type ActionItem,
  getActionItems,
  isDeployWaitOnly,
  isHandedBack,
} from './action-items';
import { getGithubClient } from './github-client';

vi.mock('./github-client', () => ({
  getGithubClient: vi.fn(),
  REPO_OWNER: 'supersprinklesracing',
  REPO_NAME: 'members',
}));

interface FakeSearchItem {
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
  overrides: Partial<FakeSearchItem> = {},
): FakeSearchItem {
  return {
    number,
    title: `Issue ${number}`,
    html_url: `https://github.com/supersprinklesracing/members/issues/${number}`,
    body: null,
    updated_at: '2026-07-07T00:00:00Z',
    user: { login: 'someone' },
    labels: [],
    assignees: [],
    comments: 0,
    ...overrides,
  };
}

// Every call site targets exactly one of the 10 expanded SEARCH_QUERIES via
// this predicate, and every non-targeted query resolves empty - keeps each
// test isolated to the one query path it's exercising.
function emptySearchPage() {
  return Promise.resolve({ data: { total_count: 0, items: [] } });
}

describe('isDeployWaitOnly', () => {
  it('is true only when every action type is post-deploy-action', () => {
    expect(
      isDeployWaitOnly({
        kind: 'issue',
        number: 1,
        title: 't',
        url: 'u',
        updatedAt: 'now',
        actionTypes: ['post-deploy-action'],
        labels: [],
      }),
    ).toBe(true);
    expect(
      isDeployWaitOnly({
        kind: 'issue',
        number: 1,
        title: 't',
        url: 'u',
        updatedAt: 'now',
        actionTypes: ['post-deploy-action', 'human-needed'],
        labels: [],
      }),
    ).toBe(false);
    expect(
      isDeployWaitOnly({
        kind: 'issue',
        number: 1,
        title: 't',
        url: 'u',
        updatedAt: 'now',
        actionTypes: [],
        labels: [],
      }),
    ).toBe(false);
  });
});

describe('isHandedBack', () => {
  function makeActionItem(overrides: Partial<ActionItem> = {}): ActionItem {
    return {
      kind: 'issue',
      number: 1,
      title: 't',
      url: 'u',
      updatedAt: 'now',
      actionTypes: ['human-needed'],
      labels: [],
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
  const TARGET_Q = (q: string) =>
    q.includes('label:claude') && q.includes('is:issue');

  function setupOctokit({
    issuesAndPullRequests,
    listComments = vi.fn().mockResolvedValue({ data: [] }),
    pullsGet = vi.fn(),
    checksListForRef = vi.fn(),
  }: {
    issuesAndPullRequests: Mock;
    listComments?: Mock;
    pullsGet?: Mock;
    checksListForRef?: Mock;
  }) {
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        search: { issuesAndPullRequests },
        issues: { listComments },
        pulls: { get: pullsGet },
        checks: { listForRef: checksListForRef },
      },
    });
  }

  it('captures the newest comment author on human-needed items (possession signal)', async () => {
    const issuesAndPullRequests = vi.fn().mockImplementation(({ q }) => {
      if (!TARGET_Q(q)) return emptySearchPage();
      return Promise.resolve({
        data: {
          total_count: 1,
          items: [
            makeItem(7, { labels: ['claude', 'human-needed'], comments: 2 }),
          ],
        },
      });
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
    setupOctokit({ issuesAndPullRequests, listComments });

    const result = await getActionItems();

    expect(result.items).toHaveLength(1);
    expect(result.items[0].lastCommentAuthor).toBe('jlapenna');
    expect(isHandedBack(result.items[0])).toBe(true);
  });

  it('paginates a query across multiple pages and collects every item', async () => {
    const issuesAndPullRequests = vi.fn().mockImplementation(({ q, page }) => {
      if (!TARGET_Q(q)) return emptySearchPage();
      if (page === 1) {
        return Promise.resolve({
          data: {
            total_count: 120,
            items: Array.from({ length: 100 }, (_, i) => makeItem(i + 1)),
          },
        });
      }
      if (page === 2) {
        return Promise.resolve({
          data: {
            total_count: 120,
            items: Array.from({ length: 20 }, (_, i) => makeItem(i + 101)),
          },
        });
      }
      return emptySearchPage();
    });
    setupOctokit({ issuesAndPullRequests });

    const result = await getActionItems();

    expect(result.items).toHaveLength(120);
    expect(result.warnings).toEqual([]);
  });

  it('flags truncation once a query hits the 1000-result page cap', async () => {
    const issuesAndPullRequests = vi.fn().mockImplementation(({ q, page }) => {
      if (!TARGET_Q(q)) return emptySearchPage();
      return Promise.resolve({
        data: {
          total_count: 1500,
          items: Array.from({ length: 100 }, (_, i) =>
            makeItem(page * 1000 + i),
          ),
        },
      });
    });
    setupOctokit({ issuesAndPullRequests });

    const result = await getActionItems();

    expect(result.items).toHaveLength(1000);
    expect(
      result.warnings.some((w) => w.includes('Search results truncated')),
    ).toBe(true);
  });

  it('records a warning and keeps other queries when one search query rejects', async () => {
    const FAILING_Q = (q: string) =>
      q.includes('label:human-needed') && q.includes('is:issue');
    const issuesAndPullRequests = vi.fn().mockImplementation(({ q }) => {
      if (FAILING_Q(q)) return Promise.reject(new Error('502 Bad Gateway'));
      if (TARGET_Q(q)) {
        return Promise.resolve({
          data: { total_count: 1, items: [makeItem(7)] },
        });
      }
      return emptySearchPage();
    });
    setupOctokit({ issuesAndPullRequests });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([7]);
    expect(result.warnings.some((w) => w.includes('Search query failed'))).toBe(
      true,
    );
  });

  it('flags truncated check runs on a PR without dropping the item', async () => {
    const issuesAndPullRequests = vi.fn().mockImplementation(({ q }) => {
      if (!TARGET_Q(q)) return emptySearchPage();
      return Promise.resolve({
        data: {
          total_count: 1,
          items: [makeItem(500, { pull_request: {} })],
        },
      });
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
    setupOctokit({ issuesAndPullRequests, pullsGet, checksListForRef });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toContain(500);
    expect(
      result.warnings.some((w) => w.includes('Check runs truncated for #500')),
    ).toBe(true);
  });

  it('sorts a review-requested PR ahead of a run-failed PR, tied with human-needed', async () => {
    const issuesAndPullRequests = vi.fn().mockImplementation(({ q }) => {
      if (!TARGET_Q(q)) return emptySearchPage();
      return Promise.resolve({
        data: {
          total_count: 3,
          items: [
            makeItem(1, { pull_request: {} }), // run-failed
            makeItem(2, { pull_request: {} }), // review-requested
            makeItem(3, { labels: ['human-needed'] }), // human-needed
          ],
        },
      });
    });
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
    setupOctokit({ issuesAndPullRequests, pullsGet, checksListForRef });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([2, 3, 1]);
  });

  it('drops an item and records a warning when classification throws, without affecting siblings', async () => {
    const issuesAndPullRequests = vi.fn().mockImplementation(({ q }) => {
      if (!TARGET_Q(q)) return emptySearchPage();
      return Promise.resolve({
        data: {
          total_count: 2,
          items: [makeItem(10), makeItem(20, { pull_request: {} })],
        },
      });
    });
    const pullsGet = vi
      .fn()
      .mockImplementation(({ pull_number }) =>
        pull_number === 20
          ? Promise.reject(new Error('404 Not Found'))
          : Promise.resolve({ data: {} }),
      );
    setupOctokit({ issuesAndPullRequests, pullsGet });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([10]);
    expect(
      result.warnings.some((w) => w.includes('Failed to classify #20')),
    ).toBe(true);
  });

  it('surfaces the takeover command on a jclaw-bot-assigned PR', async () => {
    const PR_Q = (q: string) =>
      q.includes('assignee:jclaw-bot') && q.includes('is:pull-request');
    const issuesAndPullRequests = vi.fn().mockImplementation(({ q }) => {
      if (!PR_Q(q)) return emptySearchPage();
      return Promise.resolve({
        data: {
          total_count: 1,
          items: [
            makeItem(42, {
              pull_request: {},
              assignees: [{ login: 'jclaw-bot' }],
              comments: 1,
            }),
          ],
        },
      });
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
    const checksListForRef = vi
      .fn()
      .mockResolvedValue({ data: { total_count: 0, check_runs: [] } });
    setupOctokit({
      issuesAndPullRequests,
      listComments,
      pullsGet,
      checksListForRef,
    });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([42]);
    expect(result.items[0].takeoverCommand).toBe(
      '~/p/members/tools/claude-agent-session.sh resume abc-123',
    );
  });

  it('scans takeover for a jclaw-bot-assigned issue without the claude label (interactive claim)', async () => {
    const ISSUE_Q = (q: string) =>
      q.includes('assignee:jclaw-bot') && q.includes('is:issue');
    const issuesAndPullRequests = vi.fn().mockImplementation(({ q }) => {
      if (!ISSUE_Q(q)) return emptySearchPage();
      return Promise.resolve({
        data: {
          total_count: 1,
          items: [
            makeItem(43, { assignees: [{ login: 'jclaw-bot' }], comments: 1 }),
          ],
        },
      });
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
    setupOctokit({ issuesAndPullRequests, listComments });

    const result = await getActionItems();

    expect(result.items[0].takeoverCommand).toBe(
      '~/p/members/tools/claude-agent-session.sh resume def-456',
    );
  });

  it('does not scan comments for a claude-labeled issue nobody has claimed', async () => {
    // Dispatched-but-unclaimed (runner never started): there is no session
    // yet, so there is no takeover command to find - the claim assignee,
    // not the dispatch label, is what says a session exists (#2783).
    const issuesAndPullRequests = vi.fn().mockImplementation(({ q }) => {
      if (!TARGET_Q(q)) return emptySearchPage();
      return Promise.resolve({
        data: {
          total_count: 1,
          items: [makeItem(44, { labels: ['claude'], comments: 3 })],
        },
      });
    });
    const listComments = vi.fn().mockResolvedValue({ data: [] });
    setupOctokit({ issuesAndPullRequests, listComments });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([44]);
    expect(result.items[0].takeoverCommand).toBeUndefined();
    expect(listComments).not.toHaveBeenCalled();
  });

  it('derives human-needed from jclaw-bot + jlapenna assignees even without the label (#2802)', async () => {
    const ISSUE_Q = (q: string) =>
      q.includes('assignee:jclaw-bot') && q.includes('is:issue');
    const issuesAndPullRequests = vi.fn().mockImplementation(({ q }) => {
      if (!ISSUE_Q(q)) return emptySearchPage();
      return Promise.resolve({
        data: {
          total_count: 1,
          items: [
            makeItem(50, {
              assignees: [{ login: 'jclaw-bot' }, { login: 'jlapenna' }],
              comments: 1,
            }),
          ],
        },
      });
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
    setupOctokit({ issuesAndPullRequests, listComments });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([50]);
    expect(result.items[0].actionTypes).toContain('human-needed');
  });

  it('does not derive human-needed from jclaw-bot alone (no maintainer assignee, no label)', async () => {
    const ISSUE_Q = (q: string) =>
      q.includes('assignee:jclaw-bot') && q.includes('is:issue');
    const issuesAndPullRequests = vi.fn().mockImplementation(({ q }) => {
      if (!ISSUE_Q(q)) return emptySearchPage();
      return Promise.resolve({
        data: {
          total_count: 1,
          items: [
            makeItem(51, {
              assignees: [{ login: 'jclaw-bot' }],
              comments: 0,
            }),
          ],
        },
      });
    });
    setupOctokit({ issuesAndPullRequests });

    const result = await getActionItems();

    expect(result.items.map((i) => i.number)).toEqual([51]);
    expect(result.items[0].actionTypes).not.toContain('human-needed');
  });
});
