#!/usr/bin/env bash
# Reject commits and pushes from the shared primary checkout or main.
set -euo pipefail

git_dir="$(git rev-parse --path-format=absolute --git-dir)"
common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
branch="$(git symbolic-ref --quiet --short HEAD || printf '<detached HEAD>')"

if [ "$git_dir" != "$common_dir" ] && [ "$branch" != "main" ]; then
  exit 0
fi

echo "======================================================================" >&2
echo "ERROR: commits and pushes must come from a feature worktree." >&2
if [ "$git_dir" = "$common_dir" ]; then
  echo "This is the primary checkout, which is reserved for a clean main." >&2
else
  echo "Direct commits and pushes to main are forbidden." >&2
fi
echo "Create a feature worktree from origin/main and submit a pull request." >&2
echo "======================================================================" >&2
exit 1
