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
    /\bgh\s+issue\s+(view|edit)\b([\s\S]*?)(?=(?:&&|\|\||;|\n|$))/g;
  const urlPattern =
    /https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)/g;
  const numberPattern = /(?:^|\s)#?(\d+)(?=\s|$)/g;
  // -R owner/repo, --repo owner/repo, --repo=owner/repo
  const repoFlagPattern = /(?:^|\s)(?:-R|--repo)(?:[=\s]+)(\S+)/;
  for (const commandMatch of command.matchAll(commandPattern)) {
    const segment = commandMatch[2];
    // `edit` routes an issue -- labels, assignees. `view` only reads it.
    // Only the routing verb gets the closed-state check below, because
    // reading a closed issue is ordinary research and warning about it would
    // be noise on every lookup.
    const routing = commandMatch[1] === 'edit';
    const flagMatch = segment.match(repoFlagPattern);
    const segmentRepo = flagMatch ? flagMatch[1] : null;
    for (const urlMatch of segment.matchAll(urlPattern)) {
      const key = `${urlMatch[1]}#${urlMatch[2]}`;
      const reference = {
        number: Number(urlMatch[2]),
        repo: urlMatch[1],
        routing: routing || Boolean(references.get(key)?.routing),
      };
      references.set(key, reference);
    }
    // A URL's digits would otherwise be re-counted as a bare number against
    // the segment's repo, so scan the segment with URLs removed.
    for (const numberMatch of segment
      .replace(urlPattern, ' ')
      .matchAll(numberPattern)) {
      const key = `${segmentRepo ?? ''}#${numberMatch[1]}`;
      const reference = {
        number: Number(numberMatch[1]),
        repo: segmentRepo,
        routing: routing || Boolean(references.get(key)?.routing),
      };
      references.set(key, reference);
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
      return {
        assignees: Array.isArray(issue.assignees)
          ? issue.assignees.map(({ login }) => login)
          : [],
        // Already in the response the assignee check pays for, so the
        // collision check below costs no additional request.
        state: issue.state,
        closedAt: issue.closed_at ?? null,
      };
    },
  };
}

function evaluateIssue(reference, dependencies) {
  const {
    number: issueNumber,
    repo = null,
    routing = false,
  } = typeof reference === 'number' ? { number: reference } : reference;
  const label = formatIssue({ number: issueNumber, repo });
  const violations = [];
  try {
    const issue = dependencies.getIssue(issueNumber, repo);
    if (!issue.assignees.includes(CLAIM_ASSIGNEE)) {
      violations.push({
        kind: 'unclaimed',
        text: `issue ${label} is not assigned to ${CLAIM_ASSIGNEE}`,
      });
    }
    // #1686: a session sank a full seven-task implementation into an issue
    // that had been closed hours earlier by someone else's PR, and only found
    // out when a rebase hit a content conflict. Routing an already-closed
    // issue is the same mistake one step earlier and is visible for free.
    if (routing && issue.state === 'closed') {
      const since = issue.closedAt ? ` (closed ${issue.closedAt})` : '';
      violations.push({
        kind: 'closed',
        text: `issue ${label} is already CLOSED${since}`,
      });
    }
  } catch {
    violations.push({
      kind: 'unclaimed',
      text: `could not verify the assignees for issue ${label}`,
    });
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
  const kinds = new Set(violations.map(({ kind }) => kind));
  const guidance = [];
  if (kinds.has('closed')) {
    // Deliberately first: when an issue closed under you, claiming it is the
    // wrong next move, and the stale-read advice is what actually applies.
    guidance.push(
      'A closed issue usually means the work already shipped -- re-read it and the PR that closed it before going further, and do not route or continue work that may now be a duplicate.',
    );
  }
  if (kinds.has('unclaimed')) {
    guidance.push(
      'Before continuing hands-on work, claim the issue and post a session takeover comment.',
    );
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: [
        `${projectName}-dev guardrail violation:`,
        ...violations.map(({ text }) => `- ${text}`),
        ...guidance,
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
};
