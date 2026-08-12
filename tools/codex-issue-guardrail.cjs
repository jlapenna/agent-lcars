#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const CLAIM_ASSIGNEE = 'jclaw-bot';

function extractIssueNumbers(command) {
  if (typeof command !== 'string') return [];
  const issueNumbers = new Set();
  const commandPattern = /\bgh\s+issue\s+(?:view|edit)\b([\s\S]*?)(?=(?:&&|\|\||;|\n|$))/g;
  const referencePattern = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)|(?:^|\s)#?(\d+)(?=\s|$)/g;
  for (const commandMatch of command.matchAll(commandPattern)) {
    for (const referenceMatch of commandMatch[1].matchAll(referencePattern)) {
      issueNumbers.add(Number(referenceMatch[1] ?? referenceMatch[2]));
    }
  }
  return [...issueNumbers];
}

function titleMatchesIssue(title, issueNumber, parentIssueNumber = null) {
  if (typeof title !== 'string') return false;
  const normalizedTitle = title.trim();
  const number = parentIssueNumber ?? issueNumber;
  return new RegExp(`^${number}(?:\\*|\\s|$)`).test(normalizedTitle);
}

function defaultDependencies(cwd) {
  return {
    projectName: path.basename(cwd),
    getIssue(issueNumber) {
      const output = execFileSync('gh', ['api', `repos/{owner}/{repo}/issues/${issueNumber}`], {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      const issue = JSON.parse(output);
      const parentMatch = issue.parent_issue_url?.match(/\/issues\/(\d+)$/);
      return {
        assignees: Array.isArray(issue.assignees) ? issue.assignees.map(({ login }) => login) : [],
        parentIssueNumber: parentMatch ? Number(parentMatch[1]) : null,
      };
    },
    getTmuxPane() { return process.env.TMUX_PANE ?? ''; },
    getTmuxTitle(tmuxPane) {
      return execFileSync('tmux', ['show-window-options', '-v', '-t', tmuxPane, '@user_title'], {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    },
  };
}

function evaluateIssue(issueNumber, dependencies) {
  const violations = [];
  let issue;
  try {
    issue = dependencies.getIssue(issueNumber);
    if (!issue.assignees.includes(CLAIM_ASSIGNEE)) {
      violations.push(`issue #${issueNumber} is not assigned to ${CLAIM_ASSIGNEE}`);
    }
  } catch {
    violations.push(`could not verify the assignees for issue #${issueNumber}`);
  }
  const tmuxPane = dependencies.getTmuxPane();
  if (tmuxPane) {
    try {
      const title = dependencies.getTmuxTitle(tmuxPane);
      if (!titleMatchesIssue(title, issueNumber, issue?.parentIssueNumber ?? null)) {
        violations.push(`tmux pane ${tmuxPane} is not titled for issue #${issueNumber}`);
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
  const violations = issueNumbers.flatMap((issueNumber) => evaluateIssue(issueNumber, dependencies));
  if (violations.length === 0) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: [
        `${dependencies.projectName}-dev guardrail violation:`,
        ...violations.map((violation) => `- ${violation}`),
        'Before continuing hands-on work, claim the issue, post a session takeover comment, and pin this tmux window title.',
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
      const output = runHook(input, defaultDependencies(input.cwd || process.cwd()));
      if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    } catch {
      process.stdout.write(`${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: 'repository-dev guardrail violation: the issue-workflow hook could not inspect this command.',
        },
      })}\n`);
    }
  });
}

if (require.main === module) main();

module.exports = { evaluateIssue, extractIssueNumbers, runHook, titleMatchesIssue };
