import { getActionItems, isDeployWaitOnly } from './action-items';
import { getGithubClient } from './github-client';

jest.mock('./github-client', () => ({
  getGithubClient: jest.fn(),
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
    comments: 0,
    ...overrides,
  };
}

// Every call site targets exactly one of the 8 expanded SEARCH_QUERIES via
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

describe('getActionItems', () => {
  const TARGET_Q = (q: string) =>
    q.includes('label:claude') && q.includes('is:issue');

  function setupOctokit({
    issuesAndPullRequests,
    listComments = jest.fn().mockResolvedValue({ data: [] }),
    pullsGet = jest.fn(),
    checksListForRef = jest.fn(),
  }: {
    issuesAndPullRequests: jest.Mock;
    listComments?: jest.Mock;
    pullsGet?: jest.Mock;
    checksListForRef?: jest.Mock;
  }) {
    (getGithubClient as jest.Mock).mockReturnValue({
      rest: {
        search: { issuesAndPullRequests },
        issues: { listComments },
        pulls: { get: pullsGet },
        checks: { listForRef: checksListForRef },
      },
    });
  }

  it('paginates a query across multiple pages and collects every item', async () => {
    const issuesAndPullRequests = jest
      .fn()
      .mockImplementation(({ q, page }) => {
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
    const issuesAndPullRequests = jest
      .fn()
      .mockImplementation(({ q, page }) => {
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
    const issuesAndPullRequests = jest.fn().mockImplementation(({ q }) => {
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
    const issuesAndPullRequests = jest.fn().mockImplementation(({ q }) => {
      if (!TARGET_Q(q)) return emptySearchPage();
      return Promise.resolve({
        data: {
          total_count: 1,
          items: [makeItem(500, { pull_request: {} })],
        },
      });
    });
    const pullsGet = jest.fn().mockResolvedValue({
      data: {
        draft: false,
        mergeable_state: 'clean',
        head: { sha: 'deadbeef' },
        body: null,
        requested_reviewers: [],
      },
    });
    const checksListForRef = jest.fn().mockImplementation(({ page }) => {
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
    const issuesAndPullRequests = jest.fn().mockImplementation(({ q }) => {
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
    const pullsGet = jest.fn().mockImplementation(({ pull_number }) =>
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
    const checksListForRef = jest.fn().mockImplementation(({ ref }) =>
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
    const issuesAndPullRequests = jest.fn().mockImplementation(({ q }) => {
      if (!TARGET_Q(q)) return emptySearchPage();
      return Promise.resolve({
        data: {
          total_count: 2,
          items: [makeItem(10), makeItem(20, { pull_request: {} })],
        },
      });
    });
    const pullsGet = jest
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
});
