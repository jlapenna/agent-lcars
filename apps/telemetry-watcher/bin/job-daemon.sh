#!/usr/bin/env bash
# Generic per-name background-process lifecycle, extracted from
# sidecar-lifecycle.sh (agent-lcars#1246) so a second long-lived in-job
# daemon (agent-lcars#1240's log shipper) does not have to duplicate this
# ~30-60 lines of bash a second time. Baked into the runner image alongside
# sidecar-lifecycle.sh (runner-image/Dockerfile); sidecar-lifecycle.sh is
# now a thin telemetry-specific wrapper over this script.
#
# Usage:
#   job-daemon.sh start <name> [--log <path>] -- <cmd...>
#   job-daemon.sh stop  <name>
#
# Per-<name> state lives in its own dir under a state root (default
# /tmp/agent-lcars-job-daemon, overridable via
# AGENT_LCARS_JOB_DAEMON_STATE_ROOT so tests never touch the real path)
# holding nothing but a PID file. Two different <name>s get two different
# state dirs and can never share or clobber each other's PID.
#
# --log defaults to /dev/null, not a file under the state dir. This is
# deliberate and load-bearing, not an oversight: fleet disk is tight
# (laforge's docker-root, where /tmp lands, sits at 81% full -- see
# agent-lcars#1246's own disk survey), so a new consumer of this daemon
# must explicitly opt into disk usage with --log <path> rather than
# silently inheriting a log file the way a naive default would. A daemon
# that never asks for --log leaves nothing behind but its PID file.
#
# <name> must be a simple identifier ([A-Za-z0-9_-]+) -- no `/`, no `..`,
# no leading `-` that could be misread as a flag. That is what keeps it
# safe to interpolate directly into a filesystem path below: a name can
# never escape its own state dir.
#
# Never-fail contract, mirroring sidecar-lifecycle.sh's own hard rule that
# a background job-instrumentation daemon must never fail the job that
# started it: every failure path here logs (to stderr) and exits 0,
# including a malformed invocation. `stop` on a <name> that was never
# started, or whose process has already exited, is success, not an error.
set -u

STATE_ROOT="${AGENT_LCARS_JOB_DAEMON_STATE_ROOT:-/tmp/agent-lcars-job-daemon}"

usage() {
  echo "job-daemon: $1" >&2
  echo "job-daemon: usage: $(basename "$0") start <name> [--log <path>] -- <cmd...>" >&2
  echo "job-daemon:        $(basename "$0") stop  <name>" >&2
  exit 0
}

MODE="${1:-}"
NAME="${2:-}"

case "$MODE" in
  start | stop) ;;
  *) usage "unknown or missing mode '$MODE' (expected start|stop)" ;;
esac

case "$NAME" in
  '' | -* | *[!A-Za-z0-9_-]*)
    usage "invalid or missing daemon name '$NAME' (must start with a letter, digit, or underscore, and match [A-Za-z0-9_-]+ overall; no path separators or '..')"
    ;;
esac

# Everything past `<mode> <name>` is mode-specific; this is a slice, not a
# `shift`, so it stays well-defined under `set -u` even when nothing
# follows.
set -- "${@:3}"

STATE_DIR="$STATE_ROOT/$NAME"
PID_FILE="$STATE_DIR/daemon.pid"

if [ "$MODE" = start ]; then
  LOG_FILE=/dev/null
  if [ "${1:-}" = --log ]; then
    LOG_FILE="${2:-}"
    [ -n "$LOG_FILE" ] || usage "--log requires a path"
    set -- "${@:3}"
  fi
  [ "${1:-}" = -- ] || usage "expected -- before <cmd...>"
  set -- "${@:2}"
  [ "$#" -gt 0 ] || usage "no <cmd...> given"

  # Never spawn a daemon we cannot then track -- if the state dir can't be
  # created, there is nowhere to record its PID, so don't start it.
  if ! mkdir -p "$STATE_DIR" 2>/dev/null; then
    echo "job-daemon: could not create state dir $STATE_DIR; skipping start of '$NAME'." >&2
    exit 0
  fi
  # Best-effort: an explicit --log path whose directory doesn't exist yet
  # would otherwise make the redirection below fail closed (no directory
  # for the shell to open the file in), silently preventing the command
  # from ever starting. /dev/null's parent always exists, so this is a
  # no-op on the default.
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true

  nohup "$@" >"$LOG_FILE" 2>&1 </dev/null &
  pid=$!
  if ! echo "$pid" >"$PID_FILE" 2>/dev/null; then
    echo "job-daemon: could not record pid for '$NAME' at $PID_FILE; stopping it so it doesn't leak untracked." >&2
    kill "$pid" 2>/dev/null
    exit 0
  fi
  disown
  echo "job-daemon: started '$NAME' (pid $pid)."
  exit 0
fi

# stop
if [ ! -s "$PID_FILE" ]; then
  echo "job-daemon: '$NAME' was never started (no pid file); nothing to stop."
  exit 0
fi
pid="$(cat "$PID_FILE" 2>/dev/null)"
rm -f "$PID_FILE"
case "$pid" in
  '' | *[!0-9]*)
    echo "job-daemon: '$NAME' pid file was invalid; nothing to stop." >&2
    exit 0
    ;;
esac

# Bounded wait, not a blocking `wait`: this pid was disowned by a previous
# `start` invocation (possibly a different process entirely, since jobs
# are not inherited across shells), so it is not this shell's child and
# `wait` cannot observe it. kill -0 polling is the only way to check
# liveness. 25 iterations * 0.2s = up to 5s, matching sidecar-lifecycle.sh's
# original bound; do not make this open-ended -- stop must itself return
# in bounded time so it composes with a synchronous step run after it.
kill "$pid" 2>/dev/null
for _ in $(seq 1 25); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.2
done
echo "job-daemon: stopped '$NAME' (pid $pid)."
exit 0
