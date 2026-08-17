#!/usr/bin/env bash
# Fail when this repo's copy of a file agent-lcars owns has drifted.
#
# Runs *inside a consumer repo*. agent-lcars is public, so the canonical file
# is readable without credentials; the consumer needs no cross-repo token and
# agent-lcars needs no access to the consumer. That direction is deliberate:
# AGENTS.md makes consumers depend on agent-lcars, never the reverse.
#
# Shared fleet scripts exist as byte-identical copies rather than a shared
# dependency because AGENTS.md forbids cross-repository source imports
# (agent-lcars#1307, #1311). Copies drift in silence. This makes them loud.
#
# Manifest format (one pair per line, in the consumer repo):
#   <path-in-this-repo> <path-in-agent-lcars>
#
# Exit 0 = every pair matches.
# Exit 1 = at least one pair drifted or is missing -- a real finding.
# Exit 2 = bad usage.
# Exit 3 = the canonical source could not be fetched. Deliberately distinct:
#          an unreachable source is an infrastructure failure, never a
#          finding, and must not be reported as drift.

set -uo pipefail

MANIFEST=".github/canonical-sync.conf"
REF="${CANONICAL_SYNC_REF:-main}"
BASE="${CANONICAL_SYNC_BASE:-https://raw.githubusercontent.com/jlapenna/agent-lcars}"

while [ $# -gt 0 ]; do
  case "$1" in
    --manifest) MANIFEST="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -f "$MANIFEST" ] || { echo "manifest not found: $MANIFEST" >&2; exit 2; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

drifted=0
checked=0

while read -r local canonical _rest; do
  case "$local" in ''|\#*) continue ;; esac
  [ -n "${canonical:-}" ] || { echo "  malformed manifest line: $local" >&2; exit 2; }

  out="$tmp/canonical"
  if ! curl -fsSL --retry 3 --retry-delay 2 -o "$out" "$BASE/$REF/$canonical"; then
    echo "  UNFETCHABLE $canonical from $BASE/$REF" >&2
    echo "  (infrastructure failure, not drift -- not reporting this as a finding)" >&2
    exit 3
  fi

  checked=$((checked + 1))
  if [ ! -f "$local" ]; then
    echo "  MISSING  $local (canonical: $canonical)" >&2
    drifted=$((drifted + 1))
  elif ! cmp -s "$local" "$out"; then
    echo "  DRIFTED  $local differs from agent-lcars $canonical" >&2
    echo "           fix: curl -fsSL $BASE/$REF/$canonical -o $local" >&2
    drifted=$((drifted + 1))
  fi
done < "$MANIFEST"

if [ "$drifted" -gt 0 ]; then
  echo "canonical sync: $drifted of $checked file(s) differ from agent-lcars" >&2
  exit 1
fi

echo "canonical sync OK: $checked file(s) match agent-lcars@$REF"
