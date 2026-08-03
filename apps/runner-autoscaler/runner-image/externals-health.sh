# Shared by entrypoint.sh (real runner boot, agent-lcars#3959-class fix) and
# the control plane's periodic idle-host maintenance sweep
# (scaler.go:sweepHostWorkDir, agent-lcars#392), so both call sites use
# IDENTICAL self-heal logic instead of two copies that can drift apart.
# Sourced, not executed -- written in portable POSIX sh so it works whether
# the caller is bash (entrypoint.sh) or the maintenance container's `sh -c`.

node24_runs() {
  /home/runner/externals/node24/bin/node --version >/dev/null 2>&1
}

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
#
# Serializes against every other caller on the same host (a concurrently
# booting runner's own entrypoint.sh, or another maintenance sweep) via the
# same lock file, so two racing repairs can never tear each other's copy.
repair_externals_if_needed() {
  mkdir -p /home/runner/_work
  exec 9>/home/runner/_work/.externals-populate.lock
  flock 9
  if ! node24_runs; then
    echo "Populating /home/runner/externals from backup (node24 missing or unusable)..."
    mkdir -p /home/runner/externals
    cp -r /home/runner/externals_backup/. /home/runner/externals/
  fi
  flock -u 9
  exec 9>&-
}
