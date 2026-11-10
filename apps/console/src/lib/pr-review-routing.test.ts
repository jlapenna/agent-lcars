import { describe, expect, it } from 'vitest';

import {
  detectPullRequestAuthorPipeline,
  isAutomatedReviewExcludedAuthor,
  parseAttemptClaimRunId,
  selectCrossModelReviewer,
} from './pr-review-routing';

const REPO = 'jlapenna/agent-lcars';

describe('parseAttemptClaimRunId', () => {
  it('extracts the latest attempt-claim runId from a pull request body', () => {
    expect(
      parseAttemptClaimRunId(
        'Summary\n\n<!-- attempt-claim:g1:jlapenna/agent-lcars#42/r1 -->\n<!-- attempt-claim:g2:jlapenna/agent-lcars#42/r2 -->',
      ),
    ).toBe('jlapenna/agent-lcars#42/r2');
    expect(parseAttemptClaimRunId('No marker here')).toBeUndefined();
    expect(parseAttemptClaimRunId(null)).toBeUndefined();
  });
});

describe('detectPullRequestAuthorPipeline', () => {
  it('prioritizes authoritative store pipeline when available', () => {
    expect(
      detectPullRequestAuthorPipeline({
        authorPipelineFromStore: 'agy',
        userLogin: 'agent-lcars[bot]',
        labels: [{ name: 'agent:codex' }],
      }),
    ).toBe('agy');
  });

  it('uses an unambiguous agent:* label when present', () => {
    expect(
      detectPullRequestAuthorPipeline({
        labels: [{ name: 'agent:codex' }, { name: 'type:feature' }],
        userLogin: 'jlapenna',
      }),
    ).toBe('codex');
  });

  it('ignores conflicting multiple agent:* labels and falls back to login/body', () => {
    expect(
      detectPullRequestAuthorPipeline({
        labels: [{ name: 'agent:claude' }, { name: 'agent:opencode' }],
        userLogin: 'jlapenna',
      }),
    ).toBeUndefined();
  });

  it('detects claude[bot] author login', () => {
    expect(
      detectPullRequestAuthorPipeline({
        userLogin: 'claude[bot]',
      }),
    ).toBe('claude');
  });

  it('detects authoring pipeline from body trailers before shared bot login', () => {
    expect(
      detectPullRequestAuthorPipeline({
        userLogin: 'agent-lcars[bot]',
        body: 'Implemented fix.\n\nCo-Authored-By: Antigravity <noreply@google.com>',
      }),
    ).toBe('agy');
    expect(
      detectPullRequestAuthorPipeline({
        userLogin: 'jlapenna',
        body: 'Claude-Session: https://claude.ai/code/session_01ABC',
      }),
    ).toBe('claude');
    expect(
      detectPullRequestAuthorPipeline({
        userLogin: 'agent-lcars[bot]',
        body: 'Co-Authored-By: OpenCode <noreply@opencode.ai>',
      }),
    ).toBe('opencode');
  });

  it('detects the Claude Code PR description footer so Claude PRs get a Codex review', () => {
    const body =
      '## Fix\n\n- change\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nhttps://claude.ai/code/session_017WYsJhMBpSzbmYeqBJ9e7q\n';
    const author = detectPullRequestAuthorPipeline({
      userLogin: 'jlapenna',
      body,
    });
    expect(author).toBe('claude');
    expect(
      selectCrossModelReviewer({
        repo: 'jlapenna/agent-lcars',
        authorPipeline: author,
      }),
    ).toMatchObject({
      pipeline: 'codex',
      fallbackPipelines: ['agy', 'claude'],
    });
    expect(
      detectPullRequestAuthorPipeline({
        userLogin: 'jlapenna',
        body: 'Summary.\n\nhttps://claude.ai/code/session_01ABC',
      }),
    ).toBe('claude');
  });

  it('does not treat an inline Claude session link as Claude authorship', () => {
    expect(
      detectPullRequestAuthorPipeline({
        userLogin: 'jlapenna',
        body: 'Follow-up to the work in https://claude.ai/code/session_01ABC.',
      }),
    ).toBeUndefined();
  });

  it('detects authoring pipeline from head branch prefix', () => {
    expect(
      detectPullRequestAuthorPipeline({
        userLogin: 'agent-lcars[bot]',
        headRef: 'agy/fix-widget',
      }),
    ).toBe('agy');
    expect(
      detectPullRequestAuthorPipeline({
        userLogin: 'jlapenna',
        headRef: 'claude/issue-123',
      }),
    ).toBe('claude');
    expect(
      detectPullRequestAuthorPipeline({
        userLogin: 'jlapenna',
        headRef: 'codex/issue-123',
      }),
    ).toBe('codex');
  });

  it('defaults shared agent-lcars[bot] login to codex when no other marker is present', () => {
    expect(
      detectPullRequestAuthorPipeline({
        userLogin: 'agent-lcars[bot]',
      }),
    ).toBe('codex');
  });
});

