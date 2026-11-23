import type {
  CliSessionDoc,
  IssueAgentSessionDoc,
} from '@agent-lcars/telemetry';
import { listSessionDocsByRunIds } from '@agent-lcars/telemetry/server';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import { getRunnerSessionsByRunId } from './runner-sessions';

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

  it('keeps the most recently active of several sessions for one run', async () => {
    (listSessionDocsByRunIds as Mock).mockResolvedValue([
      makeIssueAgentDoc({
        sessionId: 'newest',
        runId: '7',
        lastActivityAt: '2026-11-22T16:59:17.056Z',
      }),
      makeIssueAgentDoc({
        sessionId: 'oldest',
        runId: '7',
        lastActivityAt: '2026-11-22T16:55:33.816Z',
      }),
      makeIssueAgentDoc({
        sessionId: 'middle',
        runId: '7',
        lastActivityAt: '2026-11-22T16:57:39.054Z',
      }),
    ]);

    const { sessionsByRunId } = await getRunnerSessionsByRunId(runs('7'));

    expect(sessionsByRunId.get('7')?.sessionId).toBe('newest');
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
