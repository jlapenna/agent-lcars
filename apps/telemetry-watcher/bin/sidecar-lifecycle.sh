#!/usr/bin/env bash
# Telemetry-specific process-management wrapper around sidecar.cjs's
# `runner sidecar`/`runner finalize` subcommands, baked into the runner
# image alongside it (runner-image/Dockerfile). The direct runner invokes
# this one image-baked lifecycle for every provider.
#
# agent-lcars#1246: the actual background/PID/bounded-stop-wait/never-fail
# lifecycle mechanics now live in the generic job-daemon.sh, extracted so
# a second in-job daemon (agent-lcars#1240's log shipper) can reuse them
# without a second hand-copy of this bash. This script is left holding
# only what's genuinely telemetry-specific: the credential/RUN_ID guards,
# the sidecar.cjs argument assembly, and composing job-daemon.sh's `stop`
# with the synchronous finalize pass below it.
#
# Usage:
#   /usr/local/lib/agent-lcars/sidecar-lifecycle.sh start
#   /usr/local/lib/agent-lcars/sidecar-lifecycle.sh finalize
#
# Required env: WRITER_CREDENTIALS_FILE, RUN_ID. Optional: NUM
# (issue/PR number), INTENT_ID (orchestrator run id, `broker_intent_id` --
# the join key a work item needs to find its sessions). Every failure path
# logs and exits 0 -- telemetry must never fail the job it instruments;
# callers must treat it as best effort.
set -u

MODE="${1:?usage: $0 start|finalize}"
case "$MODE" in
  start) CLI_SUBCOMMAND=sidecar ;;
  finalize) CLI_SUBCOMMAND=finalize ;;
  *)
    echo "Unknown mode '$MODE' (expected start|finalize)" >&2
    exit 1
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIDECAR_BIN="$SCRIPT_DIR/sidecar.cjs"
JOB_DAEMON_BIN="$SCRIPT_DIR/job-daemon.sh"
DAEMON_NAME=telemetry
# job-daemon.sh owns the PID file now (under its own per-name state dir,
# agent-lcars#1246); this diagnostic log's path is unchanged by that
# extraction -- nothing outside this script reads either path, so there
# was nothing to keep in sync by moving it too.
LOG_FILE=/tmp/runner-telemetry/sidecar.log

# finalize first stops the still-running `start` daemon (if any) before
# this script's own synchronous run below -- SIGTERM only requests a
# stop, and the daemon could still be mid-flight on an asynchronous
# Firestore write from its last tick. If that write landed after this
# step's own authoritative one, it would silently overwrite the `ended`
# doc's liveness back to a stale live/idle snapshot, so wait (bounded,
# fail-soft) for it to actually exit first -- that's job-daemon.sh's own
# `stop`, which blocks for exactly this bounded window before returning.
#
# Do NOT fold this into a single job-daemon.sh call: finalize is "stop,
# THEN run a second synchronous pass" by design (agent-lcars#1246's
# proposal), never a single step -- job-daemon.sh's `stop` only ever
# kills the daemon, it has no idea a synchronous authoritative write
# needs to happen afterward, and folding the two together would remove
# the very ordering guarantee this comment describes.
if [ "$MODE" = finalize ]; then
  if [ ! -x "$JOB_DAEMON_BIN" ]; then
    echo "Telemetry lifecycle contract violation: missing baked job-daemon at $JOB_DAEMON_BIN" >&2
    exit 1
  fi
  "$JOB_DAEMON_BIN" stop "$DAEMON_NAME"
fi

if [ ! -s "$SIDECAR_BIN" ]; then
  echo "Telemetry lifecycle contract violation: missing baked sidecar at $SIDECAR_BIN" >&2
  exit 1
fi
if [ -z "${WRITER_CREDENTIALS_FILE:-}" ]; then
  # The one path that actually reproduces agent-lcars#352's motivating
  # failure: a rejected WIF credential (or any other telemetry-auth step
  # failure) never reaches sidecar.cjs at all, so a warn-annotation added
  # only inside finalize.ts's own upload/upsert catch blocks would be dead
  # code for it -- this guard, shared by both start and finalize, is the
  # earliest common point where that failure is observable.
  echo "::warning::agent-lcars-telemetry-watcher: no writer credentials file available (telemetry-auth step did not succeed); skipping telemetry $MODE, this run's telemetry is lost."
  exit 0
fi
if [ -z "${RUN_ID:-}" ]; then
  echo "RUN_ID not set; skipping telemetry $MODE." >&2
  exit 0
fi

ARGS=(runner "$CLI_SUBCOMMAND" --run-id "$RUN_ID" --projects-dir "$HOME/.claude/projects")
if [ -n "${CODEX_SESSIONS_DIR:-}" ]; then
  ARGS+=(--codex-sessions-dir "$CODEX_SESSIONS_DIR")
fi
if [ -n "${NUM:-}" ]; then
  ARGS+=(--issue-number "$NUM")
fi
if [ -n "${INTENT_ID:-}" ]; then
  ARGS+=(--intent-id "$INTENT_ID")
fi

if [ "$MODE" = start ]; then
  if [ ! -x "$JOB_DAEMON_BIN" ]; then
    echo "Telemetry lifecycle contract violation: missing baked job-daemon at $JOB_DAEMON_BIN" >&2
    exit 1
  fi
  GOOGLE_APPLICATION_CREDENTIALS="$WRITER_CREDENTIALS_FILE" \
    AGENT_TELEMETRY_PROJECT_ID=agent-lcars \
    "$JOB_DAEMON_BIN" start "$DAEMON_NAME" --log "$LOG_FILE" -- \
    node "$SIDECAR_BIN" "${ARGS[@]}"
else
  GOOGLE_APPLICATION_CREDENTIALS="$WRITER_CREDENTIALS_FILE" \
    AGENT_TELEMETRY_PROJECT_ID=agent-lcars \
    node "$SIDECAR_BIN" "${ARGS[@]}"
  echo "Telemetry finalize complete."
fi
exit 0
