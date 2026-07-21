import type { CliSessionDoc } from '@agent-lcars/telemetry';
import { listSessionDocs } from '@agent-lcars/telemetry/server';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import { getCliSessions } from './cli-sessions';
import { getGithubClient } from './github-client';

vi.mock('@agent-lcars/telemetry/server', () => ({
  getAgentTelemetryReaderFirestore: vi.fn(),
  listSessionDocs: vi.fn(),
}));

vi.mock('./github-client', () => ({
  getGithubClient: vi.fn(),
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
    branch: 'feat/agent-lcars-cli-sessions',
    ...overrides,
  };
}

function mockSearch(items: unknown[] = []) {
  const searchMock = vi.fn().mockResolvedValue({ data: { items } });
  (getGithubClient as Mock).mockReturnValue({
    rest: { search: { issuesAndPullRequests: searchMock } },
  });
  return searchMock;
}

function mockPullsGet(merged: boolean | Error) {
  const getMock =
    merged instanceof Error
      ? vi.fn().mockRejectedValue(merged)
      : vi.fn().mockResolvedValue({ data: { merged } });
  (getGithubClient as Mock).mockReturnValue({
    rest: { pulls: { get: getMock } },
  });
  return getMock;
}

describe('getCliSessions', () => {
  afterEach(() => vi.resetAllMocks());

  it('passes a lastActivityAt cutoff to the store instead of listing everything', async () => {
    (listSessionDocs as Mock).mockResolvedValue([]);
    mockSearch();

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
      branch: 'feat/agent-lcars-cli-sessions',
      turns: 3,
      totalTokens: 1200,
      pr: { number: 2600, url: 'https://github.com/o/r/pull/2600' },
    });
    expect(searchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        q: expect.stringContaining('head:feat/agent-lcars-cli-sessions'),
      }),
    );
  });

  it('resolves agent via sessionAgent(), defaulting to claude-code when the doc has none', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({ sessionId: 'legacy' }),
      makeCliDoc({ sessionId: 'opencode-session', agent: 'opencode' }),
    ]);
    mockSearch();

    const { sessions } = await getCliSessions();

    expect(sessions.find((s) => s.sessionId === 'legacy')?.agent).toBe(
      'claude-code',
    );
    expect(
      sessions.find((s) => s.sessionId === 'opencode-session')?.agent,
    ).toBe('opencode');
  });

  it('uses the transcript-recorded PR without a GitHub search when present', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
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

  it('downgrades liveness to ended once a transcript-recorded PR has merged', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({
        liveness: 'idle',
        lastActivityAt: minutesAgo(42),
        deliverables: { prNumbers: [2843], commitShas: [] },
      }),
    ]);
    const getMock = mockPullsGet(true);

    const { sessions } = await getCliSessions();

    expect(sessions[0].liveness).toBe('ended');
    expect(sessions[0].pr).toEqual({
      number: 2843,
      url: 'https://github.com/supersprinklesracing/members/pull/2843',
    });
    expect(getMock).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'members',
      pull_number: 2843,
    });
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

  it('degrades gracefully and warns once when the merge check fails, without downgrading liveness', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({
        sessionId: 'session-1',
        liveness: 'idle',
        lastActivityAt: minutesAgo(20),
        deliverables: { prNumbers: [2843], commitShas: [] },
      }),
      makeCliDoc({
        sessionId: 'session-2',
        liveness: 'idle',
        lastActivityAt: minutesAgo(21),
        deliverables: { prNumbers: [2843], commitShas: [] },
      }),
    ]);
    const getMock = mockPullsGet(new Error('502'));

    const { sessions, warnings } = await getCliSessions();

    expect(sessions.map((s) => s.liveness)).toEqual(['idle', 'idle']);
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual(['PR merge check failed for #2843.']);
  });

  it('never searches for ended sessions, even with a branch', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({ liveness: 'ended', lastActivityAt: minutesAgo(120) }),
    ]);
    const searchMock = mockSearch();

    const { sessions } = await getCliSessions();

    expect(sessions[0].liveness).toBe('ended');
    expect(sessions[0].pr).toBeUndefined();
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('searches a shared branch once and warns once when the lookup fails', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({ sessionId: 'session-1' }),
      makeCliDoc({ sessionId: 'session-2', lastActivityAt: minutesAgo(2) }),
    ]);
    const searchMock = vi.fn().mockRejectedValue(new Error('502'));
    (getGithubClient as Mock).mockReturnValue({
      rest: { search: { issuesAndPullRequests: searchMock } },
    });

    const { sessions, warnings } = await getCliSessions();

    expect(sessions).toHaveLength(2);
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([
      'PR lookup failed for branch "feat/agent-lcars-cli-sessions".',
    ]);
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
    (listSessionDocs as Mock).mockResolvedValue(docs);
    mockSearch();

    const { sessions } = await getCliSessions();

    expect(sessions).toHaveLength(20);
    expect(sessions.map((s) => s.sessionId)).toContain('live-tail');
  });

  it('passes through discovered artifacts', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({ artifacts: ['report.md', 'chart.png'] }),
    ]);
    mockSearch();

    const { sessions } = await getCliSessions();
    expect(sessions[0].artifacts).toEqual(['report.md', 'chart.png']);
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
    mockSearch();

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
