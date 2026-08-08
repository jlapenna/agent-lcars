import type { Octokit } from '@octokit/rest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { processHostedControllerEvent } = vi.hoisted(() => ({
  processHostedControllerEvent: vi.fn(),
}));

vi.mock('./hosted-controller', () => ({ processHostedControllerEvent }));

import { createOctokitReconcileTransport } from './hosted-reconciler';

const identity = {
  repository: 'jlapenna/agent-lcars',
  repositoryId: 1_307_149_765,
  runId: 93_099_054_125,
};

beforeEach(() => {
  vi.clearAllMocks();
  processHostedControllerEvent.mockResolvedValue(undefined);
});

describe('hosted reconciler GitHub transport', () => {
  it('maps bounded discovery queries and processes candidates directly', async () => {
    const listForRepo = vi.fn().mockResolvedValue({
      data: [{ number: 10 }, { number: 20 }],
    });
    const get = vi.fn().mockResolvedValue({
      data: {
        id: 20,
        number: 20,
        title: 'Reconcile me',
        body: '',
        labels: ['agent:codex'],
        created_at: '2026-08-07T00:00:00.000Z',
        updated_at: '2026-08-08T00:00:00.000Z',
        state: 'closed',
        pull_request: {},
      },
    });
    const octokit = {
      rest: {
        issues: { listForRepo, get },
      },
    } as unknown as Octokit;
    const transport = createOctokitReconcileTransport(
      octokit,
      identity,
      '2026-08-08T12:00:00.000Z',
      'request-1',
    );

    await expect(
      transport.listIssues({
        repository: 'jlapenna/agent-lcars',
        state: 'closed',
        label: 'agent:codex',
        assignee: 'jclaw-bot',
        since: '2026-08-07T00:00:00.000Z',
        page: 2,
        perPage: 100,
      }),
    ).resolves.toEqual([{ number: 10 }, { number: 20 }]);
    expect(listForRepo).toHaveBeenCalledWith({
      owner: 'jlapenna',
      repo: 'agent-lcars',
      state: 'closed',
      labels: 'agent:codex',
      assignee: 'jclaw-bot',
      since: '2026-08-07T00:00:00.000Z',
      page: 2,
      per_page: 100,
    });

    await transport.dispatchReconcile('jlapenna/agent-lcars', 20);
    expect(get).toHaveBeenCalledWith({
      owner: 'jlapenna',
      repo: 'agent-lcars',
      issue_number: 20,
    });
    expect(processHostedControllerEvent).toHaveBeenCalledWith({
      normalized: {
        kind: 'reconcile',
        task: {
          repository: 'jlapenna/agent-lcars',
          repositoryId: 1_307_149_765,
          issue: 20,
        },
        issueClosed: true,
      },
      isPullRequest: true,
      transportRunId: 93_099_054_125,
      authorityOwner: 'reconcile:93099054125:20:request-1',
      authorityBusyWaitMs: 0,
    });
  });

  it('rejects a malformed repository before making a GitHub request', async () => {
    const octokit = {
      rest: {
        issues: { listForRepo: vi.fn(), get: vi.fn() },
      },
    } as unknown as Octokit;
    const transport = createOctokitReconcileTransport(octokit, identity);
    await expect(
      transport.dispatchReconcile('not-a-repository', 1),
    ).rejects.toThrow('Invalid GitHub repository');
  });
});
