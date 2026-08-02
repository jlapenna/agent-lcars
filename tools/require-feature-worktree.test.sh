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

git init --initial-branch=main "$temp_dir/repository" >/dev/null
# Global config is masked above, so set identity explicitly for the commit
# this fixture makes.
git -C "$temp_dir/repository" config user.name test
git -C "$temp_dir/repository" config user.email test@example.com
touch "$temp_dir/repository/README.md"
git -C "$temp_dir/repository" add README.md
git -C "$temp_dir/repository" commit -m initial >/dev/null

if (cd "$temp_dir/repository" && "$root/tools/require-feature-worktree.sh"); then
  echo "expected the primary checkout to be rejected" >&2
  exit 1
fi

git -C "$temp_dir/repository" worktree add "$temp_dir/feature" -b feature >/dev/null
(cd "$temp_dir/feature" && "$root/tools/require-feature-worktree.sh")

echo "require-feature-worktree: PASS"
