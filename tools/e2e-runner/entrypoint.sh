#!/bin/bash
set -e

# Verify the Actions runtimes baked into this container before registering
# with GitHub.
# shellcheck source=/usr/local/lib/agent-lcars/externals-health.sh
source /usr/local/lib/agent-lcars/externals-health.sh

# Fail the boot loudly if Node 24 or its migration control is unavailable, rather than silently
# proceeding to run.sh, which registers with GitHub and can accept a real
# job doomed to fail before checkout even starts.
if ! required_node_runtimes_run; then
  echo "FATAL: required Actions Node 24 migration/runtime failed a preflight invocation" >&2
  exit 1
fi

exec /home/runner/run.sh "$@"
