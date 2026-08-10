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
pnpm exec husky
./tools/assert-git-hooks-installed.sh

echo "==> Worktree ready."
