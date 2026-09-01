import { describe, expect, it } from 'vitest';

import {
  matchingAgentPipelines,
  matchingReplyPipelines,
  selectedAgentPipeline,
  selectedReplyPipeline,
  supportedAgentLabels,
  supportedAgentPipelines,
  taskRefKey,
  taskRefUrl,
  type WatchedRepo,
} from './watched-repo';

const standardRepo: WatchedRepo = { owner: 'example', name: 'standard' };

describe('watched repository agent capabilities', () => {
  it('uses standard integrations when agents is omitted', () => {
    expect(supportedAgentPipelines(standardRepo)).toEqual([
      'claude',
      'codex',
      'opencode',
    ]);
    expect(supportedAgentLabels(standardRepo)).toEqual([
      'agent:claude',
      'agent:codex',
      'agent:opencode',
    ]);
    expect(selectedAgentPipeline(standardRepo, ['agent:codex'])).toBe('codex');
  });

  it('declares no dispatch integrations with agents false', () => {
    const repo = { ...standardRepo, agents: false };
    expect(supportedAgentPipelines(repo)).toEqual([]);
    expect(selectedAgentPipeline(repo, ['agent:claude'])).toBeUndefined();
    expect(
      selectedReplyPipeline(repo, ['review:claude'], 'pr'),
    ).toBeUndefined();
  });

  it('does not accept repository-specific integration overrides', () => {
    const repo: WatchedRepo = { ...standardRepo, agents: false };
    expect(supportedAgentLabels(repo)).toEqual([]);
    expect(selectedAgentPipeline(repo, ['agent:custom-codex'])).toBeUndefined();
  });

  it('does not invent precedence for contradictory agent labels', () => {
    expect(
      selectedAgentPipeline(standardRepo, ['agent:claude', 'agent:opencode']),
    ).toBeUndefined();
  });

  it('resolves one canonical reply assignment from either label family', () => {
    expect(selectedReplyPipeline(standardRepo, ['review:codex'], 'pr')).toBe(
      'codex',
    );
    expect(
      selectedReplyPipeline(standardRepo, ['review:codex'], 'issue'),
    ).toBeUndefined();
    // A PR can carry both mode labels for its one executor without making
    // Reply choose between two pipelines.
    expect(
      selectedReplyPipeline(
        standardRepo,
        ['agent:claude', 'review:claude'],
        'pr',
      ),
    ).toBe('claude');
  });

  it('withholds a reply target when canonical label families select different pipelines', () => {
    const labels = ['agent:claude', 'review:opencode'];
    expect(matchingReplyPipelines(standardRepo, labels, 'pr')).toEqual([
      'claude',
      'opencode',
    ]);
    expect(selectedReplyPipeline(standardRepo, labels, 'pr')).toBeUndefined();
  });

  it('lets callers tell zero matches apart from contradictory multi-agent state', () => {
    // Both collapse to `undefined` in selectedAgentPipeline, but a caller
    // deciding whether a first-assignment action applies needs to know
    // which case it is (#859 review).
    expect(matchingAgentPipelines(standardRepo, ['type:bug'])).toEqual([]);
    expect(
      matchingAgentPipelines(standardRepo, ['agent:claude', 'agent:opencode']),
    ).toEqual(['claude', 'opencode']);
    expect(matchingAgentPipelines(standardRepo, ['agent:codex'])).toEqual([
      'codex',
    ]);
  });
});

describe('TaskRef', () => {
  const task = {
    repository: { owner: 'example', name: 'console' },
    issueNumber: 42,
  };

  it('uses the repository and issue number as its canonical identity', () => {
    expect(taskRefKey(task)).toBe('example/console#42');
    expect(taskRefUrl(task)).toBe(
      'https://github.com/example/console/issues/42',
    );
  });
});
