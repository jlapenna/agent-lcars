import type { GithubAnchorProjection } from '@agent-lcars/orchestrator';
import { describe, expect, it } from 'vitest';

import { isSelectedGithubAnchorProjection } from './github-anchor-selector';

function projection(
  overrides: Partial<GithubAnchorProjection> = {},
): GithubAnchorProjection {
  return {
    anchor: { repo: 'jlapenna/agent-lcars', issue: 42 },
    kind: 'issue',
    state: 'open',
    title: 'Queue selector',
    body: '',
    url: 'https://github.com/jlapenna/agent-lcars/issues/42',
    labels: [],
    assigneeLogins: [],
    sourceUpdatedAt: '2026-08-30T12:00:00.000Z',
    observedAt: '2026-08-30T12:00:01.000Z',
    ...overrides,
  };
}

describe('isSelectedGithubAnchorProjection', () => {
  it.each([
    ['fleet-assigned anchor', { assigneeLogins: ['agent-lcars-bot'] }],
    ['maintainer-assigned anchor', { assigneeLogins: ['jlapenna'] }],
    ['status label', { labels: ['status:needs-human'] }],
    ['configured agent label', { labels: ['agent:codex'] }],
    ['agent-authored anchor', { author: 'agent-lcars[bot]' }],
    [
      'maintainer review request',
      {
        kind: 'pr' as const,
        requestedReviewerLogins: ['jlapenna'],
      },
    ],
  ])('selects a %s', (_reason, overrides) => {
    expect(isSelectedGithubAnchorProjection(projection(overrides))).toBe(true);
  });

  it('does not select a merely open unowned anchor', () => {
    expect(isSelectedGithubAnchorProjection(projection())).toBe(false);
  });

  it('uses a configured repository integration label', () => {
    expect(
      isSelectedGithubAnchorProjection(
        projection({ labels: ['queue:internal-agent'] }),
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
      ),
    ).toBe(true);
  });
});
