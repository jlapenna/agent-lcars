#!/bin/bash
set -e

# Repairs the shared /home/runner/externals bind mount before ever
# registering with GitHub. share_workdir (homelab orchestrator.yml) mounts
# the HOST's /home/runner/externals over whatever this image baked in at
# COPY time -- on a host neither this pool nor any other share_workdir pool
# has ever populated, that host path starts out empty (or root-owned, if
# dockerd auto-created it), which would otherwise make actions/checkout@v7
# (a JS action needing externals/node24) fail before the E2E suite ever
# starts (caught in PR #930 review). Reuses the exact same shared
# repair/preflight logic the generic JIT worker image's own entrypoint.sh
# uses -- see externals-health.sh's own header for why one shared copy
# matters (this same tree is also swept by the control plane's periodic
# idle-host maintenance job, scaler.go:sweepHostWorkDir).
# shellcheck source=/usr/local/lib/agent-lcars/externals-health.sh
source /usr/local/lib/agent-lcars/externals-health.sh

repair_externals_if_needed

# Fail the boot loudly if node24/node20 still don't run after that repair
# attempt (e.g. externals_backup itself is broken), rather than silently
# proceeding to run.sh, which registers with GitHub and can accept a real
# job doomed to fail before checkout even starts.
if ! required_node_runtimes_run; then
  echo "FATAL: required Actions runtimes node20/node24 failed a preflight invocation" >&2
  exit 1
fi

exec /home/runner/run.sh "$@"
