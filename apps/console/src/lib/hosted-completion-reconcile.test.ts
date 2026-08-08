import type { Octokit } from '@octokit/rest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { processHostedControllerEvent } = vi.hoisted(() => ({
  processHostedControllerEvent: vi.fn(),
}));

vi.mock('./hosted-controller', () => ({ processHostedControllerEvent }));

import {
  CompletionRunNotTerminalError,
  enqueueCompletionReconcile,
  reconcileCompletedWorker,
} from './hosted-completion-reconcile';
import type { WebhookTaskQueue } from './hosted-webhook-queue';

const payload = {
  repository: 'jlapenna/agent-lcars',
  repositoryId: 1_307_149_765,
  issue: 736,
  workerRunId: 93_099_054_125,
};

function octokit(status = 'completed'): Octokit {
  return {
    rest: {
      actions: {
        getWorkflowRun: vi.fn().mockResolvedValue({ data: { status } }),
      },
      issues: {
        get: vi.fn().mockResolvedValue({
          data: {
            id: 736,
            number: 736,
            title: 'Hosted broker',
            body: '',
            labels: ['agent:codex'],
            created_at: '2026-08-08T00:00:00.000Z',
            updated_at: '2026-08-08T00:00:00.000Z',
            state: 'open',
          },
        }),
      },
    },
  } as unknown as Octokit;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AGENT_LCARS_CONTROL_PLANE_REPOSITORY', 'jlapenna/agent-lcars');
  vi.stubEnv('AGENT_LCARS_ADMIN_GITHUB_LOGIN', 'jlapenna');
  processHostedControllerEvent.mockResolvedValue(undefined);
});

describe('hosted completion reconciliation', () => {
  it('queues a named signed task shortly after the callback', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const queue: WebhookTaskQueue = { enqueue };

    await expect(
      enqueueCompletionReconcile(payload, queue, {
        now: '2026-08-08T12:00:00.000Z',
        baseUrl: 'https://console.example.test/',
        secret: 'test-secret',
      }),
    ).resolves.toBe('enqueued');

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'completion-reconcile-93099054125-736',
        url: 'https://console.example.test/api/control-plane/completion/reconcile',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'x-agent-lcars-signature-256': expect.stringMatching(/^sha256=/u),
        }),
        body: Buffer.from(JSON.stringify(payload)),
        scheduleTime: { seconds: 1_786_190_405 },
      }),
    );
  });

  it('treats an existing named task as a durable duplicate', async () => {
    const queue: WebhookTaskQueue = {
      enqueue: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error(), { code: 6 })),
    };
    await expect(
      enqueueCompletionReconcile(payload, queue, {
        baseUrl: 'https://console.example.test',
        secret: 'test-secret',
      }),
    ).resolves.toBe('duplicate');
  });

  it('retries before controller mutation while the source run is active', async () => {
    await expect(
      reconcileCompletedWorker(payload, octokit('in_progress')),
    ).rejects.toBeInstanceOf(CompletionRunNotTerminalError);
    expect(processHostedControllerEvent).not.toHaveBeenCalled();
  });

  it('runs one exact reconcile after the source worker is terminal', async () => {
    await expect(
      reconcileCompletedWorker(
        payload,
        octokit(),
        '2026-08-08T12:00:10.000Z',
        'task-1',
      ),
    ).resolves.toEqual({ issue: 736, workerRunId: 93_099_054_125 });

    expect(processHostedControllerEvent).toHaveBeenCalledWith({
      normalized: expect.objectContaining({
        kind: 'reconcile',
        task: {
          issue: 736,
          repository: 'jlapenna/agent-lcars',
          repositoryId: 1_307_149_765,
        },
      }),
      isPullRequest: false,
      transportRunId: 93_099_054_125,
      authorityOwner: 'completion-reconcile:93099054125:task-1',
    });
  });
});
