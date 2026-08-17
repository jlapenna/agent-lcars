#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$temp_dir"
}
trap cleanup EXIT

# This test is the one legitimate exception to "unit tests must not execute
# real git commands" (#328) -- it exercises a git-centric hook script, so it
# necessarily runs real git. To keep it from being able to escape its
# sandbox the way apps/runner-autoscaler/build_config_test.go did (leaked
# GIT_DIR/GIT_WORK_TREE from an invoking hook environment pointed real git
# commands at the real shared repo instead of the test fixture), make it
# hermetic: clear every inherited git env var that could redirect these
# commands at a different repo, and mask global/system git config plus HOME
# so nothing here depends on -- or mutates -- the invoking environment.
unset -v GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR \
  GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
export HOME="$temp_dir/home"
mkdir -p "$HOME"

# The hook deliberately no-ops under GITHUB_ACTIONS (homelab runs its whole
# pre-commit suite in CI, where every checkout is a plain non-worktree
# clone). This test DOES run in CI, so mask the variable for the cases that
# assert rejection, and re-set it explicitly for the case that asserts the
# CI no-op.
unset -v GITHUB_ACTIONS

git init --initial-branch=main "$temp_dir/repository" >/dev/null
# Global config is masked above, so set identity explicitly for the commit
# this fixture makes.
git -C "$temp_dir/repository" config user.name test
git -C "$temp_dir/repository" config user.email test@example.com
touch "$temp_dir/repository/README.md"
git -C "$temp_dir/repository" add README.md
git -C "$temp_dir/repository" commit -m initial >/dev/null

if (cd "$temp_dir/repository" && "$root/bin/require-feature-worktree.sh"); then
  echo "expected the primary checkout to be rejected" >&2
  exit 1
fi

# The rejection banner names what was rejected: the default wording without
# an argument, the caller-supplied action word with one (sprinkles passes
# COMMITS/PUSHES from its husky hooks).
message="$( (cd "$temp_dir/repository" && "$root/bin/require-feature-worktree.sh" 2>&1) || true)"
case "$message" in
  *"commits and pushes must come from a feature worktree"*) ;;
  *)
    echo "expected the default action wording in: $message" >&2
    exit 1
    ;;
esac
message="$( (cd "$temp_dir/repository" && "$root/bin/require-feature-worktree.sh" pushes 2>&1) || true)"
case "$message" in
  *"pushes must come from a feature worktree"*) ;;
  *)
    echo "expected the caller-supplied action wording in: $message" >&2
    exit 1
    ;;
esac

# REQUIRE_WORKTREE_EXTRA_HINT is the documented repo-specific remediation
# hook (sprinkles points at its deploy script through it).
message="$( (cd "$temp_dir/repository" && REQUIRE_WORKTREE_EXTRA_HINT='Use the deploy script instead.' "$root/bin/require-feature-worktree.sh" 2>&1) || true)"
case "$message" in
  *"Use the deploy script instead."*) ;;
  *)
    echo "expected the extra hint in: $message" >&2
    exit 1
    ;;
esac

# Under GITHUB_ACTIONS the hook must no-op even in an otherwise-rejected
# checkout (CI clones are never worktrees).
(cd "$temp_dir/repository" && GITHUB_ACTIONS=true "$root/bin/require-feature-worktree.sh")

# Deletion-only push exemption (sprinkles#4296): a push whose every ref
# line carries an all-zero local sha is a pure branch deletion, normally
# run from the primary checkout, and must pass the guard.
zeros="0000000000000000000000000000000000000000"
sha="$(git -C "$temp_dir/repository" rev-parse HEAD)"
(cd "$temp_dir/repository" &&
  printf '(delete) %s refs/heads/gone %s\n' "$zeros" "$sha" |
  "$root/bin/require-feature-worktree.sh" pushes)

# ...including multiple deletions at once.
(cd "$temp_dir/repository" &&
  printf '(delete) %s refs/heads/a %s\n(delete) %s refs/heads/b %s\n' \
    "$zeros" "$sha" "$zeros" "$sha" |
  "$root/bin/require-feature-worktree.sh" pushes)

# A push that MIXES a deletion with a real ref is still rejected.
if (cd "$temp_dir/repository" &&
  printf 'refs/heads/main %s refs/heads/main %s\n(delete) %s refs/heads/gone %s\n' \
    "$sha" "$sha" "$zeros" "$sha" |
  "$root/bin/require-feature-worktree.sh" pushes); then
  echo "expected a mixed deletion+content push to be rejected" >&2
  exit 1
fi

# A content-only push is rejected regardless of stdin being attached.
if (cd "$temp_dir/repository" &&
  printf 'refs/heads/main %s refs/heads/main %s\n' "$sha" "$zeros" |
  "$root/bin/require-feature-worktree.sh" pushes); then
  echo "expected a content push from the primary checkout to be rejected" >&2
  exit 1
fi

# An empty ref stream (nothing to push) gets no exemption.
if (cd "$temp_dir/repository" &&
  "$root/bin/require-feature-worktree.sh" pushes </dev/null); then
  echo "expected an empty-stdin push to be rejected" >&2
  exit 1
fi

# Non-push invocations never read stdin: deletion-shaped input on a
# commit-stage invocation must not unlock the guard.
if (cd "$temp_dir/repository" &&
  printf '(delete) %s refs/heads/gone %s\n' "$zeros" "$sha" |
  "$root/bin/require-feature-worktree.sh" commits); then
  echo "expected a commit-stage invocation to ignore deletion-shaped stdin" >&2
  exit 1
fi

git -C "$temp_dir/repository" worktree add "$temp_dir/feature" -b feature >/dev/null
(cd "$temp_dir/feature" && "$root/bin/require-feature-worktree.sh")

echo "require-feature-worktree: PASS"
