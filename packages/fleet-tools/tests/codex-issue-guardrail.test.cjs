// Regression coverage for the fleet issue guardrail command.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  extractIssueNumbers,
  extractIssueReferences,
  runHook,
} = require('../bin/codex-issue-guardrail.cjs');

function dependencies({ assignees = ['agent-lcars-bot'] } = {}) {
  return {
    getIssue: () => ({ assignees }),
  };
}

test('extracts issue numbers from view and edit commands', () => {
  assert.deepEqual(
    extractIssueNumbers(
      'gh issue edit 642 --add-assignee agent-lcars-bot && gh issue view https://github.com/jlapenna/agent-lcars/issues/643',
    ),
    [642, 643],
  );
});

test('ignores unrelated commands', () => {
  assert.deepEqual(extractIssueNumbers('git status --short'), []);
});

test('returns no output when the issue is claimed', () => {
  const output = runHook(
    { tool_input: { command: 'gh issue edit 642 --add-label chore' } },
    dependencies(),
  );

  assert.equal(output, null);
});

test('reports an unclaimed issue', () => {
  const output = runHook(
    { tool_input: { command: 'gh issue edit 642 --add-label chore' } },
    dependencies({ assignees: [] }),
  );

  assert.match(
    output.hookSpecificOutput.additionalContext,
    /issue #642 is not assigned to agent-lcars-bot/,
  );
});

test('includes the session takeover reminder in violations', () => {
  const output = runHook(
    { tool_input: { command: 'gh issue view 642' } },
    dependencies({ assignees: [] }),
  );

  assert.match(
    output.hookSpecificOutput.additionalContext,
    /post a session takeover comment/,
  );
  assert.equal('systemMessage' in output, false);
});

test('falls back to a "repository-dev" banner when projectName is absent', () => {
  // The dependencies() helper above deliberately omits projectName -- the
  // reconciled canonical behavior (adopted from homelab's variant,
  // agent-lcars#1307) must render "repository-dev", never "undefined-dev".
  const output = runHook(
    { tool_input: { command: 'gh issue view 642' } },
    dependencies({ assignees: [] }),
  );

  assert.match(
    output.hookSpecificOutput.additionalContext,
    /^repository-dev guardrail violation:/,
  );
});

test('uses the provided projectName in the violation banner', () => {
  const output = runHook(
    { tool_input: { command: 'gh issue view 642' } },
    { ...dependencies({ assignees: [] }), projectName: 'agent-lcars' },
  );

  assert.match(
    output.hookSpecificOutput.additionalContext,
    /^agent-lcars-dev guardrail violation:/,
  );
});

test('does not inspect tmux title state for a claimed issue', () => {
  const output = runHook(
    { tool_input: { command: 'gh issue edit 642 --add-label chore' } },
    {
      ...dependencies(),
      getTmuxPane: () => '%20',
      getTmuxTitle: () => {
        throw new Error('tmux title lookup must remain non-blocking');
      },
    },
  );

  assert.equal(output, null);
});

test('reports ownership violations without requiring a tmux title', () => {
  const output = runHook(
    { tool_input: { command: 'gh issue edit 642 --add-label chore' } },
    dependencies({
      assignees: [],
    }),
  );

  assert.match(
    output.hookSpecificOutput.additionalContext,
    /issue #642 is not assigned to agent-lcars-bot/,
  );
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /tmux/i);
});

// A bare issue number means "in the cwd's repository" to gh, so a cross-repo
// command must carry its own repository or the guardrail checks the wrong
// issue entirely - silently passing an unclaimed issue elsewhere, and
// flagging an unrelated local one.
test('carries the repository named by -R / --repo', () => {
  assert.deepEqual(
    extractIssueReferences('gh issue view 761 -R jlapenna/homelab'),
    [{ number: 761, repo: 'jlapenna/homelab' }],
  );
  assert.deepEqual(
    extractIssueReferences('gh issue edit 12 --repo=owner/name --add-label x'),
    [{ number: 12, repo: 'owner/name' }],
  );
});

test('uses the URL own repository, not a -R elsewhere in the segment', () => {
  assert.deepEqual(
    extractIssueReferences(
      'gh issue view https://github.com/other/repo/issues/5 -R jlapenna/homelab',
    ),
    [{ number: 5, repo: 'other/repo' }],
  );
});

test('leaves the repository unset when the command does not name one', () => {
  assert.deepEqual(extractIssueReferences('gh issue edit 642 --add-label c'), [
    { number: 642, repo: null },
  ]);
});

test('treats the same number in different repositories as distinct issues', () => {
  assert.deepEqual(
    extractIssueReferences(
      'gh issue view 761 -R jlapenna/homelab && gh issue view 761',
    ),
    [
      { number: 761, repo: 'jlapenna/homelab' },
      { number: 761, repo: null },
    ],
  );
});

test('asks gh for the named repository, not the working directory one', () => {
  const seen = [];
  runHook(
    { tool_input: { command: 'gh issue view 761 -R jlapenna/homelab' } },
    {
      getIssue: (issueNumber, repo) => {
        seen.push([issueNumber, repo]);
        return { assignees: ['agent-lcars-bot'] };
      },
    },
  );

  assert.deepEqual(seen, [[761, 'jlapenna/homelab']]);
});

test('names the repository in a cross-repo violation', () => {
  const output = runHook(
    { tool_input: { command: 'gh issue view 761 -R jlapenna/homelab' } },
    {
      getIssue: () => ({ assignees: [] }),
    },
  );

  assert.match(
    output.hookSpecificOutput.additionalContext,
    /issue jlapenna\/homelab#761 is not assigned to/,
  );
});
