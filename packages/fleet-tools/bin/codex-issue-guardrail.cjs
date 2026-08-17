#!/usr/bin/env node

/**
 * Single fleet source (#1307, de-vendored in #1328): this file lives only
 * in agent-lcars's packages/fleet-tools. Consumer repos' .claude/settings.json
 * / .codex/hooks.json invoke it as `fleet-codex-issue-guardrail` from PATH
 * (machines install the package from main; the runner image installs it at
 * build time), guarded with `command -v` so an uninstalled machine degrades
 * quietly. fleet-identity.cjs must remain a sibling of this real file —
 * the installed bin is a symlink and require() resolves via its realpath.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { fleetLogin } = require('./fleet-identity.cjs');

const CLAIM_ASSIGNEE = fleetLogin();

// An issue number alone is ambiguous across repositories. `gh` resolves a
// bare number against the working directory's repo, so a cross-repo command
// (`gh issue view 761 -R jlapenna/homelab`) used to be checked against THIS
// repo's #761 - a different issue entirely, yielding both false violations
// and, worse, silence when the named repo's issue really was unclaimed.
// Carry the repository alongside every number.
function extractIssueReferences(command) {
  if (typeof command !== 'string') return [];
  const references = new Map();
  const commandPattern =
    /\bgh\s+issue\s+(?:view|edit)\b([\s\S]*?)(?=(?:&&|\|\||;|\n|$))/g;
  const urlPattern =
    /https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)/g;
  const numberPattern = /(?:^|\s)#?(\d+)(?=\s|$)/g;
  // -R owner/repo, --repo owner/repo, --repo=owner/repo
  const repoFlagPattern = /(?:^|\s)(?:-R|--repo)(?:[=\s]+)(\S+)/;
  for (const commandMatch of command.matchAll(commandPattern)) {
    const segment = commandMatch[1];
    const flagMatch = segment.match(repoFlagPattern);
    const segmentRepo = flagMatch ? flagMatch[1] : null;
    for (const urlMatch of segment.matchAll(urlPattern)) {
      const reference = { number: Number(urlMatch[2]), repo: urlMatch[1] };
      references.set(`${reference.repo}#${reference.number}`, reference);
    }
    // A URL's digits would otherwise be re-counted as a bare number against
    // the segment's repo, so scan the segment with URLs removed.
    for (const numberMatch of segment
      .replace(urlPattern, ' ')
      .matchAll(numberPattern)) {
      const reference = { number: Number(numberMatch[1]), repo: segmentRepo };
      references.set(`${segmentRepo ?? ''}#${reference.number}`, reference);
    }
  }
  return [...references.values()];
}

// Retained for callers that only need the numbers.
function extractIssueNumbers(command) {
  return [
    ...new Set(extractIssueReferences(command).map(({ number }) => number)),
  ];
}

function formatIssue({ number, repo }) {
  return repo ? `${repo}#${number}` : `#${number}`;
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
    getIssue(issueNumber, repo = null) {
      // `{owner}/{repo}` is gh's placeholder for the cwd's repository; use it
      // only when the command did not name one.
      const slug = repo ?? '{owner}/{repo}';
      const output = execFileSync(
        'gh',
        ['api', `repos/${slug}/issues/${issueNumber}`],
        {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      const issue = JSON.parse(output);
      const parentMatch = issue.parent_issue_url?.match(/\/issues\/(\d+)$/);
      return {
        assignees: Array.isArray(issue.assignees)
          ? issue.assignees.map(({ login }) => login)
          : [],
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

function evaluateIssue(reference, dependencies) {
  const { number: issueNumber, repo = null } =
    typeof reference === 'number' ? { number: reference } : reference;
  const label = formatIssue({ number: issueNumber, repo });
  const violations = [];
  let issue;
  try {
    issue = dependencies.getIssue(issueNumber, repo);
    if (!issue.assignees.includes(CLAIM_ASSIGNEE)) {
      violations.push(`issue ${label} is not assigned to ${CLAIM_ASSIGNEE}`);
    }
  } catch {
    violations.push(`could not verify the assignees for issue ${label}`);
  }
  const tmuxPane = dependencies.getTmuxPane();
  if (tmuxPane) {
    try {
      const title = dependencies.getTmuxTitle(tmuxPane);
      if (
        !titleMatchesIssue(title, issueNumber, issue?.parentIssueNumber ?? null)
      ) {
        violations.push(
          `tmux pane ${tmuxPane} is not titled for issue ${label}`,
        );
      }
    } catch {
      violations.push(`could not verify the title for tmux pane ${tmuxPane}`);
    }
  }
  return violations;
}

function runHook(input, dependencies) {
  const references = extractIssueReferences(input?.tool_input?.command);
  if (references.length === 0) return null;
  const violations = references.flatMap((reference) =>
    evaluateIssue(reference, dependencies),
  );
  if (violations.length === 0) return null;
  // Defensive fallback adopted from homelab's variant: a dependency object
  // without projectName must not render an "undefined-dev" banner.
  const projectName = dependencies.projectName ?? 'repository';
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: [
        `${projectName}-dev guardrail violation:`,
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
      const output = runHook(
        input,
        defaultDependencies(input.cwd || process.cwd()),
      );
      if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    } catch {
      process.stdout.write(
        `${JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext:
              'repository-dev guardrail violation: the issue-workflow hook could not inspect this command.',
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
  extractIssueReferences,
  runHook,
  titleMatchesIssue,
};
