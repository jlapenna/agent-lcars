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
const os = require('node:os');
const path = require('node:path');

const { fleetLogin } = require('./fleet-identity.cjs');

const CLAIM_ASSIGNEE = fleetLogin();

// A directory a `cd` targeted but that this resolver could not map to a
// repository (unknown, not a git checkout, `cd -`, ...). Distinct from
// "no cd happened at all" (null repo, checked against the hook's own cwd
// below) - here the command plainly moved somewhere else, and guessing wrong
// is worse than saying nothing, so the reference is dropped instead of
// checked against either repo.
const UNKNOWN_DIR = Symbol('cd-target-unresolved');

// `git -C <dir> remote get-url origin` output -> `owner/name`, or null when
// the URL isn't a recognizable GitHub remote (a fork with a non-github.com
// host, a repo with no `origin`, etc.).
function ownerRepoFromRemoteUrl(url) {
  const match = url
    .trim()
    .match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

// Real filesystem lookup, used outside of tests. Callers (tests, `runHook`
// via `dependencies`) inject their own resolver instead of exercising real
// git - see "No real git in unit tests" in project memory.
function resolveRepoForDirDefault(dir) {
  try {
    const url = execFileSync(
      'git',
      ['-C', dir, 'remote', 'get-url', 'origin'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    return ownerRepoFromRemoteUrl(url);
  } catch {
    return null;
  }
}

// A bare `cd` target as it would appear mid-command: strip surrounding
// quotes, expand `~`, and resolve relative to whatever directory was in
// effect before it. `cd -` and a directory `resolveRepoForDir` can't place
// both collapse to UNKNOWN_DIR so later `gh issue` calls in the same command
// stay silent instead of guessing.
function resolveCdTarget(basePath, rawTarget) {
  let target = rawTarget.trim();
  if (
    (target.startsWith('"') && target.endsWith('"')) ||
    (target.startsWith("'") && target.endsWith("'"))
  ) {
    target = target.slice(1, -1);
  }
  if (!target || target === '-') return UNKNOWN_DIR;
  if (basePath === UNKNOWN_DIR) return UNKNOWN_DIR;
  if (target === '~' || target.startsWith('~/')) {
    target = path.join(os.homedir(), target.slice(1));
  }
  return path.resolve(basePath, target);
}

// An issue number alone is ambiguous across repositories. `gh` resolves a
// bare number against the working directory's repo, so a cross-repo command
// (`gh issue view 761 -R jlapenna/homelab`) used to be checked against THIS
// repo's #761 - a different issue entirely, yielding both false violations
// and, worse, silence when the named repo's issue really was unclaimed.
// Carry the repository alongside every number.
//
// The Bash tool's cwd resets between commands, so a cross-repo command in
// this fleet is normally shaped `cd /other/repo && gh issue view N`, not a
// `-R`/`--repo` flag. Resolve each `gh issue` invocation's repository in
// priority order: an explicit `-R`/`--repo` on that invocation; a `GH_REPO=`
// prefix on it; the directory an earlier `cd` in the same command string
// established (mapped to its `origin` remote); otherwise leave it unset,
// which `getIssue` below resolves against the hook's own cwd exactly as
// before.
function extractIssueReferences(command, dependencies = {}) {
  if (typeof command !== 'string') return [];
  const { cwd = process.cwd(), resolveRepoForDir = resolveRepoForDirDefault } =
    dependencies;
  const references = new Map();
  const segments = command.split(/&&|\|\||;|\n/);
  const cdPattern = /^\s*cd\s+(\S.*)$/;
  const ghIssuePattern = /\bgh\s+issue\s+(view|edit)\b([\s\S]*)$/;
  const urlPattern =
    /https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)/g;
  const numberPattern = /(?:^|\s)#?(\d+)(?=\s|$)/g;
  // -R owner/repo, --repo owner/repo, --repo=owner/repo
  const repoFlagPattern = /(?:^|\s)(?:-R|--repo)(?:[=\s]+)(\S+)/;
  const ghRepoEnvPattern = /(?:^|\s)GH_REPO=(\S+)/;

  let currentDir = cwd;
  const dirRepoCache = new Map();
  const repoForDir = (dir) => {
    if (dir === UNKNOWN_DIR) return null;
    if (dirRepoCache.has(dir)) return dirRepoCache.get(dir);
    let repo;
    try {
      repo = resolveRepoForDir(dir);
    } catch {
      repo = null;
    }
    dirRepoCache.set(dir, repo);
    return repo;
  };

  for (const segment of segments) {
    const cdMatch = segment.match(cdPattern);
    if (cdMatch) {
      currentDir = resolveCdTarget(currentDir, cdMatch[1]);
      continue;
    }

    const ghMatch = segment.match(ghIssuePattern);
    if (!ghMatch) continue;
    // `edit` routes an issue -- labels, assignees. `view` only reads it.
    // Only the routing verb gets the closed-state check below, because
    // reading a closed issue is ordinary research and warning about it would
    // be noise on every lookup.
    const routing = ghMatch[1] === 'edit';
    const tail = ghMatch[2];

    const flagMatch = tail.match(repoFlagPattern);
    const envMatch = segment.match(ghRepoEnvPattern);
    let resolvedRepo = null;
    let unresolved = false;
    if (flagMatch) {
      resolvedRepo = flagMatch[1];
    } else if (envMatch) {
      resolvedRepo = envMatch[1];
    } else if (currentDir !== cwd) {
      // The command `cd`ed somewhere before this invocation.
      const repo = currentDir === UNKNOWN_DIR ? null : repoForDir(currentDir);
      if (repo) {
        resolvedRepo = repo;
      } else {
        unresolved = true;
      }
    }

    for (const urlMatch of tail.matchAll(urlPattern)) {
      const key = `${urlMatch[1]}#${urlMatch[2]}`;
      const reference = {
        number: Number(urlMatch[2]),
        repo: urlMatch[1],
        routing: routing || Boolean(references.get(key)?.routing),
      };
      references.set(key, reference);
    }
    // Stay silent on this invocation's bare numbers rather than check them
    // against the wrong repository - a URL's own repo above is unaffected,
    // since it never depended on this resolution at all.
    if (unresolved) continue;
    // A URL's digits would otherwise be re-counted as a bare number against
    // the resolved repo, so scan the segment with URLs removed.
    for (const numberMatch of tail
      .replace(urlPattern, ' ')
      .matchAll(numberPattern)) {
      const key = `${resolvedRepo ?? ''}#${numberMatch[1]}`;
      const reference = {
        number: Number(numberMatch[1]),
        repo: resolvedRepo,
        // Where the lookup has to run from: `gh` here is a per-repository
        // shim scoped by cwd, so asking about another repository from this
        // hook's own cwd fails even with an explicit owner/name slug.
        ...(!flagMatch && !envMatch && resolvedRepo ? { dir: currentDir } : {}),
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

// The banner names which repository's guardrails are in play, so it has to be
// the repository -- but every session that trips this is standing in a linked
// worktree, where basename(cwd) is the worktree's own directory. That rendered
// "agent-lcars-1686-collision-dev guardrail violation": a directory name
// nobody recognises, attached to advice about a skill that is not called that.
// The common git dir always belongs to the primary checkout, whichever
// worktree is current.
function projectNameFor(cwd) {
  try {
    const commonDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (commonDir) return path.basename(path.dirname(commonDir));
  } catch {
    // Not a repository, or no git on PATH. The banner is cosmetic; falling
    // back keeps the violation itself visible.
  }
  return path.basename(cwd);
}

function defaultDependencies(cwd) {
  return {
    projectName: projectNameFor(cwd),
    cwd,
    resolveRepoForDir: resolveRepoForDirDefault,
    getIssue(issueNumber, repo = null, dir = null) {
      // `{owner}/{repo}` is gh's placeholder for the cwd's repository; use it
      // only when the command did not name one.
      const slug = repo ?? '{owner}/{repo}';
      const output = execFileSync(
        'gh',
        ['api', `repos/${slug}/issues/${issueNumber}`],
        {
          cwd: dir ?? cwd,
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
    dir = null,
    routing = false,
  } = typeof reference === 'number' ? { number: reference } : reference;
  const label = formatIssue({ number: issueNumber, repo });
  const violations = [];
  try {
    const issue = dependencies.getIssue(issueNumber, repo, dir);
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
    // A lookup that cannot be made is not evidence the issue is unclaimed.
    // For this repository's own issues the hook still says so, because it
    // normally can look and a failure is worth seeing. For another
    // repository it stays silent: the message ends in "claim the issue",
    // and a headless run told that about an issue it could merely not read
    // (jlapenna/homelab#1084 on 2026-09-20, already claimed) may go and
    // claim or comment on it.
    if (!repo) {
      violations.push({
        kind: 'unclaimed',
        text: `could not verify the assignees for issue ${label}`,
      });
    }
  }
  return violations;
}

function runHook(input, dependencies) {
  const references = extractIssueReferences(
    input?.tool_input?.command,
    dependencies,
  );
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
  projectNameFor,
  resolveRepoForDirDefault,
};
