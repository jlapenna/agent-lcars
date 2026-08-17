#!/usr/bin/env bash
# Report when a consumer repo's copy of a file this repo owns has drifted.
#
# AGENTS.md forbids cross-repository source imports, so the fleet's shared
# scripts exist as copies rather than a shared dependency. Copies drift in
# silence; this makes them drift loudly instead (#1307, #1311).
#
# This is a read-only comparison, not a build dependency: nothing here is
# imported, compiled, or linked into an artifact. Consumers are fetched with
# `git archive`-style shallow reads and discarded.
#
# Usage:
#   check-cross-repo-drift.sh [--manifest <path>] [--fetch-root <dir>]
#
# --fetch-root points at a directory that already contains checkouts named
# after each consumer repo (used by the test, and by anyone running this
# against local clones). Without it, consumers are cloned shallow into a
# temporary directory.
#
# Exit 0 = every listed pair matches. Exit 1 = at least one pair drifted, or
# a listed path is missing. Missing is a failure, not a skip: a file that
# vanished from a consumer is exactly the drift worth catching.

set -euo pipefail

MANIFEST="$(dirname "${BASH_SOURCE[0]}")/cross-repo-drift.conf"
FETCH_ROOT=""
OWNER="${CROSS_REPO_DRIFT_OWNER:-jlapenna}"

while [ $# -gt 0 ]; do
  case "$1" in
    --manifest) MANIFEST="$2"; shift 2 ;;
    --fetch-root) FETCH_ROOT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ ! -f "$MANIFEST" ]; then
  echo "manifest not found: $MANIFEST" >&2
  exit 2
fi

repo_url() {
  case "$1" in
    sprinkles) echo "https://github.com/supersprinklesracing/sprinkles.git" ;;
    *) echo "https://github.com/$OWNER/$1.git" ;;
  esac
}

cleanup_root=""
trap '[ -n "$cleanup_root" ] && rm -rf "$cleanup_root"' EXIT

if [ -z "$FETCH_ROOT" ]; then
  cleanup_root="$(mktemp -d)"
  FETCH_ROOT="$cleanup_root"
  fetch_needed=1
else
  fetch_needed=0
fi

drifted=0
checked=0

while read -r line; do
  case "$line" in ''|\#*) continue ;; esac
  # shellcheck disable=SC2086 -- deliberate word splitting across the pair list
  set -- $line
  canonical="$1"; shift

  if [ ! -f "$canonical" ]; then
    echo "  MISSING canonical $canonical" >&2
    drifted=$((drifted + 1))
    continue
  fi

  for pair in "$@"; do
    repo="${pair%%:*}"
    path="${pair#*:}"
    root="$FETCH_ROOT/$repo"

    if [ "$fetch_needed" = 1 ] && [ ! -d "$root" ]; then
      git clone --depth 1 --quiet --filter=blob:none --no-checkout \
        "$(repo_url "$repo")" "$root" 2>/dev/null || {
        echo "  UNREACHABLE $repo (clone failed)" >&2
        drifted=$((drifted + 1))
        continue
      }
      git -C "$root" checkout --quiet HEAD -- . 2>/dev/null || true
    fi

    checked=$((checked + 1))
    if [ ! -f "$root/$path" ]; then
      echo "  MISSING  $repo:$path (canonical: $canonical)" >&2
      drifted=$((drifted + 1))
    elif ! cmp -s "$canonical" "$root/$path"; then
      echo "  DRIFTED  $repo:$path differs from $canonical" >&2
      drifted=$((drifted + 1))
    fi
  done
done < "$MANIFEST"

if [ "$drifted" -gt 0 ]; then
  echo "cross-repo drift: $drifted of $checked copies differ" >&2
  exit 1
fi

echo "cross-repo drift OK: $checked copies match"
