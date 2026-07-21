import type {
  CliSessionDoc,
  IssueAgentSessionDoc,
} from '@agent-lcars/telemetry';
import { listSessionDocs } from '@agent-lcars/telemetry/server';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import { getRunnerSessionsByRunId } from './runner-sessions';

vi.mock('@agent-lcars/telemetry/server', () => ({
  getAgentTelemetryReaderFirestore: vi.fn(),
  listSessionDocs: vi.fn(),
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

describe('getRunnerSessionsByRunId', () => {
  afterEach(() => vi.resetAllMocks());

  it('keys issue-agent docs by runId', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeIssueAgentDoc({ sessionId: 's1', runId: '111' }),
      makeIssueAgentDoc({ sessionId: 's2', runId: '222' }),
    ]);

    const { sessionsByRunId, warnings } = await getRunnerSessionsByRunId();

    expect(warnings).toEqual([]);
    expect(sessionsByRunId.get('111')?.sessionId).toBe('s1');
    expect(sessionsByRunId.get('222')?.sessionId).toBe('s2');
    expect(sessionsByRunId.size).toBe(2);
  });

  it('drops cli-source docs and issue-agent docs with no runId', async () => {
    (listSessionDocs as Mock).mockResolvedValue([
      makeCliDoc(),
      makeIssueAgentDoc({ sessionId: 'no-run-id', runId: undefined }),
      makeIssueAgentDoc({ sessionId: 'has-run-id', runId: '999' }),
    ]);

    const { sessionsByRunId } = await getRunnerSessionsByRunId();

    expect(sessionsByRunId.size).toBe(1);
    expect(sessionsByRunId.get('999')?.sessionId).toBe('has-run-id');
  });

  it('passes a ~24h activeSince cutoff to the store', async () => {
    (listSessionDocs as Mock).mockResolvedValue([]);

    await getRunnerSessionsByRunId();

    expect(listSessionDocs).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ activeSince: expect.any(String) }),
    );
    const { activeSince } = (listSessionDocs as Mock).mock.calls[0][1];
    const cutoffAgeHours =
      (Date.now() - new Date(activeSince).getTime()) / (60 * 60 * 1000);
    expect(cutoffAgeHours).toBeCloseTo(24, 1);
  });

  it('degrades to an empty map with a warning when the store fails, rather than throwing', async () => {
    (listSessionDocs as Mock).mockRejectedValue(new Error('boom'));

    const { sessionsByRunId, warnings } = await getRunnerSessionsByRunId();

    expect(sessionsByRunId.size).toBe(0);
    expect(warnings).toHaveLength(1);
  });
});
