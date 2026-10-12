#!/usr/bin/env bash
# Sourced once by direct-runner. Wires the `lcars hook` telemetry client
# (docs/hooks-telemetry-design.md section 4.5) into a dispatched provider run.
#
# Hooks run alongside the `runner sidecar`, not instead of it: the sidecar
# skips any session that carries a fresh hook marker, so a working hook
# takes over a session within one event and a broken or absent one leaves
# the sidecar writing exactly as before. Nothing here may fail a run;
# every function degrades to "sidecar only".

LCARS_BIN="${LCARS_BIN:-/usr/local/bin/lcars}"
TELEMETRY_HOOK_CREDENTIALS="${TELEMETRY_HOOK_CREDENTIALS:-/run/secrets/telemetry-writer.json}"
TELEMETRY_HOOKS_ENABLED=0
TELEMETRY_CLAUDE_ARGS=()

# Exports what the hook client needs to recognize a runner session and to
# write as telemetry-writer. Only a dedicated credentials variable is
# exported: GOOGLE_APPLICATION_CREDENTIALS in the agent's environment would
# re-target every Google SDK the agent's work calls.
telemetry_hooks_prepare() {
  TELEMETRY_HOOKS_ENABLED=0
  TELEMETRY_CLAUDE_ARGS=()
  [ -x "$LCARS_BIN" ] || return 0
  [ -r "$TELEMETRY_HOOK_CREDENTIALS" ] || return 0
  [ -n "${LCARS_RUN_ID:-}" ] && [ -n "${TARGET_REPO:-}" ] || return 0
  export LCARS_RUN_ID
  export LCARS_REPO="$TARGET_REPO"
  export LCARS_TELEMETRY_CREDENTIALS="$TELEMETRY_HOOK_CREDENTIALS"
  if [ -n "${INTENT_ID:-}" ]; then export INTENT_ID; fi
  if [[ "${ISSUE:-}" =~ ^[1-9][0-9]*$ ]]; then export NUM="$ISSUE"; fi
  TELEMETRY_HOOKS_ENABLED=1
}

# Claude: an additive --settings file. Claude merges hooks from every
# settings source, so the worker-policy entries in settings.json and any
# repository hooks keep running unchanged.
telemetry_hooks_claude() {
  [ "$TELEMETRY_HOOKS_ENABLED" = 1 ] || return 0
  local settings="$RUNNER_TEMP/claude-telemetry-hooks.json"
  local command="$LCARS_BIN hook claude"
  if jq -n --arg cmd "$command" '
      def hook($extra): [{hooks: [({type: "command", command: $cmd} + $extra)]}];
      {hooks: {
        SessionStart: hook({timeout: 10}),
        UserPromptSubmit: hook({async: true}),
        PostToolUse: hook({async: true}),
        Stop: hook({async: true}),
        SessionEnd: hook({timeout: 5})
      }}' > "$settings" 2>/dev/null; then
    TELEMETRY_CLAUDE_ARGS=(--settings "$settings")
  fi
}

# Codex: merge telemetry entries into the run's own hooks.json, keeping
# every existing group (the worker-policy bootstrap writes PreToolUse here).
# This adds no trust decision: Codex runs these entries only when the
# worker-policy rollout has already enabled hooks for this provider
# (`--enable hooks --dangerously-bypass-hook-trust`). Otherwise they are
# inert and the sidecar keeps reporting the session.
telemetry_hooks_codex() {
  [ "$TELEMETRY_HOOKS_ENABLED" = 1 ] || return 0
  local hooks_file="$1" staged
  local command="$LCARS_BIN hook codex"
  staged="$(mktemp "${hooks_file}.XXXXXX")" || return 0
  if jq --arg cmd "$command" '
      def entry($extra): {hooks: [({type: "command", command: $cmd} + $extra)]};
      def add($event; $extra):
        .hooks[$event] = (
          (.hooks[$event] // [])
          | map(select([.hooks[]?.command] | index($cmd) | not))
          + [entry($extra)]
        );
      (. // {})
      | .hooks = (.hooks // {})
      | add("SessionStart"; {timeout: 10})
      | add("UserPromptSubmit"; {async: true})
      | add("PostToolUse"; {async: true})
      | add("Stop"; {async: true})
      | add("Interrupt"; {timeout: 1})
      | add("SessionEnd"; {timeout: 3})' \
      < <(if [ -s "$hooks_file" ]; then cat "$hooks_file"; else echo '{}'; fi) \
      > "$staged" 2>/dev/null; then
    chmod 600 "$staged" && mv "$staged" "$hooks_file" && return 0
  fi
  rm -f "$staged"
}

# Drains the hook spool before `runner finalize`, so a late hook write can
# never land after the authoritative final doc, and nothing is lost when
# the container is destroyed. A detached flusher moves the live spool to
# events.pending.ndjson and holds events.lock while its write is in flight,
# so "drained" means all three are gone, not just the live file; each flush
# also sends at most a batch, so it loops. Bounded either way.
telemetry_hooks_drain() {
  [ "$TELEMETRY_HOOKS_ENABLED" = 1 ] || return 0
  local spool_dir="$HOME/.local/state/agent-lcars/spool"
  local deadline=$((SECONDS + ${TELEMETRY_HOOK_DRAIN_SECONDS:-30}))
  while [ -s "$spool_dir/events.ndjson" ] ||
    [ -s "$spool_dir/events.pending.ndjson" ] ||
    [ -e "$spool_dir/events.lock" ]; do
    timeout --kill-after=5s 20s "$LCARS_BIN" hook flush >/dev/null 2>&1 || true
    [ "$SECONDS" -lt "$deadline" ] || break
    if [ -s "$spool_dir/events.ndjson" ] ||
      [ -s "$spool_dir/events.pending.ndjson" ] ||
      [ -e "$spool_dir/events.lock" ]; then
      sleep 1
    fi
  done
  return 0
}
