import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

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
// eslint-disable-next-line no-restricted-syntax -- imported dynamically so it evaluates AFTER the vi.mock factories above; a static import would bind the unmocked module.
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

/** A schema-safe stand-in for `@agent-lcars/orchestrator`'s own
 * `{repo}#{issue}/r{generation}` runId format: `[A-Za-z0-9._:-]+` is the
 * *marker's* own intentId character class (`libs/dispatch-contracts/src/
 * marker.ts`'s `DISPATCH_MARKER_RE`), which a real runId's `/`/`#`
 * characters cannot satisfy - orchestrator-dispatch.ts currently passes the
 * real runId verbatim as `broker_intent_id`. The marker parser was widened
 * in #1187, so this fixture exercises the production-reachable join with an
 * id the marker regex can parse. */
function orchestratorRun(
  overrides: Partial<{
    runId: string;
    state: 'pending' | 'running' | 'finished' | 'canceled' | 'lost';
    pipeline: string;
    result: { ok: boolean; ref?: string; summary?: string };
    leaseExpiresAt: string;
    events: {
      at: string;
      to: 'pending' | 'running' | 'finished' | 'canceled' | 'lost';
      by: 'request' | 'dispatch' | 'report' | 'operator' | 'expiry';
      note?: string;
    }[];
  }> = {},
) {
  return {
    runId: 'intent-abc',
    task: { repo: 'supersprinklesracing/sprinkles', issue: 42 },
    state: 'running',
    pipeline: 'claude',
    requestId: 'req-1',
    leaseExpiresAt: '2026-07-07T02:00:00Z',
    events: [{ at: '2026-07-07T00:00:00Z', to: 'pending', by: 'request' }],
    createdAt: '2026-07-07T00:00:00Z',
    updatedAt: '2026-07-07T00:00:00Z',
    ...overrides,
  };
}

function useAuthoritativeState(
  runs: ReturnType<typeof orchestratorRun>[],
  overrides: {
    activeRunId?: string;
    storageRevision?: number;
    spec?: {
      title: string;
      description: string;
      pipeline: 'claude' | 'codex' | 'opencode';
      target: { repo: string };
    };
  } = {},
) {
  authoritativeResult = {
    states: new Map([
      [
        'supersprinklesracing/sprinkles#42',
        {
          schema: 'agent-lcars.authoritative-task-state/v2' as const,
          task: { repo: 'supersprinklesracing/sprinkles', issue: 42 },
          storageRevision: overrides.storageRevision ?? 7,
          updatedAt: '2026-07-07T00:00:00Z',
          ...(overrides.activeRunId === undefined
            ? {}
            : { activeRunId: overrides.activeRunId }),
          runs,
          ...(overrides.spec === undefined ? {} : { spec: overrides.spec }),
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

  it('renders an open task with no attempts (idle)', async () => {
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

  it('uses the board action classifier so task controls match the queue', async () => {
    const issuesGet = vi
      .fn()
      .mockResolvedValue(
        issueResponse({ labels: ['status:needs-human', 'agent:codex'] }),
      );
    setupOctokit({ issuesGet });
    cachedActivity = EMPTY_ACTIVITY;

    const result = await getTaskDetail(
      DEFAULT_REPO.owner,
      DEFAULT_REPO.name,
      42,
    );

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.item.actionTypes).toEqual(['needs-human']);
    expect(result.item.labels).toContain('agent:codex');
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
      // eslint-disable-next-line no-restricted-syntax -- imported dynamically so it evaluates AFTER the vi.mock factories above; a static import would bind the unmocked module.
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

  it('uses authoritative state from the orchestrator over the attempts-only fallback', async () => {
    useAuthoritativeState([orchestratorRun({ state: 'running' })], {
      activeRunId: 'intent-abc',
    });
    const issuesGet = vi
      .fn()
      .mockResolvedValue(issueResponse({ labels: ['agent:claude'] }));
    setupOctokit({ issuesGet });
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
    expect(result.work.attempts[0].attribution).toBe('orchestrator');
    expect(result.work.state).toBe('active');
  });

  it("exposes the task's own orchestrator run history verbatim as `runs`, for the native runs view (#1015)", async () => {
    const lostRun = orchestratorRun({
      runId: 'run-lost',
      state: 'lost',
      events: [
        { at: '2026-07-07T00:00:00Z', to: 'pending', by: 'request' },
        { at: '2026-07-07T00:05:00Z', to: 'running', by: 'dispatch' },
        {
          at: '2026-07-07T02:05:00Z',
          to: 'lost',
          by: 'expiry',
          note: 'lease expired with no report; auto-retry 1/3',
        },
      ],
    });
    const finishedRun = orchestratorRun({
      runId: 'run-finished',
      state: 'finished',
      result: {
        ok: true,
        ref: 'https://github.com/supersprinklesracing/sprinkles/pull/77',
      },
    });
    const livePendingRun = orchestratorRun({
      runId: 'run-live',
      state: 'pending',
      leaseExpiresAt: '2026-07-07T05:00:00Z',
    });
    useAuthoritativeState([lostRun, finishedRun, livePendingRun], {
      activeRunId: 'run-live',
    });
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
    expect(result.runs).toEqual([lostRun, finishedRun, livePendingRun]);
  });

  it('exposes an empty `runs` array for a task with no authoritative state, so the page falls back to legacy attempts', async () => {
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
    expect(result.runs).toEqual([]);
  });

  it('reports a closed task as merged only for its attempt-persisted PR number', async () => {
    useAuthoritativeState([
      orchestratorRun({
        state: 'finished',
        result: {
          ok: true,
          ref: 'https://github.com/supersprinklesracing/sprinkles/pull/77',
        },
      }),
    ]);
    const issuesGet = vi
      .fn()
      .mockResolvedValue(issueResponse({ state: 'closed' }));
    const graphql = vi.fn().mockResolvedValue({
      repository: {
        i42: {
          __typename: 'Issue',
          comments: { nodes: [] },
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
  });

  it("threads the authoritative state's work.spec snapshot onto the result", async () => {
    useAuthoritativeState([], {
      spec: {
        title: 'Snapshot title',
        description: 'Snapshot body',
        pipeline: 'claude',
        target: { repo: 'supersprinklesracing/sprinkles' },
      },
    });
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
    expect(result.spec).toEqual({
      title: 'Snapshot title',
      description: 'Snapshot body',
      pipeline: 'claude',
      target: { repo: 'supersprinklesracing/sprinkles' },
    });
  });

  it('omits spec when there is no authoritative state for the task', async () => {
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
    expect(result.spec).toBeUndefined();
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
    // Distinguishes "rejected at resolveWatchedRepo" (correct) from
    // "silently case-normalized, then 404'd from GitHub" (would produce the
    // same status but means the exact-match guard was bypassed).
    expect(issuesGet).not.toHaveBeenCalled();
  });
});
