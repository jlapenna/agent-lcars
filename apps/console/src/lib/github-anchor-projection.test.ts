import { describe, expect, it } from 'vitest';

import {
  githubAnchorProjectionFromDelivery,
  githubAnchorProjectionSignalFromDelivery,
} from './github-anchor-projection';

const REPO = 'jlapenna/agent-lcars';
const OBSERVED_AT = '2026-08-30T12:00:00.000Z';

function issuePayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'labeled',
    repository: { full_name: REPO },
    issue: {
      number: 42,
      title: 'Persist the queue anchor',
      body: 'The console must not enumerate GitHub.',
      html_url: `https://github.com/${REPO}/issues/42`,
      state: 'open',
      updated_at: '2026-08-30T11:59:00.000Z',
      user: { login: 'jlapenna' },
      labels: [{ name: 'status:needs-human' }, { name: 'agent:codex' }],
      assignees: [{ login: 'agent-lcars-bot' }],
    },
    ...overrides,
  };
}

describe('githubAnchorProjectionFromDelivery', () => {
  it('persists the complete issue anchor metadata from a webhook', () => {
    expect(
      githubAnchorProjectionFromDelivery({
        event: 'issues',
        payload: issuePayload(),
        observedAt: OBSERVED_AT,
      }),
    ).toEqual({
      anchor: { repo: REPO, issue: 42 },
      kind: 'issue',
      state: 'open',
      title: 'Persist the queue anchor',
      body: 'The console must not enumerate GitHub.',
      url: `https://github.com/${REPO}/issues/42`,
      author: 'jlapenna',
      labels: ['status:needs-human', 'agent:codex'],
      assigneeLogins: ['agent-lcars-bot'],
      sourceUpdatedAt: '2026-08-30T11:59:00.000Z',
      observedAt: OBSERVED_AT,
    });
  });

  it('projects pull requests and an issue-comment anchor without another read', () => {
    const pull = githubAnchorProjectionFromDelivery({
      event: 'pull_request',
      payload: {
        repository: { full_name: REPO },
        pull_request: {
          ...issuePayload().issue,
          draft: true,
        },
      },
      observedAt: OBSERVED_AT,
    });
    const comment = githubAnchorProjectionFromDelivery({
      event: 'issue_comment',
      payload: issuePayload({
        issue: { ...issuePayload().issue, pull_request: { url: 'ignored' } },
      }),
      observedAt: OBSERVED_AT,
    });

    expect(pull).toMatchObject({ kind: 'pr', draft: true });
    expect(comment).toMatchObject({ kind: 'pr', anchor: { issue: 42 } });
  });

  it('turns a check-run webhook into a stored-PR update without queue discovery', () => {
    expect(
      githubAnchorProjectionSignalFromDelivery({
        event: 'check_run',
        payload: {
          repository: { full_name: REPO },
          check_run: {
            name: 'Verify',
            html_url: `https://github.com/${REPO}/runs/1`,
            status: 'completed',
            conclusion: 'failure',
            pull_requests: [{ number: 42 }],
          },
        },
      }),
    ).toEqual([
      {
        anchor: { repo: REPO, issue: 42 },
        checkRun: {
          name: 'Verify',
          url: `https://github.com/${REPO}/runs/1`,
          status: 'completed',
          conclusion: 'failure',
        },
      },
    ]);
  });

  it('turns a review-thread webhook into an idempotent stored-PR signal', () => {
    expect(
      githubAnchorProjectionSignalFromDelivery({
        event: 'pull_request_review_thread',
        payload: {
          repository: { full_name: REPO },
          pull_request: { number: 42 },
          thread: { id: 'PRRT_1', is_resolved: false },
        },
      }),
    ).toEqual([
      {
        anchor: { repo: REPO, issue: 42 },
        reviewThread: { id: 'PRRT_1', resolved: false },
      },
    ]);
  });

  it('does not create a projection for another repository or an incomplete payload', () => {
    expect(
      githubAnchorProjectionFromDelivery({
        event: 'issues',
        payload: issuePayload({ repository: { full_name: 'other/repo' } }),
        observedAt: OBSERVED_AT,
      }),
    ).toBeUndefined();
    expect(
      githubAnchorProjectionFromDelivery({
        event: 'issues',
        payload: { repository: { full_name: REPO }, issue: { number: 42 } },
        observedAt: OBSERVED_AT,
      }),
    ).toBeUndefined();
  });
});
