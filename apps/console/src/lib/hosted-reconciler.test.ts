import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import { createOctokitReconcileTransport } from './hosted-reconciler';

describe('hosted reconciler GitHub transport', () => {
  it('maps bounded discovery queries and reconcile dispatches to Octokit', async () => {
    const listForRepo = vi.fn().mockResolvedValue({
      data: [{ number: 10 }, { number: 20 }],
    });
    const createWorkflowDispatch = vi.fn().mockResolvedValue({});
    const octokit = {
      rest: {
        issues: { listForRepo },
        actions: { createWorkflowDispatch },
      },
    } as unknown as Octokit;
    const transport = createOctokitReconcileTransport(octokit);

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
    expect(createWorkflowDispatch).toHaveBeenCalledWith({
      owner: 'jlapenna',
      repo: 'agent-lcars',
      workflow_id: 'agent-router.yml',
      ref: 'main',
      inputs: { kind: 'reconcile', issue: '20' },
    });
  });

  it('rejects a malformed repository before making a GitHub request', async () => {
    const octokit = {
      rest: {
        issues: { listForRepo: vi.fn() },
        actions: { createWorkflowDispatch: vi.fn() },
      },
    } as unknown as Octokit;
    const transport = createOctokitReconcileTransport(octokit);
    await expect(
      transport.dispatchReconcile('not-a-repository', 1),
    ).rejects.toThrow('Invalid GitHub repository');
  });
});
