// Regression coverage for the fleet issue guardrail command.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  extractIssueNumbers,
  extractIssueReferences,
  projectNameFor,
  resolveRepoForDirDefault,
  runHook,
} = require('../bin/codex-issue-guardrail.cjs');

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function dependencies({
  assignees = ['agent-lcars-bot'],
  state,
  closedAt = null,
} = {}) {
  return {
    // `state` is deliberately absent unless a test asks for it, so the
    // backwards-compatibility path (a dependency object predating the
    // closed-issue check) stays exercised by every other test here.
    getIssue: () => ({ assignees, ...(state ? { state, closedAt } : {}) }),
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
    [{ number: 761, repo: 'jlapenna/homelab', routing: false }],
  );
  assert.deepEqual(
    extractIssueReferences('gh issue edit 12 --repo=owner/name --add-label x'),
    [{ number: 12, repo: 'owner/name', routing: true }],
  );
});

test('uses the URL own repository, not a -R elsewhere in the segment', () => {
  assert.deepEqual(
    extractIssueReferences(
      'gh issue view https://github.com/other/repo/issues/5 -R jlapenna/homelab',
    ),
    [{ number: 5, repo: 'other/repo', routing: false }],
  );
});

test('leaves the repository unset when the command does not name one', () => {
  assert.deepEqual(extractIssueReferences('gh issue edit 642 --add-label c'), [
    { number: 642, repo: null, routing: true },
  ]);
});

test('treats the same number in different repositories as distinct issues', () => {
  assert.deepEqual(
    extractIssueReferences(
      'gh issue view 761 -R jlapenna/homelab && gh issue view 761',
    ),
    [
      { number: 761, repo: 'jlapenna/homelab', routing: false },
      { number: 761, repo: null, routing: false },
    ],
  );
});

// The Bash tool's cwd resets between commands, so the norm in this fleet is
// `cd /other/repo && gh issue view N`, not a `-R` flag. #1084/#937 in
// jlapenna/homelab (2026-09-19/20) false-positived exactly this way: the
// bare number resolved against the hook's own repo instead of the one the
// command actually `cd`ed into.
test('resolves the repository from a preceding cd', () => {
  assert.deepEqual(
    extractIssueReferences(
      'cd /home/jlapenna/p/homelab && gh issue view 1084',
      {
        cwd: '/home/jlapenna/p/agent-lcars',
        resolveRepoForDir: (dir) =>
          dir === '/home/jlapenna/p/homelab' ? 'jlapenna/homelab' : null,
      },
    ),
    [{ number: 1084, repo: 'jlapenna/homelab', routing: false }],
  );
});

test('resolves a cd through a relative path against the starting cwd', () => {
  assert.deepEqual(
    extractIssueReferences('cd ../homelab && gh issue edit 937 --add-label x', {
      cwd: '/home/jlapenna/p/agent-lcars',
      resolveRepoForDir: (dir) =>
        dir === '/home/jlapenna/p/homelab' ? 'jlapenna/homelab' : null,
    }),
    [{ number: 937, repo: 'jlapenna/homelab', routing: true }],
  );
});

test('an explicit -R wins over a preceding cd', () => {
  assert.deepEqual(
    extractIssueReferences(
      'cd /home/jlapenna/p/homelab && gh issue view 1084 -R other/repo',
      { resolveRepoForDir: () => 'jlapenna/homelab' },
    ),
    [{ number: 1084, repo: 'other/repo', routing: false }],
  );
});

test('a GH_REPO= prefix carries the repository', () => {
  assert.deepEqual(
    extractIssueReferences('GH_REPO=jlapenna/homelab gh issue view 1084'),
    [{ number: 1084, repo: 'jlapenna/homelab', routing: false }],
  );
});

test('a GH_REPO= prefix wins over a preceding cd', () => {
  assert.deepEqual(
    extractIssueReferences(
      'cd /home/jlapenna/p/homelab && GH_REPO=other/repo gh issue view 1084',
      { resolveRepoForDir: () => 'jlapenna/homelab' },
    ),
    [{ number: 1084, repo: 'other/repo', routing: false }],
  );
});

test('a plain command with no cd still resolves to the hook cwd', () => {
  assert.deepEqual(extractIssueReferences('gh issue view 642'), [
    { number: 642, repo: null, routing: false },
  ]);
});

// Guessing which repository an unrecognized `cd` target belongs to is worse
// than saying nothing: it could just as easily check the wrong issue as skip
// the right one. Stay silent instead.
test('stays silent when a preceding cd targets a directory it cannot resolve', () => {
  assert.deepEqual(
    extractIssueReferences('cd /tmp/not-a-repo && gh issue view 5', {
      resolveRepoForDir: () => null,
    }),
    [],
  );
});

test('runHook stays silent for a cd it cannot resolve, rather than checking the wrong repo', () => {
  const output = runHook(
    { tool_input: { command: 'cd /tmp/not-a-repo && gh issue edit 5' } },
    {
      resolveRepoForDir: () => null,
      getIssue: () => {
        throw new Error('must not check any repository for an unresolved cd');
      },
    },
  );

  assert.equal(output, null);
});

test('names the repository resolved from a cd in a cross-repo violation', () => {
  const output = runHook(
    {
      tool_input: {
        command: 'cd /home/jlapenna/p/homelab && gh issue view 1084',
      },
    },
    {
      getIssue: (_issueNumber, repo) => {
        assert.equal(repo, 'jlapenna/homelab');
        return { assignees: [] };
      },
      resolveRepoForDir: (dir) =>
        dir === '/home/jlapenna/p/homelab' ? 'jlapenna/homelab' : null,
    },
  );

  assert.match(
    output.hookSpecificOutput.additionalContext,
    /issue jlapenna\/homelab#1084 is not assigned to/,
  );
});

