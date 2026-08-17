#!/usr/bin/env bash
# The fleet-script drift tripwire (agent-lcars#1307). For every declared
# `canonical-path[=consumer-path]` entry this asserts, in the consumer
# checkout:
#
#   1. the vendored copy exists and is BYTE-IDENTICAL to the canonical
#      copy shipped alongside this action (the cross-repo `uses:` download
#      contains the whole agent-lcars repo, so the canonical bytes are
#      already on disk - no network fetch, no pin to go stale), and
#   2. no stray copy of that script's basename exists anywhere else in the
#      checkout - the failure mode this issue exists to close is a local
#      copy quietly growing back.
#
# Repo-specific behavior never justifies editing a vendored copy: each
# canonicalized script documents its parameterization hooks (arguments,
# environment variables, a sibling conf file) in its own header.
#
# Environment (the action supplies SCRIPTS; the rest default for CI):
#   SCRIPTS         newline-separated canonical-path[=consumer-path] entries
#   CANONICAL_ROOT  agent-lcars checkout root (default: this action's repo
#                   download, $GITHUB_ACTION_PATH/../../..)
#   CONSUMER_ROOT   consumer checkout root (default: $GITHUB_WORKSPACE, or
#                   the working directory outside Actions)
set -euo pipefail

: "${SCRIPTS:?newline-separated canonical-path[=consumer-path] entries}"
CANONICAL_ROOT="${CANONICAL_ROOT:-${GITHUB_ACTION_PATH:?}/../../..}"
CONSUMER_ROOT="${CONSUMER_ROOT:-${GITHUB_WORKSPACE:-$PWD}}"
CANONICAL_ROOT="$(cd "$CANONICAL_ROOT" && pwd)"
CONSUMER_ROOT="$(cd "$CONSUMER_ROOT" && pwd)"

failures=0
fail() {
  echo "::error::verify-fleet-scripts: $1"
  failures=$((failures + 1))
}

resync_hint() {
  echo "curl -fsSL https://raw.githubusercontent.com/jlapenna/agent-lcars/main/$1 -o $2"
}

basenames=()
declared_paths=()

while IFS= read -r entry; do
  entry="${entry#"${entry%%[![:space:]]*}"}"
  entry="${entry%"${entry##*[![:space:]]}"}"
  [ -n "$entry" ] || continue
  case "$entry" in \#*) continue ;; esac
  canonical_path="${entry%%=*}"
  consumer_path="${entry#*=}"
  canonical_file="$CANONICAL_ROOT/$canonical_path"
  consumer_file="$CONSUMER_ROOT/$consumer_path"

  if [ ! -f "$canonical_file" ]; then
    fail "canonical file $canonical_path is missing from the agent-lcars download; fix the scripts input (or the action's default list)"
    continue
  fi
  basenames+=("$(basename "$canonical_path")")
  declared_paths+=("$consumer_path")

  if [ ! -f "$consumer_file" ]; then
    fail "$consumer_path is missing; vendor the canonical copy: $(resync_hint "$canonical_path" "$consumer_path")"
    continue
  fi
  if ! cmp -s "$canonical_file" "$consumer_file"; then
    fail "$consumer_path drifted from canonical jlapenna/agent-lcars:$canonical_path; re-sync it verbatim ($(resync_hint "$canonical_path" "$consumer_path")) and move any repo-specific change into the script's documented hooks instead"
  fi
done <<<"$SCRIPTS"

# Stray-copy sweep: a canonicalized script's basename may exist ONLY at its
# declared path. Skips .git, node_modules, and .claude/worktrees (nested
# working copies are not this checkout's own files).
if [ "${#basenames[@]}" -gt 0 ]; then
  i=0
  for base in "${basenames[@]}"; do
    declared="${declared_paths[$i]}"
    i=$((i + 1))
    while IFS= read -r found; do
      rel="${found#"$CONSUMER_ROOT"/}"
      [ "$rel" = "$declared" ] && continue
      fail "stray copy of fleet-canonical $base at $rel; the only sanctioned copy is $declared - delete the stray (agent-lcars#1307)"
    done < <(find "$CONSUMER_ROOT" \
      \( -name .git -o -name node_modules -o -path "$CONSUMER_ROOT/.claude/worktrees" \) -prune \
      -o -type f -name "$base" -print)
  done
fi

if [ "$failures" -gt 0 ]; then
  echo "::error::verify-fleet-scripts: $failures problem(s). Canonical home: jlapenna/agent-lcars (#1307); never patch a vendored copy in place."
  exit 1
fi
echo "verify-fleet-scripts: every vendored fleet script matches its canonical copy."
