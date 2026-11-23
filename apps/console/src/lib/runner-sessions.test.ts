import type {
  CliSessionDoc,
  IssueAgentSessionDoc,
} from '@agent-lcars/telemetry';
import { listSessionDocsByRunIds } from '@agent-lcars/telemetry/server';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import { getRunnerSessionsByRunId, runSession } from './runner-sessions';

vi.mock('@agent-lcars/telemetry/server', () => ({
  getAgentTelemetryReaderFirestore: vi.fn(),
  listSessionDocsByRunIds: vi.fn(),
}));

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60 * 1000).toISOString();

function makeIssueAgentDoc(
  overrides: Partial<IssueAgentSessionDoc> = {},
): IssueAgentSessionDoc {
  return {
    sessionId: 'session-1',
    source: 'issue-agent',
    liveness: 'ended',
    startedAt: minutesAgo(30),
    lastActivityAt: minutesAgo(1),
    turns: 5,
    toolCallCounts: {},
    tokens: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    deliverables: { prNumbers: [], commitShas: [] },
    runId: '12345',
    issueNumber: 42,
    ...overrides,
  };
}

function makeCliDoc(overrides: Partial<CliSessionDoc> = {}): CliSessionDoc {
  return {
    sessionId: 'cli-session-1',
    source: 'cli',
    liveness: 'live',
    startedAt: minutesAgo(10),
    lastActivityAt: minutesAgo(1),
    turns: 3,
    toolCallCounts: {},
    tokens: {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    deliverables: { prNumbers: [], commitShas: [] },
    ...overrides,
  };
}

const runs = (...ids: string[]) => ids.map((id) => ({ id }));

describe('getRunnerSessionsByRunId', () => {
  afterEach(() => vi.resetAllMocks());

  it('keys issue-agent docs by runId', async () => {
    (listSessionDocsByRunIds as Mock).mockResolvedValue([
      makeIssueAgentDoc({ sessionId: 's1', runId: '111' }),
      makeIssueAgentDoc({ sessionId: 's2', runId: '222' }),
    ]);

    const { sessionsByRunId, warnings } = await getRunnerSessionsByRunId(
      runs('111', '222'),
    );

    expect(warnings).toEqual([]);
    expect(sessionsByRunId.get('111')?.sessionId).toBe('s1');
    expect(sessionsByRunId.get('222')?.sessionId).toBe('s2');
    expect(sessionsByRunId.size).toBe(2);
  });

  it('reads only the rendered runs, by id', async () => {
    (listSessionDocsByRunIds as Mock).mockResolvedValue([]);

    await getRunnerSessionsByRunId([{ id: 'a/b#1/r1' }, { id: 42 }]);

    expect(listSessionDocsByRunIds).toHaveBeenCalledWith(undefined, [
      'a/b#1/r1',
      '42',
    ]);
  });

  it('joins a run to its root session, not a newer subagent', async () => {
    (listSessionDocsByRunIds as Mock).mockResolvedValue([
      makeIssueAgentDoc({
        sessionId: 'pascal',
        runId: '7',
        parentSessionId: 'root',
        lastActivityAt: '2026-11-22T16:59:59.000Z',
      }),
      makeIssueAgentDoc({
        sessionId: 'root',
        runId: '7',
        turns: 1,
        lastActivityAt: '2026-11-22T16:59:17.056Z',
      }),
    ]);

    const { sessionsByRunId } = await getRunnerSessionsByRunId(runs('7'));

    expect(sessionsByRunId.get('7')?.sessionId).toBe('root');
  });

  it('drops cli-source docs and issue-agent docs with no runId', async () => {
    (listSessionDocsByRunIds as Mock).mockResolvedValue([
      makeCliDoc(),
      makeIssueAgentDoc({ sessionId: 'no-run-id', runId: undefined }),
      makeIssueAgentDoc({ sessionId: 'has-run-id', runId: '999' }),
    ]);

    const { sessionsByRunId } = await getRunnerSessionsByRunId(runs('999'));

    expect(sessionsByRunId.size).toBe(1);
    expect(sessionsByRunId.get('999')?.sessionId).toBe('has-run-id');
  });

  it('degrades to an empty map with a warning when the store fails, rather than throwing', async () => {
    (listSessionDocsByRunIds as Mock).mockRejectedValue(new Error('boom'));

    const { sessionsByRunId, warnings } = await getRunnerSessionsByRunId(
      runs('1'),
    );

    expect(sessionsByRunId.size).toBe(0);
    expect(warnings).toHaveLength(1);
  });
});

describe('runSession', () => {
  const tokens = (n: number) => ({
    inputTokens: n,
    outputTokens: n,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  });

  it('adds every descendant subagent to the root session tokens', () => {
    const session = runSession([
      makeIssueAgentDoc({ sessionId: 'root', tokens: tokens(100) }),
      makeIssueAgentDoc({
        sessionId: 'child',
        parentSessionId: 'root',
        tokens: tokens(10),
      }),
      makeIssueAgentDoc({
        sessionId: 'grandchild',
        parentSessionId: 'child',
        tokens: tokens(1),
      }),
    ]);

    expect(session?.sessionId).toBe('root');
    expect(session?.tokens).toEqual(tokens(111));
    expect(session?.turns).toBe(5);
  });

  it('treats a pre-#3496 Claude subagent id as a child of its parent', () => {
    const session = runSession([
      makeIssueAgentDoc({
        sessionId: 'root--subagent--a1',
        tokens: tokens(7),
        lastActivityAt: '2026-11-22T17:00:00.000Z',
      }),
      makeIssueAgentDoc({ sessionId: 'root', tokens: tokens(3) }),
    ]);

    expect(session?.sessionId).toBe('root');
    expect(session?.tokens).toEqual(tokens(10));
  });

  it('keeps the most recently active root after a provider fallback, with only its own subagents', () => {
    const session = runSession([
      makeIssueAgentDoc({
        sessionId: 'first',
        tokens: tokens(50),
        lastActivityAt: '2026-11-22T16:00:00.000Z',
      }),
      makeIssueAgentDoc({
        sessionId: 'first-child',
        parentSessionId: 'first',
        tokens: tokens(5),
      }),
      makeIssueAgentDoc({
        sessionId: 'fallback',
        tokens: tokens(20),
        lastActivityAt: '2026-11-22T17:00:00.000Z',
      }),
    ]);

    expect(session?.sessionId).toBe('fallback');
    expect(session?.tokens).toEqual(tokens(20));
  });

  it('joins nothing when only subagent sessions were recorded', () => {
    expect(
      runSession([
        makeIssueAgentDoc({ sessionId: 'child', parentSessionId: 'root' }),
      ]),
    ).toBeUndefined();
  });
});
