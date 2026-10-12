#!/usr/bin/env bash
# Hook telemetry for dispatched workers (docs/hooks-telemetry-design.md,
# phase 2). Sourced by direct-runner.sh. For a pipeline named in
# LCARS_HOOK_TELEMETRY_PROVIDERS (trusted executor deployment only, never a
# run brief), the provider's own hooks report the session through `lcars
# hook` and the polling sidecar does not start. Every failure falls back to
# the sidecar: telemetry must never fail a dispatch.

# Whether hooks replace the sidecar for this pipeline. OpenCode has no hook
# client yet, so it always keeps the sidecar.
hook_telemetry_selected() {
  case "${PIPELINE:-}" in claude|codex) ;; *) return 1 ;; esac
  local provider
  local -a providers=()
  IFS=, read -r -a providers <<< "${LCARS_HOOK_TELEMETRY_PROVIDERS:-}"
  for provider in "${providers[@]}"; do
    [ "$provider" = "$PIPELINE" ] && return 0
  done
  return 1
}

# Installs this pipeline's hook entries and exports the run context the hook
# client stamps on every event. The credentials file is named only through
# LCARS_TELEMETRY_CREDENTIALS_FILE, which the flusher hands to the Firestore
# client; it is never exported as the agent's ambient Google credentials.
hook_telemetry_bootstrap() {
  local credentials="${HOOK_TELEMETRY_CREDENTIALS_FILE:-/run/secrets/telemetry-writer.json}"
  [ -r "$credentials" ] || return 1
  export LCARS_REPO="$TARGET_REPO"
  export LCARS_ISSUE_NUMBER="${ISSUE:-}"
  export INTENT_ID
  export LCARS_TELEMETRY_CREDENTIALS_FILE="$credentials"
  if ! "${HOOK_TELEMETRY_NODE:-node}" \
    "${HOOK_TELEMETRY_CLI:-/usr/local/lib/agent-lcars/lcars-session-title.cjs}" \
    integration install "$PIPELINE" > "$RUNNER_TEMP/hook-telemetry-install.log" 2>&1; then
    return 1
  fi
  if [ "$PIPELINE" = codex ]; then
    # Isolated worker runtime: the image is the vetted hook source.
    CODEX_HOOK_ARGS=(--enable hooks --dangerously-bypass-hook-trust)
  fi
}

# Before finalize writes the authoritative final doc: let detached flushers
# finish, then drain whatever is left, so no late hook event can land after
# it and reopen an ended session.
hook_telemetry_drain() {
  local flusher="${HOOK_TELEMETRY_FLUSHER:-/usr/local/lib/agent-lcars/lcars-hook-flush.cjs}"
  local waited=0
  while pgrep -f "$flusher" > /dev/null 2>&1 && [ "$waited" -lt 30 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  timeout 60 "${HOOK_TELEMETRY_NODE:-node}" "$flusher" > /dev/null 2>&1 || true
}
