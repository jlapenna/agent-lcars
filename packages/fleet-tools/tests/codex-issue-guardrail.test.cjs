// Regression coverage for the fleet issue guardrail command.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  extractIssueNumbers,
  extractIssueReferences,
  runHook,
  titleMatchesIssue,
} = require('../bin/codex-issue-guardrail.cjs');

function dependencies({
  assignees = ['agent-lcars-bot'],
  parentIssueNumber = null,
  tmuxPane = '%20',
  tmuxTitle = '642 unified guardrail',
} = {}) {
  return {
    getIssue: () => ({ assignees, parentIssueNumber }),
    getTmuxPane: () => tmuxPane,
    getTmuxTitle: () => tmuxTitle,
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

test('accepts a title for the issue, and a bare or starred root title for a sub-issue', () => {
  assert.equal(titleMatchesIssue('642 unified guardrail', 642), true);
  assert.equal(titleMatchesIssue('642 follow-up', 643, 642), true);
  assert.equal(titleMatchesIssue('642* verify follow-up', 643, 642), true);
  assert.equal(titleMatchesIssue('643 follow-up', 643, 642), false);
  assert.equal(titleMatchesIssue('641 another task', 642), false);
});

test('returns no output when the issue is claimed and tmux is titled', () => {
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

test('reports a mismatched tmux title', () => {
  const output = runHook(
    { tool_input: { command: 'gh issue edit 642 --add-label chore' } },
    dependencies({ tmuxTitle: '641 another task' }),
  );

  assert.match(
    output.hookSpecificOutput.additionalContext,
    /tmux pane %20 is not titled for issue #642/,
  );
});

test('accepts a correctly titled sub-issue session', () => {
  const output = runHook(
    { tool_input: { command: 'gh issue view 643' } },
    dependencies({ parentIssueNumber: 642, tmuxTitle: '642 follow-up' }),
  );

  assert.equal(output, null);
});

test('accepts the starred root title marker for a sub-issue', () => {
  const output = runHook(
    { tool_input: { command: 'gh issue edit 643 --add-label chore' } },
    dependencies({
      parentIssueNumber: 642,
      tmuxTitle: '642* verify follow-up',
    }),
  );

  assert.equal(output, null);
});

test('does not require tmux outside a tmux session', () => {
  // The mismatched title would be a violation inside tmux; with no pane the
  // title check must be skipped entirely, so the hook stays silent.
  const output = runHook(
    { tool_input: { command: 'gh issue edit 642 --add-label chore' } },
    dependencies({ tmuxPane: '', tmuxTitle: 'unrelated window title' }),
  );

  assert.equal(output, null);
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
        return { assignees: ['agent-lcars-bot'], parentIssueNumber: null };
      },
      getTmuxPane: () => '',
      getTmuxTitle: () => '',
    },
  );

  assert.deepEqual(seen, [[761, 'jlapenna/homelab']]);
});

test('names the repository in a cross-repo violation', () => {
  const output = runHook(
    { tool_input: { command: 'gh issue view 761 -R jlapenna/homelab' } },
    {
      getIssue: () => ({ assignees: [], parentIssueNumber: null }),
      getTmuxPane: () => '',
      getTmuxTitle: () => '',
    },
  );

  assert.match(
    output.hookSpecificOutput.additionalContext,
    /issue jlapenna\/homelab#761 is not assigned to/,
  );
});
