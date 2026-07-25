#!/usr/bin/env bash
# Process-management wrapper around sidecar.cjs's `runner sidecar`/`runner
# finalize` subcommands, baked into the runner image alongside it
# (runner-image/Dockerfile). Every consuming dispatch workflow used to
# duplicate this ~30-60 lines of bash inline; that let members drift out
# of sync with agent-lcars for an unknown stretch of time (it was
# missing the finalize half entirely). One script, baked into the image,
# means a fix here reaches every consumer on the next image pull instead
# of needing a hand-applied patch to every workflow file.
#
# Usage (from a GitHub Actions step):
#   /usr/local/lib/agent-lcars/sidecar-lifecycle.sh start
#   /usr/local/lib/agent-lcars/sidecar-lifecycle.sh finalize
#
# Required env: WRITER_CREDENTIALS_FILE, RUN_ID. Optional: NUM
# (issue/PR number). Every failure path logs and exits 0 -- telemetry
# must never fail the job it instruments; callers should still wrap the
# step itself in `continue-on-error: true` as defense in depth.
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
STATE_DIR=/tmp/runner-telemetry
PID_FILE="$STATE_DIR/sidecar.pid"
mkdir -p "$STATE_DIR"

# finalize first stops the still-running `start` daemon (if any) before
# this script's own synchronous run below -- SIGTERM only requests a
# stop, and the daemon could still be mid-flight on an asynchronous
# Firestore write from its last tick. If that write landed after this
# step's own authoritative one, it would silently overwrite the `ended`
# doc's liveness back to a stale live/idle snapshot, so wait (bounded,
# fail-soft) for it to actually exit first.
if [ "$MODE" = finalize ] && [ -f "$PID_FILE" ]; then
  SIDECAR_DAEMON_PID="$(cat "$PID_FILE")"
  kill "$SIDECAR_DAEMON_PID" 2>/dev/null
  for _ in $(seq 1 25); do
    kill -0 "$SIDECAR_DAEMON_PID" 2>/dev/null || break
    sleep 0.2
  done
fi

if [ ! -s "$SIDECAR_BIN" ]; then
  echo "Sidecar tool not found at $SIDECAR_BIN (runner image predates this bake-in); skipping telemetry $MODE."
  exit 0
fi
if [ -z "${WRITER_CREDENTIALS_FILE:-}" ]; then
  echo "No writer credentials file available (telemetry-auth step did not succeed); skipping telemetry $MODE."
  exit 0
fi
if [ -z "${RUN_ID:-}" ]; then
  echo "RUN_ID not set; skipping telemetry $MODE." >&2
  exit 0
fi

ARGS=(runner "$CLI_SUBCOMMAND" --run-id "$RUN_ID" --projects-dir "$HOME/.claude/projects")
if [ -n "${NUM:-}" ]; then
  ARGS+=(--issue-number "$NUM")
fi

if [ "$MODE" = start ]; then
  GOOGLE_APPLICATION_CREDENTIALS="$WRITER_CREDENTIALS_FILE" \
    AGENT_TELEMETRY_PROJECT_ID=agent-lcars \
    nohup node "$SIDECAR_BIN" "${ARGS[@]}" \
    >"$STATE_DIR/sidecar.log" 2>&1 </dev/null &
  echo $! >"$PID_FILE"
  disown
  echo "Telemetry sidecar started (pid $(cat "$PID_FILE"))."
else
  GOOGLE_APPLICATION_CREDENTIALS="$WRITER_CREDENTIALS_FILE" \
    AGENT_TELEMETRY_PROJECT_ID=agent-lcars \
    node "$SIDECAR_BIN" "${ARGS[@]}"
  echo "Telemetry finalize complete."
fi
exit 0
