#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$temp_dir"
}
trap cleanup EXIT

git init --initial-branch=main "$temp_dir/repository" >/dev/null
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
