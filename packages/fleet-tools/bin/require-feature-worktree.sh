#!/usr/bin/env bash
# Reject commits and pushes from the shared primary checkout or main.
#
# This is the fleet's single copy (packages/fleet-tools, agent-lcars#1328):
# consumer repos hold no copies -- the package installs it on PATH as
# `fleet-require-worktree` (workstations via a global pnpm install tracking
# main, the runner image at image build), and hook runners (husky / the
# pre-commit framework) invoke it behind a `command -v` guard so machines
# without the install degrade quietly. Repo-specific behavior enters only
# through the hooks below, never through a diverging copy:
#   $1                           names what is being rejected in the error
#                                message (default: "commits and pushes");
#                                the literal word "pushes" also opts in to
#                                the deletion-only push exemption below
#   REQUIRE_WORKTREE_EXTRA_HINT  optional extra remediation line, printed
#                                before the closing banner (e.g. sprinkles
#                                points at its deploy script here)
#
# Push invocations ($1 = "pushes") should attach git's pre-push ref lines
# on stdin (<local ref> <local sha> <remote ref> <remote sha> per ref).
# This script CONSUMES that stream: a hook that needs the same lines again
# afterwards (git lfs pre-push does) must capture them first and pipe a
# copy in, the way sprinkles' and agent-lcars' pre-push hooks do.
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

# Deletion-only push exemption (sprinkles#4296). A deletion
# (`git push origin --delete <branch>`) has an all-zero local sha, carries
# no content, and is normally run from the PRIMARY checkout -- you delete a
# branch precisely when its worktree is already gone. Rejecting that left
# `--no-verify` as the apparent workaround, the one habit the fleet forbids
# outright: a guardrail satisfiable only by breaking another guardrail is a
# bug in the guardrail. A push that MIXES deletions with real refs is still
# subject to the guard. Only read stdin when the caller declared a push and
# actually attached a stream (never a terminal, so a bare interactive
# `fleet-require-worktree pushes` cannot hang waiting for input).
if [ "$action" = "pushes" ] && [ ! -t 0 ]; then
  refs="$(cat)"
  if [ -n "$refs" ] &&
    printf '%s\n' "$refs" |
      awk '$2 ~ /^0+$/ { del++ } $2 !~ /^0+$/ { other++ } END { exit !(del > 0 && other == 0) }'; then
    echo "require-feature-worktree: deletion-only push (no content) -- worktree guard skipped." >&2
    exit 0
  fi
fi

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
