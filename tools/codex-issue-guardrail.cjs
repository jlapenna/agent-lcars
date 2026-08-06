#!/usr/bin/env node

// This hook is intentionally CommonJS so it runs without package/module setup.
// eslint-disable-next-line no-restricted-syntax
const { execFileSync } = require('node:child_process');

const CLAIM_ASSIGNEE = 'jclaw-bot';
const PROJECT_NAME = 'agent-lcars';

function extractIssueNumbers(command) {
  if (typeof command !== 'string') return [];
  const issueNumbers = new Set();
  const issuePattern =
    /\bgh\s+issue\s+(?:view|edit)\s+(?:(?:https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/)|#)?(\d+)\b/g;
  for (const match of command.matchAll(issuePattern))
    issueNumbers.add(Number(match[1]));
  return [...issueNumbers];
}

function titleMatchesIssue(title, issueNumber, parentIssueNumber = null) {
  if (typeof title !== 'string') return false;
  const normalizedTitle = title.trim();
  if (parentIssueNumber !== null) {
    return new RegExp(`^${parentIssueNumber}\\*(?:\\s|$)`).test(
      normalizedTitle,
    );
  }
  return new RegExp(`^${issueNumber}(?:\\s|$)`).test(normalizedTitle);
}

function defaultDependencies(cwd) {
  return {
    getIssue(issueNumber) {
      const output = execFileSync(
        'gh',
        ['api', `repos/{owner}/{repo}/issues/${issueNumber}`],
        {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      const issue = JSON.parse(output);
      const parentMatch = issue.parent_issue_url?.match(/\/issues\/(\d+)$/);
      return {
        assignees: issue.assignees.map(({ login }) => login),
        parentIssueNumber: parentMatch ? Number(parentMatch[1]) : null,
      };
    },
    getTmuxPane() {
      return process.env.TMUX_PANE ?? '';
    },
    getTmuxTitle(tmuxPane) {
      return execFileSync(
        'tmux',
        ['show-window-options', '-v', '-t', tmuxPane, '@user_title'],
        {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      ).trim();
    },
  };
}

function evaluateIssue(issueNumber, dependencies) {
  const violations = [];
  let issue;
  try {
    issue = dependencies.getIssue(issueNumber);
    if (!issue.assignees.includes(CLAIM_ASSIGNEE)) {
      violations.push(
        `issue #${issueNumber} is not assigned to ${CLAIM_ASSIGNEE}`,
      );
    }
  } catch {
    violations.push(`could not verify the assignees for issue #${issueNumber}`);
  }
  const tmuxPane = dependencies.getTmuxPane();
  if (tmuxPane) {
    try {
      const title = dependencies.getTmuxTitle(tmuxPane);
      if (
        !titleMatchesIssue(title, issueNumber, issue?.parentIssueNumber ?? null)
      ) {
        violations.push(
          `tmux pane ${tmuxPane} is not titled for issue #${issueNumber}`,
        );
      }
    } catch {
      violations.push(`could not verify the title for tmux pane ${tmuxPane}`);
    }
  }
  return violations;
}

function runHook(input, dependencies) {
  const issueNumbers = extractIssueNumbers(input?.tool_input?.command);
  if (issueNumbers.length === 0) return null;
  const violations = issueNumbers.flatMap((issueNumber) =>
    evaluateIssue(issueNumber, dependencies),
  );
  if (violations.length === 0) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: [
        `${PROJECT_NAME}-dev guardrail violation:`,
        ...violations.map((violation) => `- ${violation}`),
        'Claim the issue and pin this tmux window title before continuing hands-on work.',
      ].join('\n'),
    },
  };
}

function main() {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(chunks.join(''));
      const output = runHook(input, defaultDependencies(input.cwd));
      if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    } catch {
      process.stdout.write(
        `${JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: `${PROJECT_NAME}-dev guardrail violation: the issue-workflow hook could not inspect this command.`,
          },
        })}\n`,
      );
    }
  });
}

if (require.main === module) main();

module.exports = {
  evaluateIssue,
  extractIssueNumbers,
  runHook,
  titleMatchesIssue,
};
