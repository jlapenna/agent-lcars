#!/usr/bin/env bash
# Telemetry-specific wrapper around sidecar.cjs's `runner finalize`
# subcommand, baked into the runner image alongside it
# (runner-image/Dockerfile). The direct runner invokes this one image-baked
# lifecycle for every provider once the agent exits.
#
# Live mid-run telemetry comes from provider hooks (`lcars hook`,
# docs/hooks-telemetry-design.md phase 3); the former `start` mode, which
# backgrounded a polling `runner sidecar` through job-daemon.sh, is retired.
# finalize remains the authoritative final write for every run.
#
# Usage:
#   /usr/local/lib/agent-lcars/sidecar-lifecycle.sh finalize
#
# Required env: WRITER_CREDENTIALS_FILE, RUN_ID. Optional: NUM
# (issue/PR number), INTENT_ID (orchestrator run id, `broker_intent_id` --
# the join key a work item needs to find its sessions). Every failure path
# logs and exits 0 -- telemetry must never fail the job it instruments;
# callers must treat it as best effort.
set -u

MODE="${1:?usage: $0 finalize}"
case "$MODE" in
  finalize) CLI_SUBCOMMAND=finalize ;;
  start)
    # Retired. A runner image whose direct-runner.sh predates phase 3 can
    # still pair with this script (the image bakes it from a fresh `main`
    # checkout), so keep `start` a fail-soft no-op rather than an error.
    echo "Telemetry sidecar start is retired (provider hooks report live telemetry); nothing to start."
    exit 0
    ;;
  *)
    echo "Unknown mode '$MODE' (expected finalize)" >&2
    exit 1
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIDECAR_BIN="$SCRIPT_DIR/sidecar.cjs"

if [ ! -s "$SIDECAR_BIN" ]; then
  echo "Telemetry lifecycle contract violation: missing baked sidecar at $SIDECAR_BIN" >&2
  exit 1
fi
if [ -z "${WRITER_CREDENTIALS_FILE:-}" ]; then
  # The one path that actually reproduces agent-lcars#352's motivating
  # failure: a rejected WIF credential (or any other telemetry-auth step
  # failure) never reaches sidecar.cjs at all, so a warn-annotation added
  # only inside finalize.ts's own upload/upsert catch blocks would be dead
  # code for it -- this guard is the earliest point where that failure is
  # observable.
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
if [ -n "${OPENCODE_LAST_MESSAGE_FILE:-}" ]; then
  ARGS+=(--opencode-last-message-file "$OPENCODE_LAST_MESSAGE_FILE")
fi

GOOGLE_APPLICATION_CREDENTIALS="$WRITER_CREDENTIALS_FILE" \
  AGENT_TELEMETRY_PROJECT_ID=agent-lcars \
  node "$SIDECAR_BIN" "${ARGS[@]}"
echo "Telemetry finalize complete."
exit 0
