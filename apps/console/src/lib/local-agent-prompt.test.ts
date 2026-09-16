import { describe, expect, it } from 'vitest';

import {
  localAgentCommand,
  localAgentDisplayName,
  type LocalAgentPromptItem,
  localAgentPromptText,
} from './local-agent-prompt';

const issue: LocalAgentPromptItem = {
  repo: { owner: 'jlapenna', name: 'agent-lcars' },
  kind: 'issue',
  number: 1389,
  title: 'for all work items shown in the decison ibox…',
  url: 'https://github.com/jlapenna/agent-lcars/issues/1389',
};

describe('localAgentPromptText', () => {
  it('names the item and links it, distinguishing issue from PR', () => {
    expect(localAgentPromptText(issue)).toBe(
      'Take on jlapenna/agent-lcars#1389 (issue): for all work items shown in the decison ibox…\n' +
        'https://github.com/jlapenna/agent-lcars/issues/1389',
    );
    expect(localAgentPromptText({ ...issue, kind: 'pr' })).toContain('(PR):');
  });
});

describe('localAgentCommand', () => {
  it('wraps the prompt in each pipeline’s own plain interactive invocation', () => {
    expect(localAgentCommand('claude', issue)).toBe(
      `claude '${localAgentPromptText(issue)}'`,
    );
    expect(localAgentCommand('codex', issue)).toBe(
      `codex '${localAgentPromptText(issue)}'`,
    );
    expect(localAgentCommand('opencode', issue)).toBe(
      `opencode run '${localAgentPromptText(issue)}'`,
    );
  });

  it('single-quote-escapes a title containing a single quote', () => {
    const withApostrophe = { ...issue, title: "it's broken" };
    expect(localAgentCommand('claude', withApostrophe)).toBe(
      `claude 'Take on jlapenna/agent-lcars#1389 (issue): it'\\''s broken\n${issue.url}'`,
    );
  });
});

describe('localAgentDisplayName', () => {
  it('returns the human-facing pipeline name', () => {
    expect(localAgentDisplayName('claude')).toBe('Claude');
    expect(localAgentDisplayName('codex')).toBe('Codex');
    expect(localAgentDisplayName('opencode')).toBe('OpenCode');
  });
});
