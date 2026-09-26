#!/usr/bin/env bash
# Ensure linked worktrees share generated runtime, not tracked hook policy.
set -euo pipefail

hooks_path="$(git config --get core.hooksPath || true)"
expected="$(git rev-parse --path-format=absolute --git-common-dir)/repo-tools-husky"
if [ "$hooks_path" != "$expected" ]; then
  display_path="${hooks_path:-unset}"
  echo "ERROR: expected shared Husky hooks at $expected; found $display_path." >&2
  exit 1
fi

if [ ! -f "$expected/h" ] || [ ! -x "$expected/run-hook" ]; then
  echo "ERROR: missing shared Husky runtime. Run ./tools/setup-git-hooks.sh." >&2
  exit 1
fi

for hook in pre-commit pre-push; do
  if [ ! -x "$expected/$hook" ]; then
    echo "ERROR: missing executable shared hook $hook. Run ./tools/setup-git-hooks.sh." >&2
    exit 1
  fi
done

if ! git lfs version >/dev/null 2>&1; then
  echo "ERROR: Git LFS is required by the repository pre-push hook." >&2
  exit 1
fi

echo "Git hooks are installed."