// Regression for the exact reported command shape: a `cd` into another repo
// followed by both a `view` and a routing `edit` against the same number,
// where that repo's issue really is open and claimed. Before the fix this
// still false-positived, because both bare numbers resolved against the
// hook's own repository instead of jlapenna/homelab.
test('regression: a cd-then-view-then-edit sequence against a properly claimed cross-repo issue reports nothing', () => {
  const output = runHook(
    {
      tool_input: {
        command:
          'cd /home/jlapenna/p/homelab && gh issue view 1084 --json state,assignees && gh issue edit 1084 --add-assignee agent-lcars-bot',
      },
    },
    {
      resolveRepoForDir: (dir) =>
        dir === '/home/jlapenna/p/homelab' ? 'jlapenna/homelab' : null,
      getIssue: (issueNumber, repo) => {
        assert.equal(issueNumber, 1084);
        assert.equal(repo, 'jlapenna/homelab');
        return {
          assignees: ['agent-lcars-bot'],
          state: 'open',
          closedAt: null,
        };
      },
    },
  );

  assert.equal(output, null);
});

// The resolver itself, exercised against a real (temp, isolated) git
// checkout rather than mocked -- same pattern as projectNameFor's own test
// below. No network access: `origin` is set by hand, never fetched.
test('resolveRepoForDirDefault reads the owner/repo from a real origin remote', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrail-remote-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync(
      'git',
      ['remote', 'add', 'origin', 'git@github.com:jlapenna/homelab.git'],
      { cwd: dir },
    );

    assert.equal(resolveRepoForDirDefault(dir), 'jlapenna/homelab');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveRepoForDirDefault returns null outside a git checkout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrail-noremote-'));
  try {
    assert.equal(resolveRepoForDirDefault(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

// #1686: a session spent a full seven-task implementation on an issue that
// had been closed hours earlier by someone else's PR, and only discovered it
// when a rebase hit a content conflict. The issue's state is already in the
// response the assignee check pays for, so noticing costs nothing.
test('warns when routing an already-closed issue', () => {
  const output = runHook(
    { tool_input: { command: 'gh issue edit 642 --add-label agent:codex' } },
    dependencies({ state: 'closed', closedAt: '2026-09-01T12:29:00Z' }),
  );

  assert.match(
    output.hookSpecificOutput.additionalContext,
    /issue #642 is already CLOSED \(closed 2026-09-01T12:29:00Z\)/,
  );
  assert.match(
    output.hookSpecificOutput.additionalContext,
    /the work already shipped/,
  );
});

// Reading a closed issue is ordinary research -- most of the useful context
// in this fleet lives on closed issues. Warning there would fire on every
// lookup and train the reader to skip the banner, which costs the warnings
// that matter.
test('stays silent when merely viewing a closed issue', () => {
  const output = runHook(
    { tool_input: { command: 'gh issue view 642' } },
    dependencies({ state: 'closed' }),
  );

  assert.equal(output, null);
});

test('warns about a closed issue even when it is properly claimed', () => {
  const output = runHook(
    { tool_input: { command: 'gh issue edit 642 --add-label chore' } },
    dependencies({ assignees: ['agent-lcars-bot'], state: 'closed' }),
  );

  assert.match(output.hookSpecificOutput.additionalContext, /already CLOSED/);
  assert.doesNotMatch(
    output.hookSpecificOutput.additionalContext,
    /not assigned to/,
  );
});

// When an issue closed underneath you, "claim it" is the wrong instruction --
// the stale-read advice is what applies, so it has to come first.
test('leads with the closed guidance when an issue is both closed and unclaimed', () => {
  const output = runHook(
    { tool_input: { command: 'gh issue edit 642 --add-label chore' } },
    dependencies({ assignees: [], state: 'closed' }),
  );

  const context = output.hookSpecificOutput.additionalContext;
  assert.ok(
    context.indexOf('already shipped') <
      context.indexOf('post a session takeover comment'),
    'closed guidance must precede the claim reminder',
  );
});

test('an open issue never triggers the closed warning', () => {
  const output = runHook(
    { tool_input: { command: 'gh issue edit 642 --add-label chore' } },
    dependencies({ state: 'open' }),
  );

  assert.equal(output, null);
});

// The banner names which repository's guardrails are in play. Every session
// that trips this guardrail is standing in a linked worktree, where
// basename(cwd) is the worktree's directory rather than the repository --
// which rendered "agent-lcars-1686-collision-dev guardrail violation": a
// directory nobody recognises, attached to advice about a differently-named
// skill.
test('names the repository, not the worktree directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrail-banner-'));
  const repo = path.join(root, 'my-repo');
  const worktree = path.join(root, 'my-repo-some-long-task-branch');
  const git = (args, cwd) =>
    execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });

  try {
    fs.mkdirSync(repo);
    git(['init', '-q', '-b', 'main'], repo);
    git(
      [
        '-c',
        'user.email=t@example.invalid',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      ],
      repo,
    );
    git(['worktree', 'add', '-q', worktree, '-b', 'task'], repo);

    assert.equal(projectNameFor(repo), 'my-repo');
    assert.equal(
      projectNameFor(worktree),
      'my-repo',
      'a linked worktree must still report the repository name',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The banner is cosmetic; a directory that is not a repository at all must
// still get its violation reported rather than an exception.
test('falls back to the directory name outside a repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrail-norepo-'));
  try {
    assert.equal(projectNameFor(dir), path.basename(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
