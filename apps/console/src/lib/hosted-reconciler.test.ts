import {
  AuthorityStateMissingError,
  TaskLeaseBusyError,
} from '@agent-lcars/dispatch-controller/storage/authority';
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

  it('defers a candidate with a live authority lease without failing the scan', async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        id: 20,
        number: 20,
        title: 'Already reconciling',
        body: '',
        labels: ['agent:codex'],
        created_at: '2026-08-07T00:00:00.000Z',
        updated_at: '2026-08-08T00:00:00.000Z',
        state: 'open',
      },
    });
    const octokit = {
      rest: {
        issues: { listForRepo: vi.fn(), get },
      },
    } as unknown as Octokit;
    processHostedControllerEvent.mockRejectedValueOnce(
      new TaskLeaseBusyError(
        {
          repository: 'jlapenna/agent-lcars',
          repositoryId: 1_307_149_765,
          issue: 20,
        },
        {
          owner: 'webhook:delivery-1',
          acquiredAt: '2026-08-08T12:00:00.000Z',
          expiresAt: '2026-08-08T12:02:00.000Z',
        },
      ),
    );
    const transport = createOctokitReconcileTransport(octokit, identity);

    await expect(
      transport.dispatchReconcile('jlapenna/agent-lcars', 20),
    ).resolves.toBeUndefined();
  });

  it.each([true, false])(
    'quarantines a closed pre-cutover fleet task with no dispatch label (compatibilityQuiescent=%s)',
    async (compatibilityQuiescent) => {
      const get = vi.fn().mockResolvedValue({
        data: {
          id: 20,
          number: 20,
          title: 'Retired legacy task',
          body: '',
          labels: [{ name: 'status:needs-human' }],
          created_at: '2026-08-07T00:00:00.000Z',
          updated_at: '2026-08-08T00:00:00.000Z',
          state: 'closed',
        },
      });
      const octokit = {
        rest: {
          issues: { listForRepo: vi.fn(), get },
        },
      } as unknown as Octokit;
      processHostedControllerEvent.mockRejectedValueOnce(
        new AuthorityStateMissingError(
          {
            repository: 'jlapenna/agent-lcars',
            repositoryId: 1_307_149_765,
            issue: 20,
          },
          compatibilityQuiescent,
        ),
      );
      const transport = createOctokitReconcileTransport(
        octokit,
        identity,
        '2026-08-08T12:00:00.000Z',
        'request-1',
        '2026-08-08T00:00:00.000Z',
      );

      await expect(
        transport.dispatchReconcile('jlapenna/agent-lcars', 20),
      ).resolves.toBeUndefined();
    },
  );

  it.each([
    {
      name: 'an open pre-cutover task',
      state: 'open',
      labels: [] as { name: string }[],
      createdAt: '2026-08-07T00:00:00.000Z',
      epoch: '2026-08-08T00:00:00.000Z',
      compatibilityQuiescent: true,
    },
    {
      name: 'a closed pre-cutover task with dispatch intent',
      state: 'closed',
      labels: [{ name: 'agent:codex' }],
      createdAt: '2026-08-07T00:00:00.000Z',
      epoch: '2026-08-08T00:00:00.000Z',
      compatibilityQuiescent: true,
    },
    {
      name: 'a closed post-cutover task',
      state: 'closed',
      labels: [] as { name: string }[],
      createdAt: '2026-08-09T00:00:00.000Z',
      epoch: '2026-08-08T00:00:00.000Z',
      compatibilityQuiescent: true,
    },
    {
      name: 'a closed task with an invalid cutover epoch',
      state: 'closed',
      labels: [] as { name: string }[],
      createdAt: '2026-08-07T00:00:00.000Z',
      epoch: 'not-a-timestamp',
      compatibilityQuiescent: true,
    },
  ])('keeps failing closed for $name', async (scenario) => {
    const get = vi.fn().mockResolvedValue({
      data: {
        id: 20,
        number: 20,
        title: 'Authority gap remains actionable',
        body: '',
        labels: scenario.labels,
        created_at: scenario.createdAt,
        updated_at: '2026-08-08T00:00:00.000Z',
        state: scenario.state,
      },
    });
    const octokit = {
      rest: {
        issues: { listForRepo: vi.fn(), get },
      },
    } as unknown as Octokit;
    const gap = new AuthorityStateMissingError(
      {
        repository: 'jlapenna/agent-lcars',
        repositoryId: 1_307_149_765,
        issue: 20,
      },
      scenario.compatibilityQuiescent,
    );
    processHostedControllerEvent.mockRejectedValueOnce(gap);
    const transport = createOctokitReconcileTransport(
      octokit,
      identity,
      '2026-08-08T12:00:00.000Z',
      'request-1',
      scenario.epoch,
    );

    await expect(
      transport.dispatchReconcile('jlapenna/agent-lcars', 20),
    ).rejects.toBe(gap);
  });
});