describe('isAutomatedReviewExcludedAuthor', () => {
  it('excludes dependency and CI bots from automatic PR review', () => {
    expect(isAutomatedReviewExcludedAuthor('renovate[bot]')).toBe(true);
    expect(isAutomatedReviewExcludedAuthor('dependabot[bot]')).toBe(true);
    expect(isAutomatedReviewExcludedAuthor('github-actions[bot]')).toBe(true);
    expect(isAutomatedReviewExcludedAuthor('claude[bot]')).toBe(false);
    expect(isAutomatedReviewExcludedAuthor('agent-lcars[bot]')).toBe(false);
    expect(isAutomatedReviewExcludedAuthor('jlapenna')).toBe(false);
  });
});

describe('selectCrossModelReviewer', () => {
  it('routes Codex PRs to Claude, falling back to Antigravity then Codex', () => {
    expect(
      selectCrossModelReviewer({
        repo: REPO,
        authorPipeline: 'codex',
      }),
    ).toEqual({
      pipeline: 'claude',
      fallbackPipelines: ['agy', 'codex'],
      crossModelOverride: false,
    });
  });

  it('routes Claude PRs to Codex, falling back to Antigravity then Claude', () => {
    expect(
      selectCrossModelReviewer({
        repo: REPO,
        authorPipeline: 'claude',
      }),
    ).toEqual({
      pipeline: 'codex',
      fallbackPipelines: ['agy', 'claude'],
      crossModelOverride: false,
    });
  });

  it('routes Antigravity PRs to Claude with Codex quota fallback (or Codex with Claude fallback)', () => {
    expect(
      selectCrossModelReviewer({
        repo: REPO,
        authorPipeline: 'agy',
      }),
    ).toEqual({
      pipeline: 'claude',
      fallbackPipelines: ['codex', 'agy'],
      crossModelOverride: false,
    });
    expect(
      selectCrossModelReviewer({
        repo: REPO,
        authorPipeline: 'agy',
        requestedPipeline: 'codex',
      }),
    ).toEqual({
      pipeline: 'codex',
      fallbackPipelines: ['claude', 'agy'],
      crossModelOverride: false,
    });
  });

  it('redirects a same-model review label to the opposite model and sets crossModelOverride', () => {
    expect(
      selectCrossModelReviewer({
        repo: REPO,
        authorPipeline: 'codex',
        requestedPipeline: 'codex',
      }),
    ).toEqual({
      pipeline: 'claude',
      fallbackPipelines: ['agy', 'codex'],
      crossModelOverride: true,
    });
    expect(
      selectCrossModelReviewer({
        repo: REPO,
        authorPipeline: 'claude',
        requestedPipeline: 'claude',
      }),
    ).toEqual({
      pipeline: 'codex',
      fallbackPipelines: ['agy', 'claude'],
      crossModelOverride: true,
    });
  });

  it('adds the authoring model last only when the repository supports it', () => {
    expect(
      selectCrossModelReviewer({
        repo: REPO,
        authorPipeline: 'claude',
        supportedPipelines: ['codex', 'agy'],
      }),
    ).toEqual({
      pipeline: 'codex',
      fallbackPipelines: ['agy'],
      crossModelOverride: false,
    });
  });

  it('attaches Antigravity quota fallback to explicit review:* labels on human PRs', () => {
    expect(
      selectCrossModelReviewer({
        repo: REPO,
        requestedPipeline: 'codex',
      }),
    ).toEqual({
      pipeline: 'codex',
      fallbackPipelines: ['agy', 'claude'],
      crossModelOverride: false,
    });
    expect(
      selectCrossModelReviewer({
        repo: REPO,
        requestedPipeline: 'claude',
      }),
    ).toEqual({
      pipeline: 'claude',
      fallbackPipelines: ['agy', 'codex'],
      crossModelOverride: false,
    });
  });
});
