/* eslint-disable no-restricted-syntax -- this is a CommonJS node:test fixture. */
const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  extractIssueNumbers,
  runHook,
  titleMatchesIssue,
} = require('./codex-issue-guardrail.cjs');

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
      'gh issue view 642 && gh issue edit https://github.com/jlapenna/agent-lcars/issues/643',
    ),
    [642, 643],
  );
});

test('accepts a bare root title for a sub-issue', () => {
  assert.equal(titleMatchesIssue('642 follow-up', 643, 642), true);
  assert.equal(titleMatchesIssue('643 follow-up', 643, 642), false);
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

test('accepts a correctly titled sub-issue session', () => {
  const output = runHook(
    { tool_input: { command: 'gh issue view 643' } },
    dependencies({
      parentIssueNumber: 642,
      tmuxTitle: '642 follow-up',
    }),
  );

  assert.equal(output, null);
});
