import type { CliSessionDoc } from '@agent-lcars/telemetry';
import { listSessionDocs } from '@agent-lcars/telemetry/server';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';

import { getCliSessions } from './cli-sessions';
import { getGithubClient, getWatchedRepos } from './github-client';

vi.mock('@agent-lcars/telemetry/server', () => ({
  getAgentTelemetryReaderFirestore: vi.fn(),
  listSessionDocs: vi.fn(),
}));

vi.mock('./github-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./github-client')>();
  return {
    ...actual,
    getGithubClient: vi.fn(),
    getWatchedRepos: vi.fn(),
  };
});

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60 * 1000).toISOString();

function makeCliDoc(overrides: Partial<CliSessionDoc> = {}): CliSessionDoc {
  return {
    sessionId: 'session-1',
    source: 'cli',
    liveness: 'live',
    startedAt: minutesAgo(10),
    lastActivityAt: minutesAgo(1),
    turns: 3,
    toolCallCounts: {},
    tokens: {
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    deliverables: { prNumbers: [], commitShas: [] },
    repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
    host: 'joes-workstation',
    branch: 'feat/agent-lcars-cli-sessions',
    ...overrides,
  };
}

/** The branch->PR join reads one `pulls.list` per repo and matches on
 * `head.ref` - it no longer issues a search per branch (#13). */
function mockOpenPulls(pulls: unknown[] = []) {
  const listMock = vi.fn().mockResolvedValue({ data: pulls });
  (getGithubClient as Mock).mockReturnValue({
    rest: { pulls: { list: listMock } },
  });
  return listMock;
}

function mockPullsGet(merged: boolean | Error) {
  const getMock =
    merged instanceof Error
      ? vi.fn().mockRejectedValue(merged)
      : vi.fn().mockResolvedValue({ data: { merged } });
  (getGithubClient as Mock).mockReturnValue({
    rest: {
      pulls: { get: getMock, list: vi.fn().mockResolvedValue({ data: [] }) },
    },
  });
  return getMock;
}

describe('getCliSessions', () => {
  beforeEach(() => {
    (getWatchedRepos as Mock).mockReturnValue([
      { owner: 'supersprinklesracing', name: 'sprinkles' },
    ]);
  });

  afterEach(() => vi.resetAllMocks());

  it('passes a lastActivityAt cutoff to the store instead of listing everything', async () => {
    (listSessionDocs as Mock).mockResolvedValue([]);
    mockOpenPulls();

    await getCliSessions();

    expect(listSessionDocs).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ activeSince: expect.any(String) }),
    );
    const { activeSince } = (listSessionDocs as Mock).mock.calls[0][1];
    const cutoffAgeHours =
      (Date.now() - new Date(activeSince).getTime()) / (60 * 60 * 1000);
    expect(cutoffAgeHours).toBeCloseTo(24, 1);
  });

  it('joins an active session branch to an open PR when one exists', async () => {
    (listSessionDocs as Mock).mockResolvedValue([makeCliDoc()]);
    const listMock = mockOpenPulls([
      {
        number: 2600,
        html_url: 'https://github.com/o/r/pull/2600',
        head: { ref: 'feat/agent-lcars-cli-sessions' },
      },
    ]);

    const { sessions, warnings } = await getCliSessions();

    expect(warnings).toEqual([]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: 'session-1',
      liveness: 'live',
      host: 'joes-workstation',
      branch: 'feat/agent-lcars-cli-sessions',
      turns: 3,
      totalTokens: 1200,
      pr: { number: 2600, url: 'https://github.com/o/r/pull/2600' },
    });
    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'supersprinklesracing',
        repo: 'sprinkles',
        state: 'open',
      }),
    );
  });

  it('resolves agent via sessionAgent(), defaulting to claude-code when the doc has none', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({ sessionId: 'legacy' }),
      makeCliDoc({ sessionId: 'opencode-session', agent: 'opencode' }),
    ]);
    mockOpenPulls();

    const { sessions } = await getCliSessions();

    expect(sessions.find((s) => s.sessionId === 'legacy')?.agent).toBe(
      'claude-code',
    );
    expect(
      sessions.find((s) => s.sessionId === 'opencode-session')?.agent,
    ).toBe('opencode');
  });

  it('uses the transcript-recorded PR without asking GitHub at all when present', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({ deliverables: { prNumbers: [2650, 2662], commitShas: [] } }),
    ]);
    const listMock = mockOpenPulls();

    const { sessions } = await getCliSessions();

    expect(sessions[0].pr).toEqual({
      number: 2662,
      url: 'https://github.com/supersprinklesracing/sprinkles/pull/2662',
    });
    expect(listMock).not.toHaveBeenCalled();
  });

  it('does not fabricate a deliverable PR link for a legacy repo-less session', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({
        repo: undefined,
        branch: undefined,
        deliverables: { prNumbers: [270], commitShas: [] },
      }),
    ]);
    const listMock = mockOpenPulls();

    const { sessions } = await getCliSessions();

    expect(sessions[0].pr).toBeUndefined();
    expect(listMock).not.toHaveBeenCalled();
  });

  it('resolves a repo-less active session only when its branch matches one watched repo', async () => {
    (getWatchedRepos as Mock).mockReturnValue([
      { owner: 'org-a', name: 'repo-a' },
      { owner: 'org-b', name: 'repo-b' },
    ]);
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({ repo: undefined, branch: 'fix/right-repo' }),
    ]);
    const listMock = vi
      .fn()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [
          {
            number: 272,
            html_url: 'https://github.com/org-b/repo-b/pull/272',
            head: { ref: 'fix/right-repo' },
          },
        ],
      });
    (getGithubClient as Mock).mockReturnValue({
      rest: { pulls: { list: listMock } },
    });

    const { sessions } = await getCliSessions();

    expect(sessions[0].pr).toEqual({
      number: 272,
      url: 'https://github.com/org-b/repo-b/pull/272',
    });
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it('does not guess when a repo-less branch exists in multiple watched repos', async () => {
    (getWatchedRepos as Mock).mockReturnValue([
      { owner: 'org-a', name: 'repo-a' },
      { owner: 'org-b', name: 'repo-b' },
    ]);
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({ repo: undefined, branch: 'fix/shared-name' }),
    ]);
    const listMock = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            number: 11,
            html_url: 'https://github.com/org-a/repo-a/pull/11',
            head: { ref: 'fix/shared-name' },
          },
        ],
      })
      .mockResolvedValueOnce({
        data: [
          {
            number: 22,
            html_url: 'https://github.com/org-b/repo-b/pull/22',
            head: { ref: 'fix/shared-name' },
          },
        ],
      });
    (getGithubClient as Mock).mockReturnValue({
      rest: { pulls: { list: listMock } },
    });

    const { sessions } = await getCliSessions();

    expect(sessions[0].pr).toBeUndefined();
  });

  it('keeps an idle running session visible when a recorded PR has merged', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({
        liveness: 'idle',
        lastActivityAt: minutesAgo(42),
        deliverables: { prNumbers: [2843], commitShas: [] },
      }),
    ]);
    const getMock = mockPullsGet(true);

    const { sessions } = await getCliSessions();

    expect(sessions[0].liveness).toBe('idle');
    expect(sessions[0].pr).toEqual({
      number: 2843,
      url: 'https://github.com/supersprinklesracing/sprinkles/pull/2843',
    });
    expect(getMock).not.toHaveBeenCalled();
  });

  it('keeps a live session visible when an earlier transcript-recorded PR has merged', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({
        liveness: 'live',
        lastActivityAt: minutesAgo(1),
        deliverables: { prNumbers: [2843], commitShas: [] },
      }),
    ]);
    const getMock = mockPullsGet(true);

    const { sessions } = await getCliSessions();

    expect(sessions[0].liveness).toBe('live');
    expect(sessions[0].pr).toEqual({
      number: 2843,
      url: 'https://github.com/supersprinklesracing/sprinkles/pull/2843',
    });
    expect(getMock).not.toHaveBeenCalled();
  });

  it('keeps liveness as-is when the transcript-recorded PR is still open', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({
        liveness: 'idle',
        lastActivityAt: minutesAgo(20),
        deliverables: { prNumbers: [2843], commitShas: [] },
      }),
    ]);
    mockPullsGet(false);

    const { sessions } = await getCliSessions();

    expect(sessions[0].liveness).toBe('idle');
  });

  it('never checks merge state for a finished session, even with a recorded PR', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({
        liveness: 'ended',
        lastActivityAt: minutesAgo(120),
        deliverables: { prNumbers: [2843], commitShas: [] },
      }),
    ]);
    const getMock = mockPullsGet(true);

    const { sessions } = await getCliSessions();

    expect(sessions[0].liveness).toBe('ended');
    expect(getMock).not.toHaveBeenCalled();
  });

  it('never looks up PRs for ended sessions, even with a branch', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({ liveness: 'ended', lastActivityAt: minutesAgo(120) }),
    ]);
    const listMock = mockOpenPulls();

    const { sessions } = await getCliSessions();

    expect(sessions[0].liveness).toBe('ended');
    expect(sessions[0].pr).toBeUndefined();
    expect(listMock).not.toHaveBeenCalled();
  });

  it("lists a repo's open PRs once for many sessions, and warns once when it fails", async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({ sessionId: 'session-1' }),
      makeCliDoc({ sessionId: 'session-2', lastActivityAt: minutesAgo(2) }),
    ]);
    const listMock = vi.fn().mockRejectedValue(new Error('502'));
    (getGithubClient as Mock).mockReturnValue({
      rest: { pulls: { list: listMock } },
    });

    const { sessions, warnings } = await getCliSessions();

    expect(sessions).toHaveLength(2);
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([
      'PR lookup failed for supersprinklesracing/sprinkles.',
    ]);
  });

  it('joins each session to the open PR whose head ref matches its branch', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({ sessionId: 'session-a', branch: 'feat/alpha' }),
      makeCliDoc({
        sessionId: 'session-b',
        branch: 'feat/beta',
        lastActivityAt: minutesAgo(2),
      }),
      makeCliDoc({
        sessionId: 'session-c',
        branch: 'feat/no-pr',
        lastActivityAt: minutesAgo(3),
      }),
    ]);
    const listMock = mockOpenPulls([
      {
        number: 11,
        html_url: 'https://github.com/o/r/pull/11',
        head: { ref: 'feat/alpha' },
      },
      {
        number: 22,
        html_url: 'https://github.com/o/r/pull/22',
        head: { ref: 'feat/beta' },
      },
    ]);

    const { sessions, warnings } = await getCliSessions();
    const byId = new Map(sessions.map((s) => [s.sessionId, s.pr?.number]));

    expect(byId.get('session-a')).toBe(11);
    expect(byId.get('session-b')).toBe(22);
    expect(byId.get('session-c')).toBeUndefined();
    // Three sessions across one repo still cost exactly one request.
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([]);
  });

  it('recomputes liveness from activity recency instead of trusting the stored value', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      // A live session whose watcher process check wrongly wrote 'ended'
      // (containerized sessions - the watcher cannot see their /proc).
      makeCliDoc({ sessionId: 'mislabeled', liveness: 'ended' }),
      // A stored 'live' frozen by a stopped watcher hours ago.
      makeCliDoc({
        sessionId: 'frozen',
        liveness: 'live',
        lastActivityAt: minutesAgo(120),
        branch: undefined,
      }),
    ]);
    mockOpenPulls();

    const { sessions } = await getCliSessions();
    const byId = new Map(sessions.map((s) => [s.sessionId, s.liveness]));
    expect(byId.get('mislabeled')).toBe('live');
    expect(byId.get('frozen')).toBe('ended');
  });

  it('caps the list, keeping active sessions ahead of ended ones', async () => {
    const docs = [
      // 25 ended sessions, newest first (as the store returns them)...
      ...Array.from({ length: 25 }, (_, i) =>
        makeCliDoc({
          sessionId: `ended-${i}`,
          liveness: 'ended',
          lastActivityAt: minutesAgo(61 + i),
          branch: undefined,
        }),
      ),
      // ...and one live session older than all of them.
      makeCliDoc({
        sessionId: 'live-tail',
        lastActivityAt: minutesAgo(2),
        branch: undefined,
      }),
    ];
    (listSessionDocs as Mock).mockResolvedValue(docs);
    mockOpenPulls();

    const { sessions } = await getCliSessions();

    expect(sessions).toHaveLength(20);
    expect(sessions.map((s) => s.sessionId)).toContain('live-tail');
  });

  it('passes through discovered artifacts', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({ artifacts: ['report.md', 'chart.png'] }),
    ]);
    mockOpenPulls();

    const { sessions } = await getCliSessions();
    expect(sessions[0].artifacts).toEqual(['report.md', 'chart.png']);
  });

  it('cost-weights cache-creation and cache-read tokens in totalTokens', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({
        tokens: {
          inputTokens: 1000,
          outputTokens: 200,
          cacheCreationTokens: 300,
          cacheReadTokens: 50_000,
        },
      }),
    ]);
    mockOpenPulls();

    const { sessions } = await getCliSessions();
    expect(sessions[0].totalTokens).toBe(6_575);
  });

  it('filters out non-CLI session docs', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc(),
      {
        sessionId: 'runner-1',
        source: 'issue-agent',
        liveness: 'ended',
        startedAt: minutesAgo(60),
        lastActivityAt: minutesAgo(60),
        turns: 1,
        toolCallCounts: {},
        tokens: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        deliverables: { prNumbers: [], commitShas: [] },
      },
    ]);
    mockOpenPulls();

    const { sessions } = await getCliSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('session-1');
  });

  it('degrades to an empty list with a warning when the store fails', async () => {
    (listSessionDocs as Mock).mockRejectedValue(new Error('boom'));

    const { sessions, warnings } = await getCliSessions();
    expect(sessions).toEqual([]);
    expect(warnings).toEqual([
      'CLI sessions unavailable (agent-telemetry store failed).',
    ]);
  });
});
