#!/usr/bin/env bash
# Initialize a linked worktree without changing the primary checkout.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

git_dir="$(git rev-parse --path-format=absolute --git-dir)"
common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
if [ "$git_dir" = "$common_dir" ]; then
  echo "ERROR: tools/setup-worktree.sh must run in a linked feature worktree." >&2
  exit 1
fi

# No .nx-remote-cache.env copy here on purpose. tools/nx reads through to the
# primary checkout's copy when a worktree has none, so the credential exists
# once on disk and a rotation there reaches every worktree immediately. Copying
# it would also mean a worktree made by a bare `git worktree add` (which never
# runs this script) silently loses the remote cache.

echo "==> Installing dependencies"
HUSKY=0 pnpm install --frozen-lockfile

# HUSKY=0 skips the prepare hook, and every worktree has its own ignored
# .husky/_ bootstrap directory. Regenerate it here so commit/push guards work.
echo "==> Regenerating git hooks"
./tools/setup-git-hooks.sh

# Agent sessions commit as the fleet identity, not the maintainer. An
# interactive Claude/Codex session runs git under the maintainer's global
# ~/.gitconfig, so without this every agent commit is authored "Joe LaPenna"
# and is indistinguishable from a hand-written one in git log, git blame, and
# the squash commit that lands on main. Worktrees are the seam: agent git work
# is required to happen in one and the primary checkout is reserved for a clean
# main, so scoping the identity here separates the two without touching any
# global config, credential, or anything that needs rotating.
#
# --worktree is load-bearing. A bare `git config user.email` in a linked
# worktree writes to $GIT_COMMON_DIR/config, which would rename the
# maintainer's own commits in the primary checkout and every sibling worktree.
#
# The gate keeps a human who makes a worktree by hand committing as themselves;
# these are the same variables `lcars session title` reads to identify a
# session. The address is GitHub's canonical {id}+{login} noreply form, so the
# commits link to the agent-lcars-bot account.
if [ -n "${CLAUDE_CODE_SESSION_ID:-}${CODEX_THREAD_ID:-}" ]; then
  echo "==> Attributing commits to agent-lcars-bot"
  git config extensions.worktreeConfig true
  git config --worktree user.name "agent-lcars-bot"
  git config --worktree user.email "317675255+agent-lcars-bot@users.noreply.github.com"
fi

echo "==> Worktree ready."
