import type { Octokit } from '@octokit/rest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { CompletionBindingError, processHostedControllerEvent } = vi.hoisted(
  () => ({
    CompletionBindingError: class CompletionBindingError extends Error {},
    processHostedControllerEvent: vi.fn(),
  }),
);

vi.mock('./hosted-controller', () => ({ processHostedControllerEvent }));
vi.mock('@agent-lcars/dispatch-controller/main', () => ({
  CompletionBindingError,
}));

import type { CompletionOidcIdentity } from './github-actions-oidc';
import {
  completeHostedWorker,
  HostedCompletionInputError,
} from './hosted-completion';

const identity: CompletionOidcIdentity = {
  repository: 'jlapenna/agent-lcars',
  repositoryId: 1_307_149_765,
  runId: 93_099_054_125,
  workflow: 'codex.yml',
};

function octokitForIssue(pullRequest = false): Octokit {
  return {
    rest: {
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
            ...(pullRequest ? { pull_request: {} } : {}),
          },
        }),
      },
    },
  } as unknown as Octokit;
}

beforeEach(() => {
  vi.clearAllMocks();
  processHostedControllerEvent.mockResolvedValue(undefined);
});

describe('hosted worker completion', () => {
  it('derives run and repository identity from OIDC before processing', async () => {
    await expect(
      completeHostedWorker({
        identity,
        body: {
          issue: 736,
          generation: 2,
          intentId: 'intent:abc123',
          token: 'abcdefghijklmnop',
          workflow: 'codex.yml',
          workerRunId: 1,
          outcome: 'pull-request',
          outcomeReference: { kind: 'pull-request', number: 776 },
        },
        octokit: octokitForIssue(),
        now: '2026-08-08T12:00:00.000Z',
        invocationId: 'request-1',
      }),
    ).resolves.toEqual({
      issue: 736,
      workerRunId: 93_099_054_125,
      workflow: 'codex.yml',
    });
    expect(processHostedControllerEvent).toHaveBeenCalledWith({
      normalized: expect.objectContaining({
        kind: 'completion',
        workerRunId: 93_099_054_125,
        transportRunId: 93_099_054_125,
        workflow: 'codex.yml',
        outcome: 'pull-request',
        outcomeReference: { kind: 'pull-request', number: 776 },
      }),
      isPullRequest: false,
      transportRunId: 93_099_054_125,
      authorityOwner: 'completion:93099054125:request-1',
      pollCompletionUntilTerminal: false,
    });
  });

  it('rejects a body workflow that does not match the signed workflow', async () => {
    const octokit = octokitForIssue();
    await expect(
      completeHostedWorker({
        identity,
        body: {
          issue: 736,
          generation: 2,
          intentId: 'intent:abc123',
          token: 'abcdefghijklmnop',
          workflow: 'claude.yml',
        },
        octokit,
      }),
    ).rejects.toThrow(HostedCompletionInputError);
    expect(octokit.rest.issues.get).not.toHaveBeenCalled();
    expect(processHostedControllerEvent).not.toHaveBeenCalled();
  });

  it('rejects malformed binding fields before controller mutation', async () => {
    await expect(
      completeHostedWorker({
        identity,
        body: {
          issue: 736,
          generation: 0,
          intentId: 'intent:abc123',
          token: 'short',
          workflow: 'codex.yml',
        },
        octokit: octokitForIssue(),
      }),
    ).rejects.toThrow('invalid binding fields');
    expect(processHostedControllerEvent).not.toHaveBeenCalled();
  });

  it('rejects malformed outcome evidence before controller mutation', async () => {
    await expect(
      completeHostedWorker({
        identity,
        body: {
          issue: 736,
          generation: 2,
          intentId: 'intent:abc123',
          token: 'abcdefghijklmnop',
          workflow: 'codex.yml',
          outcome: 'pull-request',
          outcomeReference: { kind: 'pull-request', number: 0 },
        },
        octokit: octokitForIssue(),
      }),
    ).rejects.toThrow('invalid binding fields');
    expect(processHostedControllerEvent).not.toHaveBeenCalled();
  });

  it('maps an authoritative binding mismatch to a non-retryable input error', async () => {
    processHostedControllerEvent.mockRejectedValueOnce(
      new CompletionBindingError(
        'Completion callback does not match the bound worker run',
      ),
    );

    await expect(
      completeHostedWorker({
        identity,
        body: {
          issue: 736,
          generation: 2,
          intentId: 'intent:stale',
          token: 'abcdefghijklmnop',
          workflow: 'codex.yml',
        },
        octokit: octokitForIssue(),
      }),
    ).rejects.toThrow(HostedCompletionInputError);
  });

  it('passes the live pull-request shape to the shared controller', async () => {
    await completeHostedWorker({
      identity,
      body: {
        issue: 736,
        generation: 2,
        intentId: 'intent:abc123',
        token: 'abcdefghijklmnop',
        workflow: 'codex.yml',
      },
      octokit: octokitForIssue(true),
    });
    expect(processHostedControllerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ isPullRequest: true }),
    );
  });
});
