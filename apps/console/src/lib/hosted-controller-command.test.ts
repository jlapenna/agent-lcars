import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getGithubClient, processHostedControllerEvent } = vi.hoisted(() => ({
  getGithubClient: vi.fn(),
  processHostedControllerEvent: vi.fn(),
}));

vi.mock('./github-client', () => ({ getGithubClient }));
vi.mock('./hosted-controller', () => ({ processHostedControllerEvent }));
vi.mock('./deployment', () => ({ maintainerLogin: () => 'jlapenna' }));

import { executeHostedControllerCommand } from './hosted-controller-command';

const repository = { owner: 'jlapenna', name: 'agent-lcars' };
const requestId = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  getGithubClient.mockReturnValue({
    rest: {
      issues: {
        get: vi.fn().mockResolvedValue({
          data: { number: 821, state: 'open', labels: ['agent:codex'] },
        }),
      },
      repos: {
        get: vi.fn().mockResolvedValue({ data: { id: 1_307_149_765 } }),
      },
    },
  });
  processHostedControllerEvent.mockResolvedValue(undefined);
});

describe('executeHostedControllerCommand', () => {
  it('keeps a retrigger request stable across retries', async () => {
    const command = {
      kind: 'retrigger' as const,
      repository,
      issueNumber: 821,
      pipeline: 'codex' as const,
      requestId,
    };

    await executeHostedControllerCommand(command);
    await executeHostedControllerCommand(command);

    expect(processHostedControllerEvent).toHaveBeenCalledTimes(2);
    const first = processHostedControllerEvent.mock.calls[0][0];
    const second = processHostedControllerEvent.mock.calls[1][0];
    expect(first.normalized).toMatchObject({
      kind: 'intent',
      intent: { sourceId: requestId, pipeline: 'codex', mode: 'implement' },
    });
    expect(second.normalized.intent).toMatchObject({
      sourceId: first.normalized.intent.sourceId,
      intentId: first.normalized.intent.intentId,
      digest: first.normalized.intent.digest,
    });
    expect(second.transportRunId).toBe(first.transportRunId);
    expect(second.authorityOwner).toBe(`console-command:${requestId}`);
  });

  it('normalizes a single-anchor reconcile without an intent generation', async () => {
    await executeHostedControllerCommand({
      kind: 'reconcile',
      repository,
      issueNumber: 821,
      requestId,
    });

    expect(processHostedControllerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        normalized: expect.objectContaining({
          kind: 'reconcile',
          issueClosed: false,
        }),
      }),
    );
  });

  it('reports controller unavailability to explicit callers', async () => {
    processHostedControllerEvent.mockRejectedValue(
      new Error('controller unavailable'),
    );

    await expect(
      executeHostedControllerCommand({
        kind: 'retrigger',
        repository,
        issueNumber: 821,
        pipeline: 'codex',
        requestId,
      }),
    ).rejects.toThrow('controller unavailable');
  });
});
