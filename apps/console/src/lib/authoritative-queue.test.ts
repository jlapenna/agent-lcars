import { describe, expect, it, vi } from 'vitest';

import { getAuthoritativeQueueItems } from './authoritative-queue';

const { getWatchedRepos, listOpenGithubAnchorProjections } = vi.hoisted(() => ({
  listOpenGithubAnchorProjections: vi.fn(),
  getWatchedRepos: vi.fn(() => [{ owner: 'jlapenna', name: 'agent-lcars' }]),
}));

vi.mock('./orchestrator-runtime', () => ({
  createOrchestratorRuntime: () => ({
    store: { listOpenGithubAnchorProjections },
  }),
}));

vi.mock('./github-client', () => ({ getWatchedRepos }));

describe('getAuthoritativeQueueItems', () => {
  it('renders webhook anchors from the control-plane store without a GitHub client', async () => {
    listOpenGithubAnchorProjections.mockResolvedValue([
      {
        anchor: { repo: 'jlapenna/agent-lcars', issue: 42 },
        kind: 'issue',
        state: 'open',
        title: 'Need a maintainer decision',
        body: 'Choose the cutover window.',
        url: 'https://github.com/jlapenna/agent-lcars/issues/42',
        labels: ['status:needs-human'],
        assigneeLogins: ['jlapenna'],
        sourceUpdatedAt: '2026-08-30T12:00:00.000Z',
        observedAt: '2026-08-30T12:00:01.000Z',
      },
    ]);

    await expect(getAuthoritativeQueueItems()).resolves.toEqual({
      items: [
        expect.objectContaining({
          kind: 'issue',
          number: 42,
          actionTypes: ['needs-human'],
          assigneeLogins: ['jlapenna'],
        }),
      ],
    });
    expect(listOpenGithubAnchorProjections).toHaveBeenCalledOnce();
  });

  it('preserves stored review, merge, check, thread, comment, and hierarchy signals', async () => {
    listOpenGithubAnchorProjections.mockResolvedValueOnce([
      {
        anchor: { repo: 'jlapenna/agent-lcars', issue: 43 },
        kind: 'pr',
        state: 'open',
        title: 'Preserve the durable queue semantics',
        body: 'Closes #41',
        url: 'https://github.com/jlapenna/agent-lcars/pull/43',
        labels: ['status:post-deploy-action'],
        assigneeLogins: [],
        lastComment: {
          body: 'Verify after deploy.',
          url: 'https://github.com/jlapenna/agent-lcars/issues/43#issuecomment-1',
          author: 'jlapenna',
        },
        parentNumber: 40,
        subIssues: { total: 3, completed: 2 },
        linkedIssueNumbers: [41],
        draft: false,
        mergeableState: 'blocked',
        requestedReviewerLogins: ['jlapenna'],
        checkRuns: [
          {
            id: '1',
            name: 'Verify',
            url: 'https://github.com/jlapenna/agent-lcars/runs/1',
            status: 'completed',
            conclusion: 'failure',
            updatedAt: '2026-08-30T12:00:00.000Z',
          },
        ],
        unresolvedReviewThreadCount: 2,
        sourceUpdatedAt: '2026-08-30T12:00:00.000Z',
        observedAt: '2026-08-30T12:00:01.000Z',
      },
    ]);

    await expect(getAuthoritativeQueueItems()).resolves.toEqual({
      items: [
        expect.objectContaining({
          actionTypes: expect.arrayContaining([
            'post-deploy-action',
            'review-requested',
            'run-failed',
          ]),
          lastCommentBody: 'Verify after deploy.',
          parentNumber: 40,
          subIssues: { total: 3, completed: 2 },
          linkedIssueNumbers: [41],
          failingChecks: [{ name: 'Verify', url: expect.any(String) }],
          unresolvedReviewThreadCount: 2,
        }),
      ],
    });
  });

  it('uses configured repository labels and excludes unrelated open anchors', async () => {
    getWatchedRepos.mockReturnValueOnce([
      {
        owner: 'jlapenna',
        name: 'agent-lcars',
        agents: {
          codex: {
            label: 'queue:internal-agent',
            replyTrigger: '/codex',
          },
        },
      },
    ]);
    listOpenGithubAnchorProjections.mockResolvedValueOnce([
      {
        anchor: { repo: 'jlapenna/agent-lcars', issue: 44 },
        kind: 'issue',
        state: 'open',
        title: 'Configured queue work',
        body: '',
        url: 'https://github.com/jlapenna/agent-lcars/issues/44',
        labels: ['queue:internal-agent'],
        assigneeLogins: [],
        sourceUpdatedAt: '2026-08-30T12:00:00.000Z',
        observedAt: '2026-08-30T12:00:01.000Z',
      },
      {
        anchor: { repo: 'jlapenna/agent-lcars', issue: 45 },
        kind: 'issue',
        state: 'open',
        title: 'Unrelated open anchor',
        body: '',
        url: 'https://github.com/jlapenna/agent-lcars/issues/45',
        labels: ['documentation'],
        assigneeLogins: [],
        sourceUpdatedAt: '2026-08-30T12:00:00.000Z',
        observedAt: '2026-08-30T12:00:01.000Z',
      },
      {
        anchor: { repo: 'unconfigured/repo', issue: 46 },
        kind: 'issue',
        state: 'open',
        title: 'Must not use a default selector config',
        body: '',
        url: 'https://github.com/unconfigured/repo/issues/46',
        labels: ['agent:codex'],
        assigneeLogins: [],
        sourceUpdatedAt: '2026-08-30T12:00:00.000Z',
        observedAt: '2026-08-30T12:00:01.000Z',
      },
    ]);

    await expect(getAuthoritativeQueueItems()).resolves.toEqual({
      items: [expect.objectContaining({ number: 44 })],
    });
  });
});
