#!/usr/bin/env bash
# Exercises the merge step of merge-live-base/action.yml against throwaway
# git repos: a PR head merged with an advanced base produces the three
# advertised outputs, and a conflicting base fails the step via git's own
# exit code rather than silently testing a misleading tree.
set -euo pipefail

action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# Extract the step's `run: |` block from action.yml so the test always
# exercises the shipped bytes (this action keeps its logic inline). The
# block is every 8-space-indented line following `run: |`, dedented.
run_script="$test_root/merge-step.sh"
awk '
  /^      run: \|/ { in_run = 1; next }
  in_run && (/^        / || /^$/) { sub(/^        /, ""); print; next }
  in_run { exit }
' "$action_dir/action.yml" > "$run_script"
grep -q 'check-ref-format' "$run_script" || fail "run-script extraction came up empty"

# GitHub runs `run:` steps under `bash -e -o pipefail`; the action's script
# relies on that for its fail-on-conflict behavior, so mirror it here.
run_step() {
  bash -e -o pipefail "$run_script"
}

make_repo() {
  local dir="$1"
  git init -q -b main "$dir"
  git -C "$dir" -c user.name=test -c user.email=t@example.com \
    commit -q --allow-empty -m "root"
}

setup_case() {
  # Layout: bare "origin" cloned into a work repo checked out at a PR head.
  local case_dir="$1" conflicting="$2"
  local upstream="$case_dir/upstream" origin="$case_dir/origin.git" work="$case_dir/work"
  mkdir -p "$case_dir"
  make_repo "$upstream"
  echo base-v1 > "$upstream/shared.txt"
  git -C "$upstream" add shared.txt
  git -C "$upstream" -c user.name=test -c user.email=t@example.com commit -q -m "base v1"
  git clone -q --bare "$upstream" "$origin"
  git clone -q "$origin" "$work"

  # PR head: branch from main, edit a PR-only file (or the shared file for
  # the conflict case).
  git -C "$work" checkout -q -b feature
  if [ "$conflicting" = conflict ]; then
    echo pr-edit > "$work/shared.txt"
  else
    echo pr-only > "$work/feature.txt"
  fi
  git -C "$work" add .
  git -C "$work" -c user.name=test -c user.email=t@example.com commit -q -m "pr head"

  # Advance the live base past the PR's fork point.
  git -C "$upstream" pull -q "$origin" main
  echo base-v2 > "$upstream/shared.txt"
  git -C "$upstream" add shared.txt
  git -C "$upstream" -c user.name=test -c user.email=t@example.com commit -q -m "base v2"
  git -C "$upstream" push -q "$origin" main

  echo "$work"
}

# --- Case 1: clean merge emits original_head/live_base/tested_head ---
work="$(setup_case "$test_root/clean" no-conflict)"
pr_head="$(git -C "$work" rev-parse HEAD)"
out_file="$test_root/clean/github-output"
: > "$out_file"
(cd "$work" && BASE_REF=main GITHUB_OUTPUT="$out_file" run_step) \
  || fail "clean merge case must succeed"
grep -q "^original_head=$pr_head$" "$out_file" || fail "original_head must be the pre-merge PR head"
live_base_sha="$(git -C "$work" rev-parse origin/main)"
grep -q "^live_base=$live_base_sha$" "$out_file" || fail "live_base must be the fetched origin/main"
tested_head="$(git -C "$work" rev-parse HEAD)"
grep -q "^tested_head=$tested_head$" "$out_file" || fail "tested_head must be the merge commit"
test "$tested_head" != "$pr_head" || fail "a merge commit must have been created"
git -C "$work" merge-base --is-ancestor "$live_base_sha" HEAD || fail "the live base must be an ancestor of the tested head"

# --- Case 2: a conflicting base fails via git merge's own exit code ---
work="$(setup_case "$test_root/conflict" conflict)"
out_file="$test_root/conflict/github-output"
: > "$out_file"
if (cd "$work" && BASE_REF=main GITHUB_OUTPUT="$out_file" run_step) 2>/dev/null; then
  fail "a conflicting base must fail the step"
fi
grep -q "^tested_head=" "$out_file" && fail "no tested_head may be emitted on a failed merge"

# --- Case 3: an invalid base ref is rejected before any fetch ---
work="$(setup_case "$test_root/badref" no-conflict)"
if (cd "$work" && BASE_REF='-bad..ref' GITHUB_OUTPUT=/dev/null run_step) 2>/dev/null; then
  fail "an invalid base ref must be rejected"
fi

echo "merge-live-base.test.sh: all cases passed"
