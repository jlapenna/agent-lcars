#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=externals-health.sh
source "$here/externals-health.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

AGENT_LCARS_EXTERNALS_DIR="$tmp/externals"
AGENT_LCARS_EXTERNALS_BACKUP_DIR="$tmp/externals_backup"
AGENT_LCARS_WORK_DIR="$tmp/work"

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
make_runtime "$AGENT_LCARS_EXTERNALS_BACKUP_DIR" node20 0
make_runtime "$AGENT_LCARS_EXTERNALS_BACKUP_DIR" node24 0

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
repair_externals_if_needed
required_node_runtimes_run || {
  echo "missing node20 runtime was not repaired" >&2
  exit 1
}

# Invocation matters: an executable-but-broken runtime must also trigger repair.
make_runtime "$AGENT_LCARS_EXTERNALS_DIR" node24 1
if required_node_runtimes_run; then
  echo "broken node24 runtime was accepted" >&2
  exit 1
fi
repair_externals_if_needed
required_node_runtimes_run || {
  echo "broken node24 runtime was not repaired" >&2
  exit 1
}

# Healthy runtimes should not pay the copy cost.
touch "$AGENT_LCARS_EXTERNALS_BACKUP_DIR/backup-only-sentinel"
repair_externals_if_needed
if [[ -e "$AGENT_LCARS_EXTERNALS_DIR/backup-only-sentinel" ]]; then
  echo "healthy externals tree was copied unnecessarily" >&2
  exit 1
fi

echo "externals-health.test.sh: all cases passed"
