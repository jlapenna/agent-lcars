#!/usr/bin/env bash
# Proves tools/check-repo-symlinks.sh against the #1255 incident's exact
# failure signature before trusting it: a fixture reproducing the
# self-referential symlink must fail red, a dangling symlink must fail red,
# and a clean tree (including a symlink that resolves fine) must pass green.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

run_check() {
  (cd "$1" && git init --initial-branch=main -q . && "$root/tools/check-repo-symlinks.sh")
}

# Case 1: a self-referential symlink cycle, mirroring the exact incident
# shape (`.agents/skills/debug-agent-run/debug-agent-run` -> its own parent
# directory).
cycle_dir="$temp_dir/cycle"
mkdir -p "$cycle_dir/skill"
ln -s ../skill "$cycle_dir/skill/skill"
if run_check "$cycle_dir" >/dev/null 2>&1; then
  echo "expected a symlink cycle to fail the check" >&2
  exit 1
fi

# Case 2: a dangling symlink with no cycle involved at all.
dangling_dir="$temp_dir/dangling"
mkdir -p "$dangling_dir"
ln -s ./does-not-exist "$dangling_dir/broken"
if run_check "$dangling_dir" >/dev/null 2>&1; then
  echo "expected a dangling symlink to fail the check" >&2
  exit 1
fi

# Case 3: a clean tree, including a symlink that resolves fine, must pass.
clean_dir="$temp_dir/clean"
mkdir -p "$clean_dir/real-target"
ln -s ./real-target "$clean_dir/link"
if ! run_check "$clean_dir" >/dev/null 2>&1; then
  echo "expected a clean tree with a resolvable symlink to pass the check" >&2
  exit 1
fi

echo "ok: check-repo-symlinks.sh catches cycles and dangling links, passes a clean tree"
