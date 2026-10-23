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

export FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true
make_runtime "$AGENT_LCARS_EXTERNALS_DIR" node24 0
required_node_runtimes_run || {
  echo "healthy Node 24 runtime was rejected" >&2
  exit 1
}

# A healthy runtime must not mask a missing migration control.
unset FORCE_JAVASCRIPT_ACTIONS_TO_NODE24
if required_node_runtimes_run; then
  echo "missing Node 24 migration control was accepted" >&2
  exit 1
fi

# Restore the control before checking a broken executable independently.
export FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true

# Invocation matters: an executable-but-broken runtime must also trigger repair.
make_runtime "$AGENT_LCARS_EXTERNALS_DIR" node24 1
if required_node_runtimes_run; then
  echo "broken node24 runtime was accepted" >&2
  exit 1
fi
echo "externals-health.test.sh: all cases passed"
