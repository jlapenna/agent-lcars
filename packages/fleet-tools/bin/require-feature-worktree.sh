#!/usr/bin/env bash
# Reject commits and pushes from the shared primary checkout or main.
#
# Fleet-canonical copy (agent-lcars#1307): jlapenna/homelab and
# supersprinklesracing/sprinkles vendor this file byte-for-byte and wire it
# through their own hook runners (the pre-commit framework / husky); the
# verify-fleet-scripts published action fails their CI when a vendored copy
# drifts. Edit it HERE and re-sync the consumers. Repo-specific behavior
# enters only through the two hooks below, never by editing a copy:
#   $1                           names what is being rejected in the error
#                                message (default: "commits and pushes")
#   REQUIRE_WORKTREE_EXTRA_HINT  optional extra remediation line, printed
#                                before the closing banner (e.g. sprinkles
#                                points at its deploy script here)
set -euo pipefail

# CI checkouts (actions/checkout) are plain, non-worktree clones on whatever
# ref triggered the run, never a feature worktree -- so this check is
# unconditionally unsatisfiable there. It is a local-authoring-discipline
# check, not a CI concern (homelab runs its whole pre-commit suite in CI,
# which is what forced this guard).
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  exit 0
fi

action="${1:-commits and pushes}"

git_dir="$(git rev-parse --path-format=absolute --git-dir)"
common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
branch="$(git symbolic-ref --quiet --short HEAD || printf '<detached HEAD>')"

if [ "$git_dir" != "$common_dir" ] && [ "$branch" != "main" ]; then
  exit 0
fi

echo "======================================================================" >&2
echo "ERROR: $action must come from a feature worktree." >&2
if [ "$git_dir" = "$common_dir" ]; then
  echo "This is the primary checkout, which is reserved for a clean main." >&2
else
  echo "Direct $action to main are forbidden." >&2
fi
echo "Create a feature worktree from origin/main and submit a pull request." >&2
if [ -n "${REQUIRE_WORKTREE_EXTRA_HINT:-}" ]; then
  echo "$REQUIRE_WORKTREE_EXTRA_HINT" >&2
fi
echo "======================================================================" >&2
exit 1
