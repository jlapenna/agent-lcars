#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=externals-health.sh
source "$here/externals-health.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

AGENT_LCARS_EXTERNALS_DIR="$tmp/externals"

make_runtime() {
  root="$1"
  runtime="$2"
  status="$3"
  mkdir -p "$root/$runtime/bin"
  printf '#!/bin/sh\nexit %s\n' "$status" >"$root/$runtime/bin/node"
  chmod +x "$root/$runtime/bin/node"
}

make_runtime "$AGENT_LCARS_EXTERNALS_DIR" node20 0
make_runtime "$AGENT_LCARS_EXTERNALS_DIR" node24 0
required_node_runtimes_run || {
  echo "healthy node20/node24 runtimes were rejected" >&2
  exit 1
}

# A healthy node24 must not mask a missing node20 dependency.
rm -rf "$AGENT_LCARS_EXTERNALS_DIR/node20"
if required_node_runtimes_run; then
  echo "missing node20 runtime was accepted" >&2
  exit 1
fi

# Restore the fixture before checking a broken executable independently.
make_runtime "$AGENT_LCARS_EXTERNALS_DIR" node20 0

# Invocation matters: an executable-but-broken runtime must also trigger repair.
make_runtime "$AGENT_LCARS_EXTERNALS_DIR" node24 1
if required_node_runtimes_run; then
  echo "broken node24 runtime was accepted" >&2
  exit 1
fi
echo "externals-health.test.sh: all cases passed"
