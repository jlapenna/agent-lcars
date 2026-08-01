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

# The remote-cache config is intentionally ignored because it contains the
# cache credential. Linked worktrees do not inherit ignored files, so copy the
# primary checkout's local config when it exists. This keeps the setup path
# aligned with tools/nx, which loads this file only after a reachability probe.
primary_root="$(dirname "$common_dir")"
if [ ! -f .nx-remote-cache.env ] && [ -f "$primary_root/.nx-remote-cache.env" ]; then
  cp "$primary_root/.nx-remote-cache.env" .nx-remote-cache.env
  chmod 600 .nx-remote-cache.env
  echo "==> Copied .nx-remote-cache.env from the primary checkout"
fi

echo "==> Installing dependencies"
HUSKY=0 pnpm install --frozen-lockfile

# HUSKY=0 skips the prepare hook, and every worktree has its own ignored
# .husky/_ bootstrap directory. Regenerate it here so commit/push guards work.
echo "==> Regenerating git hooks"
pnpm exec husky
./tools/assert-git-hooks-installed.sh

echo "==> Worktree ready."
