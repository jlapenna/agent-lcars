import type { CliSessionDoc } from '@repo/agent-telemetry';
import { listSessionDocs } from '@repo/agent-telemetry/server';

import { getCliSessions } from './cli-sessions';
import { getGithubClient } from './github-client';

jest.mock('@repo/agent-telemetry/server', () => ({
  getAgentTelemetryReaderFirestore: jest.fn(),
  listSessionDocs: jest.fn(),
}));

jest.mock('./github-client', () => ({
  getGithubClient: jest.fn(),
  REPO_OWNER: 'supersprinklesracing',
  REPO_NAME: 'members',
}));

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
    host: 'joes-workstation',
    branch: 'feat/agent-console-cli-sessions',
    ...overrides,
  };
}

function mockSearch(items: unknown[] = []) {
  const searchMock = jest.fn().mockResolvedValue({ data: { items } });
  (getGithubClient as jest.Mock).mockReturnValue({
    rest: { search: { issuesAndPullRequests: searchMock } },
  });
  return searchMock;
}

describe('getCliSessions', () => {
  afterEach(() => jest.resetAllMocks());

  it('passes a lastActivityAt cutoff to the store instead of listing everything', async () => {
    (listSessionDocs as jest.Mock).mockResolvedValue([]);
    mockSearch();

    await getCliSessions();

    expect(listSessionDocs).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ activeSince: expect.any(String) }),
    );
    const { activeSince } = (listSessionDocs as jest.Mock).mock.calls[0][1];
    const cutoffAgeHours =
      (Date.now() - new Date(activeSince).getTime()) / (60 * 60 * 1000);
    expect(cutoffAgeHours).toBeCloseTo(24, 1);
  });

  it('joins an active session branch to an open PR when one exists', async () => {
    (listSessionDocs as jest.Mock).mockResolvedValue([makeCliDoc()]);
    const searchMock = mockSearch([
      { number: 2600, html_url: 'https://github.com/o/r/pull/2600' },
    ]);

    const { sessions, warnings } = await getCliSessions();

    expect(warnings).toEqual([]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: 'session-1',
      liveness: 'live',
      host: 'joes-workstation',
      branch: 'feat/agent-console-cli-sessions',
      turns: 3,
      totalTokens: 1200,
      pr: { number: 2600, url: 'https://github.com/o/r/pull/2600' },
    });
    expect(searchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        q: expect.stringContaining('head:feat/agent-console-cli-sessions'),
      }),
    );
  });

  it('uses the transcript-recorded PR without a GitHub search when present', async () => {
    (listSessionDocs as jest.Mock).mockResolvedValue([
      makeCliDoc({ deliverables: { prNumbers: [2650, 2662], commitShas: [] } }),
    ]);
    const searchMock = mockSearch();

    const { sessions } = await getCliSessions();

    expect(sessions[0].pr).toEqual({
      number: 2662,
      url: 'https://github.com/supersprinklesracing/members/pull/2662',
    });
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('never searches for ended sessions, even with a branch', async () => {
    (listSessionDocs as jest.Mock).mockResolvedValue([
      makeCliDoc({ liveness: 'ended', lastActivityAt: minutesAgo(120) }),
    ]);
    const searchMock = mockSearch();

    const { sessions } = await getCliSessions();

    expect(sessions[0].liveness).toBe('ended');
    expect(sessions[0].pr).toBeUndefined();
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('searches a shared branch once and warns once when the lookup fails', async () => {
    (listSessionDocs as jest.Mock).mockResolvedValue([
      makeCliDoc({ sessionId: 'session-1' }),
      makeCliDoc({ sessionId: 'session-2', lastActivityAt: minutesAgo(2) }),
    ]);
    const searchMock = jest.fn().mockRejectedValue(new Error('502'));
    (getGithubClient as jest.Mock).mockReturnValue({
      rest: { search: { issuesAndPullRequests: searchMock } },
    });

    const { sessions, warnings } = await getCliSessions();

    expect(sessions).toHaveLength(2);
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([
      'PR lookup failed for branch "feat/agent-console-cli-sessions".',
    ]);
  });

  it('recomputes liveness from activity recency instead of trusting the stored value', async () => {
    (listSessionDocs as jest.Mock).mockResolvedValue([
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
    mockSearch();

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
    (listSessionDocs as jest.Mock).mockResolvedValue(docs);
    mockSearch();

    const { sessions } = await getCliSessions();

    expect(sessions).toHaveLength(20);
    expect(sessions.map((s) => s.sessionId)).toContain('live-tail');
  });

  it('passes through discovered artifacts', async () => {
    (listSessionDocs as jest.Mock).mockResolvedValue([
      makeCliDoc({ artifacts: ['report.md', 'chart.png'] }),
    ]);
    mockSearch();

    const { sessions } = await getCliSessions();
    expect(sessions[0].artifacts).toEqual(['report.md', 'chart.png']);
  });

  it('filters out non-CLI session docs', async () => {
    (listSessionDocs as jest.Mock).mockResolvedValue([
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
    mockSearch();

    const { sessions } = await getCliSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('session-1');
  });

  it('degrades to an empty list with a warning when the store fails', async () => {
    (listSessionDocs as jest.Mock).mockRejectedValue(new Error('boom'));

    const { sessions, warnings } = await getCliSessions();
    expect(sessions).toEqual([]);
    expect(warnings).toEqual([
      'CLI sessions unavailable (agent-telemetry store failed).',
    ]);
  });
});
