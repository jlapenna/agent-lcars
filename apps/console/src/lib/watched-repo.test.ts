import { describe, expect, it } from 'vitest';

import {
  selectedAgentPipeline,
  supportedAgentLabels,
  supportedAgentPipelines,
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

  it('declares no dispatch integrations with an empty agents map', () => {
    const repo = { ...standardRepo, agents: {} };
    expect(supportedAgentPipelines(repo)).toEqual([]);
    expect(selectedAgentPipeline(repo, ['agent:claude'])).toBeUndefined();
  });

  it('honors a repository integration label', () => {
    const repo: WatchedRepo = {
      ...standardRepo,
      agents: {
        codex: {
          workflowFile: 'route-codex.yml',
          label: 'agent:custom-codex',
          replyTrigger: '/custom-codex',
        },
      },
    };
    expect(supportedAgentLabels(repo)).toEqual(['agent:custom-codex']);
    expect(selectedAgentPipeline(repo, ['agent:custom-codex'])).toBe('codex');
  });

  it('does not invent precedence for contradictory agent labels', () => {
    expect(
      selectedAgentPipeline(standardRepo, ['agent:claude', 'agent:opencode']),
    ).toBeUndefined();
  });
});
