import { describe, expect, it } from 'vitest';

import {
  githubAnchorProjectionAnchorsFromDelivery,
  githubAnchorProjectionDeletionFromDelivery,
  githubAnchorProjectionFromDelivery,
} from './github-anchor-projection';

const REPO = 'jlapenna/agent-lcars';
const T0 = '2026-08-30T12:00:00.000Z';

function completeIssue() {
  return {
    repository: { full_name: REPO },
    issue: {
      number: 42,
      title: 'Anchor',
      body: 'Body',
      html_url: `https://github.com/${REPO}/issues/42`,
      state: 'open',
      updated_at: T0,
      user: { login: 'jlapenna' },
      labels: [],
      assignees: [],
    },
  };
}

describe('githubAnchorProjectionFromDelivery', () => {
  it('projects complete configured anchors', () => {
    expect(
      githubAnchorProjectionFromDelivery({
        event: 'issues',
        payload: completeIssue(),
        observedAt: T0,
      }),
    ).toMatchObject({ anchor: { repo: REPO, issue: 42 }, title: 'Anchor' });
  });

  it('returns only anchor invalidations for partial webhook events', () => {
    const cases = [
      {
        event: 'issue_comment',
        payload: {
          action: 'deleted',
          repository: { full_name: REPO },
          issue: { number: 42 },
        },
      },
      {
        event: 'check_run',
        payload: {
          repository: { full_name: REPO },
          check_run: { pull_requests: [{ number: 42 }] },
        },
      },
      {
        event: 'pull_request_review_thread',
        payload: {
          repository: { full_name: REPO },
          pull_request: { number: 42 },
          thread: { id: 'PRRT_1', is_resolved: true },
        },
      },
    ];
    for (const input of cases) {
      expect(githubAnchorProjectionAnchorsFromDelivery(input)).toEqual([
        { repo: REPO, issue: 42 },
      ]);
    }
  });

  it('rejects invalid or unwatched webhook payloads', () => {
    expect(
      githubAnchorProjectionAnchorsFromDelivery({
        event: 'check_run',
        payload: {
          repository: { full_name: 'other/repo' },
          check_run: { pull_requests: [{ number: 42 }] },
        },
      }),
    ).toEqual([]);
    expect(
      githubAnchorProjectionFromDelivery({
        event: 'issues',
        payload: { repository: { full_name: REPO } },
        observedAt: T0,
      }),
    ).toBeUndefined();
  });

  it('recognizes a configured deleted issue as a tombstone rather than a fetch', () => {
    expect(
      githubAnchorProjectionDeletionFromDelivery({
        event: 'issues',
        payload: {
          action: 'deleted',
          repository: { full_name: REPO },
          issue: { number: 42 },
        },
      }),
    ).toEqual({ repo: REPO, issue: 42 });
  });
});
