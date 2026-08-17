#!/usr/bin/env bash
# Exercises verify-fleet-scripts.sh's real failure modes against fixture
# trees (no git, no network): pass, drift, missing copy, path mapping,
# stray-copy detection with its pruned directories, and a missing
# canonical file. Deliberately no "run it against this repo" case - that
# comparison is file-vs-itself and can only pass vacuously.
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify-fleet-scripts.sh"
temp_dir="$(mktemp -d)"
cleanup() { rm -rf "$temp_dir"; }
trap cleanup EXIT

canonical="$temp_dir/canonical"
consumer="$temp_dir/consumer"
mkdir -p "$canonical/tools" "$consumer/tools" "$consumer/bin"
printf '#!/bin/sh\necho guardrail v2\n' >"$canonical/tools/guardrail.cjs"
printf '#!/bin/sh\necho watcher\n' >"$canonical/tools/watch.sh"

run() {
  status=0
  output="$(SCRIPTS="$1" CANONICAL_ROOT="$canonical" CONSUMER_ROOT="$consumer" \
    bash "$script" 2>&1)" || status=$?
}

expect() {
  case "$output" in
    *"$1"*) ;;
    *)
      echo "expected output to contain '$1', got:" >&2
      printf '%s\n' "$output" >&2
      exit 1
      ;;
  esac
}

# 1. Byte-identical copies pass, including a path-mapped entry and ignored
#    blank/comment lines.
cp "$canonical/tools/guardrail.cjs" "$consumer/bin/guardrail.cjs"
cp "$canonical/tools/watch.sh" "$consumer/tools/watch.sh"
run $'# fleet scripts\n\ntools/guardrail.cjs=bin/guardrail.cjs\ntools/watch.sh'
test "$status" = 0 || { echo "identical copies must pass: $output" >&2; exit 1; }
expect 'matches its canonical copy'

# 2. A drifted copy fails, naming the consumer path and the re-sync command.
printf '#!/bin/sh\necho guardrail v1 PATCHED\n' >"$consumer/bin/guardrail.cjs"
run $'tools/guardrail.cjs=bin/guardrail.cjs\ntools/watch.sh'
test "$status" = 1 || { echo "drift must fail" >&2; exit 1; }
expect 'bin/guardrail.cjs drifted from canonical jlapenna/agent-lcars:tools/guardrail.cjs'
expect 'curl -fsSL https://raw.githubusercontent.com/jlapenna/agent-lcars/main/tools/guardrail.cjs -o bin/guardrail.cjs'
cp "$canonical/tools/guardrail.cjs" "$consumer/bin/guardrail.cjs"

# 3. A missing vendored copy fails and names the vendor command.
rm "$consumer/tools/watch.sh"
run $'tools/guardrail.cjs=bin/guardrail.cjs\ntools/watch.sh'
test "$status" = 1 || { echo "missing copy must fail" >&2; exit 1; }
expect 'tools/watch.sh is missing'
cp "$canonical/tools/watch.sh" "$consumer/tools/watch.sh"

# 4. A stray duplicate at an undeclared path fails even when the declared
#    copy is pristine - the "local copy grows back" tripwire.
mkdir -p "$consumer/scripts"
cp "$canonical/tools/guardrail.cjs" "$consumer/scripts/guardrail.cjs"
run $'tools/guardrail.cjs=bin/guardrail.cjs\ntools/watch.sh'
test "$status" = 1 || { echo "stray copy must fail" >&2; exit 1; }
expect 'stray copy of fleet-canonical guardrail.cjs at scripts/guardrail.cjs'
rm -r "$consumer/scripts"

# 5. Pruned directories never count as strays.
mkdir -p "$consumer/node_modules/x" "$consumer/.git/hooks" "$consumer/.claude/worktrees/w/tools"
cp "$canonical/tools/guardrail.cjs" "$consumer/node_modules/x/guardrail.cjs"
cp "$canonical/tools/guardrail.cjs" "$consumer/.git/hooks/guardrail.cjs"
cp "$canonical/tools/guardrail.cjs" "$consumer/.claude/worktrees/w/tools/guardrail.cjs"
run $'tools/guardrail.cjs=bin/guardrail.cjs\ntools/watch.sh'
test "$status" = 0 || { echo "pruned dirs must not count as strays: $output" >&2; exit 1; }

# 6. A canonical path absent from the agent-lcars download fails loudly
#    (typo in the scripts input, or a manifest naming a moved file).
run 'tools/no-such-script.sh'
test "$status" = 1 || { echo "missing canonical file must fail" >&2; exit 1; }
expect 'canonical file tools/no-such-script.sh is missing'

echo 'verify-fleet-scripts.test.sh: all cases passed'
