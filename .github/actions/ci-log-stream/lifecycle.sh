#!/usr/bin/env bash
# Start/stop wrapper for the internal CI page-log shipper. Process lifecycle is
# delegated to the generic job-daemon.sh extracted in agent-lcars#1246.
# Every path exits 0: losing live logs must never change the instrumented job.
set -u

MODE="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JOB_DAEMON_BIN="${JOB_DAEMON_BIN:-/usr/local/lib/agent-lcars/job-daemon.sh}"
PAGE_DIR="${AGENT_LCARS_CI_LOG_PAGE_DIR:-/home/runner/_diag/pages}"
DIAGNOSTIC_PATH="${AGENT_LCARS_CI_LOG_DIAGNOSTIC_PATH:-/tmp/agent-lcars-ci-log-shipper.log}"
DAEMON_NAME=ci-log-stream

diagnose() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"$DIAGNOSTIC_PATH" 2>/dev/null || true
}

case "$MODE" in
  start | stop) ;;
  *)
    diagnose "invalid lifecycle mode '$MODE'; expected start|stop"
    exit 0
    ;;
esac

if [ "${RUNNER_ENVIRONMENT:-}" != self-hosted ]; then
  diagnose "runner environment is not self-hosted; $MODE is a clean no-op"
  exit 0
fi

if [ ! -x "$JOB_DAEMON_BIN" ]; then
  diagnose "job-daemon.sh is unavailable at $JOB_DAEMON_BIN; $MODE skipped"
  exit 0
fi

if [ "$MODE" = stop ]; then
  "$JOB_DAEMON_BIN" stop "$DAEMON_NAME" || true
  exit 0
fi

if [ ! -d "$PAGE_DIR" ]; then
  diagnose "runner page directory is unavailable at $PAGE_DIR; start skipped"
  exit 0
fi
if [ -z "${AGENT_LCARS_CI_LOG_LOKI_URL:-}" ]; then
  diagnose "Loki URL is empty; start skipped"
  exit 0
fi

"$JOB_DAEMON_BIN" start "$DAEMON_NAME" -- \
  node "$SCRIPT_DIR/shipper.mjs" || true
exit 0
