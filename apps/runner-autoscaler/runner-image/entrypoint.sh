#!/bin/bash
set -e

node24_runs() {
  /home/runner/externals/node24/bin/node --version >/dev/null 2>&1
}

# Serialize the externals populate across concurrently starting runners on the
# same host: externals is a shared bind mount on socket-mounted scale sets, and
# two first-boot runners racing the copy can tear each other's files. The lock
# lives in _work (shared whenever externals is; container-local otherwise, where
# the lock is uncontended and harmless). Dotfile: the workdir sweep's top-level
# glob only matches directories.
mkdir -p /home/runner/_work
exec 9>/home/runner/_work/.externals-populate.lock
flock 9

# externals is a shared, PERSISTENT bind mount on ShareWorkDir hosts: it
# outlives any single runner container and is never wiped, so a directory
# that already contains something isn't necessarily healthy. A host last
# populated before node24 existed there, or left mid-copy by a killed
# container, stays broken forever unless something actually RUNS node24
# instead of just stat'ing it -- a `cp` killed mid-write can leave a
# truncated binary that keeps its executable bit, which an `-x` test alone
# would wrongly call healthy and never repair (supersprinklesracing/sprinkles#3959,
# #3960: actions/checkout@v7 invokes externals/node24/bin/node directly and
# two unrelated e2e hosts were both stuck missing it).
if ! node24_runs; then
  echo "Populating /home/runner/externals from backup (node24 missing or unusable)..."
  mkdir -p /home/runner/externals
  cp -r /home/runner/externals_backup/. /home/runner/externals/
fi

flock -u 9
exec 9>&-

# Preflight: fail the boot loudly if node24 STILL doesn't run after that
# repair attempt (e.g. externals_backup itself is broken), rather than
# silently proceeding to run.sh, which registers with GitHub and can accept
# a real job doomed to fail before checkout even starts. A container that
# exits here without registering is swept by the scaler's existing
# crash-loop/orphan cleanup (see deregisterRunner), the same path already
# used for a dead host or a crash-looping image.
if ! node24_runs; then
  echo "FATAL: /home/runner/externals/node24/bin/node failed a preflight invocation" >&2
  exit 1
fi

# Execute the runner's standard run script with passed arguments
exec /home/runner/run.sh "$@"
