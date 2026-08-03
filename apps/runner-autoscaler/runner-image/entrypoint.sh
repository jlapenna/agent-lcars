#!/bin/bash
set -e

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
# outlives any single runner container and is never wiped, so "non-empty"
# does not mean "matches this image's backup". A host last populated by an
# older image (before a runtime was added upstream) or left mid-copy by a
# killed container gets a directory that is non-empty but still missing an
# entry the CURRENT job needs -- and then stays that way forever, since
# nothing here ever re-checks it (supersprinklesracing/sprinkles#3959,
# #3960: actions/checkout@v7 invokes externals/node24/bin/node directly
# and two unrelated e2e hosts were both stuck missing it). Check for the
# specific executable actions/checkout@v7 needs rather than trusting
# emptiness, and resync from backup whenever it's missing so a stale host
# self-heals instead of silently running a runtime set frozen from
# whenever it first onboarded.
if [ ! -x "/home/runner/externals/node24/bin/node" ]; then
  echo "Populating /home/runner/externals from backup (node24 missing)..."
  mkdir -p /home/runner/externals
  cp -r /home/runner/externals_backup/. /home/runner/externals/
fi

flock -u 9
exec 9>&-

# Preflight: fail the boot loudly if node24 still doesn't run, rather than
# silently proceeding to run.sh, which registers with GitHub and can accept
# a real job doomed to fail before checkout even starts. A container that
# exits here without registering is swept by the scaler's existing
# crash-loop/orphan cleanup (see deregisterRunner), the same path already
# used for a dead host or a crash-looping image.
if ! /home/runner/externals/node24/bin/node --version >/dev/null; then
  echo "FATAL: /home/runner/externals/node24/bin/node failed a preflight invocation" >&2
  exit 1
fi

# Execute the runner's standard run script with passed arguments
exec /home/runner/run.sh "$@"
