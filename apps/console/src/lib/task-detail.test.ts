import { describe, expect, it, type Mock, vi } from 'vitest';

import { LEDGER_MARKER } from './dispatch-ledger';
import { getGithubClient, getWatchedRepos } from './github-client';

const DEFAULT_REPO = { owner: 'supersprinklesracing', name: 'sprinkles' };

// `getCachedTaskSource` (task-detail.ts) is a real `"use cache"` function
// exercised directly by these tests (unlike `getCachedAgentActivity`,
// mocked away below) - `cacheTag`/`cacheLife` throw outside a build with
// `cacheComponents` actually enabled, which this Vite/Vitest run isn't.
// Same no-op pattern as actions.test.ts's `next/cache` mock.
vi.mock('next/cache', () => ({
  cacheTag: vi.fn(),
  cacheLife: vi.fn(),
}));

vi.mock('./github-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./github-client')>();
  return {
    ...actual,
    getGithubClient: vi.fn(),
    getWatchedRepos: vi.fn(() => [DEFAULT_REPO]),
  };
});

const EMPTY_ACTIVITY = {
  liveRuns: [],
  liveRunAttempts: [],
  recentRuns: [],
  fleet: { online: 0, busy: 0 },
  warnings: [],
};

let cachedActivity = EMPTY_ACTIVITY;
vi.mock('./dashboard-data', () => ({
  DASHBOARD_CACHE_LIFE: { stale: 30, revalidate: 30, expire: 60 },
  getCachedAgentActivity: vi.fn(async () => ({
    data: cachedActivity,
    fetchedAt: '2026-07-07T00:00:00Z',
  })),
  // Pure - reimplemented rather than pulling in the real dashboard-data.ts
  // (which would drag in its own transitive imports); mirrors its actual
  // body exactly (see dashboard-data.ts's own definition).
  oldestFetchedAt: (...fetchedAt: string[]) =>
    [...fetchedAt].sort()[0] ?? new Date().toISOString(),
}));

// Imported after the mocks above so it picks up the mocked modules.
const { getTaskDetail } = await import('./task-detail');

function setupOctokit({
  issuesGet,
  graphql,
}: {
  issuesGet: Mock;
  graphql?: Mock;
}) {
  (getGithubClient as Mock).mockReturnValue({
    rest: { issues: { get: issuesGet } },
    graphql: graphql ?? vi.fn().mockResolvedValue({ repository: {} }),
  });
}

function issueResponse(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      number: 42,
      title: 'Fix the thing',
      html_url: 'https://github.com/supersprinklesracing/sprinkles/issues/42',
      state: 'open',
      labels: [],
      ...overrides,
    },
  };
}

