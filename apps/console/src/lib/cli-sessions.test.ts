import type { CliSessionDoc } from '@agent-lcars/telemetry';
import { listSessionDocs } from '@agent-lcars/telemetry/server';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import { getCliSessions, MAX_SESSIONS } from './cli-sessions';

vi.mock('@agent-lcars/telemetry/server', () => ({
  getAgentTelemetryReaderFirestore: vi.fn(),
  listSessionDocs: vi.fn(),
}));

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60 * 1000).toISOString();

function makeCliDoc(overrides: Partial<CliSessionDoc> = {}): CliSessionDoc {
  return {
    sessionId: 'session-1',
    source: 'cli',
    agent: 'claude-code',
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

describe('getCliSessions', () => {
  afterEach(() => vi.resetAllMocks());

  it('passes a lastActivityAt cutoff to the store instead of listing everything', async () => {
    (listSessionDocs as Mock).mockResolvedValue([]);

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

  it('does not infer a PR from any active session branch', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({ sessionId: 'session-a', branch: 'feat/alpha' }),
      makeCliDoc({
        sessionId: 'session-b',
        repo: undefined,
        branch: 'feat/repo-less',
        lastActivityAt: minutesAgo(2),
      }),
    ]);

    const { sessions, warnings } = await getCliSessions();

    expect(sessions.map((session) => session.pr)).toEqual([
      undefined,
      undefined,
    ]);
    expect(warnings).toEqual([]);
  });

  it('uses the transcript-recorded PR when its repository is recorded', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({ deliverables: { prNumbers: [2650, 2662], commitShas: [] } }),
    ]);

    const { sessions } = await getCliSessions();

    expect(sessions[0].pr).toEqual({
      number: 2662,
      url: 'https://github.com/supersprinklesracing/sprinkles/pull/2662',
    });
  });

  it('does not fabricate a deliverable PR link for a legacy repo-less session', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({
        repo: undefined,
        branch: undefined,
        deliverables: { prNumbers: [270], commitShas: [] },
      }),
    ]);

    const { sessions } = await getCliSessions();

    expect(sessions[0].pr).toBeUndefined();
  });

  it('uses the persisted explicit agent', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({ sessionId: 'claude-session', agent: 'claude-code' }),
      makeCliDoc({ sessionId: 'opencode-session', agent: 'opencode' }),
    ]);

    const { sessions } = await getCliSessions();

    expect(
      sessions.find((session) => session.sessionId === 'claude-session')?.agent,
    ).toBe('claude-code');
    expect(
      sessions.find((session) => session.sessionId === 'opencode-session')
        ?.agent,
    ).toBe('opencode');
  });

  it('keeps liveness independent of a transcript-recorded PR', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({
        liveness: 'idle',
        lastActivityAt: minutesAgo(42),
        deliverables: { prNumbers: [2843], commitShas: [] },
      }),
      makeCliDoc({
        sessionId: 'ended',
        liveness: 'ended',
        lastActivityAt: minutesAgo(120),
        deliverables: { prNumbers: [2843], commitShas: [] },
      }),
    ]);

    const { sessions } = await getCliSessions();

    expect(
      sessions.find((session) => session.sessionId === 'session-1')?.liveness,
    ).toBe('idle');
    expect(
      sessions.find((session) => session.sessionId === 'ended')?.liveness,
    ).toBe('ended');
  });

  it('recomputes liveness from activity recency instead of trusting stored liveness', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({ sessionId: 'mislabeled', liveness: 'ended' }),
      makeCliDoc({
        sessionId: 'frozen',
        liveness: 'live',
        lastActivityAt: minutesAgo(120),
      }),
    ]);

    const { sessions } = await getCliSessions();
    const byId = new Map(
      sessions.map((session) => [session.sessionId, session.liveness]),
    );
    expect(byId.get('mislabeled')).toBe('live');
    expect(byId.get('frozen')).toBe('ended');
  });

  it('caps the list while keeping active sessions ahead of ended ones', async () => {
    const docs = [
      ...Array.from({ length: MAX_SESSIONS + 5 }, (_, index) =>
        makeCliDoc({
          sessionId: `ended-${index}`,
          liveness: 'ended',
          lastActivityAt: minutesAgo(61 + index),
        }),
      ),
      makeCliDoc({ sessionId: 'live-tail', lastActivityAt: minutesAgo(2) }),
    ];
    (listSessionDocs as Mock).mockResolvedValue(docs);

    const { sessions } = await getCliSessions();

    expect(sessions).toHaveLength(MAX_SESSIONS);
    expect(sessions.map((session) => session.sessionId)).toContain('live-tail');
  });

  it('passes through status, artifacts, and cost-weighted tokens', async () => {
    const statusUpdatedAt = minutesAgo(40);
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc({
        status: 'waiting on CI for #1247',
        statusUpdatedAt,
        artifacts: ['report.md', 'chart.png'],
        tokens: {
          inputTokens: 1000,
          outputTokens: 200,
          cacheCreationTokens: 300,
          cacheReadTokens: 50_000,
        },
      }),
    ]);

    const { sessions } = await getCliSessions();

    expect(sessions[0]).toMatchObject({
      status: 'waiting on CI for #1247',
      statusUpdatedAt,
      artifacts: ['report.md', 'chart.png'],
      totalTokens: 6575,
    });
  });

  it('filters non-CLI sessions and degrades cleanly when the store fails', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc(),
      makeCliDoc({
        sessionId: 'runner-1',
        source: 'issue-agent',
        liveness: 'ended',
      }),
    ]);
    expect((await getCliSessions()).sessions).toHaveLength(1);

    (listSessionDocs as Mock).mockRejectedValue(new Error('boom'));
    await expect(getCliSessions()).resolves.toEqual({
      sessions: [],
      warnings: ['CLI sessions unavailable (agent-telemetry store failed).'],
    });
  });
});
