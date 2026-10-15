#!/usr/bin/env bash
# Hook telemetry for dispatched workers (docs/hooks-telemetry-design.md,
# phase 3). Sourced by direct-runner.sh. Every pipeline's own hooks report the
# session through `lcars hook`; there is no polling sidecar. Every failure
# returns nonzero so the caller can warn and continue without live
# telemetry: telemetry must never fail a dispatch.

# Compatibility shim: the runner image fetches this helper from
# AGENT_LCARS_REF (main by default) while direct-runner.sh comes from the
# build context, so an image rebuilt from an older context still asks whether
# hooks are selected. Every pipeline is, so answer yes; otherwise that runner
# would start the retired sidecar, whose `start` is now a no-op, and lose live
# telemetry.
hook_telemetry_selected() { return 0; }

# Installs this pipeline's hook entries and exports the run context the hook
# client stamps on every event. OpenCode's plugin (lcars-telemetry.js) is
# already in the image's OpenCode config and stays inert until
# LCARS_TELEMETRY_CREDENTIALS_FILE is exported, so it needs no install. The credentials file is named only through
# LCARS_TELEMETRY_CREDENTIALS_FILE, which the flusher hands to the Firestore
# client; it is never exported as the agent's ambient Google credentials.
hook_telemetry_bootstrap() {
  local credentials="${HOOK_TELEMETRY_CREDENTIALS_FILE:-/run/secrets/telemetry-writer.json}"
  [ -r "$credentials" ] || return 1
  export LCARS_REPO="$TARGET_REPO"
  export LCARS_ISSUE_NUMBER="${ISSUE:-}"
  export INTENT_ID
  export LCARS_TELEMETRY_CREDENTIALS_FILE="$credentials"
  if [ "$PIPELINE" = opencode ]; then
    if [ ! -r "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/lcars-telemetry.js" ]; then
      unset LCARS_TELEMETRY_CREDENTIALS_FILE LCARS_REPO LCARS_ISSUE_NUMBER
      return 1
    fi
    return 0
  fi
  if ! "${HOOK_TELEMETRY_NODE:-node}" \
    "${HOOK_TELEMETRY_CLI:-/usr/local/lib/agent-lcars/lcars-session-title.cjs}" \
    integration install "$PIPELINE" > "$RUNNER_TEMP/hook-telemetry-install.log" 2>&1; then
    # No live telemetry this run; do not leave hook-client context behind.
    unset LCARS_TELEMETRY_CREDENTIALS_FILE LCARS_REPO LCARS_ISSUE_NUMBER
    return 1
  fi
  if [ "$PIPELINE" = codex ]; then
    # Isolated worker runtime: the image is the vetted hook source.
    CODEX_HOOK_ARGS=(--enable hooks --dangerously-bypass-hook-trust)
  fi
}

# Before finalize writes the authoritative final doc: fence new hook events,
# let hooks already holding a session lock finish appending, let a running
# flusher finish, then drain what is left. A hook that reaches its session
# lock after the fence records nothing (hook-command.ts), so no late event can
# land after finalize and reopen an ended session.
hook_telemetry_drain() {
  local flusher="${HOOK_TELEMETRY_FLUSHER:-/usr/local/lib/agent-lcars/lcars-hook-flush.cjs}"
  local state="${HOME}/.local/state/agent-lcars"
  mkdir -p "$state"
  local waited=0
  # Codex's SessionEnd hook hands its payload to a detached client, which
  # deletes it from hook-inflight/ once spooled (integration.ts). Fencing
  # before then would turn the session's end away.
  while compgen -G "$state/hook-inflight/*" > /dev/null && [ "$waited" -lt 30 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  : > "$state/hook-fence"
  waited=0
  # In-flight producers hold hook-sessions/<id>.lock while they append.
  while compgen -G "$state/hook-sessions/*.lock" > /dev/null && [ "$waited" -lt 30 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  # A running flusher holds the spool lock (refreshed per event); wait on the
  # lock file rather than process listing, which the image may not provide.
  waited=0
  while [ -e "$state/spool/events.lock" ] && [ "$waited" -lt 30 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  timeout 60 "${HOOK_TELEMETRY_NODE:-node}" "$flusher" > /dev/null 2>&1 || true
}