function ledgerJson(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'agent-lcars.dispatch-ledger/v1',
    revision: 1,
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

describe('getTaskDetail', () => {
  it('returns not-found for a repo the console does not watch', async () => {
    const result = await getTaskDetail('someone-else', 'other-repo', 1);
    expect(result.status).toBe('not-found');
  });

  it('returns not-found when GitHub 404s the issue', async () => {
    const issuesGet = vi.fn().mockRejectedValue({ status: 404 });
    setupOctokit({ issuesGet });
    cachedActivity = EMPTY_ACTIVITY;

    const result = await getTaskDetail(
      DEFAULT_REPO.owner,
      DEFAULT_REPO.name,
      42,
    );
    expect(result.status).toBe('not-found');
  });

  it('degrades to an error status (not a throw) when the GitHub read fails', async () => {
    const issuesGet = vi.fn().mockRejectedValue(new Error('500 boom'));
    setupOctokit({ issuesGet });
    cachedActivity = EMPTY_ACTIVITY;

    const result = await getTaskDetail(
      DEFAULT_REPO.owner,
      DEFAULT_REPO.name,
      42,
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.warning).toMatch(/unavailable/);
  });

  it('renders an open task with no ledger and no attempts (idle)', async () => {
    const issuesGet = vi.fn().mockResolvedValue(issueResponse());
    setupOctokit({ issuesGet });
    cachedActivity = EMPTY_ACTIVITY;

    const result = await getTaskDetail(
      DEFAULT_REPO.owner,
      DEFAULT_REPO.name,
      42,
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.anchorState).toBe('open');
    expect(result.work.title).toBe('Fix the thing');
    expect(result.work.provenance).toEqual({ kind: 'legacy' });
    expect(result.work.attempts).toEqual([]);
  });

  it('reports generatedAt as the older of the two cached sources it was built from, not the render time (Codex review on #375)', async () => {
    const issuesGet = vi.fn().mockResolvedValue(issueResponse());
    setupOctokit({ issuesGet });
    // Fixed well in the past - `getCachedTaskSource`'s own `fetchedAt` is a
    // real `new Date().toISOString()` captured at call time, so it will
    // always be newer than this. `oldestFetchedAt` must pick this older one,
    // proving the result reflects the cache's real age rather than a bare
    // `new Date()` at render time (which is what the pre-fix behavior
    // amounted to - see task-detail.ts's own doc comment on `generatedAt`).
    const OLD_ACTIVITY_FETCH = '2020-01-01T00:00:00Z';
    vi.mocked(
      (await import('./dashboard-data')).getCachedAgentActivity,
    ).mockResolvedValueOnce({
      data: EMPTY_ACTIVITY,
      fetchedAt: OLD_ACTIVITY_FETCH,
    });

    const result = await getTaskDetail(
      DEFAULT_REPO.owner,
      DEFAULT_REPO.name,
      42,
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.generatedAt).toBe(OLD_ACTIVITY_FETCH);
  });

  it('reports anchorState closed for a closed issue while still resolving the task', async () => {
    const issuesGet = vi
      .fn()
      .mockResolvedValue(issueResponse({ state: 'closed' }));
    setupOctokit({ issuesGet });
    cachedActivity = EMPTY_ACTIVITY;

    const result = await getTaskDetail(
      DEFAULT_REPO.owner,
      DEFAULT_REPO.name,
      42,
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.anchorState).toBe('closed');
  });

  it('joins the pinned ledger comment and cached agent-activity attempts into one LogicalWork', async () => {
    const issuesGet = vi
      .fn()
      .mockResolvedValue(issueResponse({ labels: ['agent:claude'] }));
    const graphql = vi.fn().mockResolvedValue({
      repository: {
        i42: {
          __typename: 'Issue',
          comments: {
            nodes: [
              {
                body: `${LEDGER_MARKER}\n\`\`\`json\n${JSON.stringify(ledgerJson())}\n\`\`\``,
                url: 'https://x/1',
                author: { login: 'agent-lcars[bot]' },
              },
            ],
          },
        },
      },
    });
    setupOctokit({ issuesGet, graphql });
    cachedActivity = {
      ...EMPTY_ACTIVITY,
      liveRuns: [
        {
          id: 1,
          repo: DEFAULT_REPO,
          pipeline: 'claude',
          status: 'running',
          event: 'workflow_dispatch',
          url: 'https://github.com/o/r/actions/runs/1',
          displayTitle: '#42: Claude issue agent [dispatch:g1:intent-abc]',
          issueNumber: 42,
          createdAt: '2026-07-07T00:00:00Z',
          updatedAt: '2026-07-07T00:00:00Z',
          elapsedSeconds: 60,
        },
      ],
      liveRunAttempts: undefined,
    };

    const result = await getTaskDetail(
      DEFAULT_REPO.owner,
      DEFAULT_REPO.name,
      42,
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.work.provenance).toEqual({ kind: 'ledger-v1', revision: 1 });
    expect(result.work.attempts).toHaveLength(1);
    expect(result.work.attempts[0].attribution).toBe('ledger');
    expect(result.work.intents).toHaveLength(1);
    expect(result.work.state).toBe('active');
  });

  it('resolves the watched repo for a supported owner/repo pair regardless of casing in the URL params', async () => {
    // getWatchedRepos itself is exact-match (see resolveWatchedRepo); this
    // just proves getTaskDetail doesn't add its own normalization layer
    // that could silently misattribute a task.
    (getWatchedRepos as Mock).mockReturnValueOnce([DEFAULT_REPO]);
    const issuesGet = vi.fn().mockRejectedValue({ status: 404 });
    setupOctokit({ issuesGet });
    cachedActivity = EMPTY_ACTIVITY;

    const result = await getTaskDetail('Supersprinklesracing', 'sprinkles', 42);
    expect(result.status).toBe('not-found');
  });
});
