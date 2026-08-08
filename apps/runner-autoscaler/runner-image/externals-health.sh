#!/bin/sh
# Shared by entrypoint.sh (real runner boot, agent-lcars#3959-class fix) and
# the control plane's periodic idle-host maintenance sweep
# (scaler.go:sweepHostWorkDir, agent-lcars#392), so both call sites use
# IDENTICAL self-heal logic instead of two copies that can drift apart.
# Sourced, not executed -- written in portable POSIX sh so it works whether
# the caller is bash (entrypoint.sh) or the maintenance container's `sh -c`.

node_runtime_runs() {
  "${AGENT_LCARS_EXTERNALS_DIR:-/home/runner/externals}/$1/bin/node" \
    --version >/dev/null 2>&1
}

node20_runs() {
  node_runtime_runs node20
}

node24_runs() {
  node_runtime_runs node24
}

# These are the non-Alpine runtimes proven reachable from actions used by the
# fleet: current first-party actions use node24, while OpenCode's pinned
# composite still calls actions/cache@v4, which declares node20 (#395). Do not
# probe every backup entry on every boot; add another runtime here only when a
# dispatched action demonstrates that dependency.
required_node_runtimes_run() {
  node20_runs && node24_runs
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
# two unrelated e2e hosts were both stuck missing it). A healthy node24 also
# cannot prove node20 is usable; both currently required runtimes must run.
#
# Serializes against every other caller on the same host (a concurrently
# booting runner's own entrypoint.sh, or another maintenance sweep) via the
# same lock file, so two racing repairs can never tear each other's copy.
#
# The maintenance sweep runs this as root (scaler.go:sweepHostWorkDir), while
# a real runner's entrypoint.sh runs it as the unprivileged `runner` user. If
# root's sweep is ever the FIRST caller to touch this lock on a given host
# (e.g. a newly onboarded host, or the fleet-wide sweep's initial pass on
# control-plane startup racing ahead of any real runner there), opening it
# for write creates it root-owned at the default umask -- not writable by
# `runner` -- and every subsequent real runner's own `exec 9>` on this same
# file would then fail permission-denied before it ever reaches the
# node24 check at all. touch+chmod unconditionally, before opening: root's
# own chmod always succeeds regardless of the file's prior owner (root
# bypasses the owner check), self-healing this the same way node24 itself
# gets self-healed below; a non-root caller's chmod attempt on a file it
# doesn't already own harmlessly fails and is ignored -- the mode root
# already set stands.
repair_externals_if_needed() (
  work_dir="${AGENT_LCARS_WORK_DIR:-/home/runner/_work}"
  externals_dir="${AGENT_LCARS_EXTERNALS_DIR:-/home/runner/externals}"
  backup_dir="${AGENT_LCARS_EXTERNALS_BACKUP_DIR:-/home/runner/externals_backup}"
  lock_file="$work_dir/.externals-populate.lock"

  mkdir -p "$work_dir"
  touch "$lock_file" 2>/dev/null || true
  chmod 0666 "$lock_file" 2>/dev/null || true
  exec 9>"$lock_file"
  flock 9
  if ! required_node_runtimes_run; then
    echo "Populating $externals_dir from backup (required Node runtime missing or unusable)..."
    mkdir -p "$externals_dir"
    cp -r "$backup_dir"/. "$externals_dir"/
  fi
  flock -u 9
  exec 9>&-
)
