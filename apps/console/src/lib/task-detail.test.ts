import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

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
  recentRuns: [],
  fleet: { online: 0, busy: 0 },
  warnings: [],
};

let cachedActivity = EMPTY_ACTIVITY;
let authoritativeResult = {
  states: new Map(),
  unavailableTaskKeys: new Set<string>(),
  warnings: [] as string[],
};
vi.mock('./authoritative-task-state', () => ({
  readAuthoritativeTaskStates: vi.fn(async () => authoritativeResult),
}));
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

beforeEach(() => {
  authoritativeResult = {
    states: new Map(),
    unavailableTaskKeys: new Set<string>(),
    warnings: [],
  };
});

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
      body: `Original task body\n\n<!-- agent-lcars:quick-task-request:v1 id=11111111-1111-4111-8111-111111111111 digest=${'a'.repeat(64)} -->`,
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
    task: {
      repositoryId: 1001,
      repository: 'supersprinklesracing/sprinkles',
      issue: 42,
    },
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

function useAuthoritativeState(controllerState: ReturnType<typeof ledgerJson>) {
  authoritativeResult = {
    states: new Map([
      [
        'supersprinklesracing/sprinkles#42',
        {
          schema: 'agent-lcars.authoritative-task-state/v1' as const,
          task: controllerState.task,
          storageRevision: 7,
          updatedAt: '2026-07-07T00:00:00Z',
          controllerState,
        },
      ],
    ]),
    unavailableTaskKeys: new Set<string>(),
    warnings: [],
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
    expect(result.item.body).toBe('Original task body');
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

  it('uses authoritative state when the compatibility comment diverges', async () => {
    useAuthoritativeState(ledgerJson());
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
                body: `${LEDGER_MARKER}\n\`\`\`json\n${JSON.stringify(
                  ledgerJson({ generations: [] }),
                )}\n\`\`\``,
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
    };

    const result = await getTaskDetail(
      DEFAULT_REPO.owner,
      DEFAULT_REPO.name,
      42,
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.work.provenance).toEqual({
      kind: 'authoritative-v1',
      revision: 7,
    });
    expect(result.work.attempts).toHaveLength(1);
    expect(result.work.attempts[0].attribution).toBe('ledger');
    expect(result.work.intents).toHaveLength(1);
    expect(result.work.state).toBe('active');
  });

  it('reports a closed task as merged only for its attempt-persisted PR number', async () => {
    const completedLedger = ledgerJson({
      control: { closed: true },
      generations: [
        {
          generation: 1,
          intentId: 'intent-abc',
          sourceId: 'src-1',
          occurredAt: '2026-07-07T00:00:00Z',
          pipeline: 'claude',
          state: 'completed',
          attempt: {
            runId: 1,
            outcome: 'pull-request',
            outcomeReference: { kind: 'pull-request', number: 77 },
          },
        },
      ],
    });
    useAuthoritativeState(completedLedger);
    const issuesGet = vi
      .fn()
      .mockResolvedValue(issueResponse({ state: 'closed' }));
    const graphql = vi.fn().mockResolvedValue({
      repository: {
        i42: {
          __typename: 'Issue',
          comments: {
            nodes: [
              {
                body: `${LEDGER_MARKER}\n\`\`\`json\n${JSON.stringify(completedLedger)}\n\`\`\``,
                url: 'https://x/1',
              },
            ],
          },
          closedByPullRequestsReferences: {
            nodes: [
              {
                number: 77,
                url: 'https://github.com/supersprinklesracing/sprinkles/pull/77',
                mergedAt: '2026-07-07T01:00:00Z',
              },
            ],
          },
        },
      },
    });
    setupOctokit({ issuesGet, graphql });
    cachedActivity = {
      ...EMPTY_ACTIVITY,
      recentRuns: [
        {
          id: 1,
          repo: DEFAULT_REPO,
          pipeline: 'claude',
          status: 'completed',
          conclusion: 'success',
          event: 'workflow_dispatch',
          url: 'https://github.com/o/r/actions/runs/1',
          displayTitle: '#42: Claude issue agent [dispatch:g1:intent-abc]',
          issueNumber: 42,
          createdAt: '2026-07-07T00:00:00Z',
          updatedAt: '2026-07-07T01:00:00Z',
          elapsedSeconds: 3600,
        },
      ],
    };

    const result = await getTaskDetail(
      DEFAULT_REPO.owner,
      DEFAULT_REPO.name,
      42,
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.work.attempts[0].outcome).toBe('merged-deliverable');
    expect(result.work.intents[0].outcome).toBe('merged-deliverable');
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
