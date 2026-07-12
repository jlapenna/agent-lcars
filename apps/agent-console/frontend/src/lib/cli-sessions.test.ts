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

function makeCliDoc(overrides: Partial<CliSessionDoc> = {}): CliSessionDoc {
  return {
    sessionId: 'session-1',
    source: 'cli',
    liveness: 'live',
    startedAt: '2026-07-12T00:00:00.000Z',
    lastActivityAt: '2026-07-12T00:05:00.000Z',
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

describe('getCliSessions', () => {
  afterEach(() => jest.resetAllMocks());

  it('joins a CLI session branch to an open PR when one exists', async () => {
    (listSessionDocs as jest.Mock).mockResolvedValue([makeCliDoc()]);
    const searchMock = jest.fn().mockResolvedValue({
      data: {
        items: [
          {
            number: 2600,
            title: 'feat: cli sessions',
            html_url: 'https://github.com/o/r/pull/2600',
          },
        ],
      },
    });
    (getGithubClient as jest.Mock).mockReturnValue({
      rest: { search: { issuesAndPullRequests: searchMock } },
    });

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
      pr: {
        number: 2600,
        title: 'feat: cli sessions',
        url: 'https://github.com/o/r/pull/2600',
      },
    });
    expect(searchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        q: expect.stringContaining('head:feat/agent-console-cli-sessions'),
      }),
    );
  });

  it('passes through discovered artifacts', async () => {
    (listSessionDocs as jest.Mock).mockResolvedValue([
      makeCliDoc({ artifacts: ['report.md', 'chart.png'] }),
    ]);
    (getGithubClient as jest.Mock).mockReturnValue({
      rest: {
        search: {
          issuesAndPullRequests: jest
            .fn()
            .mockResolvedValue({ data: { items: [] } }),
        },
      },
    });

    const { sessions } = await getCliSessions();
    expect(sessions[0].artifacts).toEqual(['report.md', 'chart.png']);
  });

  it('leaves pr undefined when the branch has no open PR', async () => {
    (listSessionDocs as jest.Mock).mockResolvedValue([makeCliDoc()]);
    (getGithubClient as jest.Mock).mockReturnValue({
      rest: {
        search: {
          issuesAndPullRequests: jest
            .fn()
            .mockResolvedValue({ data: { items: [] } }),
        },
      },
    });

    const { sessions } = await getCliSessions();
    expect(sessions[0].pr).toBeUndefined();
  });

  it('filters out non-CLI session docs', async () => {
    (listSessionDocs as jest.Mock).mockResolvedValue([
      makeCliDoc(),
      {
        sessionId: 'runner-1',
        source: 'issue-agent',
        liveness: 'ended',
        startedAt: '2026-07-12T00:00:00.000Z',
        lastActivityAt: '2026-07-12T00:00:00.000Z',
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
    (getGithubClient as jest.Mock).mockReturnValue({
      rest: {
        search: {
          issuesAndPullRequests: jest
            .fn()
            .mockResolvedValue({ data: { items: [] } }),
        },
      },
    });

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

  it('records a warning but keeps the session when the PR join fails', async () => {
    (listSessionDocs as jest.Mock).mockResolvedValue([makeCliDoc()]);
    (getGithubClient as jest.Mock).mockReturnValue({
      rest: {
        search: {
          issuesAndPullRequests: jest.fn().mockRejectedValue(new Error('502')),
        },
      },
    });

    const { sessions, warnings } = await getCliSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].pr).toBeUndefined();
    expect(warnings).toEqual([
      'PR lookup failed for branch "feat/agent-console-cli-sessions".',
    ]);
  });
});
